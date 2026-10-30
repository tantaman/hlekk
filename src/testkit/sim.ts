// The simulation: one seeded schedule, everything at once.
//
// The rest of the suite tests in phases — write it all, then move it all, then read. A phase order is
// a decision the test made, and the bugs that matter live between the phases: a route cache warmed
// before a move, a vshard rebalanced out from under a half-delivered outbox, a write racing the flip,
// a read crossing a host that was fenced after the plan was made. So this picks the next thing to do
// from a weighted draw and keeps going, and the only things it believes are the invariants and the
// fact that a read cannot depend on where the data sits.
//
// Nothing here is a script, because nothing replays it. The oracles are the invariant checker and the
// collapse at the end, and both hold whatever order the schedule happened to take.

import { Hlekk, VersionConflict } from "../client/client.ts";
import { LocalCluster } from "../client/local.ts";
import type { Thresholds } from "../directory/placement.ts";
import type { MoveHosts } from "../directory/move.ts";
import { Deliverer } from "../host/outbox.ts";
import type { Fields, Id, Json } from "../query/types.ts";
import { deterministic, seeded } from "../runtime/runtime.ts";
import type { Random } from "../runtime/runtime.ts";
import type { Query } from "../schema/query.ts";
import { generateQuery } from "./generate.ts";
import { assertSound } from "./invariants.ts";
import { unreliable } from "./unreliable.ts";
import type { Faults } from "./unreliable.ts";
import type { Shape } from "./shape.ts";
import { writableOut } from "./shape.ts";

/** The things the schedule can decide to do next, and how often it decides to. A write-heavy mix, so
 *  there is something for the rest of them to be wrong about. */
const WEIGHTS = {
  write: 34,
  read: 12,
  deliver: 10,
  publish: 4,
  move: 5,
  crashMove: 2,
  resumeMoves: 2,
  rebalance: 3,
  grow: 2,
  migrate: 2,
  unique: 3,
  lookup: 2,
  sweep: 1,
  kill: 1,
  revive: 1,
  check: 3,
} as const;

export type Event = keyof typeof WEIGHTS;

/** Every decision the schedule can make, so a test can say it made all of them. */
export const EVENTS = Object.keys(WEIGHTS) as Event[];

export interface SimOptions {
  shape: Shape;
  /** Later versions of it, in order, each planned on top of the last. The schedule applies them as it
   *  goes, and the settle applies whatever is left: a database does eventually finish migrating. */
  migrations?: readonly Shape[];
  seed: number;
  /** Hosts the database starts spread over, before anything is written. */
  hosts?: number;
  /** How many decisions the schedule makes. */
  steps?: number;
  /** A network, where one is wanted. Latency costs virtual ticks, so it is off by default and a few
   *  seeds turn it on. */
  faults?: Faults;
  /** The vshard batch, kept small so growth and rebalancing are reachable. */
  batch?: number;
  cap?: number;
  thresholds?: Thresholds;
}

export interface SimReport {
  /** What the schedule actually did, so a test can say it did it. */
  events: Record<string, number>;
  /** Errors the workload saw, by name. A simulation where nothing was ever refused was not testing
   *  the refusals. */
  errors: Record<string, number>;
  /** Objects the simulation still believes exist. A cascade can take one without telling it. */
  live: number;
  hosts: number;
  moves: number;
  /** The most rows waiting in any one outbox during the run. */
  queuedPeak: number;
  /** The catalog version it ended on. */
  catalog: number;
  reads: { ran: number; rows: number };
  checks: number;
}

export interface Simulated {
  cluster: LocalCluster;
  report: SimReport;
  /** What the simulation believes is still there, for a caller that wants to read it. */
  roots: { id: Id; type: string }[];
  /** The client the workload used, with the route cache the run left it holding. */
  db: Hlekk;
  /** The schema version the run ended on, which is what a query over the result is built from. */
  shape: Shape;
}

const UNIQUE_INDEX = 1;

