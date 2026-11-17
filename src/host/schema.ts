// A host's tables. Five cover v1; a sixth, `changes`, is deferred. One vshard's rows in objects,
// assocs and assoc_counts form a single key range, because the vshard sits in the ids' high bits, so
// snapshotting a vshard for a move needs no extra column or index.
//
// A list, not one string: the seam runs one statement at a time, and splitting on ";" would cut a
// statement whose comment contains one.
//
// ---- two storage formats
//
// Format 1 is `assocs` keyed `(id1, atype, id2)`. Format 2 puts the target's database in the key:
// `(id1, atype, db, id2)`, where 0 is this database and anything else is an interned alias.
//
// **There is no in-place upgrade**, and that is a reading rather than a preference. `scripts/edge-order.mjs`
// prints all three, against SQLite's own query plans:
//
//   - On the new key, a page ordered `(time, db, id2)` is served by `assocs_range` directly, at the
//     head and after a cursor.
//   - On the new key, today's order `(time, id2)` needs a temporary b-tree for its last term. So a
//     host on format 2 cannot keep format 1's page query.
//   - `ALTER TABLE ADD COLUMN` works, but the new order then sorts the whole list in a temporary
//     b-tree. So a format 1 host cannot be given format 2's statements cheaply.
//
// Hence: two formats, each with its own statements, and a vshard move is the migration — a format 1
// snapshot installs into a format 2 host with every alias 0 (`docs/global-ids.md`). That waits on
// the chunked snapshot design.md owes.
//
// **The format is a recorded fact, not an inference.** The directory holds it in `meta`, where absent
// means 1, and a host detects its own from the shape of its `assocs` and refuses to open when the two
// disagree. Without that, `CREATE TABLE IF NOT EXISTS` would leave existing hosts on format 1 while
// new databases took format 2, every read and write would keep naming its columns, nothing would
// fail, and the fleet would diverge in silence. This turns that into a refusal with a reason, which
// is principle 7 applied to a schema change.

import { PLATFORM } from "../runtime/platform.ts";
import type { Sql } from "./sql.ts";

/** 1 is today's `assocs`; 2 puts the target's database in the key. */
export type StorageFormat = 1 | 2;

/** What a database created from now on is. An existing one keeps whatever it was created with. */
export const CURRENT_FORMAT: StorageFormat = 2;

/** The one table the two formats disagree about, and the index over it.
 *
 *  Format 1's text is byte for byte what it has always been, which is what keeps the loaded wiki
 *  databases untouched: a host opened on format 1 by this code issues no DDL it would not have
 *  issued before.
 *
 *  `db` sits before `id2` rather than after. Both orders measure identically, and this one groups a
 *  local object's edges by target database — so "every edge from X into database 7" is a range scan
 *  rather than a filter — and reads in the order the 128-bit global id composes.
 *
 *  The discriminator has to be IN the key. On `(id1, atype, id2)` alone, an edge to id 5 in one
 *  database and an edge to id 5 in another are one row, and the write path's upsert would drop the
 *  first with no error and no change to its count. That is the class of thing BLOB keys and
 *  principle 7 exist to make unrepresentable.
 */
const ASSOCS: Record<StorageFormat, readonly string[]> = {
  1: [
    `CREATE TABLE IF NOT EXISTS assocs (
     id1   BLOB    NOT NULL,
     atype INTEGER NOT NULL,
     id2   BLOB    NOT NULL,
     time  INTEGER NOT NULL,         -- sort key for range reads
     data  TEXT,
     PRIMARY KEY (id1, atype, id2)
   ) WITHOUT ROWID`,
    `CREATE INDEX IF NOT EXISTS assocs_range ON assocs (id1, atype, time)`,
  ],
  2: [
    `CREATE TABLE IF NOT EXISTS assocs (
     id1   BLOB    NOT NULL,
     atype INTEGER NOT NULL,
     db    INTEGER NOT NULL DEFAULT 0, -- 0 is this database; otherwise a never-repointed alias
     id2   BLOB    NOT NULL,           -- 8-byte big-endian u64, in the TARGET database's id space
     time  INTEGER NOT NULL,           -- sort key for range reads
     data  TEXT,
     PRIMARY KEY (id1, atype, db, id2)
   ) WITHOUT ROWID`,
    // Unchanged as a declaration. Its records carry the primary key as their suffix, so they widen
    // with it, which is about half of the measured 1.019x. `INTEGER` and not a fixed width: SQLite
    // spends no payload byte at all on integer 0, so a local edge pays the header and nothing else,
    // and there is no ceiling on how many foreign databases one database may reference.
    `CREATE INDEX IF NOT EXISTS assocs_range ON assocs (id1, atype, time)`,
  ],
};

/** The tables both formats share. */
const COMMON: readonly string[] = [
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

/** Every statement a host of this format issues, `assocs` in the position it has always been in. */
export function ddl(format: StorageFormat): readonly string[] {
  return [COMMON[0], COMMON[1], ...ASSOCS[format], ...COMMON.slice(2)];
}

/**
 * The format a host's `assocs` is already in, or null when it has none — which is a host that has
 * never been adopted, and so is told its format rather than detected.
 *
 * Probed by asking for the column rather than by reading `sqlite_master` or a pragma: a missing
 * column is a parse error on every SQLite, while which pragmas a platform exposes is a platform
 * question, and this has to give the same answer on a Durable Object as under node:sqlite.
 */
export function formatOf(sql: Sql): StorageFormat | null {
  try {
    sql.all("SELECT db FROM assocs LIMIT 0");
    return 2;
  } catch {
    // No `db` column, or no table at all. One more probe tells those apart.
  }
  try {
    sql.all("SELECT id2 FROM assocs LIMIT 0");
    return 1;
  } catch {
    return null;
  }
}

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

/**
 * Brings a host's schema up, and refuses when the format it is told disagrees with the one it holds.
 *
 * The refusal is the point. `CREATE TABLE IF NOT EXISTS` is silent about a table that already exists
 * in another shape, so a host carrying format 1 rows reached by format 2 statements would answer
 * reads and accept writes while meaning something else by the key — and nothing would fail until a
 * page came back in the wrong order or an upsert dropped an edge.
 */
export function migrate(sql: Sql, format: StorageFormat): void {
  const held = formatOf(sql);
  if (held !== null && held !== format) {
    throw new FormatError(
      `this host holds storage format ${held} and was opened as format ${format}.` +
        " There is no in-place upgrade: a vshard move is the migration, since the two formats key `assocs` differently" +
        " and neither can be given the other's statements cheaply (scripts/edge-order.mjs).",
    );
  }
  for (const stmt of ddl(format)) sql.run(stmt);
}

/** The host platform's row-size limit, and so the cap on an object payload. See
 *  `../runtime/platform.ts`. */
export const MAX_PAYLOAD = PLATFORM.rowBytes;
