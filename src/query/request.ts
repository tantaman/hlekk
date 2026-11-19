// A bounded request an untrusted caller may submit, and the static guard that decides whether it may
// run at all.
//
// Lifted out of `examples/wiki/wiki-query.ts`, which built this because the wiki demo exposes a query box to
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
// 4. **What a filter reads is bounded too.** A selective filter walks its edge list until its limit
//    is filled, so a `where` over an object with a million edges reads the million, and `maxLimit`
//    bounds what a list keeps rather than what it reads. So `maxScan` is shared across the request's
//    filtered lists here, before any I/O, and a list that reaches its share stops with a cursor past
//    the last row it read (`EdgeHop` in `ops.ts`). Fixed by the text rather than spent as the read
//    goes, because a budget spent in the order hosts reply is an answer that depends on timing.

import type { FieldSpec } from "../catalog/catalog.ts";
import { decodeCursor } from "../schema/query.ts";
import { isReservedKey } from "./types.ts";
import type { CmpOp, Cond, Cursor, Frame, Json, Plan, Source } from "./types.ts";

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
  /** Rows one hop may keep. Not a bound on what a filter reads to find them: that is `maxScan`. */
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
  /**
   * Rows the request's filtered lists may examine between them. A filter reads until it has filled
   * its limit, so a selective one over a high-degree object reads the whole list, and nothing about
   * the request's text bounds that — `maxLimit` bounds what a list keeps, not what it reads.
   *
   * Shared evenly, and fixed before any I/O: each filtered list may examine this divided by the most
   * filtered lists the request could produce. A list that reaches its share stops with what it has
   * and a cursor past the last row it read, so the total is a hard bound and the caller continues
   * where it stopped. The share is in the price, as `scan`.
   */
  maxScan: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxDepth: 4,
  maxLimit: 100,
  maxFrames: 16,
  maxNodes: 20_000,
  maxCounts: 4,
  maxWhere: 4,
  // Each row a filter examines is an edge read and a read of the object it lands on. At pages of up
  // to 256 that is about twenty dependent host requests for one list given the whole allowance, and
  // a fraction of a second — against the 1,393 ms and 12 requests one unbounded filter over a single
  // high-degree page took on the Wikipedia pilot.
  maxScan: 5_000,
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
  /** Rows each filtered list may examine before it stops and hands back a cursor. Present only when
   *  the request filters a list, since otherwise nothing reads past a limit. */
  scan?: number;
}

/** How a field spec reads to a person, and what a value for it has to be. */
export function describe(spec: FieldSpec): { type: string; optional: boolean } {
  if (typeof spec === "object" && "optional" in spec) return { ...describe(spec.optional), optional: true };
  if (typeof spec === "object" && "enum" in spec) return { type: `enum(${spec.enum.join("|")})`, optional: false };
  if (typeof spec === "object" && "id" in spec) return { type: `id(${spec.id})`, optional: false };
  return { type: spec, optional: false };
}

/**
 * Refuses a filter over a field the type does not have, or a value the field could not hold.
 *
 * Exported for a caller that only learns what an object is once a database has said so, and has to
 * make this same refusal then (`reader/reader.ts`). It needs the fields of one type and nothing
 * else of a vocabulary, which is all it is given.
 */
