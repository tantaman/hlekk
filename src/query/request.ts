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
import { decodeCursor } from "../schema/query.ts";
import { isReservedKey } from "./types.ts";
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
  /** Where to continue the list from: a cursor an earlier answer handed back. Without this a served
   *  list is a first page and nothing else, since the caller holds no plan to put a cursor into —
   *  which is why a protocol that pages is a protocol that carries this one field. */
  after?: string;
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
  /**
   * Where an edge starts and lands, or undefined when the edge is not exposed.
   *
   * `counted` is false for a field relationship, which follows an id in a payload and stores
   * nothing — so it can be traversed but has no maintained counter to read. Absent means countable.
   *
   * `from` is here so that a hop can be checked against where its parent lands. Without it the
   * guard can tell that an edge exists and not that it starts anywhere near the rows it is hung
   * under, and a nonsensical traversal comes back as an empty list — which a caller cannot tell from
   * a true one. That matters most to a caller building its tree from the vocabulary rather than from
   * a schema it holds, which is what an agent discovering a database does.
   */
  edge(name: string): { from: string; to: string; counted?: boolean } | undefined;
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

/**
 * Refuses a member this protocol does not define.
 *
 * Ignoring one is the other choice, and it is the wrong one here. A caller that writes `limitt` gets
 * a silent default and an answer it cannot tell from the one it asked for — which is the situation
 * the whole `at` path exists to avoid. The cost is that a new optional field needs a version rather
 * than arriving unannounced, and a protocol whose bodies already carry a version can afford that.
 */
function onlyKnown(value: object, known: readonly string[], at: string): void {
  for (const name of Object.keys(value)) {
    if (!known.includes(name)) {
      throw new Refused(at, `no such member "${name}"; this one takes ${known.join(", ")}`);
    }
  }
}

/** How a caller turns a hop and a count into the names its answer carries. Supplied rather than
 *  assumed, because a caller that enters from somewhere else may derive them differently — the wiki
 *  demo strips its own namespace prefix — and the collision rule has to be checked against the names
 *  that will actually be used. */
export interface Aliasing {
  hop(hop: Hop): string;
  count(count: CountSpec): string;
}

/** What the protocol itself does: a hop's `as` or its edge name, and a count's `as` or the bare
 *  string it was written as. */
export const PROTOCOL_ALIASING: Aliasing = {
  hop: (hop) => (hop.as !== undefined && hop.as.length > 0 ? hop.as : hop.edge),
  count: (count) => (typeof count === "string" ? count : count.as),
};

/**
 * Refuses a name the answer would lose, and names what lost it.
 *
 * A result is `{...payload, id, $version, $edge, ...relationships, ...counts}` in that order, so two
 * of a caller's own names colliding means one of them silently wins — and what comes back is an
 * answer the caller cannot tell from a true one. Three ways that happened:
 *
 * - **A count and a hop over the same edge.** Both default their name to the edge's, and naming them
 *   that way is the obvious thing for a caller working from the vocabulary to do. The count was
 *   written last, so the list came back empty beside a count that said it was not — which is exactly
 *   the shape that makes it look right.
 * - **Two hops under one name.** Both were read and one was thrown away.
 * - **A name a row already carries.** `id` does not shadow a field: the normalized form reads
 *   `row.id` to key every object, list and count, so a relationship called `id` takes the structure
 *   of the whole answer with it.
 *
 * Separate from `check` because it depends on the aliasing, which `check` does not own.
 */
export function checkAliases(req: Request, aliasing: Aliasing = PROTOCOL_ALIASING): void {
  const level = (node: { counts?: CountSpec[]; hops?: Hop[] }, at: string): void => {
    const taken = new Map<string, string>();
    const take = (name: string, where: string, what: string): void => {
      if (typeof name !== "string" || name.length === 0) return; // reported by `check`
      if (isReservedKey(name)) {
        throw new Refused(where, `"${name}" is a name a row already carries, so ${what} cannot use it`);
      }
      const held = taken.get(name);
      if (held !== undefined) throw new Refused(where, `"${name}" is already ${held}, and one answer cannot be both`);
      taken.set(name, what);
    };
    for (const [i, hop] of (node.hops ?? []).entries()) {
      if (hop === null || typeof hop !== "object" || typeof hop.edge !== "string") continue;
      take(aliasing.hop(hop), `${at}hops[${i}]`, `the "${hop.edge}" hop`);
    }
    for (const [i, c] of (node.counts ?? []).entries()) {
      if (typeof c !== "string" && (c === null || typeof c !== "object")) continue;
      take(aliasing.count(c), `${at}counts[${i}]`, `the "${countEdge(c)}" count`);
    }
    for (const [i, hop] of (node.hops ?? []).entries()) {
      if (hop !== null && typeof hop === "object") level(hop, `${at}hops[${i}].`);
    }
  };
  level(req, "");
}

const HOP_MEMBERS = ["as", "edge", "limit", "after", "where", "counts", "hops"] as const;
const CMP_MEMBERS = ["field", "op", "value"] as const;
const COUNT_MEMBERS = ["as", "edge"] as const;

/** Every member a read request itself may carry, for a caller that validates the entry too. */
export const REQUEST_MEMBERS = ["ids", "counts", "hops"] as const;

function checkCount(c: CountSpec, at: string, vocab: Vocabulary): void {
  if (typeof c === "object" && c !== null) onlyKnown(c, COUNT_MEMBERS, at);
  const edge = vocab.edge(countEdge(c));
  if (edge === undefined) throw new Refused(at, `no edge "${countEdge(c)}"`);
  if (edge.counted === false) {
    throw new Refused(at, `edge "${countEdge(c)}" has no count: it follows an id in a payload and stores nothing`);
  }
}

