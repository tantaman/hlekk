// A bounded request an untrusted caller may submit, and the static guard that decides whether it may
// run at all.
//
// Lifted out of `worker/wiki-query.ts`, which built this because the wiki demo exposes a query box to
// the public internet. A database reached over the cross-database protocol has the same exposure for
// the same reason: the caller is another database rather than a trusted server, so principle 10 does
// not reach it. The guard therefore belongs beside the engine, not inside one application.
//
// Three properties, in the order they matter.
//
// 1. **A request is a tree, not a `Plan`.** A hop holds its children, so there is no frame index for
//    a caller to get wrong and no way to name an ancestor and build a cycle. Both are reachable in a
//    `Plan` a caller writes, and this removes them rather than guarding them — which is why the
//    protocol boundary takes this shape and not the internal one.
//
// 2. **Its cost is computable from its text, before any I/O.** A chain of hops materializes the
//    product of its limits, so the answer is exponential in depth while storage reads stay flat: a
//    budget on reads, requests or rounds never fires. The guard counts ANSWER nodes, which is
//    arithmetic over the tree. A request whose cost is only discovered by running it hands an
//    unauthenticated stranger a work amplifier.
//
// 3. **A refusal names where.** `at` is a path into the request, so a caller can correct the part
//    that was wrong instead of retrying blind, and an editor can put a caret on it.
//
// What this does NOT bound, and nothing here can: a selective filter walks its whole edge list, so a
// `where` over an object with a million edges reads the million. `maxLimit` is not a bound on that;
// the per-query scan cap design.md still owes is.

import type { FieldSpec } from "../catalog/catalog.ts";
import type { CmpOp, Json } from "./types.ts";

export const OPS: readonly CmpOp[] = ["=", "!=", "<", "<=", ">", ">="];

/** The limit a hop takes when it names none. Every hop has one: a list is always a page. */
export const DEFAULT_HOP_LIMIT = 25;

/**
 * The budget. Numbers, not taste — the mechanism is cheap and the figures are a judgement about what
 * a stranger may spend, so they are stated in one place and can be served to a caller, which is what
 * makes the budget comprehensible rather than a surprise on submit.
 */
export interface Limits {
  /** Hop nesting. Depth 10 at limit 3 was already 177,145 nodes in the probe. */
  maxDepth: number;
  /** Rows one hop may read. Not a bound on what a filter scans underneath it. */
  maxLimit: number;
  /** Frames, counting `exists` subqueries. A plan is compiled once and cached per host. */
  maxFrames: number;
  /** Answer nodes the request may materialize, summed over every node of the tree. The probe reached
   *  1,594,321 nodes at depth 12 and took 16.5 s; 20,000 is a page of results, not a heap. */
  maxNodes: number;
  /** Counts per hop, each a maintained counter read rather than a scan. */
  maxCounts: number;
  /** Filters per hop. */
  maxWhere: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxDepth: 4,
  maxLimit: 100,
  maxFrames: 16,
  maxNodes: 20_000,
  maxCounts: 4,
  maxWhere: 4,
};

// ---- what a caller may submit

export interface Cmp {
  field: string;
  op: CmpOp;
  value: Json;
}

/** A count to read from the maintained counter. A bare string is the edge name; the object form names
 *  the alias the result carries it under. */
export type CountSpec = string | { as: string; edge: string };

export const countEdge = (c: CountSpec): string => (typeof c === "string" ? c : c.edge);

export interface Hop {
  /** The name this hop's result appears under. */
  as?: string;
  /** An edge type name from the vocabulary. */
  edge: string;
  limit?: number;
  where?: Cmp[];
  /** Counts to read here, from the maintained counter. */
  counts?: CountSpec[];
  hops?: Hop[];
}

/** The part of a request that is the same wherever it entered from. A caller adds its own entry — a
 *  unique-index lookup, a list of ids — and validates that itself, because what identifies a root is
 *  the one thing a schema does not have in common with another. */
export interface Request {
  counts?: CountSpec[];
  hops?: Hop[];
}

export class Refused extends Error {
  /** Where in the submitted request the problem is, as a path, so a caller can point at it. */
  readonly at: string;
  /** For a request submitted as text, the character offset to put the caret at. */
  readonly offset?: number;
  constructor(at: string, message: string, offset?: number) {
    super(`${at}: ${message}`);
    this.name = "Refused";
    this.at = at;
    this.offset = offset;
  }
}

/**
 * What names a request may use: which edges it may traverse, and what fields the objects it lands on
 * declare. Supplied by the caller rather than read from the catalog here, because what a database
 * *exposes* is narrower than what it holds — a projection, in catalog terms — and that is a policy
 * decision rather than a schema fact.
 */
export interface Vocabulary {
  /** The object type an edge lands on, or undefined when the edge is not exposed. */
  edge(name: string): { to: string } | undefined;
  /** Every exposed edge name, so a refusal can say what was available instead. */
  edges(): readonly string[];
  /** The fields of an object type, so a filter's value is checked against what it declares. */
  fields(objectType: string): Record<string, FieldSpec> | undefined;
}

export interface Cost {
  frames: number;
  /** The upper bound on answer nodes, which is what the budget is spent on. */
  nodes: number;
}

