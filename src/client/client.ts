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
import type { Answer } from "../query/driver.ts";
import type { Stats } from "../query/driver.ts";
import type { ReadSet } from "../query/stores.ts";
import { missOwner } from "../query/types.ts";
import type { Id, Json, Miss, Plan } from "../query/types.ts";
import { Query } from "../schema/query.ts";
import type { FieldMap } from "../schema/define.ts";
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

  /** Runs a built query, or a plan with the roots to start it from. */
  async query<S>(query: Query<FieldMap, S>, opts?: QueryOptions): Promise<S[]>;
  async query(plan: Plan, rootIds: Id[], opts?: QueryOptions): Promise<Json[]>;
  async query(
    a: Plan | Query<FieldMap, unknown>,
    b?: Id[] | QueryOptions,
    c: QueryOptions = {},
  ): Promise<unknown[]> {
    if (a instanceof Query) return a.run(this, (b as QueryOptions) ?? {});
    return (await this.answer(a, b as Id[], c)).rows;
  }

  /** The answer and the graph it was read from. The builder uses the graph for cursors; `normalized`
   *  turns it into a result that holds each object once. */
  async answer(plan: Plan, rootIds: Id[], opts: QueryOptions = {}): Promise<Answer> {
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
      if ("restricted" in reply) throw new WriteRefused(m, reply.restricted);
      if ("taken" in reply) throw new ValueTaken(reply.taken.idx, reply.taken.key, reply.taken.by);
      if ("conflict" in reply) throw new VersionConflict(reply.conflict.id, reply.conflict.expected, reply.conflict.actual);

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

  /** Creates an object. `with` colocates it hard, in the parent's vshard, so the two can transact.
   *  `affinity` is a placement hint: a tenant, an owning user, or the request's own root. Given
   *  neither, the allocator places it. A caller never names a vshard. */
  async create(
    otype: number,
    data: Record<string, Json>,
    at: { with: Id } | { vshard: string } | { affinity?: string } = {},
  ): Promise<Id> {
    if ("with" in at) return this.write<Id>({ kind: "create", otype, data, with: at.with });
    const vshard = "vshard" in at ? at.vshard : await this.#transport.place(at.affinity);
    return this.write<Id>({ kind: "create", otype, data, vshard });
  }

  /** Updates an object, bumping its version. Pass the version you read as `expect` and the write
   *  lands only if the object is still at it, so a read-modify-write cannot lose someone else's. */
  update(id: Id, data: Record<string, Json>, opts: { expect?: number } = {}): Promise<number> {
    return this.write<number>({ kind: "update", id, data, expect: opts.expect });
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

  // ---- global unique index

  /** The object a value points at, or null. A local index cannot answer this: the coordinator does
   *  not know which host to ask, so the entry lives in an index vshard keyed by the value. */
  async lookupUnique(idx: number, value: string): Promise<Id | null> {
    const key = normalize(value);
    const vshard = await this.#transport.indexVshardFor(key);
    for (let depth = 0; ; depth++) {
      const route = await this.routes.route(BigInt(vshard));
      if (!route) throw new Unroutable(BigInt(vshard));
      try {
        return await this.#transport.indexLookup(route.host, vshard, idx, key);
      } catch (e) {
        // A host that no longer holds the index vshard throws rather than answering null, because a
        // missing entry and a missing vshard are not the same answer.
        if (depth >= MAX_REROUTES) throw e;
        await this.routes.reroute([BigInt(vshard)]);
      }
    }
  }

  /** Creates an object holding a value no other object may hold.
   *
   *  Reserve, create, confirm. The reservation and its check are one transaction on the one host that
   *  owns the value's index vshard, so two callers racing for the same value cannot both win. The
   *  create is a second write, on another host, which is why this cannot be one transaction; if it
   *  fails the reservation is released, and if this process dies first the reservation expires and is
   *  swept, so a crash cannot hold a value forever. */
  async createUnique(
    idx: number,
    value: string,
    otype: number,
    data: Record<string, Json>,
    at: { with: Id } | { vshard: string } | { affinity?: string } = {},
    opts: { ttlMs?: number; now?: number } = {},
  ): Promise<Id> {
    const key = normalize(value);
    const vshard = await this.#transport.indexVshardFor(key);
    const ttlMs = opts.ttlMs ?? RESERVATION_TTL_MS;
    const now = opts.now ?? Date.now();

    await this.write({ kind: "indexReserve", vshard, idx, key, now, ttlMs });
    let id: Id;
    try {
      id = await this.create(otype, data, at);
    } catch (e) {
      await this.write({ kind: "indexRelease", vshard, idx, key }).catch(() => {});
      throw e;
    }
    try {
      await this.write({ kind: "indexConfirm", vshard, idx, key, id });
    } catch (e) {
      // The object exists but nothing points at it. Take it back out rather than leaving it stranded.
      await this.delete(id).catch(() => {});
      await this.write({ kind: "indexRelease", vshard, idx, key }).catch(() => {});
      throw e;
    }
    return id;
  }
}

/** How a value is compared. Case and surrounding space are not what makes an email distinct, and the
 *  normalization has to be the same everywhere or two spellings would each get an entry. */
export function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/** How long an unconfirmed reservation holds a value. Long enough to cover a create and a confirm,
 *  short enough that a crash does not strand the value for long. */
export const RESERVATION_TTL_MS = 30_000;

/** An update whose expected version no longer held. The caller re-reads and decides. */
export class VersionConflict extends Error {
  readonly id: Id;
  readonly expected: number;
  readonly actual: number;
  constructor(id: Id, expected: number, actual: number) {
    super(`${id} is at version ${actual}, not the ${expected} this write expected`);
    this.name = "VersionConflict";
    this.id = id;
    this.expected = expected;
    this.actual = actual;
  }
}

export class ValueTaken extends Error {
  readonly idx: number;
  readonly key: string;
  /** The object holding the value, or null while another caller's reservation is still live. */
  readonly by: Id | null;
  constructor(idx: number, key: string, by: Id | null) {
    super(`${JSON.stringify(key)} is already taken${by === null ? " by a reservation in flight" : ` by ${by}`}`);
    this.name = "ValueTaken";
    this.idx = idx;
    this.key = key;
    this.by = by;
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
