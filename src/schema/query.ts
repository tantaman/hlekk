// The fluent query builder. A query is the builder's value: there is nothing to declare up front, and
// reuse is an ordinary function over a query.
//
// It compiles to a Plan, which is what hosts and the coordinator run. Each `related` level becomes one
// frame, addressed by index, so a frontier task can carry its frame and a host can cache the plan.

import { parseId } from "../host/ids.ts";
import { DEFAULT_LIMIT } from "../query/ops.ts";
import type { Stats } from "../query/driver.ts";
import type { Cond, CmpOp, Id, Json, Plan, Source } from "../query/types.ts";
import type { EdgeType, FieldMap, FieldRel, IsSingle, ObjectType, Relation, RowOf, TargetOf } from "./define.ts";

// Structural, so this module imports no value from define.ts and the two do not form a cycle: a
// stored edge carries an atype and a field relationship carries the field it follows.
const isFieldRel = <From extends FieldMap, To extends FieldMap>(r: Relation<From, To>): r is FieldRel<From, To> =>
  "field" in r;

/** A predicate, before frame indices exist. `exists` holds a whole subquery, which becomes its own
 *  frame when the plan is compiled. */
export type Pred =
  | { and: Pred[] }
  | { or: Pred[] }
  | { not: Pred }
  | { cmp: CmpOp; on: "obj" | "edge"; field: string; value: Json }
  | { existsOf: Node };

/** One `related` level, before compilation. */
interface Node {
  source: Source;
  where?: Pred;
  limit?: number;
  after?: { time: number; db: number; id2: Id; token?: string };
  children: Child[];
  counts: { alias: string; atype: number }[];
}

interface Child {
  alias: string;
  /** To-one: the result holds the object, not a list of one. */
  single: boolean;
  /** Paged: the result holds the items plus a cursor to continue from. */
  paged: boolean;
  node: Node;
}

/** A page of a related list: the rows, and what it takes to read the next ones. */
export interface Page<T> {
  items: T[];
  /** Pass to `after` to continue. Null when there is nothing to continue from. */
  cursor: string | null;
  /** Whether the list goes on past these rows. */
  more: boolean;
}

/** Edges are ordered by `(time, db, id2)`; the last two are the tie-break, so a cursor is exact. The
 *  version prefix is here because the comparator can change and an old cursor must not be read under
 *  a new one — which is exactly what happened: `db` joining the key moved the tie-break, so this is
 *  `v2` and carries the alias.
 *
 *  A `v1` cursor still decodes, as alias 0. Cursors are handed to callers and held across requests,
 *  so refusing every one already out there would break a page in flight for no gain: on format 1
 *  every alias IS 0, and on format 2 a `v1` cursor can only have come from a list with no foreign
 *  edge in it before this point. */
export const CURSOR_VERSION = "v2";

/** The prefix of a cursor that wraps another database's own continuation token. A token is opaque
 *  here: the responder minted it, drops rows its policy hides, and is the only party that knows
 *  where the list resumes. So it is carried rather than understood. */
export const TOKEN_VERSION = "t2";

export const encodeCursor = (time: number, db: number, id2: Id): string => `${CURSOR_VERSION}:${time}:${db}:${id2}`;

/** Wraps a foreign continuation as a cursor an application can hold and hand back. Base64url, so a
 *  token holding a colon does not read as a cursor's fields. */
export const encodeToken = (token: string): string =>
  `${TOKEN_VERSION}:${btoa(String.fromCharCode(...new TextEncoder().encode(token)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")}`;

/** Strict, because a cursor now arrives from an untrusted caller as well as from an answer this
 *  process minted: `Hop.after` is a continuation token a stranger may submit, and a malformed one
 *  that decoded to `NaN` would reach a SQL parameter rather than a refusal. */
