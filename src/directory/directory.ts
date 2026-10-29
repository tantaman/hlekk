// The directory DO: one per database. It says where a vshard probably is, holds the schema catalog,
// and drives vshard moves. It is consulted only on a route-cache miss.
//
// The authoritative map is one row per vshard. Runs are computed when a chunk is published, which is
// the only place their shape matters, and keeps assignment from needing a split-and-merge protocol.

import { Catalog, CatalogError } from "../catalog/catalog.ts";
import type { Lock } from "../catalog/catalog.ts";
import { MAX_VSHARD, VSHARD_BITS } from "../host/ids.ts";
import type { Sql } from "../host/sql.ts";
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
     jurisdiction TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS catalog (
     version INTEGER PRIMARY KEY,
     lock    TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS meta (
     k TEXT PRIMARY KEY,
     v TEXT NOT NULL
   )`,
];

/** The number of vshards a new database is created with. A floor, not a budget: it is how many hosts
 *  the founding data can ever spread across, and nothing divides a vshard later. */
export const INITIAL_VSHARDS = 64;

export interface DirectoryOptions {
  database: string;
  /** The initial vshard count, and the size of each later batch. */
  batch?: number;
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
      d.addHost(0);
      d.sql.txn(() => {
        for (let v = 0; v < d.batch; v++) d.#assign(BigInt(v), 0, 0);
        d.#bumpMap();
      });
    }
    return d;
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

  hostIndexes(): number[] {
    return this.sql.all<{ host: number }>("SELECT host FROM hosts ORDER BY host").map((r) => r.host);
  }

  /** The next free host index. */
  nextHost(): number {
    const row = this.sql.all<{ next: number }>("SELECT COALESCE(MAX(host), -1) + 1 AS next FROM hosts")[0];
    return row?.next ?? 0;
  }

  vshardsOn(host: number): bigint[] {
    return this.sql
      .all<{ vshard: number }>("SELECT vshard FROM assignments WHERE host = ? ORDER BY vshard", host)
      .map((r) => BigInt(r.vshard));
  }

  /** Points a vshard at a host at a given epoch. The move protocol compare-and-sets through this. */
  assign(vshard: bigint, host: number, epoch: number): void {
    this.sql.txn(() => {
      this.#assign(vshard, host, epoch);
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
