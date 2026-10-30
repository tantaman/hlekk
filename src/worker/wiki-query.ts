// The query editor's safe surface: what the schema is, what a submitted query may say, and the
// static guard that decides whether it may run at all.
//
// WHY THIS EXISTS. docs/wikimedia-demo.md draws a line: "A fixed page view and a box a stranger
// types a query into are not the same exposure, and the engine is ready for the first but not the
// second." It then names three holes, all reachable from a plan a user can type:
//
//   1. The answer is exponential in depth and no read budget sees it. A chain of `related` levels
//      materializes the product of its limits, so depth 14 at limit 3 exhausts the heap -- while
//      storage reads stay flat at 58 objects and 32 requests across depths 10, 12 and 14. A budget
//      on reads, requests, rounds or objects never fires. The guard has to count *answer* nodes.
//   2. A cycle through two edge frames recurses until the heap is gone.
//   3. A child frame index naming a frame that does not exist is an unvalidated read of
//      `plan.frames[i]`, and surfaces as a raw TypeError.
//
// Two of those three stop being representable here, which is the reason this takes a nested
// description rather than a `Plan`. A submitted query is a tree: a hop holds its children, so there
// is no frame index for a user to get wrong (3), and no way to name an ancestor and make a cycle
// (2). `Query.compile()` reserves a frame before emitting its children, so the builder cannot
// produce a cycle either. That answers the demo doc's open question -- whether the editor accepts a
// Plan directly or only a builder-produced query -- in the direction that removes the holes instead
// of guarding them.
//
// What is left is (1), which is arithmetic and is checked before any I/O: multiply the limits down
// each root-to-leaf path, sum what every node along the way materializes, and refuse the query if
// the total exceeds a budget. Plus the ordinary checks that every name exists and every value has
// the type its field declares -- an unknown field is refused rather than matching nothing, because
// in an editor a silently empty answer is a worse bug than an error message.
//
// What this does NOT fix, and nothing here can: a selective filter walks its whole edge list, so
// `where` over a page with a million backlinks reads the million. design.md's "A scan cap per
// query, returning a cursor, is not built yet" is still true, and `maxLimit` is not a bound on it.

import type { Cond, Json, Plan } from "../query/types.ts";
import type { CmpOp } from "../query/types.ts";
import type { FieldSpec } from "../catalog/catalog.ts";
import { Query } from "../schema/query.ts";
import { LOCK, Page, categoryPages, linkedFrom, pageCategories, pageLinks } from "./wiki.ts";
import type { EdgeType, FieldMap } from "../schema/define.ts";

/** Every relation the editor may traverse, by the name the schema gives it. Taken from the typed
 *  values rather than re-listed, so the editor cannot offer an edge the catalog does not have. */
const EDGES: Record<string, EdgeType<FieldMap, FieldMap, boolean>> = {
  [pageLinks.name]: pageLinks as unknown as EdgeType<FieldMap, FieldMap, boolean>,
  [linkedFrom.name]: linkedFrom as unknown as EdgeType<FieldMap, FieldMap, boolean>,
  [pageCategories.name]: pageCategories as unknown as EdgeType<FieldMap, FieldMap, boolean>,
  [categoryPages.name]: categoryPages as unknown as EdgeType<FieldMap, FieldMap, boolean>,
};

export const OPS: readonly CmpOp[] = ["=", "!=", "<", "<=", ">", ">="];

/**
 * The budget. Numbers, not taste — the demo doc says the mechanism is cheap and the figures are a
 * judgement about what a stranger may spend, so they are stated in one place and served to the
 * client, which shows the cost of a query before it is run.
 */
export const LIMITS = {
  /** Hop nesting. Depth 10 at limit 3 was already 177,145 nodes in the probe. */
  maxDepth: 4,
  /** Rows one hop may read. Not a bound on what a filter scans underneath it. */
  maxLimit: 100,
  /** Frames, counting `exists` subqueries. A plan is compiled once and cached per host. */
  maxFrames: 16,
  /** Answer nodes the query may materialize, summed over every node of the tree. The probe reached
   *  1,594,321 nodes at depth 12 and took 16.5 s; 20,000 is a page of results, not a heap. */
  maxNodes: 20_000,
  /** Counts per hop, each a maintained counter read rather than a scan. */
  maxCounts: 4,
  /** Filters per hop. */
  maxWhere: 4,
} as const;

// ---- what a client may submit

export interface Cmp {
  field: string;
  op: CmpOp;
  value: Json;
}

export interface Hop {
  /** The name this hop's result appears under. */
  as?: string;
  /** An edge type name from the schema. */
  edge: string;
  limit?: number;
  where?: Cmp[];
  /** Edge names to count, from the maintained counter. */
  counts?: string[];
  hops?: Hop[];
}

