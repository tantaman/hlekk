// The fluent query builder. A query is the builder's value: there is nothing to declare up front, and
// reuse is an ordinary function over a query.
//
// It compiles to a Plan, which is what hosts and the coordinator run. Each `related` level becomes one
// frame, addressed by index, so a frontier task can carry its frame and a host can cache the plan.

import { DEFAULT_LIMIT } from "../query/ops.ts";
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
  children: { alias: string; single: boolean; node: Node }[];
  counts: { alias: string; atype: number }[];
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
    node.children.push({ alias, single, node: child.node });
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
      frames.push({ source: n.source, limit: n.limit, children: [], counts: n.counts });
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
    const rows = await db.query(plan, this.#roots, opts);
    return rows.map((r) => reshape(r, root)) as Shape[];
  }

  /** The ids this query starts from. */
  get roots(): readonly Id[] {
    return this.#roots;
  }
}

export interface RunOptions {
  driver?: "async" | "rounds";
}

/** What a query needs from a database. The client satisfies it. */
export interface Runner {
  query(plan: Plan, rootIds: Id[], opts?: RunOptions): Promise<Json[]>;
}

function resolve(pred: Pred, emit: (n: Node) => number): Cond {
  if ("and" in pred) return { and: pred.and.map((p) => resolve(p, emit)) };
  if ("or" in pred) return { or: pred.or.map((p) => resolve(p, emit)) };
  if ("not" in pred) return { not: resolve(pred.not, emit) };
  if ("existsOf" in pred) return { exists: emit(pred.existsOf) };
  return pred;
}

/** Turns a to-one relation's one-element list into the object itself, which is what the caller asked
 *  for by declaring the edge unique. Operators always yield lists, so this is the last step. */
function reshape(row: Json, node: Node): Json {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
  const out: Record<string, Json> = { ...(row as Record<string, Json>) };
  for (const c of node.children) {
    const got = out[c.alias];
    const list = Array.isArray(got) ? got.map((r) => reshape(r, c.node)) : [];
    out[c.alias] = c.single ? (list.length > 0 ? list[0] : null) : list;
  }
  return out;
}

/** Starts a query from ids the caller already holds. Every query starts from an object and follows
 *  edges: with no single collection per type, there is nothing else to start from. */
export function gen<F extends FieldMap>(type: ObjectType<F>, ...ids: Id[]): Query<F, RowOf<F>> {
  if (ids.length === 0) throw new Error(`${type.name}.gen needs at least one id`);
  return new Query<F, RowOf<F>>({ source: { kind: "ids" }, children: [], counts: [] }, ids);
}

export { DEFAULT_LIMIT };
