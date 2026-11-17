// Query operators. The same async operators run on a host, over its local SQLite, and at the
// coordinator, over the graph gathered so far or over the hosts themselves; only the Store differs.
//
// Streams are pull-based and ordered. An operator that can't decide a row because something is
// UNKNOWN records misses and ends its stream "short": a later row can't be emitted before an
// undecided earlier one. Independent reads start together (a page's targets, the rows in a filter's
// window, a node's relationships), so a remote store can batch them and a slow branch doesn't hold up
// the rest.

import { UNKNOWN, cursorOf, isReference, referenceRow, targetOf } from "./types.ts";
import type { Cond, Cursor, Edge, End, Fields, Id, Json, Maybe, Miss, Node, Obj, Plan, Ref, Row, Store, Stream, Unknown } from "./types.ts";

export const DEFAULT_LIMIT = 50;
/** The lowest pass rate Where assumes when sizing its window, so a filter that has passed nothing yet
 *  can't ask for an unbounded read. */
export const MIN_RATE = 0.05;
/** The most rows one filter keeps in flight. */
export const MAX_AHEAD = 64;
/** Edge pages double up to this size. */
export const MAX_PAGE = 256;

export interface Req {
  ids?: Id[]; // an "ids" source
  parent?: Row; // an edge or field source
  after?: Cursor | null; // resume an edge list after this cursor
  want?: number; // rows the consumer expects to pull; sizes pages and windows
}

export interface Op {
  fetch(p: Pass, req: Req): Stream;
}

/**
 * What a pass does when it meets an edge into another database. Three answers, each with one owner.
 *
 * - `"miss"` is a **host**. It cannot follow one: the target is in a database it holds no part of,
 *   and it stores an alias it cannot even resolve. So it reports the row as a miss carrying the
 *   alias, skips it, and goes on prefetching the local rows around it. The coordinator judges
 *   membership anyway.
 * - `"follow"` is a **coordinator reading its own query**. The seam in `Hlekk.#exec` has already
 *   turned the alias into a URI, so the target is an ordinary reference to load — through a client
 *   for that database rather than for a host, which is the whole of what routing had to learn.
 * - `"reference"` is a **coordinator answering someone else's read**. A database answering a read
 *   never follows a reference out of itself, or it becomes the deputy `docs/protocol.md` rules out:
 *   it would be fetching from a third party on a caller's behalf, under its own identity, with the
 *   caller unable to tell whose answer it was. So the reference is listed and nothing is loaded.
 */
export type Foreign = "miss" | "follow" | "reference";

/** One evaluation of a plan against one store. */
export class Pass {
  readonly store: Store;
  readonly plan: Plan;
  /** What to do with an edge into another database. */
  readonly foreign: Foreign;
  /** What this pass needed and its store didn't have. On a host, the frontier it sends back. */
  readonly misses: Miss[] = [];
  readonly #background = new Set<Promise<unknown>>();
  readonly #full = new Map<number, Op>();
  readonly #rows = new Map<number, Op>();

  constructor(store: Store, plan: Plan, foreign: Foreign = "follow") {
    this.store = store;
    this.plan = plan;
    this.foreign = foreign;
  }

  miss(m: Miss): void {
    this.misses.push(m);
  }

  /** Tracks work started ahead of need that nobody may end up awaiting: a filter's window, a page's
   *  targets. Abandoning it raises no unhandled rejection, and settle() waits for it. */
  background<T>(work: Promise<T>): Promise<T> {
    this.#background.add(work);
    const forget = () => this.#background.delete(work);
    work.then(forget, forget);
    return work;
  }

