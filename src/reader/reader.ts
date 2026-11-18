// A reader: queries across databases, from a process that has none of its own.
//
// `client/client.ts` is a client over a database you run, which can also follow an edge out of it. This is
// the other half of that sentence on its own. It has no hosts, no directory and no storage, and it
// imports nothing from a platform, so it runs wherever `fetch` does.
//
// It is not a second implementation of the asking half. The two drivers already run a query over
// whatever `route` hands them, and `protocol/client.ts` already turns a database reached over HTTP
// into one of those: batching, the responder's own page tokens, the deadline and the byte cap, no
// redirects, pinned keys, and an answer validated rather than cast. What a database of your own adds
// to that is a catalog — the integers a plan is written in, and the names they stand for. So that is
// the one thing this file supplies, and it supplies it two ways:
//
// - **From the responder.** Each database is read by its own `/vocabulary`, numbered here. A name
//   keeps one number for the life of the reader, so a plan means the same thing in every database
//   it reaches, while the fields behind the name are whatever that database says they are. Nothing
//   has to be declared to read a database nobody described.
// - **From a lock**, for a caller that has one and a module generated from it. Its numbers are kept,
//   so that module's queries run here unchanged, and its fields are what an answer is narrowed to —
//   with a type the responder cannot fill declined rather than guessed at, as in the engine.
//
// **One catalog per database, not one for the reader.** A single merged catalog was the simpler
// thing and it is wrong. Two publishers may use one type name for different shapes, and the union
// of their fields describes neither: a field one of them calls an id would be read as a reference
// in the other's payload. Read by its own vocabulary, each database's objects carry the fields that
// database states, and a hop is only ever sent to a database that exposes its edge — an unknown one
// is asked of whichever database the references lead to, which is what "the caller is the hub"
// means. (The engine's client learned the second half of that from this file: see `subtree` in
// `protocol/client.ts`.)
//
// **Every edge a vocabulary names is read as a list.** A vocabulary says whether an edge is counted,
// which tells a stored edge from a field relationship, and does not say which field — so a reader
// cannot follow one by reading the payload itself. It does not need to: a hop names the edge, and
// the responder answers a field relationship as a list of at most one.
//
// A reader is the anonymous caller. A signature names a database (`spec/protocol.md` §7.2), and
// this is not one.

import { Catalog, CatalogError } from "../catalog/catalog.ts";
import type { FieldSpec, Lock } from "../catalog/catalog.ts";
import { runAsync, runRounds } from "../query/driver.ts";
import type { Answer, HostClient, Stats } from "../query/driver.ts";
import { canonicalDb, formatRef, parseRef } from "../query/ref.ts";
import type { Ref } from "../query/ref.ts";
import { DEFAULT_HOP_LIMIT, OPS, PROTOCOL_ALIASING, Refused, checkAliases, countEdge } from "../query/request.ts";
import type { Cmp, Cost, CountSpec, Hop, Request } from "../query/request.ts";
import type { Cond, Frame, Id, Json, Miss, Plan, Source } from "../query/types.ts";
import { systemClock } from "../runtime/runtime.ts";
import type { Clock } from "../runtime/runtime.ts";
import { decodeCursor, pageEnd } from "../schema/query.ts";
import {
  ForeignUnreachable,
  NotFollowed,
  ResponseCache,
  VOCABULARY_TTL_MS,
  askPrice,
  discoverPinned,
  discoverVocabulary,
  foreignClient,
} from "../protocol/client.ts";
import type { ForeignOptions, Omitted, Pins } from "../protocol/client.ts";
import type { Descriptor } from "../protocol/http.ts";
import type { VocabularyDoc } from "../protocol/surface.ts";
import { budgeted } from "../client/budget.ts";
import type { Budget } from "../client/budget.ts";
import { ReadBuilder } from "./query.ts";