export interface QuerySpec {
  /** Where the query enters: a title, which is the only entry the database has. */
  from: { ns: number; title: string };
  counts?: string[];
  hops?: Hop[];
}

export class QueryRefused extends Error {
  /** Where in the submitted query the problem is, so an editor can point at it. */
  readonly at: string;
  constructor(at: string, message: string) {
    super(`${at}: ${message}`);
    this.name = "QueryRefused";
    this.at = at;
  }
}

// ---- the schema, as the editor's autocomplete sees it

export interface SchemaView {
  objects: { name: string; otype: number; fields: { name: string; type: string; optional: boolean }[] }[];
  edges: { name: string; atype: number; from: string; to: string }[];
  entry: { by: string; namespaces: { value: number; label: string }[] };
  limits: typeof LIMITS & { ops: readonly CmpOp[] };
}

/** How a field spec reads to a person, and what a value for it has to be. */
function describe(spec: FieldSpec): { type: string; optional: boolean } {
  if (typeof spec === "object" && "optional" in spec) return { ...describe(spec.optional), optional: true };
  if (typeof spec === "object" && "enum" in spec) return { type: `enum(${spec.enum.join("|")})`, optional: false };
  if (typeof spec === "object" && "id" in spec) return { type: `id(${spec.id})`, optional: false };
  return { type: spec, optional: false };
}

/** The namespaces worth offering. MediaWiki has many; these are the ones this import holds enough of
 *  to be worth a menu entry, and the editor accepts any integer anyway. */
const NAMESPACES = [
  { value: 0, label: "Article" },
  { value: 14, label: "Category" },
  { value: 4, label: "Project" },
  { value: 10, label: "Template" },
  { value: 12, label: "Help" },
];

export function schemaView(): SchemaView {
  return {
    objects: Object.entries(LOCK.objects).map(([name, o]) => ({
      name,
      otype: o.otype,
      fields: Object.entries(o.fields).map(([f, spec]) => ({ name: f, ...describe(spec) })),
    })),
    edges: Object.entries(EDGES).map(([name, e]) => ({
      name,
      atype: e.atype,
      from: e.from.name,
      to: e.to.name,
    })),
    entry: { by: "(ns, title) — a unique index. There is no scan and no prefix search.", namespaces: NAMESPACES },
    limits: { ...LIMITS, ops: OPS },
  };
}

// ---- the guard

/** The fields of the one object type every relation here points at. */
const pageFields = LOCK.objects["wiki.page"].fields;

function checkValue(at: string, field: string, value: Json): void {
  const spec = pageFields[field];
  if (spec === undefined) {
    throw new QueryRefused(at, `no field "${field}" on wiki.page; it has ${Object.keys(pageFields).join(", ")}`);
  }
  const { type } = describe(spec);
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  // An unknown field or a mistyped value matches nothing rather than failing, and in an editor a
  // silently empty answer is harder to understand than a refusal.
  const want = type.startsWith("enum") ? "string" : type.startsWith("id(") ? "string" : type;
  if (want !== "json" && actual !== want) {
    throw new QueryRefused(at, `field "${field}" is ${type}, but the value is ${actual}`);
  }
}

interface Counted {
  /** Frames this subtree compiles to. */
  frames: number;
  /** Answer nodes it can materialize, given its ancestors' limits. */
  nodes: number;
}

/** Validates one hop and everything under it, and counts what it would cost. */
function checkHop(hop: Hop, at: string, depth: number, reaching: number): Counted {
  if (depth > LIMITS.maxDepth) {
    throw new QueryRefused(at, `hops nest ${depth} deep, the maximum is ${LIMITS.maxDepth}`);
  }
  if (typeof hop.edge !== "string" || EDGES[hop.edge] === undefined) {
    throw new QueryRefused(at, `no edge "${String(hop.edge)}"; the schema has ${Object.keys(EDGES).join(", ")}`);
  }
  const limit = hop.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMITS.maxLimit) {
    throw new QueryRefused(at, `limit must be an integer in 1..${LIMITS.maxLimit}, got ${String(hop.limit)}`);
  }
  for (const [i, c] of (hop.where ?? []).entries()) {
    if (!OPS.includes(c.op)) throw new QueryRefused(`${at}.where[${i}]`, `operator must be one of ${OPS.join(" ")}`);
    checkValue(`${at}.where[${i}]`, c.field, c.value);
  }
  if ((hop.where ?? []).length > LIMITS.maxWhere) {
    throw new QueryRefused(at, `${hop.where!.length} filters, the maximum is ${LIMITS.maxWhere}`);
  }
  for (const [i, name] of (hop.counts ?? []).entries()) {
    if (EDGES[name] === undefined) throw new QueryRefused(`${at}.counts[${i}]`, `no edge "${name}"`);
  }
  if ((hop.counts ?? []).length > LIMITS.maxCounts) {
    throw new QueryRefused(at, `${hop.counts!.length} counts, the maximum is ${LIMITS.maxCounts}`);
  }

  // The rows this hop can produce is its limit times however many rows reached it — which is the
  // product of the limits above it, and the thing no read budget can see.
  const produced = reaching * limit;
  let frames = 1;
  let nodes = produced;
  for (const [i, child] of (hop.hops ?? []).entries()) {
    const under = checkHop(child, `${at}.hops[${i}]`, depth + 1, produced);
    frames += under.frames;
    nodes += under.nodes;
  }
  return { frames, nodes };
}

