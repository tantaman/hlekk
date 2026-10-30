// The directory, as a Durable Object: one per database. It says where a vshard probably is, holds the
// lock, drives moves and runs the placement controller. It is consulted on a route-cache miss and on
// the create path, and nowhere else.
//
// Two things the in-process version did not have to do. A vshard has to be adopted on its host before
// a write to it can land, and the allocator opens vshards synchronously — so the adoptions it asks
// for are collected and flushed by whichever call asked. And a host that a move creates has never
// seen the lock, so `ensure` is where it is given one.

import type { Lock } from "../catalog/catalog.ts";
import { Allocator } from "../directory/allocator.ts";
import { Directory } from "../directory/directory.ts";
import { chunkKey } from "../directory/map.ts";
import type { Route } from "../directory/map.ts";
import { Mover } from "../directory/move.ts";
import type { MoveHosts } from "../directory/move.ts";
import { Placement } from "../directory/placement.ts";
import type { Thresholds } from "../directory/placement.ts";
import type { Snapshot, VshardStats } from "../host/host.ts";
import { doSql } from "../host/sql.ts";
import { databaseOf, hostStub, vshardsOf } from "./bindings.ts";
import type { Ctx, Env } from "./bindings.ts";
import { call, routesToWire, serve } from "./rpc.ts";

/** How long after a move fails before the alarm picks it up again. */
export const RESUME_MS = 1_000;

export interface Holding {
  vshard: string;
  state: string;
  epoch: number;
  objects: number;
}

interface Parts {
  directory: Directory;
  mover: Mover;
  allocator: Allocator;
  placement: Placement;
}

export class HlekkDirectoryDO {
  readonly #ctx: Ctx;
  readonly #env: Env;
  #parts: Parts | null = null;
  /** Vshards the allocator opened that their host has not been told about yet. */
  readonly #opened: { vshard: bigint; host: number; epoch: number }[] = [];

  constructor(ctx: Ctx, env: Env) {
    this.#ctx = ctx;
    this.#env = env;
  }