export interface ReaderOptions {
  /**
   * Your own declarations, for a caller that has a lock and a module generated from it.
   *
   * Its integers are kept, so that module's queries run here unchanged. A type it declares is read
   * through the fields it declares, and declined where the responder cannot supply one it requires.
   * Absent, every database is read by its own vocabulary and nothing is declared at all.
   */
  lock?: Lock;
  /** Injected, so a test can hand in the handler itself. */
  fetch?: typeof fetch;
  /**
   * Refuses a URI before it is reached, where the platform can tell.
   *
   * A reference is written by whoever wrote the edge, so following one is being told where to
   * connect. A process that can reach a private network has to refuse those addresses, and that
   * needs DNS, which this file does not have: `adapters/node` supplies the guard and a `reader()`
   * that carries it.
   */
  guard?: ForeignOptions["guard"];
  deadlineMs?: number;
  maxResponseBytes?: number;
  /** Where a database's proven key is recorded. Held in memory by default, which catches a key that
   *  changes under a running reader and forgets it when the process ends. */
  pins?: Pins;
  /** Answers kept for as long as their responder permits. On by default; `false` asks every time. */
  cache?: ResponseCache | false;
  /** What one read may spend. A read may narrow or widen it. */
  budget?: Budget;
  clock?: Clock;
  /** Milliseconds since the epoch, for the cache and the vocabulary's age. */
  now?: () => number;
}

export interface ReadOptions {
  budget?: Budget;
  /**
   * Collects databases that could not be reached instead of failing the read.
   *
   * Absent, an unreachable database fails the read by name. Present, what it held is left out, and
   * this says which databases and how many references — an answer that is missing something has to
   * say so, because an empty list is never how a failure is reported. Give it a `references` array
   * and it names them too: `{ databases: {}, references: [] }`.
   */
  omit?: Omitted;
  driver?: "async" | "rounds";
  /** Filled in with what the read cost: rounds, and requests. */
  stats?: Stats;
}

/** One page of a list: what a hop returns. A list is always a page, so it always says whether it
 *  goes on and where from. */
export interface Page<R extends Row = Row> {
  items: R[];
  /** Hand it back as the hop's `after`. Opaque. */
  cursor: string | null;
  more: boolean;
}

/** An object as a read returns it: its payload, and beside it what the payload cannot say. */
export interface Row {
  /** Always a full reference. A reader has no database for a bare id to be relative to. */
  id: Ref;
  /** The type's name, as the database holding the object states it. */
  $type: string;
  $version: number;
  /** The edge that reached it. Absent on a root. */
  $edge?: { time: number; data: Json | null };
  [name: string]: Json | Page | undefined;
}

/**
 * A hop or a count over an edge the database holding the object does not expose.
 *
 * Not an empty list. A database that has no such edge was not asked a question it could answer, and
 * nothing is an answer a caller cannot tell from a true empty list.
 */
export class NoSuchEdge extends Error {
  readonly database: string;
  readonly edge: string;
  constructor(database: string, edge: string, exposed: readonly string[]) {
    super(`${database} exposes no edge ${JSON.stringify(edge)}; it has ${exposed.join(", ") || "none"}`);
    this.name = "NoSuchEdge";
    this.database = database;
    this.edge = edge;
  }
}

/** Pins that live as long as the reader does. */
export function memoryPins(): Pins {
  const held = new Map<string, { pinned: string | null; state: string | null }>();
  const of = (uri: string) => held.get(uri) ?? { pinned: null, state: null };
  return {
    pinOf: async (uri) => of(uri),
    pin: async (uri, keyId) => void held.set(uri, { ...of(uri), pinned: keyId }),
    repudiate: async (uri) => void held.set(uri, { ...of(uri), state: "repudiated" }),
  };
}

/** A name's number, for the life of a reader. Objects and edges are numbered separately, as a lock
 *  numbers them. */
class Names {
  readonly #numbers = new Map<string, number>();
  readonly #names = new Map<number, string>();

  constructor(taken: Iterable<[string, number]> = []) {
    for (const [name, n] of taken) this.#set(name, n);
  }

  #set(name: string, n: number): void {
    this.#numbers.set(name, n);
    this.#names.set(n, name);
  }

  of(name: string): number {
    let n = this.#numbers.get(name);
    if (n === undefined) {
      n = this.#names.size + 1;
      while (this.#names.has(n)) n++;
      this.#set(name, n);
    }
    return n;
  }

  named(n: number): string | undefined {
    return this.#names.get(n);
  }
}

/** A field as a vocabulary describes it, back as a spec. A description this reader has no name for
 *  is still a value it can carry, so it is read as JSON rather than refused. */
function specOf(described: { type: string; optional: boolean }): FieldSpec {
  const id = /^id\((.+)\)$/.exec(described.type);
  const values = /^enum\((.*)\)$/.exec(described.type);
  const spec: FieldSpec = id
    ? { id: id[1]! }
    : values
      ? { enum: values[1]!.split("|") }
      : described.type === "string" || described.type === "number" || described.type === "boolean"
        ? described.type
        : "json";
  return described.optional ? { optional: spec } : spec;
}

