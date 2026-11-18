// The client. An app reaches a database from an ordinary Worker: the caller holds ids, and the client
// resolves hosts. Nothing about placement appears in the API.
//
// A stale route costs one extra round and never a wrong answer: the host refuses the vshards it no
// longer serves, the client re-reads the directory and resends just those. Both query drivers are
// unchanged by this, because the retry lives in the per-host client they are handed.

import type { Catalog } from "../catalog/catalog.ts";
import { vshardOf } from "../host/ids.ts";
import type { ExecReply, Refusal, Reply } from "../host/host.ts";
import type { HostClient, HostReply } from "../query/driver.ts";
import { runAsync, runRounds } from "../query/driver.ts";
import type { Answer } from "../query/driver.ts";
import { normalize as normalizeAnswer } from "../query/normalize.ts";
import type { QueryResult } from "../query/normalize.ts";
import type { Stats } from "../query/driver.ts";
import type { Foreign } from "../query/ops.ts";
import type { ReadSet } from "../query/stores.ts";
import { missOwner } from "../query/types.ts";
import type { Id, Json, Miss, Plan } from "../query/types.ts";
import { Query } from "../schema/query.ts";
import type { FieldMap } from "../schema/define.ts";
import type { Fields } from "../query/types.ts";
import { systemClock } from "../runtime/runtime.ts";
import type { Clock } from "../runtime/runtime.ts";
import { formatRef, isQualified, parseRef } from "../query/ref.ts";
import type { Ref } from "../query/ref.ts";
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

/** A host sent back an alias the registry never allocated. An alias binding is permanent, so this is
 *  not staleness: it is a number that means nothing, and the edge carrying it names no database. */