  /** Waits until no background work is left. Some of it starts more, hence the loop. */
  async settle(): Promise<void> {
    while (this.#background.size > 0) await Promise.allSettled([...this.#background]);
  }

  /** Operators are built once per frame and addressed by frame id, like rindle's arena. */
  frameOp(frame: number): Op {
    let op = this.#full.get(frame);
    if (!op) this.#full.set(frame, (op = buildFrame(this.plan, frame, "full")));
    return op;
  }

  /** A frame's rows loaded by id, for a host that can't judge their membership: their edge lives on
   *  another host, or the coordinator does the judging. No filter or limit applies; the host only
   *  prefetches what lies below the rows, including what the filter would read. */
  rowOp(frame: number): Op {
    let op = this.#rows.get(frame);
    if (!op) this.#rows.set(frame, (op = buildFrame(this.plan, frame, "rows")));
    return op;
  }
}

export function buildFrame(plan: Plan, id: number, mode: "full" | "rows"): Op {
  const f = plan.frames[id];
  let op: Op;
  if (mode === "rows") {
    op = new ObjectsById(id);
    if (f.where) op = new Probe(op, f.where);
  } else {
    op =
      f.source.kind === "ids"
        ? new ObjectsById(id)
        : f.source.kind === "edge"
          ? new EdgeHop(id, f.source.atype, f.after ?? null)
          : new FieldHop(id, f.source.field);
    if (f.where) op = new Where(op, f.where);
    op = new Take(op, f.limit ?? DEFAULT_LIMIT); // every frame has a limit
  }
  for (const c of f.children) op = new Join(op, c.alias, c.frame);
  for (const c of f.counts) op = new CountRel(op, c.alias, c.atype);
  return op;
}

const node = (row: Row): Node => ({ row, rels: [], counts: [] });

// ---- sources

/** Roots and row tasks: objects by id, in the order given, all requested at once. */
export class ObjectsById implements Op {
  readonly frame: number;

  constructor(frame: number) {
    this.frame = frame;
  }

  async *fetch(p: Pass, req: Req): Stream {
    const ids = req.ids ?? [];
    const loads = ids.map((id) => p.background(p.store.object(id, this.frame)));
    for (let i = 0; i < ids.length; i++) {
      const o = await loads[i];
      if (o === UNKNOWN) {
        await missFrom(p, ids, loads, i, this.frame);
        return "short";
      }
      if (o !== null) yield node({ obj: o, edge: null });
    }
    return "done";
  }
}

/** A stored edge hop: the parent's edge list in order, each edge joined to its target object. It reads
 *  a page at a time and requests every target in a page at once. Pages double, as Aphrodite's chunks
 *  were meant to. */
export class EdgeHop implements Op {
  readonly frame: number;
  readonly atype: number;
  /** Where the plan says to start, when the request names no cursor of its own. */
  readonly from: Cursor | null;

  constructor(frame: number, atype: number, from: Cursor | null = null) {
    this.frame = frame;
    this.atype = atype;
    this.from = from;
  }

  async *fetch(p: Pass, req: Req): Stream {
    if (!req.parent) return "done";
    const id1 = req.parent.obj.id;
    let after = req.after ?? this.from;
    for (let n = req.want ?? DEFAULT_LIMIT; ; n = Math.min(MAX_PAGE, n * 2)) {
      const page = await p.store.edges(id1, this.atype, after, n, this.frame);
      if (page === UNKNOWN) {
        p.miss({ kind: "edges", id1, atype: this.atype, frame: this.frame, after, n });
        return "short";
      }
      // A foreign row is settled before any target is asked for, because what to do with it is not a
      // read: "follow" turns it into an ordinary reference, and the other two answer it here.
      const rows = page.rows.filter((e) => e.db === 0 || keepForeign(p, e, this.frame));
      const ids = rows.map(targetOf);
      const targets = rows.map((e, i) =>
        foreignReference(p, e) ? null : p.background(p.store.object(ids[i], this.frame)),
      );
      for (let i = 0; i < rows.length; i++) {
        const e = rows[i]!;
        if (foreignReference(p, e)) {
          // Listed, not loaded: the reference is in the answer and there is no object behind it,
          // which is exactly what a caller must be able to tell from an object that is absent.
          yield node(referenceRow(ids[i]!, e));
          continue;
        }
        const o = await targets[i]!;
        if (o === UNKNOWN) {
          await missFrom(p, ids, targets as Promise<Maybe<Obj | null>>[], i, this.frame, rows);
          return "short";
        }
        if (o !== null) yield node({ obj: o, edge: e }); // an edge to a deleted object is dropped
      }
      if (page.complete || page.rows.length === 0) return "done";
      after = cursorOf(page.rows[page.rows.length - 1]!);
    }
  }
}

/** Ending short at ids[from]: record it and every later load that is unknown too, so one request
 *  fetches them together. */
async function missFrom(
  p: Pass,
  ids: Ref[],
  loads: (Promise<Maybe<Obj | null>> | null)[],
  from: number,
  frame: number,
  rows?: Edge[],
): Promise<void> {
  for (let i = from; i < ids.length; i++) {
    const load = loads[i];
    if (load !== null && (await load) === UNKNOWN) {
      // The alias rides with the miss where there is one, because a host cannot resolve it and the
      // client's seam turns it into a URI on the way back.
      const db = rows?.[i]?.db ?? 0;
      p.miss(db === 0 ? { kind: "object", id: ids[i]!, frame } : { kind: "object", id: ids[i]!, db, frame });
    }
  }
}

/** Whether a foreign row survives to be a row of this frame at all. A host reports it and drops it;
 *  the two coordinator modes both keep it. */
function keepForeign(p: Pass, e: Edge, frame: number): boolean {
  if (p.foreign !== "miss") return true;
  p.miss({ kind: "object", id: e.id2, db: e.db, frame });
  return false;
}

/** Whether this row is one to list rather than load. */
const foreignReference = (p: Pass, e: Edge): boolean => e.db !== 0 && p.foreign === "reference";

/** A to-one hop through an id stored in the parent's payload (fieldRel). */
export class FieldHop implements Op {
  readonly frame: number;
  readonly field: string;

