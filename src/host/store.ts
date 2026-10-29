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

export class SqlStore implements Store {
  readonly sql: Sql;
  #owned: Set<bigint> | null = null;
  readonly #objects = new Map<Id, Obj | null>();
  readonly #lists: EdgeSegment[] = [];
  readonly #counts = new Map<string, number>();

  constructor(sql: Sql) {
    this.sql = sql;
  }

  /** Which vshards this host owns right now. Read once: a store serves one batch, which is one
   *  snapshot, so ownership cannot change underneath it. */
  owned(): Set<bigint> {
    if (!this.#owned) {
      const rows = this.sql.all<{ vshard: number }>("SELECT vshard FROM vshards WHERE state = 'owned'");
      this.#owned = new Set(rows.map((r) => BigInt(r.vshard)));
    }
    return this.#owned;
  }

  owns(id: Id): boolean {
    return this.owned().has(vshardOf(id));
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