export async function simulate(opts: SimOptions): Promise<Simulated> {
  // The schema the workload is written against. A migration swaps it, so everything below reads it
  // rather than closing over the one the caller passed.
  let shape = opts.shape;
  const pending = [...(opts.migrations ?? [])];
  const steps = opts.steps ?? 200;
  const runtime = deterministic(opts.seed);
  const c = new LocalCluster({
    batch: opts.batch ?? 8,
    cap: opts.cap ?? 1_000_000,
    thresholds: opts.thresholds ?? { bytes: 4_000, requests: 2_000 },
    runtime,
  });
  c.directory.applyLock(shape.lock);
  if ((opts.hosts ?? 3) > 1) c.scatter(opts.hosts ?? 3);
  c.openIndexVshards(2);
  c.spreadCatalog();
  await c.publish();

  // The schedule and the faults draw on their own streams, so what the schedule does next does not
  // depend on how many random numbers the last query happened to consume.
  const r = seeded(opts.seed ^ 0x5eed);
  const faultRandom = seeded(opts.seed ^ 0xfa17);
  const transport = unreliable(c.transport, { clock: runtime.clock, random: faultRandom }, opts.faults ?? {});
  const db = Hlekk.from(transport, runtime.clock);

  const live: { id: Id; type: string }[] = [];
  const written: { atype: number; id1: Id; id2: Id }[] = [];
  const taken: string[] = [];
  const report: SimReport = {
    events: {},
    errors: {},
    live: 0,
    hosts: 0,
    moves: 0,
    queuedPeak: 0,
    catalog: 0,
    reads: { ran: 0, rows: 0 },
    checks: 0,
  };
  const note = (where: Record<string, number>, what: string) => (where[what] = (where[what] ?? 0) + 1);
  /** Runs one thing the schedule asked for. A refusal is an outcome, not a failure: that is what a
   *  fenced vshard, a stale route, a version conflict and a dropped request all look like. */
  const attempt = async (work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (e) {
      note(report.errors, e instanceof Error ? e.name : String(e));
    }
  };

  /** Vshards a root may be placed in by name: assigned, and not an index vshard. */
  const placeable = (): bigint[] => {
    const reserved = new Set(c.directory.indexVshards().map(String));
    return c.directory
      .hostIndexes()
      .flatMap((h) => c.directory.vshardsOn(h))
      .filter((v) => !reserved.has(v.toString()));
  };
  /** An object to work on. Biased towards the ones just made, because a workload spread uniformly
   *  over everything it has ever created never touches one object twice, and a race needs two
   *  writers: no conflict, no contended edge, no delete of something with edges on it. */
  const pickLive = (fit: (o: { id: Id; type: string }) => boolean = () => true) => {
    const recent = live.slice(-8).filter(fit);
    if (recent.length > 0 && r.chance(0.6)) return r.pick(recent);
    const all = live.filter(fit);
    return all.length === 0 ? undefined : r.pick(all);
  };
  const liveOf = (type: string) => live.filter((o) => o.type === type);
  const body = (type: string): { data: Fields; refs: Record<string, number> } =>
    shape.payload(r, type, (target) => {
      const of = liveOf(target);
      return of.length === 0 ? undefined : live.indexOf(r.pick(of));
    });
  const fill = (w: { data: Fields; refs: Record<string, number> }): Record<string, Json> => {
    const data = { ...w.data };
    for (const [field, at] of Object.entries(w.refs)) data[field] = live[at]?.id ?? "0";
    return data;
  };

  const create = async (): Promise<void> => {
    const type = r.pick(Object.keys(shape.types));
    const w = body(type);
    const parent = pickLive();
    const vshards = placeable();
    // Every way a caller can ask for placement: hard colocation, an affinity key, an explicit vshard,
    // and nothing at all, which is the allocator's to decide.
    const at =
      parent && r.chance(0.25)
        ? { with: parent.id }
        : r.chance(0.3)
          ? { affinity: r.pick(["t0", "t1", "t2"]) }
          : vshards.length > 0 && r.chance(0.5)
            ? { vshard: r.pick(vshards).toString() }
            : {};
    const id = await db.create(shape.types[type].otype, fill(w), at);
    live.push({ id, type });
  };

  /** The version this caller last saw for an object, as an application holding a read would. It goes
   *  stale the moment anything else writes, which is what a conditional update is for. */
  const seen = new Map<Id, number>();

  const update = async (): Promise<void> => {
    const o = pickLive();
    if (!o) return;
    // Half the time it carries the version it holds — read now if it has none, which is a real query
    // on the read path — and the other half writes unconditionally and leaves every other caller's
    // version behind.
    let expect: number | undefined;
    if (r.chance(0.5)) {
      if (!seen.has(o.id)) {
        const rows = (await shape.types[o.type].gen(o.id).run(db)) as { $version?: number }[];
        if (rows[0]?.$version !== undefined) seen.set(o.id, rows[0].$version);
      }
      expect = seen.get(o.id);
    }
    try {
      seen.set(o.id, await db.update(o.id, fill(body(o.type)), expect === undefined ? {} : { expect }));
    } catch (e) {
      // A conflict says what the version actually is, which is what the caller re-reads with.
      if (e instanceof VersionConflict) seen.set(o.id, e.actual);
      throw e;
    }
  };

  const erase = async (): Promise<void> => {
    const o = pickLive();
    if (!o) return;
    await db.delete(o.id);
    // A cascade may have taken others with it; the simulation does not try to work out which, and a
    // later read of one is a legitimate read of something that is gone.
    live.splice(live.indexOf(o), 1);
  };

  const assoc = async (): Promise<void> => {
    // From a type that has an edge to write: every pair is written from one side, so the other side's
    // type may originate nothing, and picking uniformly would spend most steps on those.
    const from = pickLive((o) => writableOut(shape, o.type).length > 0);
    if (!from) return;
    const rel = r.pick(writableOut(shape, from.type));
    const targets = liveOf(rel.to);
    if (targets.length === 0) return;
    const to = r.pick(targets);
    await db.assocAdd(rel.atype!, from.id, to.id, r.int(8), r.chance(0.3) ? { tag: r.pick(["x", "y"]) } : null);
    written.push({ atype: rel.atype!, id1: from.id, id2: to.id });
  };

  const unassoc = async (): Promise<void> => {
    if (written.length === 0) return;
    const e = r.pick(written);
    await db.assocRemove(e.atype, e.id1, e.id2);
  };

  const read = async (): Promise<void> => {
    const rooted = live.filter((x) => shape.outgoing[x.type].length > 0);
    if (rooted.length === 0) return;
    const o = r.pick(rooted);
    const q = generateQuery(r, shape, o.type, shape.types[o.type].gen(o.id) as unknown as Query<never, unknown>, {
      depth: 2 + r.int(2),
    });
    const rows = await q.run(db, { driver: r.chance(0.3) ? "rounds" : "async" });
    report.reads.ran++;
    report.reads.rows += rows.length;
  };

  const act: Record<Event, () => Promise<void>> = {
    write: async () => {
      // Several at once, so two writes are in flight against different hosts and their replies come
      // back in whatever order the network gives them.
      const kinds = [...Array(1 + r.int(3))].map(() =>
        r.pick(["create", "create", "create", "assoc", "assoc", "update", "erase", "unassoc"] as const),
      );
      const run = { create, update, erase, assoc, unassoc };
      await Promise.all(kinds.map((k) => attempt(run[k])));
    },
    read: () => attempt(read),
    deliver: async () => {
      // One partial pass on one host, not a drain to quiet: an outbox that is always empty is an
      // outbox nothing is ever read across.
      const hosts = [...c.hosts.keys()];
      if (hosts.length === 0) return;
      const host = c.host(r.pick(hosts));
      await attempt(() => new Deliverer(host, db).drain(1 + r.int(4)));
    },
    publish: () => attempt(() => c.publish()),
    move: async () => {
      const vshards = placeable();
      if (vshards.length === 0) return;
      const v = r.pick(vshards);
      const from = c.directory.resolve(v)!.host;
      let to = r.int(c.directory.nextHost() + 1);
      if (to === from) to = from + 1;
      await attempt(async () => {
        c.mover.begin(v, to);
        await c.mover.run(v);
        report.moves++;
      });
    },
    crashMove: async () => {
      const vshards = placeable();
      if (vshards.length === 0) return;
      const v = r.pick(vshards);
      const from = c.directory.resolve(v)!.host;
      // Every step that is a call to a host. Flip is not one: it is a directory write, with nothing
      // to fail.
      c.failAt(r.pick(["ensure", "fence", "snapshot", "install", "retire", "purge"] as (keyof MoveHosts)[]));
      await attempt(async () => {
        c.mover.begin(v, from + 1);
        await c.mover.run(v);
      });
      c.heal(); // the move stays recorded at the step it died on, for a later resume
    },
    resumeMoves: () => attempt(() => c.mover.resume()),
    rebalance: () =>
      attempt(async () => {
        await c.rebalance();
        c.allocator.resetRequests(); // a controller's window, or request pressure never falls
      }),
    grow: () =>
      attempt(async () => {
        c.allocator.grow();
        await c.publish();
      }),
    migrate: () =>
      attempt(async () => {
        const next = pending.shift();
        if (!next) return;
        c.directory.applyLock(next.lock);
        c.spreadCatalog();
        shape = next;
      }),
    unique: async () => {
      const type = r.pick(Object.keys(shape.types));
      const value = `v${r.int(12)}`;
      await attempt(async () => {
        const id = await db.createUnique(UNIQUE_INDEX, value, shape.types[type].otype, fill(body(type)), {});
        live.push({ id, type });
        taken.push(value);
      });
    },
    lookup: () =>
      attempt(async () => {
        const value = taken.length > 0 && r.chance(0.7) ? r.pick(taken) : `v${r.int(12)}`;
        await db.lookupUnique(UNIQUE_INDEX, value);
      }),
    sweep: async () => {
      c.sweepIndexes(runtime.clock.now(), 1 + r.int(60_000));
    },
    kill: async () => {
      const hosts = [...c.hosts.keys()];
      if (hosts.length > 1) c.kill(r.pick(hosts));
    },
    revive: async () => {
      c.heal();
    },
    check: async () => {
      // Mid-flight, so neither the outbox nor a move in progress is assumed settled.
      assertSound(c);
      report.checks++;
    },
  };

  const draw = Object.entries(WEIGHTS).flatMap(([event, n]) => [...Array(n)].map(() => event as Event));

  for (let step = 0; step < steps; step++) {
    const event = r.pick(draw);
    note(report.events, event);
    await act[event]();
    report.queuedPeak = Math.max(report.queuedPeak, c.queued());
  }

  // Everything stops, and the cluster is given the chance to settle. A database that cannot reach a
  // quiet state after the faults stop has lost something.
  c.heal();
  unwedge(c);
  await attempt(() => c.mover.resume());
  // Whatever the schedule did not get round to migrating. A host that lags the catalog does not
  // maintain an edge type it has not heard of, so a cluster the invariants are about to be read
  // against has to be on one version — which is a database that finished its migration, not a
  // convenience. What a lagging host costs is its own test.
  for (const next of pending.splice(0)) {
    c.directory.applyLock(next.lock);
    shape = next;
  }
  c.spreadCatalog();
  await c.publish();
  for (let pass = 0; pass < 32 && c.queued() > 0; pass++) await c.deliverAll();

  report.live = live.length;
  report.hosts = c.directory.hostIndexes().length;
  report.catalog = c.directory.catalog().version;
  return { cluster: c, report, roots: [...live], db, shape };
}

