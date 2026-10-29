// A whole database in one process: a directory, some hosts, and a published map. The transport a
// Worker uses in production speaks to DO stubs and a KV binding instead; everything above it is the
// same code.
//
// Publishing is explicit, so a test can leave the map stale and watch a refusal place the request.

import { Directory } from "../directory/directory.ts";
import { chunkKey } from "../directory/map.ts";
import type { Route } from "../directory/map.ts";
import { Allocator } from "../directory/allocator.ts";
import { Mover } from "../directory/move.ts";
import { Placement } from "../directory/placement.ts";
import type { MoveHosts } from "../directory/move.ts";
import type { Shed, Thresholds } from "../directory/placement.ts";
import { Host } from "../host/host.ts";
import { Deliverer } from "../host/outbox.ts";
import type { ExecReply, Reply, Routed, Snapshot } from "../host/host.ts";
import { nodeSql } from "../host/sql.node.ts";
import { systemRuntime } from "../runtime/runtime.ts";
import type { Runtime } from "../runtime/runtime.ts";
import type { Catalog } from "../catalog/catalog.ts";
import type { Miss, Plan } from "../query/types.ts";
import { Hlekk } from "./client.ts";
import type { Mutation, Transport } from "./transport.ts";

/** Where published chunks live. A KV namespace in production. */
export interface MapStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, value: Uint8Array): Promise<void>;
}

export class MemoryMapStore implements MapStore {
  readonly entries = new Map<string, Uint8Array>();
  /** Reads served, so a test can see that routing stayed off the request path. */
  reads = 0;
  writes = 0;

  get(key: string): Promise<Uint8Array | null> {
    this.reads++;
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  put(key: string, value: Uint8Array): Promise<void> {
    this.writes++;
    this.entries.set(key, value);
    return Promise.resolve();
  }
}

export interface LocalOptions {
  database?: string;
  batch?: number;
  /** Time and chance. Pass a deterministic one and the whole cluster replays from a seed. */
  runtime?: Runtime;
  /** A vshard's soft byte cap, lowered in tests so growth and rebalancing are reachable. */
  cap?: number;
  thresholds?: Thresholds;
}

/** A database running in this process. */
export class LocalCluster {
  readonly directory: Directory;
  readonly store = new MemoryMapStore();
  readonly hosts = new Map<number, Host>();
  readonly transport: Transport;
  /** Host requests served, so a test can assert what a query cost. */
  readonly calls = { exec: 0, write: 0, resolve: 0 };
  readonly database: string;

  readonly mover: Mover;
  readonly allocator: Allocator;
  readonly placement: Placement;
  /** Hosts a chaos test has knocked over. Every move operation against one throws. */
  readonly down = new Set<number>();

  readonly runtime: Runtime;

  constructor(opts: LocalOptions = {}) {
    this.runtime = opts.runtime ?? systemRuntime;
    this.database = opts.database ?? "db";
    this.directory = Directory.open(nodeSql(), { database: this.database, batch: opts.batch });
    for (const h of this.directory.hostIndexes()) this.host(h);
    this.adoptAll();
    this.transport = this.#transport();
    this.mover = new Mover(this.directory, this.#moveHosts());
    this.allocator = new Allocator(this.directory, {
      cap: opts.cap,
      random: this.runtime.random,
      open: (vshard, host, epoch) => this.host(host).adopt(vshard.toString(), epoch),
    });
    this.placement = new Placement(this.directory, this.allocator, this.mover, opts.thresholds ?? {});
  }

  /** One turn of the controller's alarm: read what the hosts hold, then move what is over threshold
   *  and publish the map once. */
  async rebalance(): Promise<Shed[]> {
    this.collect();
    const sheds = await this.placement.rebalance(() => this.publish());
    this.spreadCatalog();
    return sheds;
  }

  /** Pulls each host's per-vshard size and request rate into the directory. */
  collect(): void {
    for (const host of this.hosts.values()) this.allocator.observe(host.stats());
  }

  /** Move operations a chaos test has made fail, by name. */
  readonly failing = new Set<keyof MoveHosts>();

  /** Knocks a host over, so the move driving it fails partway and has to resume. */
  kill(host: number): void {
    this.down.add(host);
  }

  revive(host: number): void {
    this.down.delete(host);
  }

  /** Fails one step of the move protocol, wherever it runs, so a test can crash at a chosen point. */
  failAt(...steps: (keyof MoveHosts)[]): void {
    for (const s of steps) this.failing.add(s);
  }

  heal(): void {
    this.failing.clear();
    this.down.clear();
  }

  #live(host: number, step: keyof MoveHosts): Host {
    if (this.failing.has(step)) throw new Error(`${step} is failing`);
    if (this.down.has(host)) throw new Error(`host ${host} is down`);
    return this.host(host);
  }

  #moveHosts(): MoveHosts {
    const c = this;
    return {
      async ensure(host: number): Promise<void> {
        // A new host DO is created empty and receives whole vshards. It never mints them.
        c.#live(host, "ensure");
      },
      async fence(host: number, vshard: string): Promise<void> {
        c.#live(host, "fence").setState(vshard, "fenced");
      },
      async snapshot(host: number, vshard: string): Promise<Snapshot> {
        return c.#live(host, "snapshot").snapshot(vshard);
      },
      async install(host: number, snapshot: Snapshot, epoch: number): Promise<void> {
        c.#live(host, "install").install(snapshot, epoch);
      },
      async retire(host: number, vshard: string): Promise<void> {
        c.#live(host, "retire").setState(vshard, "moved");
      },
      async purge(host: number, vshard: string): Promise<void> {
        c.#live(host, "purge").purge(vshard);
      },
    };
  }

