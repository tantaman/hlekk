// The directory DO: one per database. It says where a vshard probably is, holds the schema catalog,
// and drives vshard moves. It is consulted only on a route-cache miss.
//
// The authoritative map is one row per vshard. Runs are computed when a chunk is published, which is
// the only place their shape matters, and keeps assignment from needing a split-and-merge protocol.

import { Catalog, CatalogError } from "../catalog/catalog.ts";
import type { Lock } from "../catalog/catalog.ts";
import { MAX_VSHARD, VSHARD_BITS } from "../host/ids.ts";
import { CURRENT_FORMAT, FormatError } from "../host/schema.ts";
import type { StorageFormat } from "../host/schema.ts";
import type { Sql } from "../host/sql.ts";
import { canonicalDb } from "../query/ref.ts";
import { ALG, generateKeyPair, signRotation } from "../protocol/identity.ts";
import type { KeyPair, PublicKey } from "../protocol/identity.ts";
import { SPAN, chunkBase, chunkOf, encodeChunk, runs } from "./map.ts";
import type { Route } from "./map.ts";

export const DDL: readonly string[] = [
  // One row per vshard: its host and the epoch it is served at.
  `CREATE TABLE IF NOT EXISTS assignments (
     vshard INTEGER PRIMARY KEY,
     host   INTEGER NOT NULL,
     epoch  INTEGER NOT NULL
   )`,
  // Region and jurisdiction are fixed at creation, since a DO never relocates.
  `CREATE TABLE IF NOT EXISTS hosts (
     host         INTEGER PRIMARY KEY,
     region       TEXT,
     jurisdiction TEXT,
     -- What the host's database really occupies, as it last reported. NULL until it has been asked.
     bytes        INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS catalog (
     version INTEGER PRIMARY KEY,
     lock    TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS meta (
     k TEXT PRIMARY KEY,
     v TEXT NOT NULL
   )`,

  /*
   * The other databases this one holds edges into, beside the catalog and distributed the same way,
   * because an alias must mean one thing on every host and any host can hold an edge into any of
   * them. Appended rather than replacing anything, which is what makes it safe on a directory that
   * already exists: it only adds a table.
   *
   * THE URI IS THE IDENTIFIER, and the alias is local shorthand that never leaves this database —
   * two databases may number the same foreign one differently and nothing coordinates them. That is
   * what makes the graph open: a URI is mintable before the database behind it exists, creating a
   * database needs no registry round trip, and anyone serving the protocol at a URI can be
   * referenced without asking an authority for a number. An earlier draft allocated an identity
   * beside the URI and keyed on that, because a URI can be reassigned; that answer reintroduced the
   * central allocator the whole design exists to avoid (`docs/global-ids.md`).
   *
   * `pinned` is the answer to reassignment instead: what the database proved about itself when it
   * was interned, checked on later contact. Trust on first use rather than a naming authority. A
   * mismatch moves the row to `repudiated` and reads through the alias fail, rather than quietly
   * returning a stranger's objects under an edge that meant someone else. Step 5 fills it; until
   * then it is NULL and nothing reads it.
   *
   * An alias is never repointed. `state` tombstones rather than deleting, and the next alias comes
   * from a counter in `meta` and not from `MAX(alias) + 1`, which is only accidentally correct while
   * nothing is ever purged — and apply already contemplates purging tombstoned catalog names. That
   * rule is also what lets a host store an alias without validating it: a stale client can only name
   * one already allocated, and an allocated alias always means the same URI, so the worst case is an
   * edge into a database that is gone — a dangling reference, which the read path already drops.
   */
  `CREATE TABLE IF NOT EXISTS foreign_dbs (
     alias  INTEGER PRIMARY KEY CHECK (alias > 0), -- 0 means local and is never allocated
     uri    TEXT    NOT NULL,                      -- the identifier, canonicalized before it lands
     pinned TEXT,                                  -- the id of the key it proved; NULL until reached
     state  TEXT    NOT NULL,                      -- 'live'|'unreachable'|'repudiated'|'tombstoned'
     added  INTEGER NOT NULL,
     seen   INTEGER                                -- when the pin was last confirmed
   )`,

  // So that one foreign database interns exactly once, and an alias is permanently bound to its URI.
  `CREATE UNIQUE INDEX IF NOT EXISTS foreign_dbs_uri ON foreign_dbs (uri)`,

  /*
   * This database's own signing keys, newest last. The private half never leaves the deployment: a
   * coordinator isolate reads it once and signs with it, and nothing else ever asks for it.
   *
   * Several rows rather than one, because rotation is the part that gets skipped and pinning without
   * it is a foot-gun. A rotated key carries the previous key's signature over it, so a caller holding
   * the old pin can walk forward without being told to trust the new key, and the previous key stays
   * listed through a grace window so that a caller who has not looked recently still can.
   *
   * `retired` NULL marks the current key, of which there is exactly one.
   */
  `CREATE TABLE IF NOT EXISTS keys (
     id        TEXT    PRIMARY KEY,   -- the digest of the public key, so the id is a fact about it
     alg       TEXT    NOT NULL,
     pub       TEXT    NOT NULL,      -- the raw public key, base64url
     seed      TEXT,                  -- the private half; NULL once it is only published, not used
     signed_by TEXT,                  -- the key this one replaces
     signature TEXT,                  -- that key's signature over this one
     created   INTEGER NOT NULL,
     retired   INTEGER                -- when it stopped being current; NULL for the current key
   )`,
];

