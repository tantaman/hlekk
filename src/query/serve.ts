// Serving a read to another database.
//
// `docs/protocol.md` owns the decisions; this is the half of them that is code. A database answering
// a foreign read needs no storage change at all — it is answering questions about its own objects
// with its own ids — which is why this half can exist before the alias column that the asking half
// needs.
//
// The shape is: a bounded request arrives, `check` prices it before any I/O, `planOf` compiles it
// from the catalog, the engine gathers it, and the policy decides what of that the caller may see.
// A `Plan` never crosses the wire in either direction — see `request.ts` for why.

import type { Catalog } from "../catalog/catalog.ts";
import { decodeCursor } from "../schema/query.ts";
import { normalize } from "./normalize.ts";
import type { ListEntry, QueryResult } from "./normalize.ts";
import { DEFAULT_HOP_LIMIT, DEFAULT_LIMITS, Refused, check, countEdge } from "./request.ts";
import type { Cmp, Cost, CountSpec, Hop, Limits, Request, Vocabulary } from "./request.ts";
import type { Cond, Frame, Id, Plan, Source } from "./types.ts";

/** A request as it arrives over the wire.
 *
 *  The entry is ids, and only ids: a reference into another database *is* an id, since that is what
 *  an edge stores. Entry by a unique index — "the user with this email" — is a separate decision with
 *  a much larger authorization question behind it, and nothing needs it to follow a reference. */
export interface ReadRequest extends Request {
  ids: Id[];
}

/** How much of an answer the caller may keep.
 *
 *  Stated by the responder because only the responder knows its own enforcement granularity: policy
 *  per identity can be reused for that identity, policy per request cannot be reused at all. A caller
 *  left to guess either re-asks for everything or serves an answer the policy has since withdrawn. */
export type Cacheability =
  | { reuse: "never" }
  | { reuse: "caller"; seconds: number }
  | { reuse: "public"; seconds: number };

/**
 * What an implementation fills in. The protocol fixes the questions, not the answers: one deployment
 * may check only the calling identity, another every object, another refuse all but three shapes.
 *
 * This authorizes the ANSWER, not the reads. The engine has already read what it gathered by the time
 * these are asked, so a policy here costs the caller nothing and saves the responder nothing; it
 * decides disclosure. A policy that needs to bound work does it with `Limits` and by what it exposes
 * in the `Vocabulary`.
 */
export interface Policy {
  /** May the caller see this object at all? A false answer makes it indistinguishable from absent. */
  object(id: Id, otype: number): boolean;
  /**
   * May the caller read this object's count of this edge type?
   *
   * Separate from `object` because a count is one maintained row and therefore free, so it rides
   * along on a read authorized for something else unless it is asked about. "This object has 4,312
   * edges you cannot follow" is a disclosure, and an implementation thinking about objects will not
   * notice it is answering about edges.
   */
  count(id: Id, atype: number): boolean;
  cache(): Cacheability;
}

/** Everything exposed, reusable by anyone. For a database serving public data, and for tests. */
export const PUBLIC: Policy = {
  object: () => true,
  count: () => true,
  cache: () => ({ reuse: "public", seconds: 60 }),
};

export interface Served {
  result: QueryResult;
  /** What the request was priced at, so a caller can see what it spent. */
  cost: Cost;
  cache: Cacheability;
}

/** What `serve` needs from a database. One method, so the protocol layer is testable without an
 *  engine and the engine needs to know nothing about the protocol. `Hlekk` satisfies it. */
export interface ReadSource {
  normalized(plan: Plan, rootIds: Id[], opts?: { foreign?: "reference" }): Promise<QueryResult>;
}

/**
 * The names a request may use, from the catalog, optionally narrowed to what this database exposes.
 *
 * `exposed` is the point: what a database serves is narrower than what it holds, and choosing that is
 * policy. A projection (`catalog/projection.ts`) already names this selection for code generation;
 * this is the same idea pointed outward. With no selection every edge in the catalog is traversable,
 * which is the right default only for a database whose whole graph is public.
 */