  /** The host at an index, created empty if it is new. A host receives vshards; it never mints them. */
  host(index: number): Host {
    let host = this.hosts.get(index);
    if (!host) {
      this.hosts.set(index, (host = Host.open(nodeSql(), this.directory.catalog(), this.runtime.clock)));
      this.directory.addHost(index);
    }
    return host;
  }

  /** Installs on each host every vshard the directory says it owns. The move protocol does this one
   *  vshard at a time; a fresh database does it in bulk. */
  adoptAll(): void {
    for (const index of this.directory.hostIndexes()) {
      const host = this.host(index);
      for (const v of this.directory.vshardsOn(index)) {
        const route = this.directory.resolve(v)!;
        if (!host.holds(v)) host.adopt(v.toString(), route.epoch);
      }
    }
  }

  /** Publishes the map. Once per rebalance, not once per move: a chunk rewritten per move is rate
   *  limited on classic KV and expensive on KV Instant. */
  async publish(): Promise<void> {
    for (const i of this.directory.chunkIndexes()) {
      await this.store.put(chunkKey(this.database, i), this.directory.chunk(i));
    }
  }

  /** Pushes the newest catalog to every host, as a host behind the catalog would fetch it. */
  spreadCatalog(): void {
    for (const host of this.hosts.values()) host.setCatalog(this.directory.catalog());
  }

  client(): Hlekk {
    return Hlekk.from(this.transport, this.runtime.clock);
  }

  /** Runs every host's alarm until the outbox is quiet, as a cluster at rest would reach. */
  async deliverAll(passes = 16): Promise<number> {
    let delivered = 0;
    for (let i = 0; i < passes; i++) {
      let moved = 0;
      for (const [index, host] of [...this.hosts]) {
        void index;
        const pass = await new Deliverer(host, this.client()).drainAll();
        moved += pass.delivered;
      }
      delivered += moved;
      if (moved === 0) break; // nothing left that can be delivered
    }
    return delivered;
  }

  /** Opens index vshards and installs them, which a database does the first time an index exists. */
  openIndexVshards(n = 4): bigint[] {
    const opened = this.allocator.grow().slice(0, n);
    this.directory.setIndexVshards([...this.directory.indexVshards(), ...opened]);
    return opened;
  }

  /** Reclaims expired reservations on every index vshard, as an alarm would. */
  sweepIndexes(now = this.runtime.clock.now(), ttlMs = 30_000): number {
    let n = 0;
    for (const v of this.directory.indexVshards()) {
      const route = this.directory.resolve(v);
      if (route) n += this.host(route.host).indexSweep(v.toString(), now, ttlMs);
    }
    return n;
  }

  /** Rows still waiting across every host. */
  queued(): number {
    return [...this.hosts.values()].reduce((n, h) => n + h.pending().length, 0);
  }

  #transport(): Transport {
    const cluster = this;
    return {
      async exec(host: number, plan: Plan, tasks: Miss[], routed: Routed): Promise<ExecReply> {
        cluster.calls.exec++;
        return cluster.host(host).exec(plan, tasks, routed);
      },
      async write(host: number, m: Mutation, epoch: number): Promise<Reply<unknown>> {
        cluster.calls.write++;
        const h = cluster.host(host);
        switch (m.kind) {
          case "create":
            return h.create({ otype: m.otype, data: m.data, with: m.with, vshard: m.vshard, epoch });
          case "update":
            return h.update({ id: m.id, data: m.data, expect: m.expect, epoch });
          case "delete":
            return h.delete({ id: m.id, epoch });
          case "assocAdd":
            return h.assocAdd({ atype: m.atype, id1: m.id1, id2: m.id2, time: m.time, data: m.data, epoch });
          case "assocRemove":
            return h.assocRemove({ atype: m.atype, id1: m.id1, id2: m.id2, epoch });
          case "apply":
            return h.apply(m.op);
          case "indexReserve":
            return h.indexReserve({ vshard: m.vshard, idx: m.idx, key: m.key, now: m.now, ttlMs: m.ttlMs, epoch });
          case "indexConfirm":
            return h.indexConfirm({ vshard: m.vshard, idx: m.idx, key: m.key, id: m.id, epoch });
          case "indexRelease":
            return h.indexRelease({ vshard: m.vshard, idx: m.idx, key: m.key, epoch });
        }
      },
      chunk(index: number): Promise<Uint8Array | null> {
        return cluster.store.get(chunkKey(cluster.database, index));
      },
      async resolve(vshards: readonly bigint[]): Promise<Map<bigint, Route>> {
        cluster.calls.resolve++;
        const out = new Map<bigint, Route>();
        for (const v of vshards) {
          const r = cluster.directory.resolve(v);
          if (r) out.set(v, r);
        }
        return out;
      },
      async catalog(): Promise<Catalog> {
        return cluster.directory.catalog();
      },
      async place(affinity?: string): Promise<string> {
        return cluster.allocator.place(affinity).toString();
      },
      async indexVshardFor(key: string): Promise<string> {
        return cluster.directory.indexVshardFor(key).toString();
      },
      async indexLookup(host: number, vshard: string, idx: number, key: string): Promise<string | null> {
        const h = cluster.host(host);
        if (!h.holds(BigInt(vshard))) throw new Error(`host ${host} does not hold index vshard ${vshard}`);
        return h.indexLookup(vshard, idx, key);
      },
    };
  }

  /** Which host currently holds a vshard, for assertions. */
  holderOf(vshard: bigint): number | undefined {
    return this.directory.resolve(vshard)?.host;
  }
}
