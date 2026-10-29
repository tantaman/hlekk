// A whole database in one process: a directory, some hosts, and a published map. The transport a
// Worker uses in production speaks to DO stubs and a KV binding instead; everything above it is the
// same code.
//
// Publishing is explicit, so a test can leave the map stale and watch a refusal place the request.

import { Directory } from "../directory/directory.ts";
import { chunkKey } from "../directory/map.ts";
import type { Route } from "../directory/map.ts";
import { Host } from "../host/host.ts";
import type { ExecReply, Reply, Routed } from "../host/host.ts";
import { nodeSql } from "../host/sql.node.ts";
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

  constructor(opts: LocalOptions = {}) {
    this.database = opts.database ?? "db";
    this.directory = Directory.open(nodeSql(), { database: this.database, batch: opts.batch });
    for (const h of this.directory.hostIndexes()) this.host(h);
    this.adoptAll();
    this.transport = this.#transport();
  }

  /** The host at an index, created empty if it is new. A host receives vshards; it never mints them. */
  host(index: number): Host {
    let host = this.hosts.get(index);
    if (!host) {
      this.hosts.set(index, (host = Host.open(nodeSql(), this.directory.catalog())));
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
    return Hlekk.from(this.transport);
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
            return h.update({ id: m.id, data: m.data, epoch });
          case "delete":
            return h.delete({ id: m.id, epoch });
          case "assocAdd":
            return h.assocAdd({ atype: m.atype, id1: m.id1, id2: m.id2, time: m.time, data: m.data, epoch });
          case "assocRemove":
            return h.assocRemove({ atype: m.atype, id1: m.id1, id2: m.id2, epoch });
          case "apply":
            return h.apply(m.op);
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
    };
  }

  /** Which host currently holds a vshard, for assertions. */
  holderOf(vshard: bigint): number | undefined {
    return this.directory.resolve(vshard)?.host;
  }
}
