// A host's tables. Five cover v1; a sixth, `changes`, is deferred. One vshard's rows in objects,
// assocs and assoc_counts form a single key range, because the vshard sits in the ids' high bits, so
// snapshotting a vshard for a move needs no extra column or index.
//
// A list, not one string: the seam runs one statement at a time, and splitting on ";" would cut a
// statement whose comment contains one.

import type { Sql } from "./sql.ts";

export const DDL: readonly string[] = [
  // Which vshards this host owns, at which epoch, and the next id sequence.
  `CREATE TABLE IF NOT EXISTS vshards (
     vshard   INTEGER PRIMARY KEY,
     epoch    INTEGER NOT NULL,
     state    TEXT    NOT NULL,      -- 'owned' | 'fenced' | 'moved'
     next_seq INTEGER NOT NULL
   )`,

  // One row per object. JSON payload, capped at the platform's 2 MB row size.
  `CREATE TABLE IF NOT EXISTS objects (
     id      BLOB    PRIMARY KEY,    -- 8-byte big-endian u64
     otype   INTEGER NOT NULL,
     version INTEGER NOT NULL,
     data    TEXT    NOT NULL
   ) WITHOUT ROWID`,

  // Outbound edges of objects on this host. An edge into another database would put that
  // database in this key; see `schema.foreign.ts`, which nothing applies yet.
  `CREATE TABLE IF NOT EXISTS assocs (
     id1   BLOB    NOT NULL,
     atype INTEGER NOT NULL,
     id2   BLOB    NOT NULL,
     time  INTEGER NOT NULL,         -- sort key for range reads
     data  TEXT,
     PRIMARY KEY (id1, atype, id2)
   ) WITHOUT ROWID`,

  // Serves newest-first range reads.
  `CREATE INDEX IF NOT EXISTS assocs_range ON assocs (id1, atype, time)`,

  // Maintained with the edge write: COUNT(*) on a million-edge list would be O(n).
  `CREATE TABLE IF NOT EXISTS assoc_counts (
     id1   BLOB    NOT NULL,
     atype INTEGER NOT NULL,
     n     INTEGER NOT NULL,
     PRIMARY KEY (id1, atype)
   ) WITHOUT ROWID`,

  // Global index entries. A local index cannot answer "user by email": the coordinator does not know
  // which host to ask. Entries live in index vshards keyed by hash(value), so every entry for one
  // value has one home and uniqueness is enforced there, on one host, in one transaction.
  `CREATE TABLE IF NOT EXISTS index_entries (
     vshard INTEGER NOT NULL,      -- the index vshard this entry lives in
     idx    INTEGER NOT NULL,      -- which index
     key    TEXT    NOT NULL,      -- the normalized value
     id     BLOB,                  -- the object it points at; null while only reserved
     state  TEXT    NOT NULL,      -- 'reserved' | 'confirmed'
     at     INTEGER NOT NULL,      -- when it was reserved, for reclaiming it
     PRIMARY KEY (vshard, idx, key)
   ) WITHOUT ROWID`,

  // Inverse edges bound for other vshards, delivered by alarm.
  `CREATE TABLE IF NOT EXISTS outbox (
     vshard        INTEGER NOT NULL, -- source vshard; rows move with it
     seq           INTEGER NOT NULL,
     target_vshard INTEGER NOT NULL,
     op            TEXT    NOT NULL, -- JSON: add or remove an inverse edge
     PRIMARY KEY (vshard, seq)
   ) WITHOUT ROWID`,
];

export function migrate(sql: Sql): void {
  for (const stmt of DDL) sql.run(stmt);
}

/** The platform's row-size limit, and so the cap on an object payload. */
export const MAX_PAYLOAD = 2 * 1024 * 1024;
