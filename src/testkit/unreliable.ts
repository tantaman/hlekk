// A transport that behaves like a network. Everything above it has so far talked to hosts through a
// synchronous function call, so "crossing a DO" cost nothing and nothing ever arrived out of order,
// twice, or not at all.
//
// Every delay goes through the clock, so a virtual one reorders replies exactly and repeatably without
// the suite waiting.

import type { Catalog } from "../catalog/catalog.ts";
import type { Route } from "../directory/map.ts";
import type { ExecReply, Reply, Routed } from "../host/host.ts";
import type { Id, Miss, Plan } from "../query/types.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { Mutation, Transport } from "../client/transport.ts";

export interface Faults {
  /** Latency per call, in milliseconds, picked uniformly from this range. Unequal latencies are what
   *  make replies arrive out of the order they were sent. */
  latency?: [number, number];
  /** Probability a call fails before reaching the host. The caller sees an error and nothing happened. */
  failBefore?: number;
  /** Probability a write reaches the host, is applied, and then its reply is lost. The caller sees an
   *  error although the write landed, which is the case that tells idempotent operations from the
   *  rest. */
  loseReply?: number;
  /** Probability a chunk read hands back a chunk from before the last publish. */
  staleChunk?: number;
}

export class Dropped extends Error {
  readonly applied: boolean;
  constructor(what: string, applied: boolean) {
    super(`${what}: the reply was lost${applied ? " after it was applied" : " before it arrived"}`);
    this.name = "Dropped";
    this.applied = applied;
  }
}

export interface Simulated extends Transport {
  /** What the simulation did, so a test can say it did something. */
  readonly counts: { calls: number; failedBefore: number; lostReplies: number; staleChunks: number };
}

export function unreliable(inner: Transport, runtime: Runtime, faults: Faults = {}): Simulated {
  const { clock, random } = runtime;
  const [lo, hi] = faults.latency ?? [0, 0];
  const counts = { calls: 0, failedBefore: 0, lostReplies: 0, staleChunks: 0 };
  /** The chunk bytes handed out last time, per index, for serving a stale read. */
  const previous = new Map<number, Uint8Array>();

  const hop = async (what: string): Promise<void> => {
    counts.calls++;
    if (hi > 0) await clock.sleep(lo + random.int(hi - lo + 1));
    if (faults.failBefore && random.chance(faults.failBefore)) {
      counts.failedBefore++;
      throw new Dropped(what, false);
    }
  };

  return {
    counts,

    async exec(host: number, plan: Plan, tasks: Miss[], routed: Routed): Promise<ExecReply> {
      await hop(`exec on host ${host}`);
      const reply = await inner.exec(host, plan, tasks, routed);
      // A read's reply can be lost too, but losing it changes nothing but the error, since a read
      // applies nothing.
      if (faults.loseReply && random.chance(faults.loseReply)) {
        counts.lostReplies++;
        throw new Dropped(`exec on host ${host}`, false);
      }
      return reply;
    },

    async write(host: number, m: Mutation, epoch: number): Promise<Reply<unknown>> {
      await hop(`${m.kind} on host ${host}`);
      const reply = await inner.write(host, m, epoch);
      if (faults.loseReply && random.chance(faults.loseReply)) {
        counts.lostReplies++;
        // Applied, and the caller will never know. Whether that is safe to retry is the operation's
        // business, not the transport's.
        throw new Dropped(`${m.kind} on host ${host}`, reply.ok);
      }
      return reply;
    },

    async chunk(index: number): Promise<Uint8Array | null> {
      await hop(`chunk ${index}`);
      const current = await inner.chunk(index);
      const before = previous.get(index);
      if (before && faults.staleChunk && random.chance(faults.staleChunk)) {
        counts.staleChunks++;
        return before;
      }
      if (current) previous.set(index, current);
      return current;
    },

    async resolve(vshards: readonly bigint[]): Promise<Map<bigint, Route>> {
      await hop("resolve");
      return inner.resolve(vshards);
    },

    async catalog(): Promise<Catalog> {
      await hop("catalog");
      return inner.catalog();
    },

    async place(affinity?: string): Promise<string> {
      await hop("place");
      return inner.place(affinity);
    },

    async indexVshardFor(key: string): Promise<string> {
      await hop("indexVshardFor");
      return inner.indexVshardFor(key);
    },

    async indexLookup(host: number, vshard: string, idx: number, key: string): Promise<Id | null> {
      await hop(`indexLookup on host ${host}`);
      return inner.indexLookup(host, vshard, idx, key);
    },
  };
}
