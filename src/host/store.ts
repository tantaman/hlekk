// A host's Store over its own SQLite. Reads are synchronous, as DO SQLite's are, so every promise it
// returns is already settled: a batch runs in one turn of the event loop, as one snapshot, with no
// cursor open across an await. Anything in a vshard this host doesn't own reads UNKNOWN, which is
// never the same as empty.

import { UNKNOWN, listKey } from "../query/types.ts";
import type { Cursor, Edge, EdgePage, Fields, Id, Maybe, Obj, Store } from "../query/types.ts";
import type { EdgeSegment, ReadSet } from "../query/stores.ts";
import { fromKey, toKey, vshardOf } from "./ids.ts";
import type { Sql } from "./sql.ts";

const OBJECT = "SELECT otype, version, data FROM objects WHERE id = ?";
const PAGE_HEAD =
  "SELECT id2, time, data FROM assocs WHERE id1 = ? AND atype = ? ORDER BY time DESC, id2 DESC LIMIT ?";
// (time, id2) strictly below the cursor. Written out rather than as a row value so the index on
// (id1, atype, time) is plainly the one that serves it.
const PAGE_AFTER =
  "SELECT id2, time, data FROM assocs WHERE id1 = ? AND atype = ? AND (time < ? OR (time = ? AND id2 < ?))" +
  " ORDER BY time DESC, id2 DESC LIMIT ?";
const COUNT = "SELECT n FROM assoc_counts WHERE id1 = ? AND atype = ?";

interface ObjectRow {
  otype: number;
  version: number;
  data: string;
}
interface AssocRow {
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
  /** Vshards the caller routed to that this host no longer serves at that epoch. */
  readonly refused = new Map<string, Refusal>();
  #served: Map<bigint, { state: State; epoch: number }> | null = null;
  readonly #objects = new Map<Id, Obj | null>();
  readonly #lists: EdgeSegment[] = [];
  readonly #counts = new Map<string, number>();

  constructor(sql: Sql, routed: Routed | null = null) {
    this.sql = sql;
    this.routed = routed;
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

  /** A read is served while this host still holds the vshard, fenced included: a move stops writes for
   *  the length of the copy, not reads. A retired vshard, or one at another epoch than the caller
   *  routed with, is refused so the caller re-resolves. */
  owns(id: Id): boolean {
    const vshard = vshardOf(id);
    const row = this.#rows().get(vshard);
    const refuse = (state: State | "absent", epoch: number) => {
      this.refused.set(vshard.toString(), { vshard: vshard.toString(), state, epoch });
      return false;
    };
    if (!row) return this.routed?.has(vshard) ? refuse("absent", -1) : false;
    if (row.state === "moved") return refuse(row.state, row.epoch);
    const expected = this.routed?.get(vshard);
    if (expected !== undefined && expected !== row.epoch) return refuse(row.state, row.epoch);
    return true;
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
    const rows =
      after === null
        ? this.sql.all<AssocRow>(PAGE_HEAD, toKey(id1), atype, n + 1)
        : this.sql.all<AssocRow>(PAGE_AFTER, toKey(id1), atype, after.time, after.time, toKey(after.id2), n + 1);
    const all: Edge[] = rows.map((r) => ({
      id1,
      atype,
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
