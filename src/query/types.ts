// Value types shared by the Hlekk query engine: rows, streams, plans, misses and the store seam.

export type Id = string;
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Fields = { [k: string]: Json };

export interface Obj {
  id: Id;
  otype: number;
  version: number;
  data: Fields;
}

export interface Edge {
  id1: Id;
  atype: number;
  /** The target's database, as this database's own interned alias: 0 is local. Always 0 on storage
   *  format 1, which has no column for it. See `host/schema.ts`. */
  db: number;
  id2: Id;
  time: number;
  data: Fields | null;
}

/** A row in a frame: the object, plus the edge that reached it (null for roots and field hops). */
export interface Row {
  obj: Obj;
  edge: Edge | null;
}

/** A row plus lazily produced relationships and counts, as in rindle. Each thunk starts fresh work. */
export interface Node {
  row: Row;
  rels: Rel[];
  counts: Count[];
}

/** How a stream ended. "short": it stopped at something its store didn't know, so its rows are a
 *  prefix of the answer, not the answer. */
export type End = "done" | "short";

/** Ordered rows, pulled one at a time. Async everywhere: a host's reads settle at once, while the
 *  coordinator's may wait on a host. */
export type Stream = AsyncGenerator<Node, End, undefined>;

export interface Rel {
  alias: string;
  stream: () => Stream;
}

export interface Count {
  alias: string;
  n: () => Promise<Maybe<number>>;
}

/** "Not known here": a vshard this host doesn't own, or data the coordinator hasn't fetched yet.
 *  Never the same as empty. */
export const UNKNOWN: unique symbol = Symbol("unknown");
export type Unknown = typeof UNKNOWN;
export type Maybe<T> = T | Unknown;

/** Edge lists are ordered newest first, `(time desc, db desc, id2 desc)`. The last two break ties, so
 *  cursors are exact.
 *
 *  `db` is in the sort key because it is in the primary key: `scripts/edge-order.mjs` shows that on
 *  format 2 an order of `(time, id2)` needs a temporary b-tree for its last term, while
 *  `(time, db, id2)` is served by `assocs_range` directly, at the head and after a cursor. So the
 *  tie-break is not a choice — at one `time`, five edges read back as `2:8 2:3 1:7 0:9 0:4`, foreign
 *  before local, and this comparator has to agree with that or a tie-broken cursor lands in the
 *  wrong place. See `cmpId` for the same hazard one level down. */
export interface Cursor {
  time: number;
  db: number;
  id2: Id;
}

/** Numeric order over canonical decimal ids: length first, then lexicographic. A host orders by the
 *  8-byte big-endian blob, which sorts numerically, so the coordinator has to agree with it or a
 *  tie-broken cursor lands in the wrong place. Plain string compare would put "10" before "9". */
export function cmpId(a: Id, b: Id): number {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function edgeOrder(a: Cursor, b: Cursor): number {
  if (a.time !== b.time) return b.time - a.time;
  if (a.db !== b.db) return b.db - a.db;
  return -cmpId(a.id2, b.id2);
}

export const listKey = (id1: Id, atype: number) => `${id1}:${atype}`;

/** A read that reached an edge into another database. Step 4 follows these; until then the only safe
 *  thing to do is say so. */
export class ForeignEdge extends Error {
  readonly db: number;
  readonly id2: Id;
  constructor(e: Edge) {
    super(
      `${e.id1} has an edge of type ${e.atype} into database ${e.db} (id ${e.id2}), and following one is not built yet.`,
    );
    this.name = "ForeignEdge";
    this.db = e.db;
    this.id2 = e.id2;
  }
}

/**
 * An edge's target as one of this database's ids, throwing on a foreign one.
 *
 * The two alternatives are both worse than a throw, which is why this is not a filter. Dropping a
 * foreign edge would read as a dangling reference, so a database that holds the reference and a
 * database that does not would answer identically — and the whole point of storing it is that the
 * reference exists. Loading it by number would return whichever LOCAL object happens to share those
 * 47 bits, which is an answer about the wrong object with nothing to mark it as one.
 *
 * Step 4 replaces this: a host sends a foreign row back as a miss carrying the alias, and the
 * coordinator resolves the alias to a URI and asks that database. Every call site here is a site
 * that step touches.
 */
export function localId(e: Edge): Id {
  if (e.db !== 0) throw new ForeignEdge(e);
  return e.id2;
}

/** One read of an edge list: up to n edges after a cursor. complete: no edges follow them. */
export interface EdgePage {
  rows: Edge[];
  complete: boolean;
}

// ---- plans

/** A compiled query: one frame per `related` level, addressed by index. Frame 0 is the root. */
export interface Plan {
  frames: Frame[];
}

export interface Frame {
  source: Source;
  where?: Cond;
  limit?: number;
  /** Where to start an edge list. A page's cursor comes back here to read the next rows; a request
   *  may override it, which is how the coordinator continues a list mid-query. */
  after?: Cursor;
  children: { alias: string; frame: number }[];
  counts: { alias: string; atype: number }[];
}

export type Source =
  | { kind: "ids" } // root: objects by id, in the order given
  | { kind: "edge"; atype: number } // a stored edge from the parent
  | { kind: "field"; field: string }; // an id in the parent's payload (fieldRel)

export type CmpOp = "=" | "!=" | "<" | "<=" | ">" | ">=";

export type Cond =
  | { and: Cond[] }
  | { or: Cond[] }
  | { not: Cond }
  | { cmp: CmpOp; on: "obj" | "edge"; field: string; value: Json }
  | { exists: number }; // a child frame, normally with limit 1

// ---- misses and the store seam

/** Something a pass needed and its store didn't have. A host's misses are the frontier it sends back;
 *  the coordinator sends the same shapes to hosts as tasks. */
export type Miss =
  | { kind: "object"; id: Id; frame: number } // load id as a row of `frame`, prefetching below it
  | { kind: "edges"; id1: Id; atype: number; frame: number; after: Cursor | null; n: number } // a page; its targets as rows of `frame`
  | { kind: "count"; id1: Id; atype: number };

/** Names the data a miss asks for. Objects key by id alone: the first frame to ask decides what the
 *  host prefetches below the object. */
export function missKey(m: Miss): string {
  if (m.kind === "object") return `o:${m.id}`;
  if (m.kind === "count") return `c:${listKey(m.id1, m.atype)}`;
  return `e:${listKey(m.id1, m.atype)}:${m.after ? `${m.after.time}:${m.after.db}:${m.after.id2}` : "head"}`;
}

/** The id whose vshard holds the data, so its host is the one to ask. */
export const missOwner = (m: Miss): Id => (m.kind === "object" ? m.id : m.id1);

/** Reads, as promises. A host's DO SQLite settles at once, and so does the round driver's view of the
 *  gathered graph, which answers UNKNOWN for gaps. The async driver's store waits on the owning host
 *  instead and never answers UNKNOWN. `frame` tells a remote host what to prefetch below a row. */
export interface Store {
  /** null = known not to exist. */
  object(id: Id, frame: number): Promise<Maybe<Obj | null>>;
  /** Up to n edges after `after`, in order. */
  edges(id1: Id, atype: number, after: Cursor | null, n: number, frame: number): Promise<Maybe<EdgePage>>;
  count(id1: Id, atype: number): Promise<Maybe<number>>;
}