export function decodeCursor(cursor: string): { time: number; db: number; id2: Id; token?: string } {
  const parts = cursor.split(":");
  if (parts[0] === TOKEN_VERSION) {
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]{1,4096}$/.test(parts[1]!)) {
      throw new TypeError(`not a continuation token: ${JSON.stringify(cursor)}`);
    }
    const padded = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return { time: 0, db: 0, id2: "0", token: new TextDecoder().decode(Uint8Array.from(raw, (c) => c.charCodeAt(0))) };
  }
  const legacy = parts[0] === "v1";
  if (!legacy && parts[0] !== CURSOR_VERSION) {
    throw new TypeError(`cursor version ${parts[0]}, expected ${CURSOR_VERSION}`);
  }
  if (parts.length !== (legacy ? 3 : 4)) throw new TypeError(`not a cursor: ${JSON.stringify(cursor)}`);
  const time = Number(parts[1]);
  if (!Number.isSafeInteger(time)) throw new TypeError(`not a cursor time: ${JSON.stringify(parts[1])}`);
  const db = legacy ? 0 : Number(parts[2]);
  if (!Number.isSafeInteger(db) || db < 0) throw new TypeError(`not a database alias: ${JSON.stringify(parts[2])}`);
  const id2 = parts[legacy ? 2 : 3]!;
  parseId(id2); // the 8-byte guard: a cursor's id2 is a local id, never a qualified reference
  return { time, db, id2 };
}

const clone = (n: Node): Node => ({ ...n, children: [...n.children], counts: [...n.counts] });

// ---- predicate combinators

/** A comparison against a field of the related object. */
export const objField = (field: string, cmp: CmpOp, value: Json): Pred => ({ cmp, on: "obj", field, value });

/** A comparison against a field stored on the edge. Only these can be indexed: an edge list lives on
 *  id1's host, while its targets may live anywhere. */
export const edgeField = (field: string, cmp: CmpOp, value: Json): Pred => ({ cmp, on: "edge", field, value });

export const and = (...preds: Pred[]): Pred => ({ and: preds });
export const or = (...preds: Pred[]): Pred => ({ or: preds });
export const not = (pred: Pred): Pred => ({ not: pred });

/** True when the related object has at least one match through this relation. Evaluated as a bounded
 *  count, so it stops at the first row rather than reading the list. */
export function exists<From extends FieldMap, R extends Relation<From, FieldMap>>(
  rel: R,
  build?: (q: Query<TargetOf<R>, RowOf<TargetOf<R>>>) => Query<TargetOf<R>, unknown>,
): Pred {
  const inner = build ? build(new Query<TargetOf<R>, RowOf<TargetOf<R>>>(leaf(rel))) : new Query(leaf(rel));
  return { existsOf: { ...inner.node, limit: 1 } };
}

function leaf<From extends FieldMap, To extends FieldMap>(rel: Relation<From, To>): Node {
  const source: Source = isFieldRel(rel) ? { kind: "field", field: rel.field } : { kind: "edge", atype: rel.atype };
  return { source, children: [], counts: [] };
}

// ---- the builder

export class Query<F extends FieldMap, Shape> {
  /** Read by exists() and by run(); not part of the public surface. */
  readonly node: Node;
  readonly #roots: Id[];

  constructor(node: Node, roots: Id[] = []) {
    this.node = node;
    this.#roots = roots;
  }