export function vocabularyOf(catalog: Catalog, exposed?: Iterable<string>): Vocabulary {
  const names = exposed === undefined ? undefined : new Set(exposed);
  const visible = (name: string) => names === undefined || names.has(name);
  return {
    edge(name) {
      if (!visible(name)) return undefined;
      const e = catalog.edgeNamed(name);
      return e === undefined ? undefined : { to: e.to, counted: e.atype !== undefined };
    },
    edges() {
      return catalog.edgeTypes().map((e) => e.name).filter(visible);
    },
    fields(objectType) {
      if (names !== undefined && !catalog.edgeTypes().some((e) => visible(e.name) && e.to === objectType)) {
        // A type nothing exposed lands on is not part of this database's surface, so its fields are
        // not filterable even if the catalog knows them.
        return undefined;
      }
      return catalog.objectNamed(objectType)?.fields;
    },
  };
}

const aliasOf = (hop: Hop): string => (hop.as !== undefined && hop.as.length > 0 ? hop.as : hop.edge);
const countAlias = (c: CountSpec): string => (typeof c === "string" ? c : c.as);

/** Filters as one condition. Every filter is on the target object's fields, which is what `check`
 *  validates them against. */
function condOf(where: Cmp[] | undefined): Cond | undefined {
  const cmps = (where ?? []).map((w): Cond => ({ cmp: w.op, on: "obj", field: w.field, value: w.value }));
  if (cmps.length === 0) return undefined;
  return cmps.length === 1 ? cmps[0] : { and: cmps };
}

/**
 * Compiles a checked request into a plan, from the catalog alone.
 *
 * No generated typed edge values are needed: a frame's source carries an `atype` and a condition is
 * plain data, so a name from the catalog is enough. That is what lets a served boundary exist without
 * the serving deployment having generated code for the caller's projection.
 *
 * Call `check` first; this assumes every name resolves. Children are emitted after their parent's
 * frame is reserved, as `Query.compile` does, so indices are stable.
 */
export function planOf(req: ReadRequest, catalog: Catalog): Plan {
  const frames: Frame[] = [];
  const emit = (source: Source, node: Partial<Hop> & Request, isRoot: boolean): number => {
    const index = frames.length;
    frames.push({
      source,
      limit: isRoot ? undefined : (node.limit ?? DEFAULT_HOP_LIMIT),
      // `check` has already decoded this one, so a cursor here is known to be well formed. The root
      // takes none: the entry is ids, and a list of ids is not a page.
      after: isRoot || node.after === undefined ? undefined : decodeCursor(node.after),
      children: [],
      counts: [],
    });
    const children = (node.hops ?? []).map((hop) => {
      const edge = catalog.edgeNamed(hop.edge)!;
      const child: Source =
        edge.atype === undefined ? { kind: "field", field: edge.field! } : { kind: "edge", atype: edge.atype };
      return { alias: aliasOf(hop), frame: emit(child, hop, false) };
    });
    const counts = (node.counts ?? []).map((c) => ({
      alias: countAlias(c),
      atype: catalog.edgeNamed(countEdge(c))!.atype!,
    }));
    frames[index] = { ...frames[index], children, counts, where: condOf(node.where) };
    return index;
  };
  emit({ kind: "ids" }, req, true);
  return { frames };
}

