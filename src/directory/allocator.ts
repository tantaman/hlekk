// The allocator decides where a new root object goes, and the placement controller decides when a
// vshard should move. Together they are the only thing that grows a database from one DO to many, and
// application code sees neither.
//
// A root hashes an affinity key into the active set, so the founding data spreads from the first write
// and the controller has something to peel off on day one. `with` overrides it and forces the parent's
// vshard, which is the only capacity limit developers see, and only if they opt in.

import { MAX_VSHARD } from "../host/ids.ts";
import { systemRandom } from "../runtime/runtime.ts";
import type { Random } from "../runtime/runtime.ts";
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

/** A vshard's soft size cap, set against the 10 GB per-DO storage limit rather than against move
 *  time. A vshard is allowed to fill most of a host because the answer to one that grows large is to
 *  give it a host of its own: shedding is for a host whose *several* vshards approach the limit
 *  together, and a lone vshard at the cap needs no destination because the cap is what stops it
 *  growing further.
 *
 *  The margin below 10 GB covers what no vshard owns — the `vshards` table, the freelist a delete
 *  leaves behind — and leaves the controller room to act before a write meets SQLITE_FULL, past which
 *  writes fail while reads and deletes keep working. DO bills storage in GB of 10^9 bytes, so this is
 *  9 GB in those terms and not in GiB.
 *
 *  The move pause this implies is accepted: a 9 GB stop-the-world copy is a long one, and the route
 *  out of it is the base of the database in R2 (`paged-storage.md`), not a smaller cap. What is NOT
 *  merely slow is the copy itself — `snapshot()` materializes a whole vshard as one JS object and
 *  `install()` replays it in a single transaction, which no 9 GB vshard survives. See the note on
 *  `Host.snapshot`. */
export const VSHARD_CAP = 9_000_000_000;

export interface AllocatorOptions {
  /** The soft cap. A vshard stops taking new roots at half of it, keeping the rest for colocated
   *  children of objects already in it. */
  cap?: number;
  /** Installs a newly opened vshard on its host. A host receives vshards and never mints them, so a
   *  vshard the directory has assigned does not exist until its host has been told. */
  open?: (vshard: bigint, host: number, epoch: number) => void;
  /** Where placement without an affinity key gets its chance. Seeded in tests, so a placement that
   *  went wrong can be replayed. */
  random?: Random;
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
  readonly #random: Random;

  constructor(directory: Directory, opts: AllocatorOptions = {}) {
    this.directory = directory;
    this.cap = opts.cap ?? VSHARD_CAP;
    this.#open = opts.open ?? (() => {});
    this.#random = opts.random ?? systemRandom;
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
    const i = affinity === undefined ? this.#random.int(set.length) : hash(affinity) % set.length;
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
    // Hosts in load order, read once. The vshards this opens are empty, so adding them cannot change
    // that order, and recomputing it per vshard made opening a batch quadratic.
    const hosts = this.directory.hostsByLoad();
    const opened: { vshard: bigint; host: number }[] = [];
    for (let i = 0n; i < batch; i++) {
      const v = from + i;
      if (v > MAX_VSHARD) break;
      if (this.directory.resolve(v)) continue;
      // Spread the batch across hosts, lightest first. Putting a whole batch on the emptiest host
      // would send every new root to one host, which is the mistake opening one vshard would have
      // made. Hosts receive vshards; they never mint them, so this opens no host of its own.
      opened.push({ vshard: v, host: hosts[opened.length % Math.max(1, hosts.length)] ?? 0 });
    }
    this.directory.assignMany(opened.map((o) => ({ ...o, epoch: 0 })));
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

}

/** FNV-1a. An affinity key only has to spread evenly; nothing here depends on it being unguessable. */
export function hash(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}
