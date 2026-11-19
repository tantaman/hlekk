// What a Worker and a Durable Object see of the platform, as the narrowest structural types that
// serve. Hand-written for the same reason `DoStorage` is: nothing here needs a dependency on the
// generated worker types, and writing out what is actually used says what the layer depends on.

import { Directory } from "../../directory/directory.ts";
import { DEFAULT_CHUNK } from "../../host/host.ts";
import type { ChunkBudget } from "../../host/host.ts";
import type { DoStorage } from "../../host/sql.ts";

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
  /** Unpublishes a chunk. Only a database being erased needs this: a live map is rewritten in place,
   *  so a merely stale chunk is overwritten rather than removed. */
  delete(key: string): Promise<void>;
}

/**
 * An R2 bucket, as narrowly as a bulk load needs it.
 *
 * Narrow on purpose, and not only for the reason below: S3, minio, Azure blobs or a local directory
 * all satisfy these two members, so a bulk load is not tied to R2 and a port supplies whatever it has.
 *
 * Ranged `get` is the part that matters: a bulk payload is pulled in chunks a Durable Object can
 * insert inside one invocation, with the offset held as a cursor in its own storage, so progress
 * survives eviction and the whole load is resumable without a coordinator.
 */
export interface Bucket {
  get(
    key: string,
    options?: { range: { offset: number; length?: number } },
  ): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

/** A Durable Object's own context: its storage, and its alarm. */
export interface Ctx {
  storage: DoStorage & {
    setAlarm(at: number): Promise<void>;
    getAlarm(): Promise<number | null>;
    /**
     * Erases everything this object holds, and the only way to reclaim a Durable Object's storage.
     *
     * Nothing outside an object can delete it: a `deleted_classes` migration takes the whole
     * namespace and every database in it, deleting the Worker does the same, and the API has no
     * per-object delete. So an object can only be reclaimed by being asked to erase itself — which
     * matters here because changing `HLEKK_DATABASE` is how a clean slate is had, and it *abandons*
     * the old database rather than removing it.
     */
    deleteAll(): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
}

/** Every binding this database needs. Both the Worker and a host DO hold all of them: a host's alarm
 *  routes its own outbox deliveries, so it talks to other hosts the same way a Worker does. */
export interface Env {
  HLEKK_HOSTS: Namespace;
  HLEKK_DIRECTORY: Namespace;
  HLEKK_MAP: Kv;
  /**
   * This deployment's database. One deployment serves one database, by decision: a Durable Object's
   * env comes from the deployment that defines its namespace and never from whoever called it, so a
   * Worker holding two names does not get two databases — it gets one set of hosts that the second
   * database's directory adopts vshards on. That was tried; see `examples/wiki/wiki-app.ts`.
   *
   * It still scopes the DO names and the map's KV keys, which costs nothing and means a second
   * deployment can share the namespaces rather than needing its own.
   */
  HLEKK_DATABASE?: string;
  /**
   * The canonical URI this database is linked to by, for the cross-database protocol.
   *
   * Configuration and not a request, because the URI is the database's identity: to everyone holding
   * an edge into it, a database that answers at another name is another database. Recorded in the
   * directory the first time it opens, and refused if it later disagrees. Absent is the state every
   * database deployed before the protocol existed is in — it can still be read over the protocol,
   * since answering is about its own objects, but it cannot tell a reference to itself from a
   * reference to a stranger, so it does not collapse one.
   */
  HLEKK_DATABASE_URI?: string;
  /** Lowers the placement controller's byte threshold, so a demo can reach a rebalance without
   *  writing gigabytes. */
  HLEKK_SHED_BYTES?: string;
  /** Where bulk payloads are staged, for a load that bypasses the mutation path. Optional, because
   *  only a deployment doing a bulk import binds it. */
  HLEKK_BULK?: Bucket;
  /** The initial vshard count, and the size of each later batch. A database keeps the value it was
   *  created with: the count is read once, when the directory first opens, and changing it afterwards
   *  moves nothing. Left unset it is INITIAL_VSHARDS. */
  HLEKK_VSHARDS?: string;
  /** Rows per chunk of a move's copy. Lowered so a demo's small vshards still cross in many chunks;
   *  left unset it is DEFAULT_CHUNK, which is sized for a request on a deployed host. */
  HLEKK_CHUNK_ROWS?: string;
}

export const databaseOf = (env: Env): string => env.HLEKK_DATABASE ?? "demo";

/** The initial vshard count this database was created with, or the default. A count the id layout
 *  cannot hold is refused here rather than at the first assignment, where the reason would be a
 *  constraint failure on a vshard number. */
export function vshardsOf(env: Env): number | undefined {
  if (env.HLEKK_VSHARDS === undefined) return undefined;
  const n = Number(env.HLEKK_VSHARDS);
  if (!Number.isInteger(n) || n < 1 || BigInt(n) > Directory.maxVshards) {
    throw new RangeError(`HLEKK_VSHARDS must be an integer in 1..${Directory.maxVshards}, got ${env.HLEKK_VSHARDS}`);
  }
  return n;
}

/** What one chunk of a move's copy may carry. Only the row bound is configurable: it is the one a
 *  test wants lowered, and the byte bound is a property of the platform's request limits. */
export function chunkOf(env: Env): ChunkBudget {
  if (env.HLEKK_CHUNK_ROWS === undefined) return DEFAULT_CHUNK;
  const rows = Number(env.HLEKK_CHUNK_ROWS);
  if (!Number.isInteger(rows) || rows < 1) throw new RangeError(`HLEKK_CHUNK_ROWS must be a positive integer, got ${env.HLEKK_CHUNK_ROWS}`);
  return { ...DEFAULT_CHUNK, rows };
}

/** The directory is one DO per database. */
export const directoryStub = (env: Env): Stub =>
  env.HLEKK_DIRECTORY.get(env.HLEKK_DIRECTORY.idFromName(`${databaseOf(env)}/directory`));

/** A host by index. The name is derived, which is what keeps host identity out of the shard map. */
export const hostStub = (env: Env, host: number): Stub =>
  env.HLEKK_HOSTS.get(env.HLEKK_HOSTS.idFromName(`${databaseOf(env)}/h-${host}`));