interface Learned {
  /** The descriptor's catalog version this was read under. */
  version: number;
  at: number;
  doc: VocabularyDoc;
  catalog: Catalog;
}

const REQUEST_MEMBERS = ["counts", "hops"] as const;
const HOP_MEMBERS = ["as", "edge", "limit", "after", "where", "counts", "hops"] as const;
const CMP_MEMBERS = ["field", "op", "value"] as const;

function onlyKnown(value: object, known: readonly string[], at: string, hint = ""): void {
  for (const name of Object.keys(value)) {
    if (!known.includes(name)) throw new Refused(at, `no such member "${name}"; this one takes ${known.join(", ")}${hint}`);
  }
}

export class Reader {
  readonly clock: Clock;
  readonly #opts: ReaderOptions;
  readonly #declared: Catalog | undefined;
  readonly #types: Names;
  readonly #edges: Names;
  readonly #pins: Pins;
  readonly #cache: ResponseCache | undefined;
  readonly #now: () => number;
  readonly #learned = new Map<string, Learned>();

  constructor(opts: ReaderOptions = {}) {
    this.#opts = opts;
    this.clock = opts.clock ?? systemClock;
    this.#now = opts.now ?? (() => Date.now());
    this.#declared = opts.lock === undefined ? undefined : Catalog.compile(opts.lock);
    this.#types = new Names(Object.entries(opts.lock?.objects ?? {}).map(([name, o]) => [name, o.otype]));
    this.#edges = new Names(
      Object.entries(opts.lock?.edges ?? {}).flatMap(([name, e]) => (e.atype === undefined ? [] : [[name, e.atype] as [string, number]])),
    );
    this.#pins = opts.pins ?? memoryPins();
    this.#cache = opts.cache === false ? undefined : (opts.cache ?? new ResponseCache(this.#now));
  }

  get #transport(): Pick<ForeignOptions, "fetch" | "guard" | "deadlineMs" | "maxResponseBytes" | "pins"> {
    const { fetch, guard, deadlineMs, maxResponseBytes } = this.#opts;
    return { fetch, guard, deadlineMs, maxResponseBytes, pins: this.#pins };
  }

  // ---- one database

  /** Meets a database: its descriptor, checked and pinned, and its vocabulary. */
  async database(uri: string): Promise<Database> {
    const db = canonicalDb(uri);
    const descriptor = await discoverPinned(db, this.#transport);
    const { doc } = await this.#learn(db, descriptor);
    return new Database(this, descriptor, doc);
  }

  /**
   * The catalog one database is read by: its vocabulary, numbered here.
   *
   * Asked for again when the descriptor reports a different catalog version, and after
   * `VOCABULARY_TTL_MS` whatever it reports.
   */
  async #learn(db: string, descriptor: Descriptor, spend?: () => AbortSignal): Promise<Learned> {
    const held = this.#learned.get(db);
    const now = this.#now();
    if (held !== undefined && held.version === descriptor.catalog && now - held.at < VOCABULARY_TTL_MS) return held;
    const doc = await discoverVocabulary(db, this.#transport, spend);
    const learned: Learned = { version: descriptor.catalog, at: now, doc, catalog: this.#catalogOf(db, doc) };
    this.#learned.set(db, learned);
    return learned;
  }

  #catalogOf(db: string, doc: VocabularyDoc): Catalog {
    const objects: Lock["objects"] = {};
    const type = (name: string, fields: Record<string, FieldSpec>): void => {
      // A type the caller declared is read through the caller's fields. Whether the responder can
      // fill them is `agree`'s to decide, with this same document.
      objects[name] = { otype: this.#types.of(name), fields: this.#declared?.objectNamed(name)?.fields ?? fields };
    };
    for (const [name, entry] of Object.entries(doc.types)) {
      type(name, Object.fromEntries(Object.entries(entry.fields).map(([field, described]) => [field, specOf(described)])));
    }
    const edges: Lock["edges"] = {};
    for (const [name, entry] of Object.entries(doc.edges)) {
      // An edge may land on a type the vocabulary names and does not list. It is still somewhere a
      // hop can arrive, so it is a type with nothing to read.
      for (const end of [entry.from, entry.to]) if (!(end in objects)) type(end, {});
      const field = this.#declared?.edgeNamed(name)?.field;
      edges[name] =
        field !== undefined && field in objects[entry.from]!.fields
          ? { from: entry.from, to: entry.to, field }
          : { from: entry.from, to: entry.to, atype: this.#edges.of(name), ...(entry.foreign === true ? { foreign: true } : {}) };
    }
    try {
      return Catalog.compile({ version: 1, objects, edges });
    } catch (e) {
      if (!(e instanceof CatalogError)) throw e;
      throw new ForeignUnreachable(db, `invalid vocabulary: ${e.message}`);
    }
  }

  // ---- running a query

  /**
   * Runs a plan from references, across however many databases it reaches.
   *
   * This is what a query built with `hlekk/schema` calls, so `Type.gen(ref).related(...).run(reader)`
   * is a query against databases you do not run.
   */
  async answer(plan: Plan, rootIds: Id[], opts: ReadOptions = {}): Promise<Answer> {
    for (const id of rootIds) {
      if (parseRef(id).db === null) {
        throw new TypeError(
          `${JSON.stringify(id)} is a bare id, and a reader has no database for it to be relative to.` +
            " Start from `<database URI>#<id>`, or read through `database(uri)`, which qualifies its own ids.",
        );
      }
    }
    const spending = budgeted(this.clock, { ...this.#opts.budget, ...opts.budget });
    const clients = new Map<string, HostClient>();
    const route = (id: Ref): HostClient => {
      const { db } = parseRef(id);
      if (db === null) throw new TypeError(`an answer led to the bare id ${id}, which names no database`);
      let client = clients.get(db);
      if (client === undefined) clients.set(db, (client = spending(db, this.#client(db, opts.omit))));
      return client;
    };
    const answer =
      opts.driver === "rounds"
        ? await runRounds(plan, rootIds, route, opts.stats)
        : await runAsync(plan, rootIds, route, opts.stats, (f) => this.clock.defer(f));
    for (const row of answer.rows) this.#stamp(plan, answer, row, 0);
    return answer;
  }

  #client(db: string, omit: Omitted | undefined): HostClient {
    const asking = foreignClient(db, {
      ...this.#transport,
      catalog: async (descriptor, spend) => (await this.#learn(db, descriptor, spend)).catalog,
      // Only a declaration can disagree with a vocabulary; a catalog read from one is that document.
      agree: this.#declared !== undefined,
      vocabulary: async () => this.#learned.get(db)!.doc,
      cache: this.#cache,
      now: this.#now,
      omit,
    });
    return {
      metersRequests: true,
      exec: async (plan, tasks, spend) => {
        // A list or a count is asked of the database that holds the object it hangs under, and that
        // database may not expose the edge. That is the caller's mistake and not a database being
        // unreachable, so it is raised before `omit` could take it for one — and by name, where the
        // client underneath has only this reader's number for it.
        const before = this.#unexposed(db, tasks);
        if (before) throw before;
        try {
          return await asking.exec(plan, tasks, spend);
        } catch (e) {
          throw (e instanceof NotFollowed && this.#unexposed(db, tasks)) || e;
        }
      },
    };
  }

  #unexposed(db: string, tasks: readonly Miss[]): NoSuchEdge | undefined {
    const learned = this.#learned.get(db);
    if (learned === undefined) return undefined;
    for (const task of tasks) {
      if (task.kind === "object" || learned.catalog.edge(task.atype) !== undefined) continue;
      return new NoSuchEdge(db, this.#edges.named(task.atype) ?? `#${task.atype}`, Object.keys(learned.doc.edges));
    }
    return undefined;
  }

  /** Writes each row's type beside it. The engine's rows do not carry one, because a query built
   *  from a catalog knows what it asked for; a reader that started from a reference does not. */
  #stamp(plan: Plan, answer: Answer, value: Json, frame: number): void {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const held = answer.graph.objects.get(value.id as Id);
    if (held) value.$type = this.#types.named(held.otype) ?? null;
    for (const child of plan.frames[frame]!.children) {
      const below = value[child.alias];
      if (Array.isArray(below)) for (const item of below) this.#stamp(plan, answer, item, child.frame);
    }
  }

  /** What a request would cost one database, asked of it. See `Database.price`. */
  priceAt(database: string, ids: Id[], request: Request = {}): Promise<Cost> {
    return askPrice(database, { ids, ...request }, this.#transport);
  }

  // ---- reading by name

  /**
   * Reads objects by reference, and whatever the request hangs under them.
   *
   * The request is the body `POST {db}/read` takes, without its `ids`: the same hops, counts,
   * filters, limits and cursors, under the same rules. What differs is that it does not stop at the
   * database it entered. A hop is asked of whichever database holds the object it starts from, so
   * one request may name edges from several vocabularies.
   */
  async read(refs: Ref | readonly Ref[], request: Request = {}, opts: ReadOptions = {}): Promise<Row[]> {
    const roots = typeof refs === "string" ? [refs] : [...refs];
    if (roots.length === 0) throw new Refused("ids", "a read enters from at least one reference");
    const plan = this.#planOf(request);
    const answer = await this.answer(plan, roots, opts);
    const page = (value: Json, frame: number): Row => {
      // The type goes beside the id, which is where a reader looks for what a thing is.
      const row = {} as Row;
      for (const [key, held] of Object.entries(value as Record<string, Json>)) {
        if (key !== "$type") row[key] = held;
        if (key === "id") row.$type = (value as Record<string, Json>).$type as string;
      }
      for (const child of plan.frames[frame]!.children) {
        const below = row[child.alias];
        const items = Array.isArray(below) ? below.map((item) => page(item, child.frame)) : [];
        const spec = plan.frames[child.frame]!;
        row[child.alias] = { items, ...pageEnd(row.id, spec.source, spec.after, items.at(-1) as Json | undefined, answer.graph) };
      }
      return row;
    };
    return answer.rows.map((row) => page(row, 0));
  }

  /**
   * Starts a read from references, to be built by chaining: `related`, `countAs`, then `run`.
   *
   * The same read as `read(refs, request)`, written rather than spelled out. `request()` on what
   * this returns is that request.
   */
  from(refs: Ref | readonly Ref[]): ReadBuilder {
    return new ReadBuilder(this, typeof refs === "string" ? [refs] : [...refs]);
  }

  /**
   * A request as a plan, in this reader's numbers.
   *
   * Checked here for what can be checked without a vocabulary: members the protocol does not
   * define, and names that would collide in the answer (`spec/protocol.md` §5.1.1). Whether an edge
   * exists is the question only the database it is asked of can answer, and it does.
   */
  #planOf(request: Request): Plan {
    if (request === null || typeof request !== "object" || Array.isArray(request)) throw new Refused("query", "expected an object");
    onlyKnown(request, REQUEST_MEMBERS, "query", "; the references to enter from are the first argument");
    checkAliases(request, PROTOCOL_ALIASING, Infinity);

    const frames: Frame[] = [];
    const emit = (source: Source, node: Partial<Hop> & Request, at: string): number => {
      const index = frames.length;
      const root = source.kind === "ids";
      if (!root) {
        onlyKnown(node, HOP_MEMBERS, at);
        if (node.limit !== undefined && node.limit < 1) throw new Refused(`${at}.limit`, "limit must be at least 1");
        if (node.after !== undefined && typeof node.after !== "string") throw new Refused(`${at}.after`, "expected a cursor");
      }
      frames.push({
        source,
        limit: root ? undefined : (node.limit ?? DEFAULT_HOP_LIMIT),
        after: root || node.after === undefined ? undefined : cursorOf(node.after, `${at}.after`),
        children: [],
        counts: [],
      });
      const children = (node.hops ?? []).map((hop, i) => ({
        alias: PROTOCOL_ALIASING.hop(hop),
        frame: emit(this.#sourceOf(hop.edge), hop, `${at === "" ? "" : `${at}.`}hops[${i}]`),
      }));
      const counts = (node.counts ?? []).map((c, i) => ({
        alias: PROTOCOL_ALIASING.count(c),
        atype: this.#counted(c, `${at === "" ? "" : `${at}.`}counts[${i}]`),
      }));
      frames[index] = { ...frames[index]!, children, counts, where: condOf(node.where, at) };
      return index;
    };
    emit({ kind: "ids" }, request, "");
    return { frames };
  }

  #sourceOf(edge: string): Source {
    const field = this.#declared?.edgeNamed(edge)?.field;
    return field !== undefined ? { kind: "field", field } : { kind: "edge", atype: this.#edges.of(edge) };
  }

  #counted(count: CountSpec, at: string): number {
    const edge = countEdge(count);
    if (this.#declared?.edgeNamed(edge)?.field !== undefined) {
      throw new Refused(at, `edge "${edge}" has no count: it follows an id in a payload and stores nothing`);
    }
    return this.#edges.of(edge);
  }
}

/** A cursor this reader handed back in an earlier page. One from anywhere else is refused here,
 *  with its place in the request, rather than reaching a database as a position it never gave. */
function cursorOf(after: string, at: string) {
  try {
    return decodeCursor(after);
  } catch (e) {
    throw new Refused(at, `${(e as Error).message}; a cursor is the one a page of this list returned`);
  }
}

function condOf(where: Cmp[] | undefined, at: string): Cond | undefined {
  const cmps = (where ?? []).map((w, i): Cond => {
    const path = `${at}.where[${i}]`;
    if (w === null || typeof w !== "object" || Array.isArray(w)) throw new Refused(path, "expected an object");
    onlyKnown(w, CMP_MEMBERS, path);
    if (typeof w.field !== "string" || !w.field || !("value" in w)) throw new Refused(path, "a comparison requires a field and value");
    if (!OPS.includes(w.op)) throw new Refused(path, `operator must be one of ${OPS.join(" ")}`);
    return { cmp: w.op, on: "obj", field: w.field, value: w.value };
  });
  if (cmps.length === 0) return undefined;
  return cmps.length === 1 ? cmps[0] : { and: cmps };
}

/** One database, as a reader met it. A place to start from: its ids are the only ones this reader
 *  can take bare, and its vocabulary says what may be asked of them. */
export class Database {
  readonly reader: Reader;
  /** The canonical URI. Every reference into this database begins with it. */
  readonly database: string;
  readonly descriptor: Descriptor;
  readonly vocabulary: VocabularyDoc;

  constructor(reader: Reader, descriptor: Descriptor, vocabulary: VocabularyDoc) {
    this.reader = reader;
    this.database = descriptor.database;
    this.descriptor = descriptor;
    this.vocabulary = vocabulary;
  }

  get limits(): Descriptor["limits"] {
    return this.descriptor.limits;
  }

  get types(): VocabularyDoc["types"] {
    return this.vocabulary.types;
  }

  get edges(): VocabularyDoc["edges"] {
    return this.vocabulary.edges;
  }

  /** The edges that may be hung under an object of a type: the ones that start there
   *  (`spec/protocol.md` §4.3). An answer states each object's type, so this is what to ask next. */
  edgesFrom(type: string): string[] {
    return Object.entries(this.edges).flatMap(([name, edge]) => (edge.from === type ? [name] : []));
  }

  /** A reference to one of this database's objects. One that is already a reference is returned as
   *  it is, wherever it points. */
  ref(id: Id | Ref): Ref {
    return parseRef(id).db === null ? formatRef(this.database, id) : id;
  }

  /** `Reader.from`, entered from this database's own ids. */
  from(ids: Id | Ref | readonly (Id | Ref)[]): ReadBuilder {
    return this.reader.from((typeof ids === "string" ? [ids] : [...ids]).map((id) => this.ref(id)));
  }

  /** `Reader.read`, entered from this database's own ids. */
  read(ids: Id | Ref | readonly (Id | Ref)[], request: Request = {}, opts: ReadOptions = {}): Promise<Row[]> {
    const refs = (typeof ids === "string" ? [ids] : [...ids]).map((id) => this.ref(id));
    return this.reader.read(refs, request, opts);
  }

  /**
   * What a request would cost this database, with nothing read.
   *
   * Priced as written and as if all of it were asked here, so it is exact for a request that stays
   * in this database and an upper bound on this database's share of one that leaves it.
   */
  price(ids: Id | Ref | readonly (Id | Ref)[], request: Request = {}): Promise<Cost> {
    const own = (typeof ids === "string" ? [ids] : [...ids]).map((id) => {
      const { db, id: bare } = parseRef(id);
      if (db !== null && db !== this.database) throw new TypeError(`${id} is not in ${this.database}, so this database cannot price it`);
      return bare;
    });
    return this.reader.priceAt(this.database, own, request);
  }
}

/** Meets one database with a reader made for it. `database.reader` is that reader, for reading on
 *  from references that lead elsewhere. */
export function connect(uri: string, opts: ReaderOptions = {}): Promise<Database> {
  return new Reader(opts).database(uri);
}