/** How a field spec reads to a person, and what a value for it has to be. */
export function describe(spec: FieldSpec): { type: string; optional: boolean } {
  if (typeof spec === "object" && "optional" in spec) return { ...describe(spec.optional), optional: true };
  if (typeof spec === "object" && "enum" in spec) return { type: `enum(${spec.enum.join("|")})`, optional: false };
  if (typeof spec === "object" && "id" in spec) return { type: `id(${spec.id})`, optional: false };
  return { type: spec, optional: false };
}

function checkValue(at: string, field: string, value: Json, objectType: string, vocab: Vocabulary): void {
  const fields = vocab.fields(objectType);
  if (fields === undefined) throw new Refused(at, `no object type "${objectType}" is exposed`);
  const spec = fields[field];
  if (spec === undefined) {
    throw new Refused(at, `no field "${field}" on ${objectType}; it has ${Object.keys(fields).join(", ")}`);
  }
  const { type } = describe(spec);
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  // An unknown field or a mistyped value matches nothing rather than failing, and a silently empty
  // answer is harder to understand than a refusal.
  const want = type.startsWith("enum") ? "string" : type.startsWith("id(") ? "string" : type;
  if (want !== "json" && actual !== want) {
    throw new Refused(at, `field "${field}" is ${type}, but the value is ${actual}`);
  }
}

interface Counted {
  /** Frames this subtree compiles to. */
  frames: number;
  /** Answer nodes it can materialize, given its ancestors' limits. */
  nodes: number;
}

/** Validates one hop and everything under it, and counts what it would cost. */
function checkHop(hop: Hop, at: string, depth: number, reaching: number, vocab: Vocabulary, limits: Limits): Counted {
  if (depth > limits.maxDepth) {
    throw new Refused(at, `hops nest ${depth} deep, the maximum is ${limits.maxDepth}`);
  }
  const edge = typeof hop.edge === "string" ? vocab.edge(hop.edge) : undefined;
  if (edge === undefined) {
    throw new Refused(at, `no edge "${String(hop.edge)}"; the schema has ${vocab.edges().join(", ")}`);
  }
  const limit = hop.limit ?? DEFAULT_HOP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > limits.maxLimit) {
    throw new Refused(at, `limit must be an integer in 1..${limits.maxLimit}, got ${String(hop.limit)}`);
  }
  for (const [i, c] of (hop.where ?? []).entries()) {
    if (!OPS.includes(c.op)) throw new Refused(`${at}.where[${i}]`, `operator must be one of ${OPS.join(" ")}`);
    checkValue(`${at}.where[${i}]`, c.field, c.value, edge.to, vocab);
  }
  if ((hop.where ?? []).length > limits.maxWhere) {
    throw new Refused(at, `${hop.where!.length} filters, the maximum is ${limits.maxWhere}`);
  }
  for (const [i, c] of (hop.counts ?? []).entries()) {
    if (vocab.edge(countEdge(c)) === undefined) {
      throw new Refused(`${at}.counts[${i}]`, `no edge "${countEdge(c)}"`);
    }
  }
  if ((hop.counts ?? []).length > limits.maxCounts) {
    throw new Refused(at, `${hop.counts!.length} counts, the maximum is ${limits.maxCounts}`);
  }

  // The rows this hop can produce is its limit times however many rows reached it — which is the
  // product of the limits above it, and the thing no read budget can see.
  const produced = reaching * limit;
  let frames = 1;
  let nodes = produced;
  for (const [i, child] of (hop.hops ?? []).entries()) {
    const under = checkHop(child, `${at}.hops[${i}]`, depth + 1, produced, vocab, limits);
    frames += under.frames;
    nodes += under.nodes;
  }
  return { frames, nodes };
}

/**
 * Refuses a request that must not run, and reports what a permitted one will cost.
 *
 * Separate from compiling, so a caller can be told the price of a request before it is sent and an
 * editor can price one as it is typed. The entry is NOT checked here — see `Request`.
 */
export function check(req: Request, vocab: Vocabulary, limits: Limits = DEFAULT_LIMITS): Cost {
  if (!req || typeof req !== "object") throw new Refused("query", "expected an object");
  for (const [i, c] of (req.counts ?? []).entries()) {
    if (vocab.edge(countEdge(c)) === undefined) throw new Refused(`counts[${i}]`, `no edge "${countEdge(c)}"`);
  }
  if ((req.counts ?? []).length > limits.maxCounts) {
    throw new Refused("counts", `${req.counts!.length} counts, the maximum is ${limits.maxCounts}`);
  }

  let frames = 1;
  let nodes = 1; // the root object
  for (const [i, hop] of (req.hops ?? []).entries()) {
    const under = checkHop(hop, `hops[${i}]`, 1, 1, vocab, limits);
    frames += under.frames;
    nodes += under.nodes;
  }
  if (frames > limits.maxFrames) {
    throw new Refused("query", `compiles to ${frames} frames, the maximum is ${limits.maxFrames}`);
  }
  if (nodes > limits.maxNodes) {
    throw new Refused(
      "query",
      `could materialize ${nodes.toLocaleString()} answer nodes, the maximum is ${limits.maxNodes.toLocaleString()}. ` +
        `This is the product of the limits down each path, and no amount of storage reading would reveal it — ` +
        `lower a limit or remove a hop.`,
    );
  }
  return { frames, nodes };
}