export interface Cost {
  frames: number;
  /** The upper bound on answer nodes, which is what the budget is spent on. */
  nodes: number;
}

/**
 * Refuses a query that must not run, and reports what a permitted one will cost.
 *
 * Separate from compiling so an editor can price a query as it is typed, which is what makes the
 * budget comprehensible rather than a surprise on submit.
 */
export function check(spec: QuerySpec): Cost {
  if (!spec || typeof spec !== "object") throw new QueryRefused("query", "expected an object");
  const from = spec.from;
  if (!from || typeof from.title !== "string" || from.title.length === 0) {
    throw new QueryRefused("from", "a title is required; entry is by (ns, title)");
  }
  if (from.title.length > 512) throw new QueryRefused("from.title", "longer than 512 characters");
  if (!Number.isInteger(from.ns) || from.ns < 0 || from.ns > 5000) {
    throw new QueryRefused("from.ns", `namespace must be an integer in 0..5000, got ${String(from.ns)}`);
  }
  for (const [i, name] of (spec.counts ?? []).entries()) {
    if (EDGES[name] === undefined) throw new QueryRefused(`counts[${i}]`, `no edge "${name}"`);
  }
  if ((spec.counts ?? []).length > LIMITS.maxCounts) {
    throw new QueryRefused("counts", `${spec.counts!.length} counts, the maximum is ${LIMITS.maxCounts}`);
  }

  let frames = 1;
  let nodes = 1; // the root object
  for (const [i, hop] of (spec.hops ?? []).entries()) {
    const under = checkHop(hop, `hops[${i}]`, 1, 1);
    frames += under.frames;
    nodes += under.nodes;
  }
  if (frames > LIMITS.maxFrames) {
    throw new QueryRefused("query", `compiles to ${frames} frames, the maximum is ${LIMITS.maxFrames}`);
  }
  if (nodes > LIMITS.maxNodes) {
    throw new QueryRefused(
      "query",
      `could materialize ${nodes.toLocaleString()} answer nodes, the maximum is ${LIMITS.maxNodes.toLocaleString()}. ` +
        `This is the product of the limits down each path, and no amount of storage reading would reveal it — ` +
        `lower a limit or remove a hop.`,
    );
  }
  return { frames, nodes };
}

/** Prices a query without refusing it, for an editor that wants to show the cost of something that
 *  is over budget rather than only of something under it. */
export function price(spec: QuerySpec): Cost | { error: string; at: string } {
  try {
    return check(spec);
  } catch (e) {
    if (e instanceof QueryRefused) return { error: e.message, at: e.at };
    throw e;
  }
}

// ---- compiling a checked query

/** Builds the typed query a checked spec describes. Call `check` first; this assumes it passed. */
export function build(spec: QuerySpec, rootId: string): Query<FieldMap, unknown> {
  let q = Page.gen(rootId) as unknown as Query<FieldMap, unknown>;
  for (const name of spec.counts ?? []) q = q.countAs(name.replace(/^wiki\./, ""), EDGES[name]!);
  for (const hop of spec.hops ?? []) q = addHop(q, hop);
  return q;
}

function addHop(q: Query<FieldMap, unknown>, hop: Hop): Query<FieldMap, unknown> {
  const edge = EDGES[hop.edge]!;
  const alias = hop.as && hop.as.length > 0 ? hop.as : hop.edge.replace(/^wiki\./, "");
  return q.related(alias, edge, (child) => {
    let c = child.limit(hop.limit ?? 25) as unknown as Query<FieldMap, unknown>;
    for (const w of hop.where ?? []) c = c.where(w.field, w.op, w.value as never);
    for (const name of hop.counts ?? []) c = c.countAs(name.replace(/^wiki\./, ""), EDGES[name]!);
    for (const inner of hop.hops ?? []) c = addHop(c, inner);
    return c as never;
  }) as unknown as Query<FieldMap, unknown>;
}

/** The compiled plan, for showing an author what their query became. */
export function planOf(spec: QuerySpec, rootId: string): Plan {
  return build(spec, rootId).compile().plan;
}

export type { Cond };