/** Clears the attempt counters on moves the schedule wedged. The mover gives up on a step that keeps
 *  failing rather than hammering it, and leaves the move for a human; the end of a run is the human,
 *  and whatever was failing — a host the schedule killed, a step it made fail — has stopped. */
function unwedge(c: LocalCluster): void {
  c.directory.sql.run("UPDATE moves SET attempts = 0");
}

/** Moves every vshard onto one host that has never held anything. The data does not change, so no
 *  read of it may: this is the oracle's contract run backwards, and it holds whatever the schedule
 *  did, which no replay of a script could claim. */
export async function collapse(c: LocalCluster): Promise<number> {
  unwedge(c);
  await c.mover.resume();
  const to = c.directory.nextHost();
  const from = c.directory.hostIndexes().filter((h) => h !== to);
  for (const index of from) {
    for (const v of c.directory.vshardsOn(index)) {
      c.mover.begin(v, to);
      await c.mover.run(v);
    }
  }
  c.spreadCatalog();
  await c.publish();
  for (let pass = 0; pass < 16 && c.queued() > 0; pass++) await c.deliverAll();
  return to;
}

/** A query over each root the simulation left behind, built from its own stream so it does not depend
 *  on what the run consumed. */
export function probes(shape: Shape, roots: { id: Id; type: string }[], seed: number, n = 12): Query<never, unknown>[] {
  const r = seeded(seed);
  const usable = roots.filter((o) => shape.outgoing[o.type].length > 0);
  return r.shuffle(usable)
    .slice(0, n)
    .map((o) =>
      generateQuery(r, shape, o.type, shape.types[o.type].gen(o.id) as unknown as Query<never, unknown>, { depth: 3 }),
    );
}
