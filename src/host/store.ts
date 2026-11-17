// A host's Store over its own SQLite. Reads are synchronous, as DO SQLite's are, so every promise it
// returns is already settled: a batch runs in one turn of the event loop, as one snapshot, with no
// cursor open across an await. Anything in a vshard this host doesn't own reads UNKNOWN, which is
// never the same as empty.

import { UNKNOWN, listKey } from "../query/types.ts";
import type { Cursor, Edge, EdgePage, Fields, Id, Maybe, Obj, Store } from "../query/types.ts";
import type { EdgeSegment, ReadSet } from "../query/stores.ts";
import { fromKey, toKey, vshardOf } from "./ids.ts";
import { formatOf } from "./schema.ts";
import type { StorageFormat } from "./schema.ts";
import type { Sql } from "./sql.ts";

const OBJECT = "SELECT otype, version, data FROM objects WHERE id = ?";

/**
 * The page statements, one pair per storage format.
 *
 * Format 2's order is `(time, db, id2)` and not `(time, id2)`, and that is a reading rather than a
 * preference: `scripts/edge-order.mjs` shows SQLite serving `(time, db, id2)` from `assocs_range`
 * directly at the head and after a cursor, while `(time, id2)` on the same table needs a temporary
 * b-tree for its last term. So a format 2 host cannot keep format 1's page query, and the tie-break
 * moves with the key — at one `time`, five edges read back as `2:8 2:3 1:7 0:9 0:4`, foreign before
 * local. `edgeOrder` in `query/types.ts` and the cursor codec in `schema/query.ts` have to agree
 * with that or a tie-broken cursor lands in the wrong place.
 *
 * Format 1's text is byte for byte what it has always been, which is what keeps a loaded database
 * answering exactly the statements it was loaded with.
 *
 * The cursor comparison is written out rather than as a row value so the index on
 * `(id1, atype, time)` is plainly the one that serves it.
 */
const PAGE: Record<StorageFormat, { head: string; after: string }> = {
  1: {
    head: "SELECT id2, time, data FROM assocs WHERE id1 = ? AND atype = ? ORDER BY time DESC, id2 DESC LIMIT ?",
    after:
      "SELECT id2, time, data FROM assocs WHERE id1 = ? AND atype = ? AND (time < ? OR (time = ? AND id2 < ?))" +
      " ORDER BY time DESC, id2 DESC LIMIT ?",
  },
  2: {
    head:
      "SELECT db, id2, time, data FROM assocs WHERE id1 = ? AND atype = ?" +
      " ORDER BY time DESC, db DESC, id2 DESC LIMIT ?",
    after:
      "SELECT db, id2, time, data FROM assocs WHERE id1 = ? AND atype = ?" +
      " AND (time < ? OR (time = ? AND (db < ? OR (db = ? AND id2 < ?))))" +
      " ORDER BY time DESC, db DESC, id2 DESC LIMIT ?",
  },
};

const COUNT = "SELECT n FROM assoc_counts WHERE id1 = ? AND atype = ?";

interface ObjectRow {
  otype: number;
  version: number;
  data: string;
}
interface AssocRow {
  /** Absent on format 1, which has no column for it. */
  db?: number;
  id2: Uint8Array;
  time: number;
  data: string | null;
}

/** The epoch the caller routed with, per vshard. A host serves a vshard only at the epoch the caller
 *  expected, so a stale route reads UNKNOWN and the caller re-resolves rather than reading data that
 *  has since moved. */
export type Routed = ReadonlyMap<bigint, number>;

export type State = "owned" | "fenced" | "moved";

/** Why a host would not serve a vshard. It knows it no longer owns the vshard, but not who does: its
 *  vshards row carries no target, so the caller re-reads the directory, which is authoritative. */
export interface Refusal {
  vshard: string;
  state: State | "absent";
  epoch: number;
}

export class SqlStore implements Store {
  readonly sql: Sql;
  readonly routed: Routed | null;
  readonly format: StorageFormat;
  /** Vshards the caller routed to that this host no longer serves at that epoch. */
  readonly refused = new Map<string, Refusal>();
  #served: Map<bigint, { state: State; epoch: number }> | null = null;
  readonly #objects = new Map<Id, Obj | null>();
  readonly #lists: EdgeSegment[] = [];
  readonly #counts = new Map<string, number>();