/** The number of vshards a new database is created with. A floor, not a budget: it is how many hosts
 *  the founding data can ever spread across, and nothing divides a vshard later. */
export const INITIAL_VSHARDS = 64;

export interface DirectoryOptions {
  database: string;
  /** The initial vshard count, and the size of each later batch. */
  batch?: number;
  /** The canonical URI this database is linked to by. Recorded on creation; interning it is refused,
   *  since an edge into yourself is a local edge. */
  uri?: string;
  /** The storage format a NEW database is created with. An existing one keeps what it was created
   *  with, whatever this says. Only a test that wants the old shape passes 1. */
  format?: StorageFormat;
}

export class Directory {
  readonly database: string;
  readonly batch: number;
  readonly sql: Sql;
  #catalog: Catalog | null = null;

  private constructor(sql: Sql, opts: DirectoryOptions) {
    this.sql = sql;
    this.database = opts.database;
    this.batch = opts.batch ?? INITIAL_VSHARDS;
  }

  /** Opens a database, creating its first batch of vshards on one host if it is new. A database with
   *  two rows therefore costs one host DO and one chunk. */
  static open(sql: Sql, opts: DirectoryOptions): Directory {
    for (const stmt of DDL) sql.run(stmt);
    const d = new Directory(sql, opts);
    if (d.#count() === 0) {
      // A new database. Its storage format is recorded now and never changes: absent means 1, so
      // every database that existed before this code is format 1 by the absence of this row, and
      // every one created from now on says so explicitly.
      d.setMeta("storageFormat", String(opts.format ?? CURRENT_FORMAT));
      d.addHost(0);
      d.assignMany([...Array(d.batch)].map((_, v) => ({ vshard: BigInt(v), host: 0, epoch: 0 })));
    }
    if (opts.uri !== undefined) d.setDatabaseUri(opts.uri);
    return d;
  }

  // ---- the storage format, and the registry of databases this one references

  /** The format this database's hosts key `assocs` with. Absent means 1, which is what every
   *  database created before the column existed is. */
  storageFormat(): StorageFormat {
    return this.#meta("storageFormat") === "2" ? 2 : 1;
  }

  /** The URI this database is linked to by, or undefined when it has not been told one. */
  databaseUri(): string | undefined {
    return this.#meta("databaseUri");
  }

  setDatabaseUri(uri: string): void {
    const canonical = canonicalDb(uri);
    const held = this.databaseUri();
    if (held !== undefined && held !== canonical) {
      // The URI is the identity, and a database that answered at one name and now answers at
      // another is, to everyone holding an edge into it, a different database.
      throw new FormatError(`this database is ${held} and cannot be renamed to ${canonical}`);
    }
    if (this.aliasOf(canonical) !== undefined) {
      throw new FormatError(`${canonical} is already interned here as a foreign database`);
    }
    this.setMeta("databaseUri", canonical);
  }

