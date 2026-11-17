// The transport a Worker and a host DO use: Durable Object stubs for hosts and the directory, and a
// KV namespace for the published shard map.
//
// This is the whole of what the platform costs. Everything above it — the client, both drivers, the
// re-routing on a refusal, the operators — is the same code the in-process cluster runs, which is why
// the suite can prove anything about it at all.

import type { Catalog } from "../../catalog/catalog.ts";
import { Catalog as Compile } from "../../catalog/catalog.ts";
import type { Lock } from "../../catalog/catalog.ts";
import type { Mutation, Transport } from "../../client/transport.ts";
import { chunkKey } from "../../directory/map.ts";
import type { Route } from "../../directory/map.ts";
import type { ExecReply, Reply, Routed } from "../../host/host.ts";
import type { Id, Miss, Plan } from "../../query/types.ts";
import { databaseOf, directoryStub, hostStub } from "./bindings.ts";
import type { Env } from "./bindings.ts";
import { call, routedToWire, routesFromWire } from "./rpc.ts";

/** One per isolate, keyed by the environment it was built from. The client memoizes on the transport
 *  and its shard-map chunks live there, so a transport rebuilt per request would re-read the map on
 *  every request — which is the one thing the published map exists to avoid. */
const pool = new WeakMap<Env, Transport>();

export function cloudflareTransport(env: Env): Transport {
  let transport = pool.get(env);
  if (!transport) pool.set(env, (transport = build(env)));
  return transport;
}

function build(env: Env): Transport {
  const database = databaseOf(env);
  /** The compiled catalog, which is stable for a catalog version and expensive to recompile. */
  let catalog: Catalog | null = null;

  return {
    async exec(host: number, plan: Plan, tasks: Miss[], routed: Routed): Promise<ExecReply> {
      return call<ExecReply>(hostStub(env, host), "exec", plan, tasks, routedToWire(routed));
    },

    async write(host: number, m: Mutation, epoch: number): Promise<Reply<unknown>> {
      return call<Reply<unknown>>(hostStub(env, host), "write", m, epoch);
    },

    async chunk(index: number): Promise<Uint8Array | null> {
      const bytes = await env.HLEKK_MAP.get(chunkKey(database, index), { type: "arrayBuffer" });
      return bytes === null ? null : new Uint8Array(bytes);
    },

    async resolve(vshards: readonly bigint[]): Promise<Map<bigint, Route>> {
      const wire = await call<[string, Route][]>(directoryStub(env), "resolve", vshards.map(String));
      return routesFromWire(wire);
    },

    async catalog(): Promise<Catalog> {
      if (!catalog) catalog = Compile.compile(await call<Lock>(directoryStub(env), "lock"));
      return catalog;
    },

    async place(affinity?: string): Promise<string> {
      return call<string>(directoryStub(env), "place", affinity ?? null);
    },

    async indexVshardFor(key: string): Promise<string> {
      return call<string>(directoryStub(env), "indexVshardFor", key);
    },

    async indexLookup(host: number, vshard: string, idx: number, key: string): Promise<Id | null> {
      return call<Id | null>(hostStub(env, host), "indexLookup", vshard, idx, key);
    },

    async intern(uri: string): Promise<number> {
      return call<number>(directoryStub(env), "intern", uri);
    },

    async aliases(): Promise<{ database: string | null; aliases: { alias: number; uri: string; state: string }[] }> {
      return call(directoryStub(env), "aliases");
    },
  };
}