  constructor(frame: number, field: string) {
    this.frame = frame;
    this.field = field;
  }

  async *fetch(p: Pass, req: Req): Stream {
    const id = req.parent?.obj.data[this.field];
    if (typeof id !== "string") return "done";
    // A payload id may be qualified: that is the other place `query/ref.ts` allows one. A host
    // answers UNKNOWN for it rather than refusing, and this is the miss that sends it to the
    // database that holds it — already absolute, since a payload carries the URI and not an alias.
    const o = await p.store.object(id, this.frame);
    if (o === UNKNOWN) {
      p.miss({ kind: "object", id, frame: this.frame });
      return "short";
    }
    if (o !== null) yield node({ obj: o, edge: null });
    return "done";
  }
}

// ---- filtering and limits

type Truth = boolean | Unknown;

/** Filters rows with three-valued logic. It evaluates a window of rows ahead of the consumer at once
 *  and yields in order. The window is what's still needed divided by the pass rate so far, so a
 *  selective filter reads further ahead. A row it can't decide ends the stream short. */
export class Where implements Op {
  readonly input: Op;
  readonly cond: Cond;

  constructor(input: Op, cond: Cond) {
    this.input = input;
    this.cond = cond;
  }

  async *fetch(p: Pass, req: Req): Stream {
    const need = req.want ?? DEFAULT_LIMIT;
    let passed = 0;
    let seen = 0;
    const window = () => {
      const rate = Math.max(MIN_RATE, (passed + 1) / (seen + 2)); // Laplace: one in two before any evidence
      return Math.min(MAX_AHEAD, Math.ceil(Math.max(1, need - passed) / rate));
    };
    const rows = this.input.fetch(p, { ...req, want: window() });
    // A filter cannot judge a reference: this database does not hold the object, so every field test
    // over it would read as false and the row would be dropped — which would hide that the reference
    // exists. It passes through undecided and the caller, who can follow it, judges.
    const ahead = new Ahead(p, rows, (n) => (isReference(n.row.obj) ? Promise.resolve(true) : evalCond(p, this.cond, n.row)));
    try {
      for (;;) {
        ahead.fill(window());
        const s = await ahead.next();
        if ("end" in s) return s.end;
        seen++;
        if (s.v === UNKNOWN) return "short"; // can't place this row, so nothing after it either
        if (s.v) {
          passed++;
          yield s.node;
        }
      }
    } finally {
      ahead.close();
    }
  }
}

type Slot<V> = { node: Node; v: V } | { end: End };

/** Pulls rows ahead of the consumer, starts each one's evaluation as soon as it arrives, and hands the
 *  results back in input order. */
class Ahead<V> {
  readonly #p: Pass;
  readonly #input: Stream;
  readonly #evaluate: (n: Node) => Promise<V>;
  readonly #slots: Promise<Slot<V>>[] = [];
  #ended = false;

  constructor(p: Pass, input: Stream, evaluate: (n: Node) => Promise<V>) {
    this.#p = p;
    this.#input = input;
    this.#evaluate = evaluate;
  }

