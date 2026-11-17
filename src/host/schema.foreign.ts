// The shape a reference into another database would take, as DDL, applied by nothing.
//
// `docs/global-ids.md` owns the reasoning and the readings; this file exists so the shape is
// reviewable and typechecked rather than only described, and so that whoever next edits `assocs`
// or the directory's tables finds it.
//
// DELIBERATELY NOT SPLICED INTO EITHER `DDL`. `migrate` runs `CREATE TABLE IF NOT EXISTS`, so
// adding these to `host/schema.ts` and `directory/directory.ts` would leave existing hosts on the
// old shape while new databases took the new one. Nothing would fail — every read and write names
// its columns — so the fleet would diverge silently, which is what principle 7 exists to prevent.
//
// Two live reasons to wait, beyond that one. `docs/wikimedia-plan.md`'s bulk-import oracle rests on a fourth
// simplewiki database, loaded through the bulk path, being comparable row for row against the two
// loaded through the mutation path; a different primary key ends that comparison. And the enwiki
// placement decision in step 3 is irreversible and is made against figures a wider row moves by the
// measured 1.019x. So this lands after step 1's reading, not before.

/**
 * `assocs`, with the target's database in the key. A REPLACEMENT for the entry in `host/schema.ts`'s
 * `DDL`, not an addition to it.
 *
 * `(db, id2)` is the 128-bit global id with the prefix interned: a foreign `id2` is the remote
 * database's own 8-byte id, so the pair costs a varint plus 8 bytes rather than 16. `db` sits before
 * `id2` so that a local object's edges group by target database, making "every edge from X into
 * database 7" a range scan; both orders measure identically on storage.
 *
 * The discriminator has to be IN the key. On `(id1, atype, id2)` alone, an edge to id 5 in one
 * database and an edge to id 5 in another collide, and the write path's `INSERT OR REPLACE` would
 * drop the first with no error and no change to its count.
 */
export const FOREIGN_ASSOCS_DDL: readonly string[] = [
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
  // with it, which is about half of the measured 1.019x.
  `CREATE INDEX IF NOT EXISTS assocs_range ON assocs (id1, atype, time)`,
];

/**
 * The alias registry, which would be APPENDED to `directory/directory.ts`'s `DDL`. One per database,
 * beside the catalog and distributed the same way, because an alias must mean one thing on every
 * host and a host can hold an edge into any foreign database.
 *
 * THE URI IS THE IDENTIFIER, and the alias is local shorthand for it — it never leaves this database,
 * so two databases may number the same foreign one differently and nothing coordinates them. That is
 * what makes the graph open: a URI is mintable before the database behind it exists, creating one
 * needs no registry round trip, and anyone serving the protocol at a URI can be referenced without
 * asking an authority for a number.
 *
 * An earlier revision put a separately allocated identity beside the URI and keyed the registry on
 * that, because a URI can be reassigned and an alias bound to one can come to mean another database.
 * The hazard is real; that answer was not, since it reintroduces the central allocator the whole
 * design exists to avoid. `pinned` is the answer instead: record what the database proved about
 * itself when it was interned and check it on later contact, trust on first use rather than a naming
 * authority. A mismatch moves the row to `repudiated` and reads through the alias fail, rather than
 * quietly returning a stranger's objects under an edge that meant someone else.
 *
 * An alias is never repointed: `state` tombstones rather than deleting, and the next alias comes from
 * a counter in `meta` rather than `MAX(alias) + 1`, which is only accidentally correct while nothing
 * is purged. That rule is also what lets a host store an alias without validating it — a stale client
 * can only name one already allocated, so the worst case is a dangling reference, which the read path
 * already drops.
 *
 * What this costs: URI canonicalization becomes load-bearing. Scheme, host case, default port,
 * trailing slash, percent-encoding and fragments all have to be settled before the unique index means
 * anything, or two spellings of one database become two aliases and it does not notice.
 */
export const FOREIGN_DBS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS foreign_dbs (
     alias  INTEGER PRIMARY KEY CHECK (alias > 0), -- 0 means local and is never allocated
     uri    TEXT    NOT NULL,                      -- the identifier, canonicalized before it lands
     pinned BLOB,                                  -- what it proved about itself; NULL until reached
     state  TEXT    NOT NULL,                      -- 'live'|'unreachable'|'repudiated'|'tombstoned'
     added  INTEGER NOT NULL,
     seen   INTEGER                                 -- when the pin was last confirmed
   )`,

  // So that one foreign database interns exactly once, and an alias is permanently bound to its URI.
  `CREATE UNIQUE INDEX IF NOT EXISTS foreign_dbs_uri ON foreign_dbs (uri)`,
];
