// The coordinator's two drivers, rounds and async, and a host's handler for one batch of tasks.

import { Pass, drain, materialize } from "./ops.ts";
import { Cache, CacheStore } from "./stores.ts";
import type { ReadSet } from "./stores.ts";
import { UNKNOWN, missKey, missOwner } from "./types.ts";
import type { Cursor, EdgePage, Id, Json, Maybe, Miss, Obj, Plan, Store } from "./types.ts";

export interface HostReply {
  reads: ReadSet;
  misses: Miss[];
}

/** In production, an RPC to a host DO. */
export interface HostClient {
  exec(plan: Plan, tasks: Miss[]): Promise<HostReply>;
}

/** A store over one host's own data, which also records what it read. */
export interface LocalStore extends Store {
  reads(): ReadSet;
}

/** A host runs each task against its local data and reports what it read and what it couldn't. Every
 *  read settles at once, so the batch runs to completion before the DO takes another event: one
 *  snapshot, and no SQL cursor open across real I/O. */
export async function hostExec(store: LocalStore, plan: Plan, tasks: Miss[]): Promise<HostReply> {
  const p = new Pass(store, plan);
  await Promise.all(tasks.map((t) => runTask(p, store, t)));
  await p.settle(); // speculative reads too, so what the reply holds doesn't depend on timing
  return { reads: store.reads(), misses: p.misses };
}

async function runTask(p: Pass, store: LocalStore, t: Miss): Promise<void> {
  if (t.kind === "object") return drain(p.rowOp(t.frame).fetch(p, { ids: [t.id] }));
  if (t.kind === "count") {
    await store.count(t.id1, t.atype);
    return;
  }
  // One page of the list, then each target as a row of the frame, separately so that an unknown
  // target doesn't stop the prefetch below the others. The coordinator judges membership.
  const page = await store.edges(t.id1, t.atype, t.after, t.n, t.frame);
  if (page === UNKNOWN) return;
  await Promise.all(page.rows.map((e) => drain(p.rowOp(t.frame).fetch(p, { ids: [e.id2] }))));
}

export const MAX_ROUNDS = 16;

/** A query's answer, and the normalized graph it was read from. The graph carries what the nested
 *  rows cannot: every object once with its version, and each edge list's completeness, which is where
 *  a cursor comes from. */
export interface Answer {
  rows: Json[];
  graph: Cache;
}

export interface Stats {
  rounds: number;
  requests: number;
}

// ---- rounds

/** The barrier driver: send every outstanding miss, wait for every host, repeat. Once nothing is
 *  outstanding, evaluate the whole query over the gathered graph. Only a known answer is the answer;
 *  whatever the pass still missed goes out again. */
export async function runRounds(
  plan: Plan,
  rootIds: Id[],
  route: (id: Id) => HostClient,
  stats: Stats = { rounds: 0, requests: 0 },
): Promise<Answer> {
  const cache = new Cache();
  let tasks: Miss[] = rootIds.map((id) => ({ kind: "object", id, frame: 0 }));
  for (;;) {
    tasks = outstanding(tasks, cache);
    if (tasks.length === 0) {
      const p = new Pass(new CacheStore(cache), plan);
      const out = await materialize(p.frameOp(0).fetch(p, { ids: rootIds }));
      if (out !== UNKNOWN) return { rows: out, graph: cache };
      await p.settle();
      tasks = outstanding(p.misses, cache);
      if (tasks.length === 0) throw new Error("pass missed data the cache already holds");
    }
    if (++stats.rounds > MAX_ROUNDS) throw new Error("query did not converge");

    const byHost = new Map<HostClient, Miss[]>();
    for (const t of tasks) {
      const h = route(missOwner(t));
      byHost.set(h, [...(byHost.get(h) ?? []), t]);
    }
    stats.requests += byHost.size;
    const replies = await Promise.all([...byHost].map(([h, ts]) => h.exec(plan, ts)));
    for (const r of replies) cache.merge(r.reads);
    tasks = replies.flatMap((r) => r.misses);
  }
}