export function checkValue(at: string, field: string, value: Json, objectType: string, vocab: Pick<Vocabulary, "fields">): void {
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
export function onlyKnown(value: object, known: readonly string[], at: string, hint = ""): void {
  for (const name of Object.keys(value)) {
    if (!known.includes(name)) {
      throw new Refused(at, `no such member "${name}"; this one takes ${known.join(", ")}${hint}`);
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
export function checkAliases(req: Request, aliasing: Aliasing = PROTOCOL_ALIASING, maxDepth = DEFAULT_LIMITS.maxDepth): void {
  const level = (node: { counts?: CountSpec[]; hops?: Hop[] }, at: string, depth: number): void => {
    for (const name of ["counts", "hops"] as const) {
      if (node[name] !== undefined && !Array.isArray(node[name])) throw new Refused(at + name, "expected an array");
    }
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
      const path = `${at}hops[${i}]`;
      if (depth > maxDepth) throw new Refused(path, `hops nest ${depth} deep, the maximum is ${maxDepth}`);
      if (hop === null || typeof hop !== "object" || Array.isArray(hop)) throw new Refused(path, "expected an object");
      if (typeof hop.edge !== "string" || !hop.edge) throw new Refused(path + ".edge", "expected an edge name");
      if (hop.as !== undefined && (typeof hop.as !== "string" || !hop.as)) throw new Refused(path + ".as", "expected an alias");
      if (hop.where !== undefined && !Array.isArray(hop.where)) throw new Refused(path + ".where", "expected an array");
      if (hop.limit !== undefined && !Number.isInteger(hop.limit)) throw new Refused(path + ".limit", "limit must be an integer");
      take(aliasing.hop(hop), `${at}hops[${i}]`, `the "${hop.edge}" hop`);
    }
    for (const [i, c] of (node.counts ?? []).entries()) {
      const path = `${at}counts[${i}]`;
      if (typeof c !== "string") {
        if (!c || typeof c !== "object" || Array.isArray(c)) throw new Refused(path, "expected an edge name or count");
        if (typeof c.as !== "string" || !c.as) throw new Refused(path + ".as", "expected an alias");
        if (typeof c.edge !== "string" || !c.edge) throw new Refused(path + ".edge", "expected an edge name");
      }
      take(aliasing.count(c), `${at}counts[${i}]`, `the "${countEdge(c)}" count`);
    }
    for (const [i, hop] of (node.hops ?? []).entries()) {
      if (hop !== null && typeof hop === "object") level(hop, `${at}hops[${i}].`, depth + 1);
    }
  };
  level(req, "", 1);
}

const HOP_MEMBERS = ["as", "edge", "limit", "after", "where", "counts", "hops"] as const;
const CMP_MEMBERS = ["field", "op", "value"] as const;
const COUNT_MEMBERS = ["as", "edge"] as const;

/** Every member a read request itself may carry, for a caller that validates the entry too. */
export const REQUEST_MEMBERS = ["ids", "counts", "hops"] as const;

// ---- what is wrong with a request whichever database it is asked of
//
// One function per kind of node, called from `check` at the point it reaches that node and from
// `checkShape` on their own. They are separate so that there is one of each: a caller with no
// single vocabulary to check against (`reader/reader.ts`) once kept its own copies of these, and
// the copies had already stopped agreeing with the originals — a count with a member this protocol
// does not define was refused here and taken there.

function hopShape(hop: Hop, at: string): void {
  if (hop === null || typeof hop !== "object") throw new Refused(at, "expected an object");
  onlyKnown(hop, HOP_MEMBERS, at);
}

function cmpShape(c: Cmp, at: string): void {
  if (c === null || typeof c !== "object") throw new Refused(at, "expected an object");
  onlyKnown(c, CMP_MEMBERS, at);
  if (typeof c.field !== "string" || !c.field || !("value" in c)) throw new Refused(at, "a comparison requires a field and value");
  if (!OPS.includes(c.op)) throw new Refused(at, `operator must be one of ${OPS.join(" ")}`);
}

function countShape(c: CountSpec, at: string): void {
  if (typeof c === "object" && c !== null) onlyKnown(c, COUNT_MEMBERS, at);
}

/**
 * Refuses what is wrong with a request whichever database it is asked of.
 *
 * `check` needs a vocabulary: whether an edge exists, where it starts, what a filter's field holds.
 * A caller that puts one request to several databases has no single vocabulary to check it
 * against, and still has to refuse the rest — a member this protocol does not define, a filter that
 * is not a comparison, a limit that is not a number of rows — or a mistake `check` would have
 * named comes back as an answer. With `checkAliases`, which stands apart for the same reason and is
 * to be called first, this is everything about a request that is not a question for a database.
 */
export function checkShape(req: Request): void {
  const level = (node: Request, at: string): void => {
    for (const [i, c] of (node.counts ?? []).entries()) countShape(c, `${at}counts[${i}]`);
    for (const [i, hop] of (node.hops ?? []).entries()) {
      const path = `${at}hops[${i}]`;
      hopShape(hop, path);
      if (hop.limit !== undefined && (!Number.isInteger(hop.limit) || hop.limit < 1)) {
        throw new Refused(`${path}.limit`, "limit must be an integer of at least 1");
      }
      if (hop.after !== undefined && typeof hop.after !== "string") throw new Refused(`${path}.after`, "expected a cursor");
      for (const [j, c] of (hop.where ?? []).entries()) cmpShape(c, `${path}.where[${j}]`);
      level(hop, `${path}.`);
    }
  };
  level(req, "");
}

function checkCount(c: CountSpec, at: string, vocab: Vocabulary): void {
  countShape(c, at);
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
  /** Filtered lists it can produce: one per row reaching each hop that filters. */
  filtered: number;
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
  hopShape(hop, at);
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
    cmpShape(c, `${at}.where[${i}]`);
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
  // Each row reaching this hop is a list of its own, and a filtered one reads past its limit.
  let filtered = (hop.where ?? []).length > 0 ? reaching : 0;
  for (const [i, child] of (hop.hops ?? []).entries()) {
    const under = checkHop(child, `${at}.hops[${i}]`, depth + 1, produced, vocab, limits, edge.to);
    frames += under.frames;
    nodes += under.nodes;
    filtered += under.filtered;
  }
  return { frames, nodes, filtered };
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
  let filtered = 0;
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
    filtered += under.filtered;
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
  if (filtered === 0) return { frames, nodes };
  // The share is fixed here rather than spent as the read goes, because a budget spent in the order
  // lists happen to be read is an answer that depends on which host replied first. Fixed per list,
  // it is the same answer however the data is spread and whichever driver runs it.
  const scan = Math.floor(limits.maxScan / filtered);
  if (scan < 1) {
    throw new Refused(
      "query",
      `could filter ${filtered.toLocaleString()} lists, and ${limits.maxScan.toLocaleString()} rows examined is the most ` +
        "a request may spend on filters between them, which leaves none a row. Filter fewer lists, " +
        `lower a limit above a filtered hop${roots === 1 ? "" : " or enter from fewer ids"}.`,
    );
  }
  return { frames, nodes, scan };
}

// ---- from a request to a plan

/** A hop's filters as one condition: their conjunction. Every filter is on the target object's
 *  fields, which is what a filter's value is checked against. */
export function condOf(where: Cmp[] | undefined): Cond | undefined {
  const cmps = (where ?? []).map((w): Cond => ({ cmp: w.op, on: "obj", field: w.field, value: w.value }));
  if (cmps.length === 0) return undefined;
  return cmps.length === 1 ? cmps[0] : { and: cmps };
}

/**
 * How the names in a request become what a plan carries.
 *
 * It is the one thing two compilers of the same request do differently. A database answering a
 * read resolves a name through its catalog. A caller with no catalog of its own resolves it
 * through whatever numbers it is reading by. Everything else — which frame a hop becomes, what a
 * hop with no limit gets, that the entry takes no cursor — is the request's own meaning, and there
 * is one of it.
 */
export interface Naming {
  /** What a hop reads from: a stored edge, or the payload field a relationship follows. */
  source(hop: Hop, at: string): Source;
  /** The edge type a count reads. */
  counted(count: CountSpec, at: string): number;
  /** A hop's `after`, decoded. */
  cursor(after: string, at: string): Cursor;
}

/**
 * Compiles a request into a plan.
 *
 * Run the checks first: this assumes a well-formed request. Children are emitted after their
 * parent's frame is reserved, as `Query.compile` does, so indices are stable. `each` is told of
 * every frame as it is reserved, with the node it came from and that node's path, for a caller
 * that has to say where in the request something was once it is able to say what was wrong with it.
 */
export function compile(
  req: Request,
  naming: Naming,
  aliasing: Aliasing = PROTOCOL_ALIASING,
  each?: (frame: number, node: Request & Partial<Hop>, at: string) => void,
): Plan {
  const frames: Frame[] = [];
  const emit = (source: Source, node: Request & Partial<Hop>, at: string): number => {
    const index = frames.length;
    const root = source.kind === "ids";
    frames.push({
      source,
      limit: root ? undefined : (node.limit ?? DEFAULT_HOP_LIMIT),
      // The root takes none: the entry is ids, and a list of ids is not a page.
      after: root || node.after === undefined ? undefined : naming.cursor(node.after, `${at}.after`),
      children: [],
      counts: [],
    });
    each?.(index, node, at);
    const under = at === "" ? "" : `${at}.`;
    const children = (node.hops ?? []).map((hop, i) => {
      const path = `${under}hops[${i}]`;
      return { alias: aliasing.hop(hop), frame: emit(naming.source(hop, path), hop, path) };
    });
    const counts = (node.counts ?? []).map((c, i) => ({
      alias: aliasing.count(c),
      atype: naming.counted(c, `${under}counts[${i}]`),
    }));
    frames[index] = { ...frames[index]!, children, counts, where: condOf(node.where) };
    return index;
  };
  emit({ kind: "ids" }, req, "");
  return { frames };
}