export class UnknownAlias extends Error {
  readonly alias: number;
  constructor(alias: number) {
    super(`a host holds an edge into database ${alias}, which this database's registry never allocated`);
    this.name = "UnknownAlias";
    this.alias = alias;
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

/**
 * What one query may spend reaching other databases.
 *
 * Per query, not per client: a foreign client is built once per isolate and a budget that lived
 * there would be shared by every query the isolate runs, which is the opposite of what it is for.
 * One tenant's query latency is partly another tenant's problem the moment a hop crosses the
 * internet, and three numbers are what bound it — a deadline, how many requests, and how many
 * databases.
 */
export interface Budget {
  /** Milliseconds for the whole query's foreign hops. */
  deadlineMs?: number;
  /** Requests to other databases. */
  requests?: number;
  /** Databases one query may reach. */
  databases?: number;
}

export const DEFAULT_BUDGET: Required<Budget> = { deadlineMs: 15_000, requests: 64, databases: 8 };

/** A query's budget, spent. `what` is which of the three ran out, so a caller can raise the right
 *  one rather than guessing. */
export class BudgetSpent extends Error {
  readonly what: "deadline" | "requests" | "databases";
  constructor(what: "deadline" | "requests" | "databases", detail: string) {
    super(`this query's foreign-hop budget is spent: ${detail}`);
    this.name = "BudgetSpent";
    this.what = what;
  }
}

export interface QueryOptions {
  /** Rounds sends every outstanding read and waits; async lets each branch move on when its own data
   *  lands. Async is the default: its latency is the longest chain of dependent reads. */
  driver?: "async" | "rounds";
  stats?: Stats;
  /**
   * What to do with an edge into another database. `"follow"`, the default, asks that database.
   * `"reference"` lists the reference and loads nothing, which is what a database ANSWERING a read
   * does — see `Foreign` in `query/ops.ts` for why that is not an option but a rule.
   */
  foreign?: Foreign;
  /** What this query may spend reaching other databases. Defaults to `DEFAULT_BUDGET`. */
  budget?: Budget;
}

/** This database's own URI and the aliases it has allocated, read once per isolate. */
interface Registry {
  database: string | null;
  byUri: Map<string, number>;
  byAlias: Map<number, string>;
}

export class Hlekk {
  readonly routes: Routes;
  readonly clock: Clock;
  readonly #transport: Transport;
  readonly #clients = new Map<number, HostClient>();
  readonly #foreign = new Map<string, HostClient>();
  readonly #openForeign: ((database: string) => HostClient) | undefined;
  /** Cached for the life of the isolate. An alias binding is permanent — an alias is never
   *  repointed — so there is nothing here that can go stale; only new aliases can appear, and a
   *  write that needs one interns it and adds it. That permanence is what makes a foreign hop cost
   *  no directory round trip at read time. */
  #registry: Promise<Registry> | null = null;

  private constructor(transport: Transport, clock: Clock, openForeign?: (database: string) => HostClient) {
    this.#transport = transport;
    this.clock = clock;
    this.#openForeign = openForeign;
    this.routes = new Routes(transport);
  }

  /** Memoized per transport: the same client for the life of the isolate. Its shard-map chunks are
   *  what keep the directory and the published map off the request path, and a client built fresh per
   *  request reuses none of them. */
  static from(
    transport: Transport,
    clock: Clock = systemClock,
    openForeign?: (database: string) => HostClient,
  ): Hlekk {
    let client = pool.get(transport);
    if (!client) pool.set(transport, (client = new Hlekk(transport, clock, openForeign)));
    return client;
  }

  /** Drops the memoized client for a transport, so the next `from` builds a fresh one.
   *
   *  For a harness that has to hand the same database two different clients — one that cannot follow
   *  an edge out of it and one that can. A deployment builds its client once, with whatever it needs
   *  already in hand, and never calls this. */
  static forget(transport: Transport): void {
    pool.delete(transport);
  }

  catalog(): Promise<Catalog> {
    return this.#transport.catalog();
  }

  /** The alias registry, read once. */
  async registry(): Promise<Registry> {
    if (!this.#registry) {
      this.#registry = this.#transport.aliases().then((got) => ({
        database: got.database,
        byUri: new Map(got.aliases.map((a) => [a.uri, a.alias])),
        byAlias: new Map(got.aliases.map((a) => [a.alias, a.uri])),
      }));
    }
    return this.#registry;
  }

  /**
   * Turns a reference into the alias a host stores, and refuses what cannot be stored.
   *
   * Four things happen here and nowhere else, which is the point of having one seam for it:
   *
   * 1. A reference to THIS database collapses to a bare id. An edge into yourself is a local edge,
   *    and letting it through as an alias would make the same object reachable under two keys.
   * 2. The edge type has to permit a foreign target. The catalog's flag is the planner's static
   *    signal, and a foreign row under a type that does not declare one is a row no read can route.
   * 3. The URI is interned, through the directory, which canonicalizes it and never repoints an
   *    alias.
   * 4. The alias joins the isolate's cache, so the next edge into the same database costs nothing.
   */
  async #aliasFor(atype: number, target: Ref): Promise<{ db: number; id: Id }> {
    const { db, id } = parseRef(target);
    if (db === null) return { db: 0, id };
    const registry = await this.registry();
    if (registry.database !== null && db === registry.database) return { db: 0, id };
    const edge = (await this.catalog()).edge(atype);
    if (edge !== undefined && !edge.foreign) {
      throw new TypeError(
        `${edge.name} does not permit a foreign target, so it cannot point at ${target}.` +
          ' Declare the edge type with `"foreign": true`, which also forbids an inverse and a cascade on it.',
      );
    }
    const held = registry.byUri.get(db);
    if (held !== undefined) return { db: held, id };
    const alias = await this.#transport.intern(db);
    registry.byUri.set(db, alias);
    registry.byAlias.set(alias, db);
    return { db: alias, id };
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

  /** The same answer, normalized: every object once with its version, and the structure separately.
   *  Not the default — nesting is what a caller renders from. This is for a response that leaves the
   *  Worker, where a shared object would otherwise be duplicated once per path. */
  async normalized<S>(query: Query<FieldMap, S>, opts?: QueryOptions): Promise<QueryResult>;
  async normalized(plan: Plan, rootIds: Id[], opts?: QueryOptions): Promise<QueryResult>;
  async normalized(
    a: Plan | Query<FieldMap, unknown>,
    b?: Id[] | QueryOptions,
    c: QueryOptions = {},
  ): Promise<QueryResult> {
    const built = a instanceof Query;
    const plan: Plan = built ? a.compile().plan : a;
    const roots: Id[] = built ? [...a.roots] : (b as Id[]);
    const opts: QueryOptions = built ? ((b as QueryOptions) ?? {}) : c;
    const answer = await this.answer(plan, roots, opts);
    return normalizeAnswer(plan, roots, answer.rows, answer.graph);
  }

  /** The answer and the graph it was read from. The builder uses the graph for cursors; `normalized`
   *  turns it into a result that holds each object once. */
  async answer(plan: Plan, rootIds: Id[], opts: QueryOptions = {}): Promise<Answer> {
    const route = await this.#router(rootIds.filter((id) => !isQualified(id)).map(vshardOf), opts.budget);
    // The async driver's batching window is a deferred turn, so it goes through the clock too: a
    // virtual one closes the window without waiting, and closes it at a repeatable point.
    return opts.driver === "rounds"
      ? runRounds(plan, rootIds, route, opts.stats, opts.foreign)
      : runAsync(plan, rootIds, route, opts.stats, (f) => this.clock.defer(f), opts.foreign);
  }

  /**
   * One client per host, and one per foreign database, so a driver batching by client identity sends
   * one request per holder.
   *
   * That is the whole of what routing had to learn for a cross-database read. Both drivers already
   * group by client identity, so a foreign database gets one request per batching window however
   * many of its objects a query needs — the same property that makes a wide local fan-out one
   * request per host.
   */
  async #router(seed: readonly bigint[], budget?: Budget): Promise<(id: Ref) => HostClient> {
    await this.routes.routeAll(seed);
    const spending = this.#budget(budget);
    return (id: Ref) => {
      if (isQualified(id)) {
        const database = parseRef(id).db!;
        return spending(database, this.#foreignClientFor(database));
      }
      const vshard = vshardOf(id);
      const route = this.routes.peek(vshard);
      // A driver's route() is synchronous, so a vshard the cache has never seen cannot be resolved
      // here. It batches under a host it does know, and #exec resolves the batch properly before
      // sending, so the guess costs nothing.
      const host = route?.host ?? this.#anyHost();
      return this.#clientFor(host);
    };
  }

  /**
   * One query's budget, as a wrapper around whichever foreign client it reaches for.
   *
   * The wrapper and not the client, because the client is cached for the isolate and the budget is
   * not. Every hop goes through here, so the three numbers are enforced in one place and a refusal
   * says which ran out.
   */
  #budget(given: Budget | undefined): (database: string, client: HostClient) => HostClient {
    const budget = { ...DEFAULT_BUDGET, ...given };
    const until = this.clock.now() + budget.deadlineMs;
    const reached = new Set<string>();
    let requests = budget.requests;
    // One wrapper per database per query, and not one per call. Both drivers batch by client
    // IDENTITY, so a fresh object per miss would put every miss in its own batch — twelve objects in
    // one database would be twelve requests, which is exactly what the batching exists to avoid.
    const wrapped = new Map<string, HostClient>();
    const wrap = (database: string, client: HostClient): HostClient => ({
      exec: async (plan, tasks) => {
        if (!reached.has(database) && reached.size >= budget.databases) {
          throw new BudgetSpent(
            "databases",
            `${budget.databases} databases, and ${database} would be the ${reached.size + 1}st`,
          );
        }
        reached.add(database);
        const remaining = until - this.clock.now();
        const expired = () => new BudgetSpent("deadline", `${budget.deadlineMs} ms for foreign hops to ${database}`);
        if (remaining <= 0) throw expired();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(expired()), remaining);
        const spend = () => {
          if (this.clock.now() >= until || controller.signal.aborted) throw expired();
          if (requests <= 0) throw new BudgetSpent("requests", `${budget.requests} requests to other databases`);
          requests--;
          return controller.signal;
        };
        try {
          if (!client.metersRequests) spend();
          const timedOut = new Promise<never>((_, reject) => {
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
          });
          return await Promise.race([client.exec(plan, tasks, spend), timedOut]);
        } finally {
          clearTimeout(timer);
        }
      },
    });
    return (database, client) => {
      let held = wrapped.get(database);
      if (!held) wrapped.set(database, (held = wrap(database, client)));
      return held;
    };
  }

  /** One client per foreign database, built on first use and kept for the life of the isolate. */
  #foreignClientFor(database: string): HostClient {
    let client = this.#foreign.get(database);
    if (!client) {
      if (this.#openForeign === undefined) {
        throw new TypeError(
          `this query reaches ${database}, and no foreign client was configured.` +
            " Pass `foreign` to `Hlekk.from` with a client factory — `protocol/client.ts` has one over HTTP.",
        );
      }
      this.#foreign.set(database, (client = this.#openForeign(database)));
    }
    return client;
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
    // Resolve before sending. The batching above groups by whatever the cache knew synchronously,
    // which for a vshard it had never seen is a guess; placing it here costs no round trip.
    const placed = await this.routes.routeAll(vshards);
    const elsewhere = vshards.filter((v) => placed.get(v) !== undefined && placed.get(v)!.host !== host);
    if (elsewhere.length > 0 && depth < MAX_REROUTES) {
      const mine = tasks.filter((t) => !elsewhere.includes(vshardOf(missOwner(t))));
      const byHost = new Map<number, Miss[]>();
      for (const t of tasks.filter((t) => elsewhere.includes(vshardOf(missOwner(t))))) {
        const to = placed.get(vshardOf(missOwner(t)))!.host;
        byHost.set(to, [...(byHost.get(to) ?? []), t]);
      }
      const parts = await Promise.all([
        ...(mine.length > 0 ? [this.#exec(host, plan, mine, depth + 1)] : []),
        ...[...byHost].map(([h, ts]) => this.#exec(h, plan, ts, depth + 1)),
      ]);
      return { reads: merge(parts.map((p) => p.reads)), misses: parts.flatMap((p) => p.misses) };
    }

    const routed = new Map<bigint, number>();
    for (const v of vshards) {
      const r = this.routes.peek(v);
      if (r) routed.set(v, r.epoch);
    }
    const reply = await this.#absolute(await this.#transport.exec(host, plan, tasks, routed));
    if (reply.refusals.length === 0) return { reads: reply.reads, misses: reply.misses };
    if (depth >= MAX_REROUTES) throw new TooManyReroutes(reply.refusals);

    const refused = reply.refusals.map((r) => BigInt(r.vshard));
    const replaced = await this.routes.reroute(refused);
    const again = tasks.filter((t) => refused.includes(vshardOf(missOwner(t))));

    // Re-partition by the new owner: a batch can be refused for several vshards at once, which may
    // now live on different hosts.
    const byHost = new Map<number, Miss[]>();
    for (const t of again) {
      const v = vshardOf(missOwner(t));
      const route = replaced.get(v);
      if (!route) throw new Unroutable(v);
      byHost.set(route.host, [...(byHost.get(route.host) ?? []), t]);
    }
    const retries = await Promise.all([...byHost].map(([h, ts]) => this.#exec(h, plan, ts, depth + 1)));
    return {
      reads: merge([reply.reads, ...retries.map((r) => r.reads)]),
      misses: [...reply.misses, ...retries.flatMap((r) => r.misses)],
    };
  }

  /**
   * The seam. Every alias a host sent back becomes a URI, here and nowhere else.
   *
   * A host stores an alias and cannot resolve one; the registry that can is the directory's, and the
   * coordinator holds it cached for the life of the isolate. So this is the one line where the two
   * meet, and past it the coordinator sees only references: `targetOf` on an edge gives a `Ref`,
   * `missOwner` gives a `Ref`, and `#router` dispatches on whether it is qualified. The alias stays
   * on the edge for ordering alone, because the order an edge list is read in is `(time, db, id2)`
   * and that is storage, not identity.
   *
   * Doing it at the seam rather than at each use is what keeps the rest of the coordinator from
   * needing to know that aliases exist at all.
   */
  async #absolute(reply: ExecReply): Promise<ExecReply> {
    const foreign =
      reply.misses.some((m) => m.kind === "object" && m.db) ||
      reply.reads.lists.some((l) => l.rows.some((e) => e.db !== 0));
    if (!foreign) return reply;

    const uri = async (alias: number): Promise<string> => {
      const held = (await this.registry()).byAlias.get(alias);
      if (held !== undefined) return held;
      // An alias allocated by another isolate since this one cached the registry. Aliases are
      // append-only and never repointed, so one re-read is enough and there is nothing to
      // invalidate; a number still missing after it was never allocated at all.
      this.#registry = null;
      const again = (await this.registry()).byAlias.get(alias);
      if (again === undefined) throw new UnknownAlias(alias);
      return again;
    };

    for (const list of reply.reads.lists) {
      for (const e of list.rows) {
        if (e.db !== 0) e.target = formatRef(await uri(e.db), e.id2);
      }
    }
    const misses: Miss[] = [];
    for (const m of reply.misses) {
      if (m.kind === "object" && m.db) misses.push({ kind: "object", id: formatRef(await uri(m.db), m.id), frame: m.frame });
      else misses.push(m);
    }
    return { ...reply, misses };
  }

  // ---- writes

  async write<T = unknown>(m: Mutation, opts: WriteOptions = {}): Promise<T> {
    const anchor = anchorOf(m);
    const vshard = anchor.kind === "id" ? vshardOf(anchor.id) : BigInt(anchor.vshard);
    const budget = opts.deadlineMs ?? WRITE_DEADLINE_MS;
    const sleep = opts.sleep ?? ((ms: number) => this.clock.sleep(ms));
    const until = this.clock.now() + budget;
    let reroutes = 0;
    let wait = 1;
    for (;;) {
      const route = await this.routes.route(vshard);
      if (!route) throw new Unroutable(vshard);
      const reply = (await this.#transport.write(route.host, m, route.epoch)) as Reply<T>;
      if (reply.ok) return reply.value;
      if ("maintained" in reply) throw new MaintainedEdge(reply.maintained.edge, reply.maintained.by);
      if ("restricted" in reply) throw new WriteRefused(m, reply.restricted);
      if ("taken" in reply) throw new ValueTaken(reply.taken.idx, reply.taken.key, reply.taken.by);
      if ("conflict" in reply) throw new VersionConflict(reply.conflict.id, reply.conflict.expected, reply.conflict.actual);

      if (reply.refused.state === "fenced") {
        // Mid-move. The route is not wrong, so re-resolving would find the same host; the write waits
        // for the copy and the flip, which is what "writes pause for the duration" means.
        if (this.clock.now() >= until) throw new StillFenced(vshard, budget);
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

  /** Adds an edge. The target is a `Ref`: a bare id for an object in this database, or
   *  `<database URI>#<id>` for one in another. */
  async assocAdd(atype: number, id1: Id, id2: Ref, time?: number, data?: Record<string, Json> | null): Promise<void> {
    const to = await this.#aliasFor(atype, id2);
    return this.write<void>({ kind: "assocAdd", atype, id1, db: to.db, id2: to.id, time, data });
  }

  /** Adds an edge unless it is already there, in which case nothing about it changes — not its
   *  `time`, and so not its place in the list. `assocAdd` is an upsert and moves an edge to the head;
   *  this is for an edge whose re-statement somebody else can cause. See `AssocAddOp.keep`. */
  async assocAddIfAbsent(atype: number, id1: Id, id2: Ref, time?: number, data?: Record<string, Json> | null): Promise<void> {
    const to = await this.#aliasFor(atype, id2);
    return this.write<void>({ kind: "assocAdd", atype, id1, db: to.db, id2: to.id, time, data, keep: true });
  }

  /** Adds many edges, grouped so that each group is one transaction on one host.
   *
   *  `assocAdd` costs one durable commit per edge, which is the whole of the ~6,300 edges/s ceiling
   *  a deployed bulk load measured. A transaction cannot span hosts and the ownership fence is per
   *  vshard, so the grouping is by `vshardOf(id1)` — the same key `anchorOf` routes a single add by.
   *  Each group is then one request, one transaction and one commit.
   *
   *  Groups are issued in sequence rather than in parallel on purpose. `wikimedia-import.md`'s
   *  second finding is that a shuffled insert collapses as the B-tree outgrows cache, and that
   *  grouping each batch onto one host in key order took it from ~970/s to ~6,300/s; firing every
   *  group of a batch at once would reintroduce exactly the interleaving that measurement warns
   *  about. The parallelism belongs across hosts, in the loader, where it already is.
   *
   *  Returns the number of edges written. An edge write is an idempotent upsert whose count moves
   *  only for a new edge, so a caller that retries a whole batch cannot double-count — but a partial
   *  failure is reported per group, and the error names how many groups had already landed, because
   *  a batch spanning vshards is not one unit even though each group is. */
  async assocAddMany(
    edges: readonly { atype: number; id1: Id; id2: Ref; time?: number; data?: Fields | null }[],
  ): Promise<number> {
    if (edges.length === 0) return 0;
    // Resolved before grouping, so a batch holding a foreign target is refused before any of it is
    // written rather than partway through.
    const resolved = await Promise.all(
      edges.map(async (e) => {
        const to = await this.#aliasFor(e.atype, e.id2);
        return { atype: e.atype, id1: e.id1, db: to.db, id2: to.id, time: e.time, data: e.data };
      }),
    );
    const groups = new Map<bigint, typeof resolved[number][]>();
    for (const e of resolved) {
      const v = vshardOf(e.id1);
      const g = groups.get(v);
      if (g) g.push(e);
      else groups.set(v, [e]);
    }
    let written = 0;
    let done = 0;
    for (const group of groups.values()) {
      try {
        written += await this.write<number>({ kind: "assocAddMany", edges: group });
      } catch (e) {
        (e as Error).message +=
          ` (after ${done} of ${groups.size} vshard groups, ${written} edges, had been written)`;
        throw e;
      }
      done++;
    }
    return written;
  }

  async assocRemove(atype: number, id1: Id, id2: Ref): Promise<void> {
    const to = await this.#aliasFor(atype, id2);
    return this.write<void>({ kind: "assocRemove", atype, id1, db: to.db, id2: to.id });
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
    const now = opts.now ?? this.clock.now();

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

/** A direct write to the derived half of a paired edge type. Write its inverse: that side's writes
 *  maintain this one, and one writer per row is what keeps the two halves in step. */
export class MaintainedEdge extends Error {
  readonly edge: string;
  readonly by: string;
  constructor(edge: string, by: string) {
    super(`${edge} is maintained by ${by}; write ${by} instead`);
    this.name = "MaintainedEdge";
    this.edge = edge;
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