/**
 * Applies the policy to a gathered answer.
 *
 * A forbidden object leaves `objects`, leaves every list that names it, and takes its own lists and
 * counts with it — which makes it indistinguishable from an absent one, the decision `protocol.md`
 * settles.
 *
 * That is achievable after the fact only because the engine already behaves this way for deletes:
 * edges to missing objects are dropped at read time, and a maintained count still counts them, so a
 * page shorter than its limit beside a larger count is exactly what a deleted object looks like. If
 * the read path did not already do that, filtering the answer here would itself be the tell.
 *
 * WHY THIS IS A WALK and not a filter. Dropping a hidden object and the lists keyed by it is not
 * enough, because the answer is a graph and not a list: an object the request reached only by hopping
 * THROUGH the hidden one stays perfectly visible to `policy.object`, and its own list key is parented
 * by its own id rather than by the hidden one. Filtering entry by entry therefore leaves the
 * descendants of a hidden object in the answer — and had that object genuinely been absent, the
 * engine would never have gathered them at all, so their presence is both the tell and the
 * disclosure. The only faithful question is "what would still have been reached", so that is what
 * this asks: re-walk the shape from the roots, refusing to step through anything hidden, and keep
 * what the walk arrives at. An object reachable by some other permitted path survives, because an
 * absent parent would not have hidden it either.
 */
export function enforce(result: QueryResult, plan: Plan, policy: Policy): QueryResult {
  const hidden = new Set<Id>();
  for (const [id, entry] of Object.entries(result.objects)) {
    if (!policy.object(id, entry.otype)) hidden.add(id);
  }
  if (hidden.size === 0 && everyCountAllowed(result, plan, policy)) return result;

  // The walk. `reached` is keyed by frame and id together, not by id alone: the same object can sit
  // at two frames with different children under each, and collapsing them would stop the walk short
  // of a list the request did ask for. A queue rather than recursion, since depth is a caller's
  // number.
  const roots = result.roots.filter((id) => !hidden.has(id));
  const reached = new Set<string>();
  const visible = new Set<Id>();
  const keptLists = new Set<string>();
  const queue: { id: Id; frame: number }[] = [];
  const step = (id: Id, frame: number): void => {
    const at = `${frame}:${id}`;
    if (reached.has(at)) return;
    reached.add(at);
    visible.add(id);
    queue.push({ id, frame });
  };
  for (const id of roots) step(id, 0);
  for (let i = 0; i < queue.length; i++) {
    const { id, frame } = queue[i]!;
    for (const child of Object.values(result.shape[frame] ?? {})) {
      const key = `${child}:${id}`;
      const list = result.lists[key];
      if (list === undefined) continue;
      keptLists.add(key);
      for (const to of list.ids) if (!hidden.has(to)) step(to, child);
    }
  }

  const objects: QueryResult["objects"] = {};
  for (const [id, entry] of Object.entries(result.objects)) {
    if (visible.has(id)) objects[id] = entry;
  }

  const lists: QueryResult["lists"] = {};
  for (const key of keptLists) {
    lists[key] = prune(result.lists[key]!, hidden);
  }

  const counts: QueryResult["counts"] = {};
  for (const [key, byAlias] of Object.entries(result.counts)) {
    // A count is keyed by its own object's frame, so the key is exactly what the walk recorded.
    if (!reached.has(key)) continue;
    const parent = parentOf(key);
    const frame = plan.frames[Number(key.slice(0, key.indexOf(":")))];
    const kept: Record<string, number> = {};
    for (const [alias, n] of Object.entries(byAlias)) {
      const atype = frame?.counts.find((c) => c.alias === alias)?.atype;
      if (atype === undefined || policy.count(parent, atype)) kept[alias] = n;
    }
    if (Object.keys(kept).length > 0) counts[key] = kept;
  }

  return { roots, objects, lists, counts, shape: result.shape };
}

const parentOf = (key: string): Id => key.slice(key.indexOf(":") + 1);

/** Drops hidden ids, and the edge that reached each one, which is positional and so must go with it. */
function prune(list: ListEntry, hidden: ReadonlySet<Id>): ListEntry {
  const keep = list.ids.map((id) => !hidden.has(id));
  if (keep.every((k) => k)) return list;
  return {
    ids: list.ids.filter((_, i) => keep[i]),
    edges: list.edges === undefined ? undefined : list.edges.filter((_, i) => keep[i]),
    cursor: list.cursor,
    more: list.more,
  };
}