/** Drop duplicate tasks and anything the coordinator already holds. */
function outstanding(tasks: Miss[], cache: Cache): Miss[] {
  const seen = new Set<string>();
  return tasks.filter((t) => {
    const key = missKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    if (t.kind === "object") return cache.object(t.id) === UNKNOWN;
    if (t.kind === "count") return cache.count(t.id1, t.atype) === UNKNOWN;
    return cache.page(t.id1, t.atype, t.after, t.n) === UNKNOWN;
  });
}

// ---- async

/** The async driver: the query runs once, at the coordinator, and a read the gathered graph can't
 *  answer waits on its host. Each branch moves on as soon as its own data arrives. Hosts still prefetch
 *  below each row they're asked for; their misses go unused, since the coordinator asks for what it
 *  needs when it needs it. `defer` schedules a batch's send for once everything runnable has run. */
export async function runAsync(
  plan: Plan,
  rootIds: Id[],
  route: (id: Id) => HostClient,
  stats: Stats = { rounds: 0, requests: 0 },
  defer: (f: () => void) => void = (f) => setTimeout(f, 0),
): Promise<Answer> {
  const store = new LoaderStore(plan, route, defer, stats);
  const p = new Pass(store, plan);
  const out = await materialize(p.frameOp(0).fetch(p, { ids: rootIds }));
  if (out === UNKNOWN) throw new Error("ended short over a store that never answers UNKNOWN");
  return { rows: out, graph: store.cache };
}

/** The async driver's store: reads the gathered graph and, on a gap, asks the owning host and waits.
 *  Gaps found in the same tick go to each host as one request (the DataLoader pattern), and a gap is
 *  fetched once however many readers wait on it. */
export class LoaderStore implements Store {
  readonly cache = new Cache();
  readonly #plan: Plan;
  readonly #route: (id: Id) => HostClient;
  readonly #defer: (f: () => void) => void;
  readonly #stats: Stats;
  readonly #open = new Map<HostClient, { tasks: Miss[]; reply: Promise<void> }>();
  readonly #inflight = new Map<string, Promise<void>>();

  constructor(plan: Plan, route: (id: Id) => HostClient, defer: (f: () => void) => void, stats: Stats) {
    this.#plan = plan;
    this.#route = route;
    this.#defer = defer;
    this.#stats = stats;
  }

  object(id: Id, frame: number): Promise<Maybe<Obj | null>> {
    return this.#through(() => this.cache.object(id), { kind: "object", id, frame });
  }

  edges(id1: Id, atype: number, after: Cursor | null, n: number, frame: number): Promise<Maybe<EdgePage>> {
    return this.#through(() => this.cache.page(id1, atype, after, n), { kind: "edges", id1, atype, frame, after, n });
  }

  count(id1: Id, atype: number): Promise<Maybe<number>> {
    return this.#through(() => this.cache.count(id1, atype), { kind: "count", id1, atype });
  }

  async #through<T>(read: () => Maybe<T>, t: Miss): Promise<T> {
    const v = read();
    if (v !== UNKNOWN) return v;
    await this.#load(t);
    const w = read();
    if (w === UNKNOWN) throw new Error(`host returned no ${missKey(t)}`); // a moved vshard, once moves exist
    return w;
  }

  #load(t: Miss): Promise<void> {
    const key = missKey(t);
    let loaded = this.#inflight.get(key);
    if (!loaded) {
      loaded = this.#enqueue(t);
      this.#inflight.set(key, loaded);
      const forget = () => this.#inflight.delete(key);
      loaded.then(forget, forget);
    }
    return loaded;
  }

  /** Adds t to its host's open batch, opening one if needed. */
  #enqueue(t: Miss): Promise<void> {
    const host = this.#route(missOwner(t));
    let batch = this.#open.get(host);
    if (!batch) {
      const tasks: Miss[] = [];
      const reply = new Promise<void>((send) => this.#defer(send)).then(async () => {
        this.#open.delete(host);
        this.#stats.requests++;
        this.cache.merge((await host.exec(this.#plan, tasks)).reads);
      });
      this.#open.set(host, (batch = { tasks, reply }));
    }
    batch.tasks.push(t);
    return batch.reply;
  }
}
