// What a Worker and a Durable Object see of the platform, as the narrowest structural types that
// serve. Hand-written for the same reason `DoStorage` is: nothing here needs a dependency on the
// generated worker types, and writing out what is actually used says what the layer depends on.

import type { DoStorage } from "../host/sql.ts";

export interface Stub {
  fetch(request: Request): Promise<Response>;
}

export interface Namespace {
  /** A stub by name, so a host's identity is derived from its index and the map carries no name
   *  table. */
  idFromName(name: string): unknown;
  get(id: unknown): Stub;
}

/** Where published shard-map chunks live. Values are bytes; `chunk()` reads them back as such. */
export interface Kv {
  get(key: string, options: { type: "arrayBuffer" }): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer | Uint8Array): Promise<void>;
}

/** A Durable Object's own context: its storage, and its alarm. */
export interface Ctx {
  storage: DoStorage & {
    setAlarm(at: number): Promise<void>;
    getAlarm(): Promise<number | null>;
  };
}

/** Every binding this database needs. Both the Worker and a host DO hold all of them: a host's alarm
 *  routes its own outbox deliveries, so it talks to other hosts the same way a Worker does. */
export interface Env {
  HLEKK_HOSTS: Namespace;
  HLEKK_DIRECTORY: Namespace;
  HLEKK_MAP: Kv;
  /** Scopes DO names, so one namespace can hold many databases. */
  HLEKK_DATABASE?: string;
  /** Lowers the placement controller's byte threshold, so a demo can reach a rebalance without
   *  writing gigabytes. */
  HLEKK_SHED_BYTES?: string;
}

export const databaseOf = (env: Env): string => env.HLEKK_DATABASE ?? "demo";

/** The directory is one DO per database. */
export const directoryStub = (env: Env): Stub =>
  env.HLEKK_DIRECTORY.get(env.HLEKK_DIRECTORY.idFromName(`${databaseOf(env)}/directory`));

/** A host by index. The name is derived, which is what keeps host identity out of the shard map. */
export const hostStub = (env: Env, host: number): Stub =>
  env.HLEKK_HOSTS.get(env.HLEKK_HOSTS.idFromName(`${databaseOf(env)}/h-${host}`));