  /** The alias a URI already has here, or undefined. */
  aliasOf(uri: string): number | undefined {
    return this.sql.all<{ alias: number }>("SELECT alias FROM foreign_dbs WHERE uri = ?", canonicalDb(uri))[0]?.alias;
  }

  /** The URI an alias means, or undefined when it was never allocated. */
  uriOf(alias: number): string | undefined {
    return this.sql.all<{ uri: string }>("SELECT uri FROM foreign_dbs WHERE alias = ?", alias)[0]?.uri;
  }

  /**
   * The alias for a foreign database, allocating one on first sight.
   *
   * Canonicalizes first and refuses a spelling that is not canonical rather than repairing it:
   * `foreign_dbs_uri` is a unique index over the text, so two spellings of one database would be two
   * aliases and it would not notice (`query/ref.ts`).
   *
   * The alias comes from a counter in `meta`, not from `MAX(alias) + 1`. The two agree only while
   * nothing is ever purged, and a purged row whose number came back would silently repoint every
   * edge that still named it — the same hazard as reusing a catalog integer, and the same answer.
   */
  intern(uri: string, now = 0): number {
    const canonical = canonicalDb(uri);
    if (canonical === this.databaseUri()) {
      throw new FormatError(
        `${canonical} is this database, and an edge into yourself is a local edge.` +
          " The client collapses a reference to its own database to a bare id before it gets here.",
      );
    }
    return this.sql.txn(() => {
      const held = this.aliasOf(canonical);
      if (held !== undefined) return held;
      const next = Number(this.#meta("nextAlias") ?? "1");
      this.sql.run(
        "INSERT INTO foreign_dbs (alias, uri, state, added) VALUES (?, ?, 'live', ?)",
        next,
        canonical,
        now,
      );
      this.setMeta("nextAlias", String(next + 1));
      return next;
    });
  }

  /** Every alias this database has allocated, in allocation order. The coordinator resolves a
   *  foreign hop through this; a host stores the number and never looks one up. */
  aliases(): { alias: number; uri: string; state: string }[] {
    return this.sql.all<{ alias: number; uri: string; state: string }>(
      "SELECT alias, uri, state FROM foreign_dbs ORDER BY alias",
    );
  }

  // ---- identity

  /**
   * This database's current key pair, generating one the first time it is asked for.
   *
   * On first use rather than at creation, which amounts to the same thing for a database that is
   * ever linked to and costs nothing for one that is not. Not because an empty database has to be
   * free — one deployment is one database, so nobody is counting the empty ones — but because a key
   * is the one piece of per-database state that is expensive to generate and pointless to have
   * before anything asks for it.
   */
  #keyWork: Promise<void> = Promise.resolve();

  #serializeKeys<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#keyWork.then(work);
    this.#keyWork = result.then(() => {}, () => {});
    return result;
  }

  identity(now = 0): Promise<KeyPair> {
    return this.#serializeKeys(() => this.#identity(now));
  }