  /** Built on first use, not in the constructor. Opening a database assigns its first batch of
   *  vshards in one transaction, and a Durable Object may not touch its storage while it is being
   *  constructed — which fails as an opaque internal error, with the reason nowhere in reach. */
  #ready(): Parts {
    if (!this.#parts) {
      const directory = Directory.open(doSql(this.#ctx.storage), {
        database: databaseOf(this.#env),
        batch: vshardsOf(this.#env),
      });
      const mover = new Mover(directory, this.#moveHosts());
      const allocator = new Allocator(directory, {
        open: (vshard, host, epoch) => this.#opened.push({ vshard, host, epoch }),
      });
      const placement = new Placement(directory, allocator, mover, this.#thresholds());
      this.#parts = { directory, mover, allocator, placement };
    }
    return this.#parts;
  }

  #thresholds(): Thresholds {
    const bytes = Number(this.#env.HLEKK_SHED_BYTES ?? NaN);
    return Number.isFinite(bytes) ? { bytes } : {};
  }

  /** What the mover needs from the hosts, each step one call. */
  #moveHosts(): MoveHosts {
    const env = this.#env;
    const lock = () => this.#lock();
    return {
      ensure: async (host: number) => {
        // A host a move creates has never seen the lock, and a host without one applies no onDelete
        // and maintains no inverse. It is given one before it is given any rows.
        await call(hostStub(env, host), "setCatalog", lock());
      },
      fence: async (host, vshard) => {
        await call(hostStub(env, host), "fence", vshard);
      },
      snapshot: (host, vshard) => call<Snapshot>(hostStub(env, host), "snapshot", vshard),
      install: async (host, snapshot, epoch) => {
        await call(hostStub(env, host), "install", snapshot, epoch);
      },
      retire: async (host, vshard) => {
        await call(hostStub(env, host), "retire", vshard);
      },
      purge: async (host, vshard) => {
        await call(hostStub(env, host), "purge", vshard);
      },
    };
  }

  #lock(): Lock {
    return this.#ready().directory.catalog().lock;
  }

  /** Tells each host about the vshards the allocator opened for it. One call per host, not per
   *  vshard: opening a batch is one decision and should cost one round trip to each host it touches. */
  async #flush(): Promise<void> {
    const pending = this.#opened.splice(0);
    if (pending.length === 0) return;
    const byHost = new Map<number, { vshard: string; epoch: number }[]>();
    for (const o of pending) {
      byHost.set(o.host, [...(byHost.get(o.host) ?? []), { vshard: o.vshard.toString(), epoch: o.epoch }]);
    }
    await Promise.all([...byHost].map(([host, entries]) => this.#adopt(host, entries)));
  }

  async #adopt(host: number, entries: { vshard: string; epoch: number }[]): Promise<void> {
    await call(hostStub(this.#env, host), "setCatalog", this.#lock());
    await call(hostStub(this.#env, host), "adopt", entries);
  }

  /** Publishes the map. Once per rebalance, not once per move: a chunk rewritten per move is rate
   *  limited on classic KV. */
  async #publish(): Promise<number> {
    const indexes = this.#ready().directory.chunkIndexes();
    for (const i of indexes) {
      await this.#env.HLEKK_MAP.put(chunkKey(databaseOf(this.#env), i), this.#ready().directory.chunk(i));
    }
    return indexes.length;
  }

  async fetch(request: Request): Promise<Response> {
    return serve(request, () => ({
      /** Applies the first lock and lays the database out over `hosts` hosts.
       *
       *  A new database's whole initial batch is on host 0, and nothing has adopted any of it yet, so
       *  spreading it is a reassignment rather than a move — there is nothing to copy. Which is also
       *  the only moment that is true. */
      init: async (lock: Lock, hosts: number, indexVshards: number) => {
        // Once only. Laying the database out is a reassignment with nothing to copy, which is true
        // exactly while nothing has been adopted; re-running it later would point vshards at hosts
        // that do not hold their rows, and the rows would simply stop being reachable.
        if (this.#ready().directory.catalog().version !== 0) {
          return {
            catalog: this.#ready().directory.catalog().version,
            hosts: this.#ready().directory.hostIndexes().length,
            chunks: this.#ready().directory.chunkIndexes().length,
            alreadyInitialized: true,
          };
        }
        this.#ready().directory.applyLock(lock);
        const all = this.#ready().directory
          .hostIndexes()
          .flatMap((h) => this.#ready().directory.vshardsOn(h))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const per = Math.ceil(all.length / Math.max(1, hosts));
        const spread = all.map((vshard, i) => ({ vshard, host: Math.min(hosts - 1, Math.floor(i / per)), epoch: 0 }));
        for (const e of spread) this.#ready().directory.addHost(e.host);
        this.#ready().directory.assignMany(spread);

        // Index vshards are their own, so a hot index does not drag unrelated data around with it.
        const opened = this.#ready().allocator.grow().slice(0, indexVshards);
        this.#ready().directory.setIndexVshards([...this.#ready().directory.indexVshards(), ...opened]);

        const byHost = new Map<number, { vshard: string; epoch: number }[]>();
        for (const e of [...spread, ...this.#opened.splice(0)]) {
          byHost.set(e.host, [...(byHost.get(e.host) ?? []), { vshard: e.vshard.toString(), epoch: e.epoch }]);
        }
        await Promise.all([...byHost].map(([host, entries]) => this.#adopt(host, entries)));
        const chunks = await this.#publish();
        return {
          catalog: this.#ready().directory.catalog().version,
          hosts: this.#ready().directory.hostIndexes().length,
          chunks,
          alreadyInitialized: false,
        };
      },

      lock: () => this.#lock(),

      applyLock: async (lock: Lock) => {
        this.#ready().directory.applyLock(lock);
        // Every host, including ones holding nothing: a delete applies every team's onDelete, so a
        // host behind the catalog is a host that quietly does not.
        await Promise.all(
          this.#ready().directory.hostIndexes().map((h) => call(hostStub(this.#env, h), "setCatalog", lock)),
        );
        return { catalog: this.#ready().directory.catalog().version };
      },

      resolve: (vshards: string[]): [string, Route][] => {
        const out = new Map<bigint, Route>();
        for (const v of vshards) {
          const route = this.#ready().directory.resolve(BigInt(v));
          if (route) out.set(BigInt(v), route);
        }
        return routesToWire(out);
      },

      place: async (affinity: string | null) => {
        const vshard = this.#ready().allocator.place(affinity ?? undefined);
        // The allocator may have opened a batch to answer this, and a vshard its host has not adopted
        // would refuse the write that is about to arrive.
        await this.#flush();
        if (this.#opened.length === 0 && this.#ready().directory.mapVersion() > 0) await this.#publish();
        return vshard.toString();
      },

      indexVshardFor: (key: string) => this.#ready().directory.indexVshardFor(key).toString(),

      grow: async () => {
        const opened = this.#ready().allocator.grow();
        await this.#flush();
        await this.#publish();
        return opened.map(String);
      },

      move: async (vshard: string, to: number) => {
        this.#ready().mover.begin(BigInt(vshard), to);
        const step = await this.#ready().mover.run(BigInt(vshard));
        await this.#publish();
        return { vshard, to, step };
      },

      /** One turn of the controller: read what the hosts hold, move what is over threshold, publish
       *  once. */
      rebalance: async () => {
        const hosts = this.#ready().directory.hostIndexes();
        const reports = await Promise.all(
          hosts.map(async (h) => ({
            host: h,
            stats: await call<VshardStats[]>(hostStub(this.#env, h), "stats"),
            bytes: await call<number>(hostStub(this.#env, h), "size"),
          })),
        );
        for (const r of reports) {
          this.#ready().allocator.observe(r.stats);
          this.#ready().directory.observeHostBytes(r.host, r.bytes);
        }
        const sheds = await this.#ready().placement.rebalance(() => this.#publish().then(() => undefined));
        await this.#flush();
        this.#ready().allocator.resetRequests();
        // Vshards cross the wire as decimal strings, so the shape says so rather than relying on the
        // serializer to notice. The loads go with them because a shed is only meaningful against what
        // the hosts reported: a threshold an empty database already crosses proves nothing.
        return {
          sheds: sheds.map((s) => ({ ...s, vshards: s.vshards.map(String) })),
          loads: this.#ready().placement
            .load()
            .map((l) => ({ host: l.host, bytes: l.bytes, reported: l.reported, vshards: l.vshards.length })),
        };
      },

      publish: () => this.#publish(),

      resume: async () => {
        await this.#ready().mover.resume();
        await this.#publish();
        return this.#ready().mover.inFlight().length;
      },

      /** Where everything is, for an operator or a test. */
      where: async () => {
        const hosts = this.#ready().directory.hostIndexes();
        const holdings = await Promise.all(hosts.map((h) => call<Holding[]>(hostStub(this.#env, h), "holdings")));
        const pending = await Promise.all(hosts.map((h) => call<number>(hostStub(this.#env, h), "pending")));
        return {
          database: databaseOf(this.#env),
          catalog: this.#ready().directory.catalog().version,
          mapVersion: this.#ready().directory.mapVersion(),
          indexVshards: this.#ready().directory.indexVshards().map(String),
          inFlight: this.#ready().mover.inFlight().length,
          hosts: hosts.map((host, i) => ({
            host,
            vshards: holdings[i].length,
            objects: holdings[i].reduce((n, v) => n + v.objects, 0),
            pending: pending[i],
            holding: holdings[i].filter((v) => v.objects > 0),
          })),
        };
      },

      /** Drains every host, for a caller that would rather not wait for alarms. */
      deliver: async () => {
        let left = 0;
        for (let pass = 0; pass < 8; pass++) {
          const each = await Promise.all(
            this.#ready().directory.hostIndexes().map((h) => call<number>(hostStub(this.#env, h), "drain")),
          );
          left = each.reduce((n, p) => n + p, 0);
          if (left === 0) break;
        }
        return left;
      },
    }));
  }

  /** The alarm: a move that failed partway is resumed rather than left with a vshard fenced. */
  async alarm(): Promise<void> {
    try {
      await this.#ready().mover.resume();
      await this.#publish();
    } finally {
      if (this.#ready().mover.inFlight().length > 0) await this.#ctx.storage.setAlarm(Date.now() + RESUME_MS);
    }
  }
}
