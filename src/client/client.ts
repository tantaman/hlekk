// The client. An app reaches a database from an ordinary Worker: the caller holds ids, and the client
// resolves hosts. Nothing about placement appears in the API.
//
// A stale route costs one extra round and never a wrong answer: the host refuses the vshards it no
// longer serves, the client re-reads the directory and resends just those. Both query drivers are
// unchanged by this, because the retry lives in the per-host client they are handed.

import type { Catalog } from "../catalog/catalog.ts";
import { vshardOf } from "../host/ids.ts";
import type { Refusal, Reply } from "../host/host.ts";
import type { HostClient, HostReply } from "../query/driver.ts";
import { runAsync, runRounds } from "../query/driver.ts";
import type { Stats } from "../query/driver.ts";
import type { ReadSet } from "../query/stores.ts";
import { missOwner } from "../query/types.ts";
import type { Id, Json, Miss, Plan } from "../query/types.ts";
import { Routes } from "./routes.ts";
import { anchorOf } from "./transport.ts";
import type { Mutation, Transport } from "./transport.ts";

/** How many times a request may be re-routed before the client gives up. A move takes one; more than
 *  a couple means the map is churning faster than a query can finish. */
export const MAX_REROUTES = 4;

export class Unroutable extends Error {
  constructor(vshard: bigint) {
    super(`no host owns vshard ${vshard}`);
    this.name = "Unroutable";
  }
}

/** How long a write waits for a vshard that is mid-move. The source is fenced for the length of the
 *  copy, so the write pauses rather than failing; past this it gives up and says why. */
export const WRITE_DEADLINE_MS = 5_000;

export class StillFenced extends Error {
  readonly vshard: bigint;
  constructor(vshard: bigint, waited: number) {
    super(`vshard ${vshard} was still fenced after ${waited} ms: a move is taking longer than the write could wait`);
    this.name = "StillFenced";
    this.vshard = vshard;
  }
}

export class TooManyReroutes extends Error {
  readonly refusals: Refusal[];
  constructor(refusals: Refusal[]) {
    super(`gave up after ${MAX_REROUTES} re-routes: ${refusals.map((r) => `${r.vshard} is ${r.state}`).join(", ")}`);
    this.name = "TooManyReroutes";
    this.refusals = refusals;
  }
}

export interface WriteOptions {
  /** How long to wait out a move before giving up. */
  deadlineMs?: number;
  /** Injectable for tests, so a paused write does not depend on wall-clock timing. */
  sleep?: (ms: number) => Promise<void>;
}

export interface QueryOptions {
  /** Rounds sends every outstanding read and waits; async lets each branch move on when its own data
   *  lands. Async is the default: its latency is the longest chain of dependent reads. */
  driver?: "async" | "rounds";
  stats?: Stats;
}

export class Hlekk {
  readonly routes: Routes;
  readonly #transport: Transport;
  readonly #clients = new Map<number, HostClient>();

  private constructor(transport: Transport) {
    this.#transport = transport;
    this.routes = new Routes(transport);
  }

  /** Memoized per transport: the same client for the life of the isolate. Its shard-map chunks are
   *  what keep the directory and the published map off the request path, and a client built fresh per
   *  request reuses none of them. */
  static from(transport: Transport): Hlekk {
    let client = pool.get(transport);
    if (!client) pool.set(transport, (client = new Hlekk(transport)));
    return client;
  }

  catalog(): Promise<Catalog> {
    return this.#transport.catalog();
  }

  // ---- reads

  async query(plan: Plan, rootIds: Id[], opts: QueryOptions = {}): Promise<Json[]> {
    const route = await this.#router(rootIds.map(vshardOf));
    const driver = opts.driver === "rounds" ? runRounds : runAsync;
    return driver(plan, rootIds, route, opts.stats);
  }

