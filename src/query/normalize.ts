// The normalized form of a query's answer: every object once, with its version, and the structure
// kept separately.
//
// It is not the form a caller renders from — nesting is, and that is the default. This is for the two
// things nesting cannot do. A response that leaves the Worker duplicates a shared object once per
// path, which for a graph query is the common case rather than the exception; and a live view has to
// know which nodes are the same object before it can patch one.
//
// It is a serializer, not a mechanism: the coordinator already gathers exactly this, and `materialize`
// throws it away on the way out.

import { encodeCursor } from "../schema/query.ts";
import type { Cache } from "./stores.ts";
import { listKey } from "./types.ts";
import type { Fields, Id, Json, Plan } from "./types.ts";

export interface ObjectEntry {
  otype: number;
  version: number;
  data: Fields;
}

export interface ListEntry {
  /** The ids this level holds for that parent, in order, after its filter and limit. */
  ids: Id[];
  /** The edge that reached each id, positionally. Absent where no edge did. */
  edges?: ({ time: number; data: Fields | null } | null)[];
  cursor: string | null;
  more: boolean;
}

export interface QueryResult {
  roots: Id[];
  objects: Record<Id, ObjectEntry>;
  /** Keyed `${frame}:${parentId}`. By frame, not by edge type: two aliases over one edge type with
   *  different filters or limits are two answers and must not collide. */
  lists: Record<string, ListEntry>;
  /** Keyed `${frame}:${parentId}`, then by the alias the count was asked for under. */
  counts: Record<string, Record<string, number>>;
  /** The query's shape: per frame, which alias leads to which frame. A consumer that does not hold
   *  the plan needs this to walk the lists. */
  shape: Record<number, Record<string, number>>;
}

const RESERVED = new Set(["id", "$version", "$edge"]);

/** Turns a nested answer and the graph it was read from into the normalized form. Takes the driver's
 *  rows, before the builder reshapes them. */
export function normalize(plan: Plan, rootIds: readonly Id[], rows: readonly Json[], graph: Cache): QueryResult {
  const out: QueryResult = { roots: [...rootIds], objects: {}, lists: {}, counts: {}, shape: {} };

  for (const [index, frame] of plan.frames.entries()) {
    const aliases: Record<string, number> = {};
    for (const c of frame.children) aliases[c.alias] = c.frame;
    out.shape[index] = aliases;
  }

  const visit = (value: Json, frame: number): Id | null => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, Json>;
    const id = row.id as Id | undefined;
    if (id === undefined) return null;

    // The payload comes from the graph, which holds it once and knows its type and version. Rebuilding
    // it from the row would mean guessing which keys were aliases.
    const held = graph.objects.get(id);
    if (held && !(id in out.objects)) {
      out.objects[id] = { otype: held.otype, version: held.version, data: held.data };
    }

    const spec = plan.frames[frame];
    for (const child of spec.children) {
      const got = row[child.alias];
      const items = Array.isArray(got) ? got : [];
      const ids: Id[] = [];
      const edges: ({ time: number; data: Fields | null } | null)[] = [];
      let sawEdge = false;
      for (const item of items) {
        const childId = visit(item, child.frame);
        if (childId === null) continue;
        ids.push(childId);
        const edge = edgeOf(item);
        if (edge) sawEdge = true;
        edges.push(edge);
      }
      const entry: ListEntry = { ids, ...continuation(id, child.frame, ids.length, plan, graph) };
      if (sawEdge) entry.edges = edges;
      out.lists[`${child.frame}:${id}`] = entry;
    }

    for (const count of spec.counts) {
      const n = row[count.alias];
      if (typeof n !== "number") continue;
      const key = `${frame}:${id}`;
      out.counts[key] = { ...(out.counts[key] ?? {}), [count.alias]: n };
    }
    return id;
  };

  for (const row of rows) visit(row, 0);
  return out;
}

function edgeOf(item: Json): { time: number; data: Fields | null } | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const edge = (item as Record<string, Json>).$edge;
  if (edge === null || edge === undefined || typeof edge !== "object" || Array.isArray(edge)) return null;
  const time = (edge as Record<string, Json>).time;
  if (typeof time !== "number") return null;
  const data = (edge as Record<string, Json>).data;
  return { time, data: data === null || data === undefined ? null : (data as Fields) };
}

/** Where a list can be continued from, and whether it goes on. Only the graph knows: the ids handed
 *  back are the ones that passed a filter and fit a limit. */
function continuation(
  parent: Id,
  frame: number,
  returned: number,
  plan: Plan,
  graph: Cache,
): { cursor: string | null; more: boolean } {
  const source = plan.frames[frame].source;
  if (source.kind !== "edge") return { cursor: null, more: false };
  const run = graph.lists.get(listKey(parent, source.atype));
  if (!run) return { cursor: null, more: false };
  const last = run.rows[Math.min(returned, run.rows.length) - 1];
  const cursor = last ? encodeCursor(last.time, last.id2) : null;
  return { cursor, more: returned < run.rows.length || !run.complete };
}

/** Keys the way the maps above are keyed, so a consumer does not have to build the strings by hand. */
export const listAt = (frame: number, parent: Id): string => `${frame}:${parent}`;

export { RESERVED as RESERVED_KEYS };