  /** Keep n rows in flight, counting the one the consumer awaits next. */
  fill(n: number): void {
    while (!this.#ended && this.#slots.length < n) {
      const slot = this.#input.next().then(async (r): Promise<Slot<V>> => {
        if (r.done) {
          this.#ended = true;
          return { end: r.value };
        }
        return { node: r.value, v: await this.#evaluate(r.value) };
      });
      this.#slots.push(this.#p.background(slot));
    }
  }

  /** fill() ran first, and slots run out only after the one holding the end. */
  next(): Promise<Slot<V>> {
    return this.#slots.shift()!;
  }

  /** Stop pulling. Rows already requested finish as background work, then the input closes. */
  close(): void {
    this.#ended = true;
    this.#p.background(this.#input.return("done"));
  }
}

/** Kleene logic. Within one row the terms run in order and short-circuit, so a field test can spare a
 *  remote `exists`; rows overlap in Where's window instead. */
export async function evalCond(p: Pass, c: Cond, row: Row): Promise<Truth> {
  if ("and" in c) {
    let unknown = false;
    for (const x of c.and) {
      const v = await evalCond(p, x, row);
      if (v === false) return false;
      if (v === UNKNOWN) unknown = true;
    }
    return unknown ? UNKNOWN : true;
  }
  if ("or" in c) {
    let unknown = false;
    for (const x of c.or) {
      const v = await evalCond(p, x, row);
      if (v === true) return true;
      if (v === UNKNOWN) unknown = true;
    }
    return unknown ? UNKNOWN : false;
  }
  if ("not" in c) {
    const v = await evalCond(p, c.not, row);
    return v === UNKNOWN ? UNKNOWN : !v;
  }
  if ("exists" in c) return exists(p, c.exists, row);
  return compare(c, row);
}

/** `exists` as a count up to 1: one row decides it even if later rows are unknown, and no rows decides
 *  it only if the subquery ended "done". */
async function exists(p: Pass, frame: number, parent: Row): Promise<Truth> {
  const rows = p.frameOp(frame).fetch(p, { parent, want: 1 });
  const r = await rows.next();
  if (r.done) return r.value === "short" ? UNKNOWN : false;
  p.background(rows.return("done"));
  return true;
}