function everyCountAllowed(result: QueryResult, plan: Plan, policy: Policy): boolean {
  for (const [key, byAlias] of Object.entries(result.counts)) {
    const frame = plan.frames[Number(key.slice(0, key.indexOf(":")))];
    for (const alias of Object.keys(byAlias)) {
      const atype = frame?.counts.find((c) => c.alias === alias)?.atype;
      if (atype !== undefined && !policy.count(parentOf(key), atype)) return false;
    }
  }
  return true;
}

export interface ServeOptions {
  catalog: Catalog;
  source: ReadSource;
  vocabulary: Vocabulary;
  /**
   * Which object types this database exposes at all, by integer.
   *
   * The vocabulary narrows what a request may *say*; this narrows what an answer may *hold*, and the
   * two are not the same question. The entry is ids, and an id does not carry its type, so a caller
   * naming the id of an unexposed object would otherwise get it back — the one way into a narrowed
   * database's unnarrowed half. Enforced through the policy rather than at encode time so that the
   * walk in `enforce` applies: an object hidden here takes its descendants with it, which is what
   * makes it indistinguishable from absent rather than merely missing.
   */
  exposes?: (otype: number) => boolean;
  policy?: Policy;
  limits?: Limits;
  /** Ids one request may enter from. Separate from `Limits`, which bounds the tree below the entry. */
  maxIds?: number;
}

export const MAX_IDS = 100;

/**
 * Prices one read, reading nothing.
 *
 * Split out of `serve` so the two cannot disagree. `docs/protocol.md` makes "a request is priced
 * before it runs" the one non-negotiable property, and a price route that is a second implementation
 * of the same arithmetic is a price a caller cannot rely on — so there is one implementation and
 * both routes call it. The conformance suite checks the equality from outside, which only means
 * anything because it could have failed.
 *
 * The entry is validated before the price, because the price depends on it: the tree is gathered
 * once per root, so `check` needs the width of the entry to total it. Pricing first meant pricing
 * for one root and then serving `maxIds` of them — the tree under a request certified at 10,101
 * nodes materialized a hundred times over, which is the work amplifier this guard exists to remove.
 * The ordering also decides which fault a request carrying both is told about, and "this costs too
 * much" is not something a caller whose `ids` is a string can act on.
 */
export function price(req: ReadRequest, opts: ServeOptions): Cost {
  const { vocabulary, limits = DEFAULT_LIMITS, maxIds = MAX_IDS } = opts;
  const ids = req?.ids;
  if (!Array.isArray(ids) || ids.length === 0) throw new Refused("ids", "at least one id is required");
  if (ids.length > maxIds) throw new Refused("ids", `${ids.length} ids, the maximum is ${maxIds}`);
  if (ids.some((id) => typeof id !== "string")) throw new Refused("ids", "every id must be a decimal string");
  return check(req, vocabulary, limits, ids.length);
}

/**
 * Answers one read. Throws `Refused` — from `request.ts`, with a path into the request — for anything
 * that must not run; a caller turns that into whatever its transport calls a bad request.
 */
export async function serve(req: ReadRequest, opts: ServeOptions): Promise<Served> {
  const { catalog, source, exposes, policy = PUBLIC } = opts;
  const cost = price(req, opts);

  const plan = planOf(req, catalog);
  // A database answering a read never follows a reference out of itself. It would be fetching from
  // a third party on the caller's behalf, under its own identity, with the caller unable to tell
  // whose answer it got — the deputy `docs/protocol.md` rules out. So the reference is listed and
  // nothing is loaded, and the caller asks that database itself.
  const result = await source.normalized(plan, [...req.ids], { foreign: "reference" });
  const effective: Policy =
    exposes === undefined
      ? policy
      : {
          object: (id, otype) => exposes(otype) && policy.object(id, otype),
          count: (id, atype) => policy.count(id, atype),
          cache: () => policy.cache(),
        };
  return { result: enforce(result, plan, effective), cost, cache: policy.cache() };
}

export { Refused };