  /** Follows a relation, naming the result. The output name is chosen here, not where the edge is
   *  defined, so two products can traverse one edge under different names. */
  related<A extends string, R extends Relation<F, FieldMap>, CS = RowOf<TargetOf<R>>>(
    alias: A,
    rel: R,
    build?: (q: Query<TargetOf<R>, RowOf<TargetOf<R>>>) => Query<TargetOf<R>, CS>,
  ): Query<F, Shape & { [K in A]: IsSingle<R> extends true ? CS | null : CS[] }> {
    const start = new Query<TargetOf<R>, RowOf<TargetOf<R>>>(leaf(rel));
    const child = build ? build(start) : (start as unknown as Query<TargetOf<R>, CS>);
    const single = isFieldRel(rel) || rel.unique === true;
    const node = clone(this.node);
    node.children.push({ alias, single, paged: false, node: child.node });
    return new Query(node, this.#roots);
  }

  /** Follows a relation and returns a page: the rows, a cursor to continue from, and whether the list
   *  goes on. Every `related` carries a limit, so a list is always a page; this is how the caller
   *  reads the rest of one. */
  relatedPage<A extends string, R extends Relation<F, FieldMap>, CS = RowOf<TargetOf<R>>>(
    alias: A,
    rel: R,
    build?: (q: Query<TargetOf<R>, RowOf<TargetOf<R>>>) => Query<TargetOf<R>, CS>,
  ): Query<F, Shape & { [K in A]: Page<CS> }> {
    const start = new Query<TargetOf<R>, RowOf<TargetOf<R>>>(leaf(rel));
    const child = build ? build(start) : (start as unknown as Query<TargetOf<R>, CS>);
    const node = clone(this.node);
    node.children.push({ alias, single: false, paged: true, node: child.node });
    return new Query(node, this.#roots);
  }

  /** Resumes a related list after a cursor. */
  after(cursor: string): Query<F, Shape> {
    const node = clone(this.node);
    node.after = decodeCursor(cursor);
    return new Query(node, this.#roots);
  }

  /** The number of edges of a type, from the maintained counter rather than a COUNT(*). */
  countAs<A extends string>(alias: A, e: EdgeType<F, FieldMap, boolean>): Query<F, Shape & { [K in A]: number }> {
    const node = clone(this.node);
    node.counts.push({ alias, atype: e.atype });
    return new Query(node, this.#roots);
  }

  /** Keeps the related objects a predicate holds for. Rows come out in edge order, and a row is
   *  emitted only once every earlier row is decided. */
  where<K extends keyof F & string>(field: K, cmp: CmpOp, value: F[K]["value"] & Json): Query<F, Shape>;
  where(pred: Pred): Query<F, Shape>;
  where(a: string | Pred, cmp?: CmpOp, value?: Json): Query<F, Shape> {
    const pred: Pred = typeof a === "string" ? objField(a, cmp!, value!) : a;
    const node = clone(this.node);
    node.where = node.where === undefined ? pred : and(node.where, pred);
    return new Query(node, this.#roots);
  }

  /** How many related objects to read. Every `related` has one; this overrides the default. */
  limit(n: number): Query<F, Shape> {
    const node = clone(this.node);
    node.limit = n;
    return new Query(node, this.#roots);
  }

  /** Reads one object rather than a list, where the relation is to-one in practice but the edge type
   *  does not say so. */
  one(): Query<F, Shape> {
    return this.limit(1);
  }

  /** The plan this query compiles to, and the shape its results need before they are handed back. */
  compile(): { plan: Plan; root: Node } {
    const frames: Plan["frames"] = [];
    const emit = (n: Node): number => {
      const index = frames.length;
      frames.push({ source: n.source, limit: n.limit, after: n.after, children: [], counts: n.counts });
      // Children are emitted after this frame is reserved, so a cycle in the builder is impossible
      // and indices are stable.
      const children = n.children.map((c) => ({ alias: c.alias, frame: emit(c.node) }));
      const where = n.where === undefined ? undefined : resolve(n.where, emit);
      frames[index] = { ...frames[index], children, where };
      return index;
    };
    emit(this.node);
    return { plan: { frames }, root: this.node };
  }

  /** Runs the query. The database resolves hosts; this names none. */
  async run(db: Runner, opts?: RunOptions): Promise<Shape[]> {
    if (this.#roots.length === 0) throw new Error("a query needs a root: start it from Type.gen(id)");
    const { plan, root } = this.compile();
    const answer = await db.answer(plan, [...this.#roots], opts);
    return answer.rows.map((r) => reshape(r, root, answer.graph)) as Shape[];
  }

  /** The ids this query starts from. */
  get roots(): readonly Id[] {
    return this.#roots;
  }
}

export interface RunOptions {
  driver?: "async" | "rounds";
  /** Filled in with what the read cost: rounds, and requests to hosts. The runner has always
   *  reported it; a query built through the builder had no way to ask. */
  stats?: Stats;
}

/** What a query needs from a database: the answer, and the graph it was read from. The graph is where
 *  a cursor comes from, since only it knows whether an edge list was exhausted. */
export interface Runner {
  answer(plan: Plan, rootIds: Id[], opts?: RunOptions): Promise<{ rows: Json[]; graph: ListSource }>;
}

/** The part of the gathered graph a cursor needs. `db` rides along because it is part of the sort
 *  key on storage format 2, so a cursor minted without it lands in the wrong place at a tie. */
export interface ListSource {
  lists: ReadonlyMap<string, { rows: { time: number; db: number; id2: Id }[]; complete: boolean }>;
}

function resolve(pred: Pred, emit: (n: Node) => number): Cond {
  if ("and" in pred) return { and: pred.and.map((p) => resolve(p, emit)) };
  if ("or" in pred) return { or: pred.or.map((p) => resolve(p, emit)) };
  if ("not" in pred) return { not: resolve(pred.not, emit) };
  if ("existsOf" in pred) return { exists: emit(pred.existsOf) };
  return pred;
}

/** The last step: a to-one relation becomes the object itself, and a paged one becomes its items plus
 *  a cursor. Operators always yield lists, so both shapes are made here. */
function reshape(row: Json, node: Node, graph: ListSource): Json {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
  const out: Record<string, Json> = { ...(row as Record<string, Json>) };
  for (const c of node.children) {
    const got = out[c.alias];
    const list = Array.isArray(got) ? got.map((r) => reshape(r, c.node, graph)) : [];
    if (c.single) {
      out[c.alias] = list.length > 0 ? list[0] : null;
      continue;
    }
    if (!c.paged) {
      out[c.alias] = list;
      continue;
    }
    out[c.alias] = { items: list, ...edgeOf(out.id as Id, c.node, list, graph) } as unknown as Json;
  }
  return out;
}

/** A page's cursor and whether the list goes on. Only the graph knows: the rows handed back are the
 *  ones that passed a filter and fit a limit, which says nothing about what is left. */
function edgeOf(
  parent: Id,
  node: Node,
  items: Json[],
  graph: ListSource,
): { cursor: string | null; more: boolean } {
  if (node.source.kind !== "edge") return { cursor: null, more: false };
  const list = graph.lists.get(`${parent}:${node.source.atype}`);
  if (list === undefined) return { cursor: null, more: false };
  // From the graph's own row rather than from the row handed back, because a cursor carries the
  // target's database alias and that is storage order, not something an application holds. It is
  // also what `normalize.ts` does, and the two have to mint the same cursor for the same page.
  const row = list.rows[Math.min(items.length, list.rows.length) - 1];
  const cursor = row ? encodeCursor(row.time, row.db, row.id2) : null;
  // More when the list held rows beyond the ones returned, or was never read to its end.
  const more = items.length < list.rows.length || !list.complete;
  return { cursor, more };
}

/** Starts a query from ids the caller already holds. Every query starts from an object and follows
 *  edges: with no single collection per type, there is nothing else to start from. */
export function gen<F extends FieldMap>(type: ObjectType<F>, ...ids: Id[]): Query<F, RowOf<F>> {
  if (ids.length === 0) throw new Error(`${type.name}.gen needs at least one id`);
  return new Query<F, RowOf<F>>({ source: { kind: "ids" }, children: [], counts: [] }, ids);
}

export { DEFAULT_LIMIT };