  /** One client per host, so a driver batching by client identity sends one request per host. */
  async #router(seed: readonly bigint[]): Promise<(id: Id) => HostClient> {
    await this.routes.routeAll(seed);
    return (id: Id) => {
      const vshard = vshardOf(id);
      const route = this.routes.peek(vshard);
      // A driver's route() is synchronous, so a vshard the cache has never seen cannot be resolved
      // here. It goes to the host the cache does know, which refuses it, and the retry below places
      // it. One extra round, which is what a stale route costs anyway.
      const host = route?.host ?? this.#anyHost();
      return this.#clientFor(host);
    };
  }

  #anyHost(): number {
    const first = this.#clients.keys().next();
    return first.done ? 0 : first.value;
  }

  #clientFor(host: number): HostClient {
    let client = this.#clients.get(host);
    if (!client) {
      this.#clients.set(
        host,
        (client = {
          exec: (plan, tasks) => this.#exec(host, plan, tasks, 0),
        }),
      );
    }
    return client;
  }

  /** Sends a batch to one host and places whatever it refuses. */
  async #exec(host: number, plan: Plan, tasks: Miss[], depth: number): Promise<HostReply> {
    const vshards = [...new Set(tasks.map((t) => vshardOf(missOwner(t))))];
    const routed = new Map<bigint, number>();
    for (const v of vshards) {
      const r = this.routes.peek(v);
      if (r) routed.set(v, r.epoch);
    }
    const reply = await this.#transport.exec(host, plan, tasks, routed);
    if (reply.refusals.length === 0) return { reads: reply.reads, misses: reply.misses };
    if (depth >= MAX_REROUTES) throw new TooManyReroutes(reply.refusals);

    const refused = reply.refusals.map((r) => BigInt(r.vshard));
    const placed = await this.routes.reroute(refused);
    const again = tasks.filter((t) => refused.includes(vshardOf(missOwner(t))));

    // Re-partition by the new owner: a batch can be refused for several vshards at once, which may
    // now live on different hosts.
    const byHost = new Map<number, Miss[]>();
    for (const t of again) {
      const v = vshardOf(missOwner(t));
      const route = placed.get(v);
      if (!route) throw new Unroutable(v);
      byHost.set(route.host, [...(byHost.get(route.host) ?? []), t]);
    }
    const retries = await Promise.all([...byHost].map(([h, ts]) => this.#exec(h, plan, ts, depth + 1)));
    return {
      reads: merge([reply.reads, ...retries.map((r) => r.reads)]),
      misses: [...reply.misses, ...retries.flatMap((r) => r.misses)],
    };
  }

  // ---- writes

  async write<T = unknown>(m: Mutation, opts: WriteOptions = {}): Promise<T> {
    const anchor = anchorOf(m);
    const vshard = anchor.kind === "id" ? vshardOf(anchor.id) : BigInt(anchor.vshard);
    const budget = opts.deadlineMs ?? WRITE_DEADLINE_MS;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const until = Date.now() + budget;
    let reroutes = 0;
    let wait = 1;
    for (;;) {
      const route = await this.routes.route(vshard);
      if (!route) throw new Unroutable(vshard);
      const reply = (await this.#transport.write(route.host, m, route.epoch)) as Reply<T>;
      if (reply.ok) return reply.value;
      if (!("refused" in reply)) throw new WriteRefused(m, reply.restricted);

      if (reply.refused.state === "fenced") {
        // Mid-move. The route is not wrong, so re-resolving would find the same host; the write waits
        // for the copy and the flip, which is what "writes pause for the duration" means.
        if (Date.now() >= until) throw new StillFenced(vshard, budget);
        await sleep(wait);
        wait = Math.min(wait * 2, 50);
        await this.routes.reroute([vshard]); // in case the flip landed while we waited
        continue;
      }
      // Retired, absent, or an epoch we no longer hold: the route is stale, not busy.
      if (++reroutes > MAX_REROUTES) throw new TooManyReroutes([reply.refused]);
      await this.routes.reroute([vshard]);
    }
  }

  create(otype: number, data: Record<string, Json>, at: { with: Id } | { vshard: string }): Promise<Id> {
    return this.write<Id>({ kind: "create", otype, data, ...at });
  }

  update(id: Id, data: Record<string, Json>): Promise<number> {
    return this.write<number>({ kind: "update", id, data });
  }

  delete(id: Id): Promise<void> {
    return this.write<void>({ kind: "delete", id });
  }

  assocAdd(atype: number, id1: Id, id2: Id, time?: number, data?: Record<string, Json> | null): Promise<void> {
    return this.write<void>({ kind: "assocAdd", atype, id1, id2, time, data });
  }

  assocRemove(atype: number, id1: Id, id2: Id): Promise<void> {
    return this.write<void>({ kind: "assocRemove", atype, id1, id2 });
  }
}

export class WriteRefused extends Error {
  readonly mutation: Mutation;
  readonly restricted: { id: Id; edge: string };
  constructor(mutation: Mutation, restricted: { id: Id; edge: string }) {
    super(`${mutation.kind} refused: ${restricted.id} still has ${restricted.edge} edges`);
    this.name = "WriteRefused";
    this.mutation = mutation;
    this.restricted = restricted;
  }
}

const pool = new WeakMap<Transport, Hlekk>();

function merge(sets: ReadSet[]): ReadSet {
  return {
    objects: sets.flatMap((s) => s.objects),
    lists: sets.flatMap((s) => s.lists),
    counts: sets.flatMap((s) => s.counts),
  };
}