  constructor(sql: Sql, routed: Routed | null = null, format?: StorageFormat) {
    this.sql = sql;
    this.routed = routed;
    // Detected when it is not passed, so a store built straight over a host's SQL reads the shape
    // that is actually there rather than the one it hoped for.
    this.format = format ?? formatOf(sql) ?? 1;
  }

  /** Which vshards this host holds, and in what state. Read once: a store serves one batch, which is
   *  one snapshot, so ownership cannot change underneath it. */
  #rows(): Map<bigint, { state: State; epoch: number }> {
    if (!this.#served) {
      const rows = this.sql.all<{ vshard: number; state: State; epoch: number }>(
        "SELECT vshard, state, epoch FROM vshards",
      );
      this.#served = new Map(rows.map((r) => [BigInt(r.vshard), { state: r.state, epoch: r.epoch }]));
    }
    return this.#served;
  }

  /** Whether this host serves a vshard at the epoch the caller routed with. A read is served while the
   *  host still holds it, fenced included: a move stops writes for the length of the copy, not reads.
   *  A retired vshard, or one at another epoch, is not served. Pure: recording a refusal is a separate
   *  decision, because a read the host made on its own may legitimately fall outside it. */
  serves(vshard: bigint): true | Refusal {
    const row = this.#rows().get(vshard);
    const v = vshard.toString();
    if (!row) return { vshard: v, state: "absent", epoch: -1 };
    if (row.state === "moved") return { vshard: v, state: row.state, epoch: row.epoch };
    const expected = this.routed?.get(vshard);
    if (expected !== undefined && expected !== row.epoch) return { vshard: v, state: row.state, epoch: row.epoch };
    return true;
  }

  /** Records that this host would not serve a vshard, so the caller re-resolves instead of reading an
   *  empty answer as an answer. */
  refuse(refusal: Refusal): void {
    this.refused.set(refusal.vshard, refusal);
  }

  owns(id: Id): boolean {
    const vshard = vshardOf(id);
    const verdict = this.serves(vshard);
    if (verdict === true) return true;
    // Only when the caller said it was routing here. A read the host made while prefetching below a
    // row is the frontier, not a bad route.
    if (this.routed?.has(vshard)) this.refuse(verdict);
    return false;
  }

  object(id: Id): Promise<Maybe<Obj | null>> {
    if (!this.owns(id)) return Promise.resolve(UNKNOWN);
    const row = this.sql.all<ObjectRow>(OBJECT, toKey(id))[0];
    const o: Obj | null = row ? { id, otype: row.otype, version: row.version, data: JSON.parse(row.data) as Fields } : null;
    this.#objects.set(id, o);
    return Promise.resolve(o);
  }

  edges(id1: Id, atype: number, after: Cursor | null, n: number): Promise<Maybe<EdgePage>> {
    if (!this.owns(id1)) return Promise.resolve(UNKNOWN);
    // One row past the limit: it says only whether the list goes on.
    const stmt = PAGE[this.format];
    const rows =
      after === null
        ? this.sql.all<AssocRow>(stmt.head, toKey(id1), atype, n + 1)
        : this.format === 2
          ? this.sql.all<AssocRow>(
              stmt.after,
              toKey(id1),
              atype,
              after.time,
              after.time,
              after.db,
              after.db,
              toKey(after.id2),
              n + 1,
            )
          : this.sql.all<AssocRow>(stmt.after, toKey(id1), atype, after.time, after.time, toKey(after.id2), n + 1);
    const all: Edge[] = rows.map((r) => ({
      id1,
      atype,
      db: r.db ?? 0,
      id2: fromKey(r.id2),
      time: r.time,
      data: r.data === null ? null : (JSON.parse(r.data) as Fields),
    }));
    const page: EdgePage = { rows: all.slice(0, n), complete: all.length <= n };
    this.#lists.push({ id1, atype, after, ...page });
    return Promise.resolve(page);
  }

  count(id1: Id, atype: number): Promise<Maybe<number>> {
    if (!this.owns(id1)) return Promise.resolve(UNKNOWN);
    // No row means no edges of that type. COUNT(*) on a million-edge list would be O(n).
    const n = this.sql.all<{ n: number }>(COUNT, toKey(id1), atype)[0]?.n ?? 0;
    this.#counts.set(listKey(id1, atype), n);
    return Promise.resolve(n);
  }

  /** Everything read so far, to ship back to the coordinator. */
  reads(): ReadSet {
    return { objects: [...this.#objects], lists: [...this.#lists], counts: [...this.#counts] };
  }
}