  async #identity(now: number): Promise<KeyPair> {
    const row = this.sql.all<{ id: string; pub: string; seed: string | null }>(
      "SELECT id, pub, seed FROM keys WHERE retired IS NULL ORDER BY created DESC LIMIT 1",
    )[0];
    if (row?.seed != null) return { public: { id: row.id, alg: ALG, key: row.pub }, seed: row.seed };
    const pair = await generateKeyPair();
    this.#storeKey(pair, now, undefined);
    return pair;
  }

  /** Every key this database publishes, oldest first. A retired one stays here through its grace
   *  window, because a caller holding a pin on it needs it present to walk forward from. */
  publishedKeys(): PublicKey[] {
    return this.sql
      .all<{ id: string; alg: string; pub: string; signed_by: string | null; signature: string | null; retired: number | null }>(
        "SELECT id, alg, pub, signed_by, signature, retired FROM keys ORDER BY created, id",
      )
      .map((r) => ({
        id: r.id,
        alg: r.alg as typeof ALG,
        key: r.pub,
        ...(r.signed_by !== null && r.signature !== null ? { signedBy: { id: r.signed_by, signature: r.signature } } : {}),
        ...(r.retired !== null ? { retired: r.retired } : {}),
      }));
  }

  /** Rotates to a new key, signed by the one it replaces. The old key stays published and keeps its
   *  private half until it is pruned, so a request already in flight still verifies. */
  rotateKey(now = 0): Promise<PublicKey> {
    return this.#serializeKeys(() => this.#rotateKey(now));
  }

  async #rotateKey(now: number): Promise<PublicKey> {
    const current = await this.#identity(now);
    const next = await generateKeyPair();
    const signedBy = await signRotation(current.seed, next.public);
    this.sql.txn(() => {
      this.sql.run("UPDATE keys SET retired = ? WHERE id = ?", now, current.public.id);
      this.#storeKey(next, now, signedBy);
    });
    return { ...next.public, signedBy };
  }

  /** Drops a retired key's private half and then the key itself, once its grace window has passed.
   *  Returns how many were dropped. A caller pinned on a pruned key is repudiated on next contact,
   *  which is the cost of the window being finite and the reason it should not be short. */
  pruneKeys(now: number, graceMs: number): number {
    const cutoff = now - graceMs;
    const gone = this.sql.all<{ id: string }>("SELECT id FROM keys WHERE retired IS NOT NULL AND retired < ?", cutoff);
    for (const k of gone) this.sql.run("DELETE FROM keys WHERE id = ?", k.id);
    return gone.length;
  }

  #storeKey(pair: KeyPair, now: number, signedBy: PublicKey["signedBy"]): void {
    this.sql.run(
      "INSERT OR REPLACE INTO keys (id, alg, pub, seed, signed_by, signature, created, retired)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
      pair.public.id,
      pair.public.alg,
      pair.public.key,
      pair.seed,
      signedBy?.id ?? null,
      signedBy?.signature ?? null,
      now,
    );
  }

  // ---- pins

  /** The key id this database recorded for another, or undefined if it has never reached it. */
  pinnedOf(uri: string): string | undefined {
    const row = this.sql.all<{ pinned: string | null }>("SELECT pinned FROM foreign_dbs WHERE uri = ?", canonicalDb(uri))[0];
    return row?.pinned ?? undefined;
  }

  stateOf(uri: string): string | undefined {
    return this.sql.all<{ state: string }>("SELECT state FROM foreign_dbs WHERE uri = ?", canonicalDb(uri))[0]?.state;
  }

  /**
   * Records what a database proved about itself, interning it if it has no row yet.
   *
   * The registry is symmetric: this database pins B's key when it interns B, and pins A's key when A
   * first calls — one table, as `docs/protocol.md` says, with only the alias outbound-only. Pinning
   * an inbound caller therefore spends an alias on it, which is a number this database may never
   * write an edge under. That is the price of one table instead of two, and it is small: an integer,
   * and a caller a policy distinguishes is one this database has a relationship with anyway.
   */
  pin(uri: string, keyId: string, now = 0): void {
    const canonical = canonicalDb(uri);
    this.sql.txn(() => {
      if (this.aliasOf(canonical) === undefined) this.intern(canonical, now);
      this.sql.run("UPDATE foreign_dbs SET pinned = ?, seen = ?, state = 'live' WHERE uri = ?", keyId, now, canonical);
    });
  }

  /** The database at this URI answered with a key its pin cannot reach. Reads through the alias fail
   *  from here on, rather than quietly returning a stranger's objects under an edge that meant
   *  someone else. */
  repudiate(uri: string): void {
    this.sql.run("UPDATE foreign_dbs SET state = 'repudiated' WHERE uri = ?", canonicalDb(uri));
  }

  /** Only an operator un-repudiates, which is why this is a method and not a code path. It clears
   *  the pin as well: whatever is at that URI now has to prove itself from scratch. */
  unrepudiate(uri: string): void {
    this.sql.run("UPDATE foreign_dbs SET state = 'live', pinned = NULL WHERE uri = ?", canonicalDb(uri));
  }

  // ---- routing

  resolve(vshard: bigint): Route | undefined {
    const row = this.sql.all<{ host: number; epoch: number }>(
      "SELECT host, epoch FROM assignments WHERE vshard = ?",
      Number(vshard),
    )[0];
    return row ? { host: row.host, epoch: row.epoch } : undefined;
  }

  /** The DO name of a host. Derived from the index, so the map never carries a name table, and scoped
   *  by database so many databases can share one DO namespace. */
  hostName(host: number): string {
    return `${this.database}/h-${host}`;
  }

  addHost(host: number, region?: string, jurisdiction?: string): void {
    this.sql.run(
      "INSERT INTO hosts (host, region, jurisdiction) VALUES (?, ?, ?) ON CONFLICT (host) DO NOTHING",
      host,
      region ?? null,
      jurisdiction ?? null,
    );
  }

  /** Records what a host reports it really occupies. The per-vshard shares cannot be summed to this,
   *  so it is kept per host and not derived. */
  observeHostBytes(host: number, bytes: number): void {
    this.sql.run("UPDATE hosts SET bytes = ? WHERE host = ?", bytes, host);
  }

  /** What a host last reported it occupies, or null if it has never been asked. */
  hostBytes(host: number): number | null {
    const row = this.sql.all<{ bytes: number | null }>("SELECT bytes FROM hosts WHERE host = ?", host)[0];
    return row?.bytes ?? null;
  }

  hostIndexes(): number[] {
    return this.sql.all<{ host: number }>("SELECT host FROM hosts ORDER BY host").map((r) => r.host);
  }

  /** The next free host index. */
  nextHost(): number {
    const row = this.sql.all<{ next: number }>("SELECT COALESCE(MAX(host), -1) + 1 AS next FROM hosts")[0];
    return row?.next ?? 0;
  }

  /** Hosts in increasing order of what they hold, which is the order a new batch fills them in. The
   *  host's own figure where it has reported one, since that is what the per-DO limit is enforced on;
   *  the sum of its vshards' shares until then. */
  hostsByLoad(): number[] {
    return this.sql
      .all<{ host: number }>(
        "SELECT h.host AS host, COALESCE(h.bytes, SUM(u.bytes), 0) AS bytes FROM hosts h" +
          " LEFT JOIN assignments a ON a.host = h.host LEFT JOIN usage u ON u.vshard = a.vshard" +
          " GROUP BY h.host ORDER BY bytes ASC, h.host ASC",
      )
      .map((r) => r.host);
  }

  vshardsOn(host: number): bigint[] {
    return this.sql
      .all<{ vshard: number }>("SELECT vshard FROM assignments WHERE host = ? ORDER BY vshard", host)
      .map((r) => BigInt(r.vshard));
  }

  /** Points a vshard at a host at a given epoch. The move protocol compare-and-sets through this. */
  assign(vshard: bigint, host: number, epoch: number): void {
    this.assignMany([{ vshard, host, epoch }]);
  }

  /** Points many vshards at hosts in one transaction, bumping the map version once. Opening a batch
   *  one row at a time costs a map bump per row, which for a batch is most of the work. */
  assignMany(entries: readonly { vshard: bigint; host: number; epoch: number }[]): void {
    if (entries.length === 0) return;
    this.sql.txn(() => {
      for (const e of entries) this.#assign(e.vshard, e.host, e.epoch);
      this.#bumpMap();
    });
  }

  // ---- the published map

  mapVersion(): number {
    return Number(this.#meta("mapVersion") ?? "0");
  }

  /** One chunk of the published map. Rebuilt from the assignments it covers, so publishing is a range
   *  scan of a few thousand rows and never blocks the directory on the whole map. */
  chunk(index: number): Uint8Array {
    const base = chunkBase(index);
    const rows = this.sql.all<{ vshard: number; host: number; epoch: number }>(
      "SELECT vshard, host, epoch FROM assignments WHERE vshard >= ? AND vshard < ? ORDER BY vshard",
      Number(base),
      Number(base) + SPAN,
    );
    return encodeChunk(
      index,
      this.mapVersion(),
      runs(
        index,
        rows.map((r) => ({ vshard: BigInt(r.vshard), host: r.host, epoch: r.epoch })),
      ),
    );
  }

  /** Every chunk that holds an assignment, for a full publish. */
  chunkIndexes(): number[] {
    const rows = this.sql.all<{ vshard: number }>("SELECT MIN(vshard) AS lo, MAX(vshard) AS hi FROM assignments") as unknown as {
      lo: number | null;
      hi: number | null;
    }[];
    const { lo, hi } = rows[0] ?? { lo: null, hi: null };
    if (lo === null || hi === null) return [];
    const out: number[] = [];
    for (let i = chunkOf(BigInt(lo)); i <= chunkOf(BigInt(hi)); i++) out.push(i);
    return out;
  }

  // ---- global index vshards

  /** Vshards dedicated to global index entries. Their own, so a hot index does not drag a data vshard
   *  around with it, and either can move without the other. */
  indexVshards(): bigint[] {
    const raw = this.#meta("indexVshards");
    return raw ? (JSON.parse(raw) as string[]).map(BigInt) : [];
  }

  setIndexVshards(vshards: readonly bigint[]): void {
    this.setMeta("indexVshards", JSON.stringify(vshards.map(String)));
  }

  /** Where a value's entry lives. Every entry for one value has one home, which is what lets
   *  uniqueness be checked on a single host in a single transaction. */
  indexVshardFor(key: string): bigint {
    const set = this.indexVshards();
    if (set.length === 0) throw new Error("no index vshards have been opened for this database");
    return set[indexHash(key) % set.length];
  }

  // ---- the catalog

  /** Compare-and-sets the catalog from version N to N + 1, re-checking what it can. */
  applyLock(lock: Lock): Catalog {
    const current = this.catalog();
    if (lock.version !== current.version + 1) {
      throw new CatalogError(`lock is version ${lock.version}, but this database is at ${current.version}`);
    }
    const next = Catalog.compile(lock); // throws before anything is stored
    if (this.storageFormat() === 1) {
      const foreign = Object.entries(lock.edges).filter(([, e]) => e.foreign).map(([name]) => name);
      if (foreign.length > 0) {
        // A format 1 host has no column for the target's database, so the alias would be dropped and
        // the edge would read back as one into this database. Refused when the lock is applied,
        // because that is the last point at which nothing has been written against it.
        throw new FormatError(
          `${foreign.join(", ")} permit${foreign.length === 1 ? "s" : ""} foreign targets, and this database is` +
            " storage format 1, which has no column for the target's database. A vshard move onto format 2 is the" +
            " migration; there is no in-place upgrade (src/host/schema.ts).",
        );
      }
    }
    for (const name of current.lock.tombstones ?? []) {
      if (name in lock.objects || name in lock.edges) {
        throw new CatalogError(`${name} is tombstoned here and cannot be reused before a purge`);
      }
    }
    this.sql.run("INSERT INTO catalog (version, lock) VALUES (?, ?)", lock.version, JSON.stringify(lock));
    this.#catalog = next;
    return next;
  }

  catalog(): Catalog {
    if (!this.#catalog) {
      const row = this.sql.all<{ lock: string }>("SELECT lock FROM catalog ORDER BY version DESC LIMIT 1")[0];
      this.#catalog = row ? Catalog.compile(JSON.parse(row.lock) as Lock) : Catalog.empty();
    }
    return this.#catalog;
  }

  // ---- internals

  #count(): number {
    return this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM assignments")[0]?.n ?? 0;
  }

  #assign(vshard: bigint, host: number, epoch: number): void {
    if (vshard < 0n || vshard > MAX_VSHARD) throw new RangeError(`vshard out of range: ${vshard}`);
    this.sql.run(
      "INSERT INTO assignments (vshard, host, epoch) VALUES (?, ?, ?)" +
        " ON CONFLICT (vshard) DO UPDATE SET host = excluded.host, epoch = excluded.epoch",
      Number(vshard),
      host,
      epoch,
    );
  }

  #bumpMap(): void {
    this.sql.run(
      "INSERT INTO meta (k, v) VALUES ('mapVersion', '1')" +
        " ON CONFLICT (k) DO UPDATE SET v = CAST(CAST(meta.v AS INTEGER) + 1 AS TEXT)",
    );
  }

  #meta(k: string): string | undefined {
    return this.sql.all<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)[0]?.v;
  }

  meta(k: string): string | undefined {
    return this.#meta(k);
  }

  setMeta(k: string, v: string): void {
    this.sql.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", k, v);
  }

  /** How many vshards exist, for the allocator. */
  size(): number {
    return this.#count();
  }

  /** Guards against a vshard count the id layout cannot hold. */
  static get maxVshards(): bigint {
    return 1n << VSHARD_BITS;
  }
}

/** FNV-1a over the normalized value. It only has to spread evenly across the index vshards. */
export function indexHash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}
