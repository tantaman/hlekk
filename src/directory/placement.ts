// The placement controller. It watches what each host holds and moves vshards off the ones that are
// over a threshold, onto an underused host or a new one.
//
// It prefers a contiguous run. A run moves as one unit and so shares an epoch, which keeps it to one
// shard-map entry, where shedding scattered vshards costs an entry each; and because roots hash into
// the active set, the vshards in a batch fill at about the same rate, so a run is about as good a
// choice as the single largest or busiest one.
//
// It publishes once per rebalance, not once per move: a chunk rewritten per move is rate limited on
// classic KV and expensive on KV Instant.

import type { Allocator } from "./allocator.ts";
import type { Directory } from "./directory.ts";
import type { Mover } from "./move.ts";
import { shedBytes } from "../runtime/platform.ts";

export interface Thresholds {
  /** Bytes on one host before it sheds, against the host platform's storage limit. Measured on what
   *  the engine reports it occupies, not on a sum of payloads: see `VshardStats`. */
  bytes?: number;
  /** Requests per window on one host before it sheds, against the platform's per-host request rate. */
  requests?: number;
}

export const DEFAULT_THRESHOLDS: Required<Thresholds> = {
  // Close to the platform's per-host storage limit, leaving room for the shed to run before a write
  // meets SQLITE_FULL. It sits BELOW a single vshard's cap, so a lone vshard grown past it trips the
  // threshold with nothing to shed — not something a move can help, and `pickRun` declines it rather
  // than renaming the host.
  bytes: shedBytes(),
  // Still a guess, not a derivation: this is a count per window where the platform's figure is a rate,
  // and nothing has calibrated the window. See design.md's open question on the request threshold.
  requests: 500_000,
};

export interface HostLoad {
  host: number;
  bytes: number;
  requests: number;
  vshards: bigint[];
  /** Whether `bytes` is the host's own figure. False means it has not reported since it was created,
   *  so `bytes` is the sum of its vshards' shares instead — a smaller unit, and smaller by a factor
   *  that depends on the rows. A host in that state holds either nothing or only what this rebalance
   *  just gave it, so reading it as near-empty is right; but the two are not comparable figures and
   *  anything reporting them should say which it has. */
  reported: boolean;
}

export interface Shed {
  vshards: bigint[];
  from: number;
  to: number;
  why: "bytes" | "requests";
}

export class Placement {
  readonly directory: Directory;
  readonly allocator: Allocator;
  readonly mover: Mover;
  readonly thresholds: Required<Thresholds>;

