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

export interface Thresholds {
  /** Bytes on one host before it sheds. Well under the 10 GB per-DO limit. */
  bytes?: number;
  /** Requests per window on one host before it sheds, against the 1,000/sec soft limit per DO. */
  requests?: number;
}

export const DEFAULT_THRESHOLDS: Required<Thresholds> = {
  bytes: 5 * 1024 * 1024 * 1024,
  requests: 500_000,
};

export interface HostLoad {
  host: number;
  bytes: number;
  requests: number;
  vshards: bigint[];
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

  /** What each host holds, from what the allocator last recorded. */
  load(): HostLoad[] {
    return this.directory.hostIndexes().map((host) => {
      const vshards = this.directory.vshardsOn(host);
      let bytes = 0;
      let requests = 0;
      for (const v of vshards) {
        const u = this.allocator.usage(v);
        bytes += u.bytes;
        requests += u.requests;
      }
      return { host, bytes, requests, vshards };
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
      const over = (why === "bytes" ? l.bytes - this.thresholds.bytes : l.requests - this.thresholds.requests);
      // Shed enough to come back under, plus a margin, so it does not trip again immediately.
      const target = Math.ceil(over + (why === "bytes" ? this.thresholds.bytes : this.thresholds.requests) * 0.1);
      const picked = pickRun(l.vshards, weight, target);
      if (picked.length === 0 || picked.length === l.vshards.length) continue; // nothing to shed, or it is one vshard

      const to = this.#destination(taking, picked.reduce((n, v) => n + weight(v), 0), why, () => nextHost++);
      if (to === l.host) continue;
      out.push({ vshards: picked, from: l.host, to, why });
      const moved = picked.reduce((n, v) => n + weight(v), 0);
      const here = taking.get(l.host)!;
      if (why === "bytes") here.bytes -= moved;
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
