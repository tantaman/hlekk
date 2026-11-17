// Value types shared by the Hlekk query engine: rows, streams, plans, misses and the store seam.

export type Id = string;
/** A local `Id`, or `<database URI>#<id>`. Re-exported from `ref.ts`, which owns the spelling. */
export type Ref = string;
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
  /** The target's id IN ITS OWN DATABASE. With `db` it is the whole of the reference, and the two
   *  together are the storage coordinates an edge list is ordered by. Never a reference on its own:
   *  see `targetOf`. */
  id2: Id;
  /**
   * The reference the target is reached by, absolute once the client has resolved the alias.
   *
   * Set only for a foreign edge, and only past the seam in `Hlekk.#exec` where every alias becomes a
   * URI. A host never sets it — a host stores an alias and cannot resolve one — so its absence on a
   * foreign row means the seam has not run, which `targetOf` turns into a loud failure rather than a
   * read of whichever local object shares those bits.
   */
  target?: Ref;
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
  /**
   * A continuation this database did not mint, for a list that lives in another one.
   *
   * Exclusive with the three fields above: when it is set they are placeholders and nothing orders
   * by them. A responder drops rows the caller may not see, so the last VISIBLE row is not where the
   * list resumes — only the responder knows that, and it says so in the page it answers. Trying to
   * continue a foreign list from the caller's own sort key would silently skip whatever the policy
   * removed at the boundary.
   */
  token?: string;
}

/** Whether a continuation is a token the database holding the list handed back. */
export const isToken = (after: Cursor | null): boolean => after?.token !== undefined;

/** A cursor that is only a token. The sort key is a placeholder: nothing compares it. */
export const tokenCursor = (token: string): Cursor => ({ time: 0, db: 0, id2: "0", token });

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
 * The reference an edge's target is reached by: a bare id for a local one, and the absolute
 * reference for a foreign one.
 *
 * Throws on a foreign edge the seam has not resolved. The two alternatives are both worse than a
 * throw, which is why this is not a fallback. Dropping the edge would read as a dangling reference,
 * so a database that holds the reference and one that does not would answer identically — and the
 * whole point of storing it is that the reference exists. Loading it by its low half would return
 * whichever LOCAL object happens to share those 47 bits, which is an answer about the wrong object
 * with nothing to mark it as one.
 */
export function targetOf(e: Edge): Ref {
  // The resolved reference wins where there is one. A row in a list that another database answered
  // carries its target as a reference and no alias of this database's — there is nothing for an
  // alias to mean, since the ordering is the responder's — so `target` is the only thing that says
  // which object it is.
  if (e.target !== undefined) return e.target;
  if (e.db === 0) return e.id2;
  throw new ForeignEdge(e);
}

/** The storage coordinates an edge list is ordered by. Separate from `targetOf` because the order is
 *  `(time, db, id2)` and `id2` is the target's id in its own database, never the reference: a cursor
 *  carries what the responder's own `ORDER BY` compares. */
export const cursorOf = (e: Edge): Cursor => ({ time: e.time, db: e.db, id2: e.id2 });

/**
 * The otype of a row that is a reference rather than an object.
 *
 * A database answering a read never follows an edge into another database, or it becomes the deputy
 * `docs/protocol.md` rules out. What it does instead is list the reference and load nothing, which
 * needs a row whose only true field is its id — this is how such a row says so. Catalog otypes are
 * allocated from 1 upwards, so a negative one belongs to no type in any catalog and `catalog.object`
 * answers undefined for it, which is what keeps it from being named in an answer.
 */
export const REFERENCE = -1;

export const isReference = (o: Obj): boolean => o.otype === REFERENCE;

/** A row that is an unfollowed reference. */
export const referenceRow = (ref: Ref, edge: Edge): Row => ({
  obj: { id: ref, otype: REFERENCE, version: 0, data: {} },
  edge,
});

/** One read of an edge list: up to n edges after a cursor. complete: no edges follow them. */
export interface EdgePage {
  rows: Edge[];
  complete: boolean;
  /** Where the database holding this list says it continues, for a list this database does not hold.
   *  Absent for a local list, which continues from its own last row. */
  next?: string;
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
  /** Load id as a row of `frame`, prefetching below it. `db` is set only by a host that met an edge
   *  into another database and cannot resolve the alias; the seam in `Hlekk.#exec` replaces the pair
   *  with an absolute reference, so past that line a miss carries a `Ref` and no alias. */
  | { kind: "object"; id: Ref; db?: number; frame: number }
  | { kind: "edges"; id1: Id; atype: number; frame: number; after: Cursor | null; n: number } // a page; its targets as rows of `frame`
  | { kind: "count"; id1: Id; atype: number };

/** Names the data a miss asks for. Objects key by id alone: the first frame to ask decides what the
 *  host prefetches below the object. */
export function missKey(m: Miss): string {
  // The alias is part of the key while it is still there: before the seam runs, a foreign target and
  // a local object can have the same low half, and one key for both would drop one of them.
  if (m.kind === "object") return m.db ? `o:${m.db}:${m.id}` : `o:${m.id}`;
  if (m.kind === "count") return `c:${listKey(m.id1, m.atype)}`;
  if (m.after?.token !== undefined) return `e:${listKey(m.id1, m.atype)}:t:${m.after.token}`;
  return `e:${listKey(m.id1, m.atype)}:${m.after ? `${m.after.time}:${m.after.db}:${m.after.id2}` : "head"}`;
}

/** The reference whose holder is the one to ask: a local id, whose vshard names a host, or a
 *  qualified reference, whose prefix names a database. */
export const missOwner = (m: Miss): Ref => (m.kind === "object" ? m.id : m.id1);

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