interface Counted {
  /** Frames this subtree compiles to. */
  frames: number;
  /** Answer nodes it can materialize, given its ancestors' limits. */
  nodes: number;
}

/** Validates one hop and everything under it, and counts what it would cost. */
function checkHop(
  hop: Hop,
  at: string,
  depth: number,
  reaching: number,
  vocab: Vocabulary,
  limits: Limits,
  /** The type the rows this hop is hung under are, where it is known. */
  parent: string | undefined,
): Counted {
  if (hop === null || typeof hop !== "object") throw new Refused(at, "expected an object");
  onlyKnown(hop, HOP_MEMBERS, at);
  if (depth > limits.maxDepth) {
    throw new Refused(at, `hops nest ${depth} deep, the maximum is ${limits.maxDepth}`);
  }
  const edge = typeof hop.edge === "string" ? vocab.edge(hop.edge) : undefined;
  if (edge === undefined) {
    throw new Refused(at, `no edge "${String(hop.edge)}"; the schema has ${vocab.edges().join(", ")}`);
  }
  // A hop has to start where its parent lands. It can only ever return nothing otherwise, and
  // "nothing" is an answer a caller cannot tell from a true empty list — which is the one thing a
  // caller building its tree from the vocabulary must be able to rely on.
  if (parent !== undefined && edge.from !== parent) {
    const available = vocab.edges().filter((name) => vocab.edge(name)?.from === parent);
    throw new Refused(
      at,
      `"${hop.edge}" starts at ${edge.from}, and this hop is under ${parent}.` +
        ` From ${parent} the schema has ${available.length === 0 ? "no edges" : available.join(", ")}`,
    );
  }
  const limit = hop.limit ?? DEFAULT_HOP_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > limits.maxLimit) {
    throw new Refused(at, `limit must be an integer in 1..${limits.maxLimit}, got ${String(hop.limit)}`);
  }
  if (hop.after !== undefined) {
    // A field relationship follows an id in a payload: there is no list, so there is nothing to
    // continue. Checked before the cursor itself, because "this edge cannot be paged" is the
    // actionable half.
    if (edge.counted === false) {
      throw new Refused(at, `edge "${hop.edge}" cannot be continued: it follows an id in a payload and has no list`);
    }
    try {
      decodeCursor(hop.after);
    } catch (e) {
      throw new Refused(at, `after is not a cursor from an earlier answer: ${(e as Error).message}`);
    }
  }
  for (const [i, c] of (hop.where ?? []).entries()) {
    if (c === null || typeof c !== "object") throw new Refused(`${at}.where[${i}]`, "expected an object");
    onlyKnown(c, CMP_MEMBERS, `${at}.where[${i}]`);
    if (!OPS.includes(c.op)) throw new Refused(`${at}.where[${i}]`, `operator must be one of ${OPS.join(" ")}`);
    checkValue(`${at}.where[${i}]`, c.field, c.value, edge.to, vocab);
  }
  if ((hop.where ?? []).length > limits.maxWhere) {
    throw new Refused(at, `${hop.where!.length} filters, the maximum is ${limits.maxWhere}`);
  }
  for (const [i, c] of (hop.counts ?? []).entries()) {
    checkCount(c, `${at}.counts[${i}]`, vocab);
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
    const under = checkHop(child, `${at}.hops[${i}]`, depth + 1, produced, vocab, limits, edge.to);
    frames += under.frames;
    nodes += under.nodes;
  }
  return { frames, nodes };
}

/**
 * Refuses a request that must not run, and reports what a permitted one will cost.
 *
 * Separate from compiling, so a caller can be told the price of a request before it is sent and an
 * editor can price one as it is typed. Whether the entry is *valid* is NOT decided here — see
 * `Request`, which has no entry at all — but how WIDE it is has to be, because the tree below it is
 * gathered once per root and the budget is spent on the total.
 *
 * `roots` is that width: the number of objects the request enters from, which `serve` takes from
 * `ids.length`. It defaults to 1 for the single-entry case, and a caller that enters from N objects
 * and prices for one has understated the request by a factor of N — which is property 2 in this
 * file's header failing in the direction that matters, since the surplus is work an unauthenticated
 * stranger got for free.
 */
export function check(req: Request, vocab: Vocabulary, limits: Limits = DEFAULT_LIMITS, roots = 1): Cost {
  if (!req || typeof req !== "object") throw new Refused("query", "expected an object");
  for (const [i, c] of (req.counts ?? []).entries()) {
    checkCount(c, `counts[${i}]`, vocab);
  }
  if ((req.counts ?? []).length > limits.maxCounts) {
    throw new Refused("counts", `${req.counts!.length} counts, the maximum is ${limits.maxCounts}`);
  }

  let frames = 1;
  let nodes = roots; // the root objects themselves
  for (const [i, hop] of (req.hops ?? []).entries()) {
    // `reaching` is how many rows arrive at this hop, which at the top is one per root.
    //
    // No parent type for a hop off the root. The entry is ids, an id does not carry its type, and
    // `ids` may legitimately hold objects of several types — so there is nothing sound to check
    // against here, and pricing happens before any I/O that could find out. Closing that would mean
    // a caller optionally stating the root's type, which is a new request member and so a new wire
    // version; it is recorded in PLAN.md rather than guessed at.
    const under = checkHop(hop, `hops[${i}]`, 1, roots, vocab, limits, undefined);
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
        `This is the product of the limits down each path${roots === 1 ? "" : `, times the ${roots} roots it enters from`}, ` +
        `and no amount of storage reading would reveal it — ` +
        `lower a limit${roots === 1 ? "" : ", enter from fewer ids"} or remove a hop.`,
    );
  }
  return { frames, nodes };
}