/** Total over schemaless JSON: null matches nothing and mismatched types compare false. */
function compare(c: Extract<Cond, { cmp: unknown }>, row: Row): boolean {
  const v: Json | undefined =
    c.on === "obj" ? row.obj.data[c.field] : c.field === "time" ? row.edge?.time : row.edge?.data?.[c.field];
  const w = c.value;
  if (v === undefined || v === null || w === null || typeof v !== typeof w || typeof v === "object") return false;
  const a = v as number; // same primitive type on both sides, so the comparison is well defined
  const b = w as number;
  switch (c.cmp) {
    case "=":
      return a === b;
    case "!=":
      return a !== b;
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
}

/** Top-N per parent. Each fetch is one partition, so an initial query keeps no window state. Rows past
 *  the limit don't matter, so a stream cut off at the limit is "done" even if it would have ended short. */
export class Take implements Op {
  readonly input: Op;
  readonly limit: number;

  constructor(input: Op, limit: number) {
    this.input = input;
    this.limit = limit;
  }

  async *fetch(p: Pass, req: Req): Stream {
    const limit = Math.min(this.limit, req.want ?? this.limit);
    if (limit <= 0) return "done";
    const rows = this.input.fetch(p, { ...req, want: limit });
    try {
      for (let n = 0; n < limit; n++) {
        const r = await rows.next();
        if (r.done) return r.value;
        yield r.value;
      }
      return "done";
    } finally {
      p.background(rows.return("done"));
    }
  }
}

/** Where, for rows a host can't judge: it evaluates the filter so that whatever the filter reads is
 *  prefetched, and lets every row through. */
export class Probe implements Op {
  readonly input: Op;
  readonly cond: Cond;

  constructor(input: Op, cond: Cond) {
    this.input = input;
    this.cond = cond;
  }

  fetch(p: Pass, req: Req): Stream {
    return each(p, this.input.fetch(p, req), (n) => {
      p.background(evalCond(p, this.cond, n.row));
    });
  }
}

// ---- relationships and counts

/** Attaches a child frame as a lazy relationship. The parent row is captured by value, so the thunk
 *  can run any time later. */
export class Join implements Op {
  readonly input: Op;
  readonly alias: string;
  readonly frame: number;

  constructor(input: Op, alias: string, frame: number) {
    this.input = input;
    this.alias = alias;
    this.frame = frame;
  }

  fetch(p: Pass, req: Req): Stream {
    return each(p, this.input.fetch(p, req), (n) => {
      const parent = n.row;
      // Nothing hangs off a reference. This database holds no edge list for an object it does not
      // have, so attaching one would read as an empty list where the truth is "ask the database that
      // holds it" — and the caller does, because the reference is in the answer.
      if (isReference(parent.obj)) return;
      n.rels.push({ alias: this.alias, stream: () => p.frameOp(this.frame).fetch(p, { parent }) });
    });
  }
}

/** An unfiltered edge count from assoc_counts. A count never changes membership or order, so rows flow
 *  on; a node whose count is unknown is not an answer. */
export class CountRel implements Op {
  readonly input: Op;
  readonly alias: string;
  readonly atype: number;

  constructor(input: Op, alias: string, atype: number) {
    this.input = input;
    this.alias = alias;
    this.atype = atype;
  }

  fetch(p: Pass, req: Req): Stream {
    return each(p, this.input.fetch(p, req), (n) => {
      if (isReference(n.row.obj)) return; // a count of edges this database does not hold is not zero
      const id1 = n.row.obj.id;
      n.counts.push({
        alias: this.alias,
        n: async () => {
          const c = await p.store.count(id1, this.atype);
          if (c === UNKNOWN) p.miss({ kind: "count", id1, atype: this.atype });
          return c;
        },
      });
    });
  }
}

/** Passes a stream through, calling f on each node, and keeps its end. Closing the result closes the
 *  input. */
async function* each(p: Pass, rows: Stream, f: (n: Node) => void): Stream {
  try {
    for (;;) {
      const r = await rows.next();
      if (r.done) return r.value;
      f(r.value);
      yield r.value;
    }
  } finally {
    p.background(rows.return("done"));
  }
}

// ---- sinks

/** Coordinator sink: nested JSON (rindle's View), or UNKNOWN if any part ended short. A node starts
 *  loading as soon as it arrives, and its relationships and counts load together. */
export async function materialize(rows: Stream): Promise<Maybe<Json[]>> {
  const out: Promise<Maybe<Json>>[] = [];
  let r = await rows.next();
  for (; !r.done; r = await rows.next()) out.push(quiet(materializeNode(r.value)));
  const nodes = await Promise.all(out);
  return r.value === "done" && allKnown(nodes) ? nodes : UNKNOWN;
}

async function materializeNode(n: Node): Promise<Maybe<Json>> {
  const [rels, counts] = await Promise.all([
    Promise.all(n.rels.map((r) => materialize(r.stream()))),
    Promise.all(n.counts.map((c) => c.n())),
  ]);
  if (!allKnown(rels) || !allKnown(counts)) return UNKNOWN;
  // Reserved keys go after the payload, so they are authoritative: a `$`-prefixed field name is
  // refused by the catalog, but stored JSON is not re-validated on read.
  const o: Fields = { ...n.row.obj.data, id: n.row.obj.id, $version: n.row.obj.version };
  // The edge that reached this row. Without it an edge's own time and data can be filtered on and
  // never read, and a limited list has no cursor to continue from.
  if (n.row.edge) o.$edge = { time: n.row.edge.time, data: n.row.edge.data };
  n.rels.forEach((r, i) => (o[r.alias] = rels[i]));
  n.counts.forEach((c, i) => (o[c.alias] = counts[i]));
  return o;
}

/** Host sink: pull everything so the reads happen. The read set goes back, not the tree. */
export async function drain(rows: Stream): Promise<void> {
  const below: Promise<unknown>[] = [];
  for await (const n of rows) {
    for (const r of n.rels) below.push(quiet(drain(r.stream())));
    for (const c of n.counts) below.push(quiet(c.n()));
  }
  await Promise.all(below);
}

const allKnown = <T>(xs: Maybe<T>[]): xs is T[] => xs.every((x) => x !== UNKNOWN);

/** Marks a promise handled so it can be abandoned; whoever awaits it still sees its rejection. */
function quiet<T>(work: Promise<T>): Promise<T> {
  work.catch(() => {});
  return work;
}