  constructor(directory: Directory, allocator: Allocator, mover: Mover, thresholds: Thresholds = {}) {
    this.directory = directory;
    this.allocator = allocator;
    this.mover = mover;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /** What each host holds, from what the allocator last recorded.
   *
   *  `bytes` is the host's own report of what its database occupies, which is the figure the 10 GB
   *  per-DO limit is enforced on, falling back to the sum of its vshards' shares for a host that has
   *  not reported yet. Summing the shares alone would undercount real storage by up to 4.7x and so
   *  shed too late — after SQLITE_FULL, where writes fail and a delete is the only way back. */
  load(): HostLoad[] {
    return this.directory.hostIndexes().map((host) => {
      const vshards = this.directory.vshardsOn(host);
      let shares = 0;
      let requests = 0;
      for (const v of vshards) {
        const u = this.allocator.usage(v);
        shares += u.bytes;
        requests += u.requests;
      }
      const reported = this.directory.hostBytes(host);
      return { host, bytes: reported ?? shares, requests, vshards, reported: reported !== null };
    });
  }

  /** What it would move, without moving it. */
  decide(): Shed[] {
    const loads = this.load();
    const out: Shed[] = [];
    // Hosts that could take work, lightest first, so one rebalance does not pile onto one host.
    const taking = new Map(loads.map((l) => [l.host, { bytes: l.bytes, requests: l.requests }]));
    let nextHost = this.directory.nextHost();

    for (const l of loads.sort((a, b) => b.bytes - a.bytes)) {
      const why = l.bytes > this.thresholds.bytes ? "bytes" : l.requests > this.thresholds.requests ? "requests" : null;
      if (!why) continue;
      const weight = (v: bigint) => (why === "bytes" ? this.allocator.usage(v).bytes : this.allocator.usage(v).requests);

      // Two units meet here. A host's `bytes` is what its engine reports, and a vshard's weight is
      // the share its rows account for, which is smaller by a factor that depends on those rows. So
      // thresholds and destinations are decided in the host's unit, `pickRun` chooses in shares, and
      // these convert between them by the ratio this host currently shows. For requests there is one
      // unit and both are the identity.
      const shares = l.vshards.reduce((n, v) => n + this.allocator.usage(v).bytes, 0);
      const convertible = why === "bytes" && shares > 0 && l.bytes > 0;
      const toShares = (n: number) => (convertible ? Math.ceil(n * (shares / l.bytes)) : n);
      const toHost = (n: number) => (convertible ? Math.round(n * (l.bytes / shares)) : n);

      const over = (why === "bytes" ? l.bytes - this.thresholds.bytes : l.requests - this.thresholds.requests);
      // Shed enough to come back under, plus a margin, so it does not trip again immediately.
      const target = Math.ceil(over + (why === "bytes" ? this.thresholds.bytes : this.thresholds.requests) * 0.1);
      const picked = pickRun(l.vshards, weight, toShares(target));
      if (picked.length === 0 || picked.length === l.vshards.length) continue; // nothing to shed, or it is one vshard

      const moved = picked.reduce((n, v) => n + weight(v), 0);
      const to = this.#destination(taking, toHost(moved), why, () => nextHost++);
      if (to === l.host) continue;
      out.push({ vshards: picked, from: l.host, to, why });
      const here = taking.get(l.host)!;
      if (why === "bytes") here.bytes -= toHost(moved);
      else here.requests -= moved;
    }
    return out;
  }

  /** Moves what is over threshold, then publishes the map once. */
  async rebalance(publish?: () => Promise<void>): Promise<Shed[]> {
    const sheds = this.decide();
    for (const shed of sheds) {
      this.directory.addHost(shed.to);
      for (const v of shed.vshards) {
        this.mover.begin(v, shed.to);
        await this.mover.run(v);
      }
    }
    if (sheds.length > 0 && publish) await publish();
    return sheds;
  }

  /** An existing host with room, or a new one. */
  #destination(
    taking: Map<number, { bytes: number; requests: number }>,
    weight: number,
    why: "bytes" | "requests",
    fresh: () => number,
  ): number {
    const limit = why === "bytes" ? this.thresholds.bytes : this.thresholds.requests;
    const candidates = [...taking]
      .filter(([, l]) => (why === "bytes" ? l.bytes : l.requests) + weight <= limit)
      .sort((a, b) => (why === "bytes" ? a[1].bytes - b[1].bytes : a[1].requests - b[1].requests));
    if (candidates.length > 0) {
      const [host, load] = candidates[0];
      if (why === "bytes") load.bytes += weight;
      else load.requests += weight;
      return host;
    }
    const host = fresh();
    taking.set(host, why === "bytes" ? { bytes: weight, requests: 0 } : { bytes: 0, requests: weight });
    return host;
  }
}

/** What to shed from one host: a contiguous prefix of one of its runs.
 *
 *  A prefix, because the vshards left behind stay contiguous, so the map gains no entry beyond the one
 *  the move itself costs. Among the prefixes that cover `target`, the fewest vshards wins, since each
 *  one is a stop-the-world pause, and then the least excess, so the host is not stripped further than
 *  it needs to be. When none covers the target, the heaviest prefix goes and the next pass takes more.
 *  Never the whole host: that is a rename, not a rebalance. */
export function pickRun(vshards: readonly bigint[], weight: (v: bigint) => number, target: number): bigint[] {
  const sorted = [...vshards].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const runs: bigint[][] = [];
  for (const v of sorted) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] + 1n === v) last.push(v);
    else runs.push([v]);
  }

  let covering: { slice: bigint[]; acc: number } | null = null;
  let heaviest: { slice: bigint[]; acc: number } | null = null;
  for (const run of runs) {
    let acc = 0;
    for (let n = 1; n <= run.length; n++) {
      acc += weight(run[n - 1]);
      if (n === vshards.length) break; // that would be the whole host
      const slice = run.slice(0, n);
      if (acc >= target) {
        // Fewest vshards, then least excess.
        if (!covering || slice.length < covering.slice.length || (slice.length === covering.slice.length && acc < covering.acc)) {
          covering = { slice, acc };
        }
        break; // a longer prefix of this run can only be worse on both counts
      }
      if (!heaviest || acc > heaviest.acc) heaviest = { slice, acc };
    }
  }
  return (covering ?? heaviest)?.slice ?? [];
}
