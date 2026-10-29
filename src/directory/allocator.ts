// The allocator decides where a new root object goes, and the placement controller decides when a
// vshard should move. Together they are the only thing that grows a database from one DO to many, and
// application code sees neither.
//
// A root hashes an affinity key into the active set, so the founding data spreads from the first write
// and the controller has something to peel off on day one. `with` overrides it and forces the parent's
// vshard, which is the only capacity limit developers see, and only if they opt in.

import { MAX_VSHARD } from "../host/ids.ts";
import type { VshardStats } from "../host/host.ts";
import type { Directory } from "./directory.ts";

export const USAGE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS usage (
     vshard   INTEGER PRIMARY KEY,
     bytes    INTEGER NOT NULL DEFAULT 0,
     requests INTEGER NOT NULL DEFAULT 0,
     objects  INTEGER NOT NULL DEFAULT 0
   )`,
];

/** A vshard's soft size cap. Set by move time, not storage: a stop-the-world move pauses the vshard's
 *  writes for the whole copy. */
export const VSHARD_CAP = 1024 * 1024 * 1024;

export interface AllocatorOptions {
  /** The soft cap. A vshard stops taking new roots at half of it, keeping the rest for colocated
   *  children of objects already in it. */
  cap?: number;
  /** Installs a newly opened vshard on its host. A host receives vshards and never mints them, so a
   *  vshard the directory has assigned does not exist until its host has been told. */
  open?: (vshard: bigint, host: number, epoch: number) => void;
}

export class NoRoom extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoRoom";
  }
}

export class Allocator {
  readonly directory: Directory;
  readonly cap: number;
  readonly #open: (vshard: bigint, host: number, epoch: number) => void;

  constructor(directory: Directory, opts: AllocatorOptions = {}) {
    this.directory = directory;
    this.cap = opts.cap ?? VSHARD_CAP;
    this.#open = opts.open ?? (() => {});
    for (const stmt of USAGE_DDL) directory.sql.run(stmt);
  }

  /** Vshards still taking new roots: assigned, below half the byte cap, and not an index vshard.
   *  Index vshards are their own, so placing a root in one would tie a hot index to unrelated data and
   *  make either impossible to move without the other. */
  active(): bigint[] {
    const rows = this.directory.sql.all<{ vshard: number }>(
      "SELECT a.vshard AS vshard FROM assignments a LEFT JOIN usage u ON u.vshard = a.vshard" +
        " WHERE COALESCE(u.bytes, 0) < ? ORDER BY a.vshard",
      Math.floor(this.cap / 2),
    );
    const reserved = new Set(this.directory.indexVshards().map(String));
    return rows.map((r) => BigInt(r.vshard)).filter((v) => !reserved.has(v.toString()));
  }

  /** Where a new root goes. The affinity key is whatever groups objects that get read together: a
   *  tenant, an owning user, or the creating request's own root. Objects sharing one land in one
   *  vshard, so they stay on one host as the database spreads. */
  place(affinity?: string): bigint {
    let set = this.active();
    if (set.length === 0) set = this.grow();
    if (set.length === 0) throw new NoRoom("every vshard is full and the vshard space is exhausted");
    const i = affinity === undefined ? Math.floor(Math.random() * set.length) : hash(affinity) % set.length;
    return set[i];
  }

  /** Opens the next batch of vshards when the active set empties. A batch, not one vshard: opening one
   *  would funnel every create in the database onto one vshard on one host. */
  grow(): bigint[] {
    // Past the highest vshard in use, not past the count: assignments need not be contiguous once
    // anything has been reassigned.
    const highest = this.directory.sql.all<{ hi: number | null }>("SELECT MAX(vshard) AS hi FROM assignments")[0]?.hi;
    const from = highest === null || highest === undefined ? 0n : BigInt(highest) + 1n;
    const batch = BigInt(this.directory.batch);
    const opened: { vshard: bigint; host: number }[] = [];
    this.directory.sql.txn(() => {
      for (let i = 0n; i < batch; i++) {
        const v = from + i;
        if (v > MAX_VSHARD) break;
        if (this.directory.resolve(v)) continue;
        // A new vshard goes to the host with the least on it. Hosts receive vshards; they never mint
        // them, so this opens no host of its own.
        const host = this.#emptiest();
        this.directory.assign(v, host, 0);
        opened.push({ vshard: v, host });
      }
    });
    for (const o of opened) this.#open(o.vshard, o.host, 0);
    return opened.map((o) => o.vshard);
  }

  /** Records what the hosts reported, which is what makes a vshard leave the active set. */
  observe(stats: Iterable<VshardStats>): void {
    this.directory.sql.txn(() => {
      for (const s of stats) {
        this.directory.sql.run(
          "INSERT INTO usage (vshard, bytes, requests, objects) VALUES (?, ?, ?, ?)" +
            " ON CONFLICT (vshard) DO UPDATE SET bytes = excluded.bytes, objects = excluded.objects," +
            " requests = usage.requests + excluded.requests",
          Number(BigInt(s.vshard)),
          s.bytes,
          s.requests,
          s.objects,
        );
      }
    });
  }

  usage(vshard: bigint): { bytes: number; requests: number; objects: number } {
    return (
      this.directory.sql.all<{ bytes: number; requests: number; objects: number }>(
        "SELECT bytes, requests, objects FROM usage WHERE vshard = ?",
        Number(vshard),
      )[0] ?? { bytes: 0, requests: 0, objects: 0 }
    );
  }

  /** Clears the request counters, so a controller's window starts fresh. */
  resetRequests(): void {
    this.directory.sql.run("UPDATE usage SET requests = 0");
  }

  #emptiest(): number {
    const rows = this.directory.sql.all<{ host: number; bytes: number }>(
      "SELECT h.host AS host, COALESCE(SUM(u.bytes), 0) AS bytes FROM hosts h" +
        " LEFT JOIN assignments a ON a.host = h.host LEFT JOIN usage u ON u.vshard = a.vshard" +
        " GROUP BY h.host ORDER BY bytes ASC, h.host ASC LIMIT 1",
    );
    return rows[0]?.host ?? 0;
  }
}

/** FNV-1a. An affinity key only has to spread evenly; nothing here depends on it being unguessable. */
export function hash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}
