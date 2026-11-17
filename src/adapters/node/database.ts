// A whole hlekk database in one Node process, over files.
//
// This is "spin up your own, with no account anywhere" — and the proof that the design is
// implementable off the platform it was designed on. What it swaps is the two platform seams that
// Cloudflare supplied: a Durable Object's SQLite becomes a file, and the published shard map becomes
// a file too. Everything above that — the client, both drivers, the directory, the allocator, the
// placement controller, the move protocol, the outbox — is the code a deployment runs, unchanged.
//
// **One writer at a time**, which `docs/design.md` names as a precondition rather than a limitation:
// every mutation commits in one transaction and the ownership fence is per vshard, so two processes
// over one directory would be two writers of one vshard with nothing ordering them. One process is
// what satisfies that, and it is also what a single-node deployment is.
//
// What this is NOT is the Cloudflare adapter's equal. There is no alarm, so the outbox is drained by
// whoever asks; there is no eviction, so nothing is reopened; and `size()` is the file's own, which
// is the figure a per-process limit would be enforced on if there were one.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Catalog } from "../../catalog/catalog.ts";
import type { Lock } from "../../catalog/catalog.ts";
import { Hlekk } from "../../client/client.ts";
import { LocalCluster } from "../../client/local.ts";
import type { HostClient } from "../../query/driver.ts";
import { nodeSql } from "../../host/sql.node.ts";
import type { StorageFormat } from "../../host/schema.ts";
import { Deliverer } from "../../host/outbox.ts";
import { discover, foreignClient } from "../../protocol/client.ts";
import type { ForeignOptions, Pins } from "../../protocol/client.ts";
import { ResponseCache } from "../../protocol/client.ts";
import { surfaceOf } from "../../protocol/surface.ts";
import type { Binding } from "../../protocol/http.ts";
import type { Projection } from "../../catalog/projection.ts";
import type { Policy } from "../../query/serve.ts";
import type { ListenBinding } from "./http.ts";
import { privateAddressGuard } from "./guard.ts";

export interface OpenOptions {
  /** The directory the database's files live in. Created if it is not there. */
  dir: string;
  /** The canonical URI this database is linked to by. Recorded on first open and never changed. */
  uri?: string;
  /** The lock to apply, if it is ahead of what the directory holds. */
  lock?: Lock;
  /** What this database exposes over the protocol. Everything in its catalog by default. */
  projection?: Projection;
  policy?: Policy;
  /** The storage format a NEW database is created with. */
  format?: StorageFormat;
  /** How many vshards a new database starts with. */
  batch?: number;
  /** Signs outgoing requests and pins what a responder proves. On by default: a deployment that can
   *  prove who it is should. */
  identity?: boolean;
  /** Allows a loopback database URI, for a test with two processes on one machine. Off otherwise,
   *  because a stranger's URI must not reach this network. */
  allowLoopback?: boolean;
  foreign?: Partial<ForeignOptions>;
}

export interface NodeHlekk {
  cluster: LocalCluster;
  /** The client an application uses. It follows an edge out of this database. */
  db: Hlekk;
  catalog: Catalog;
  /** What to hand `protocol/http.ts` or `adapters/node/http.ts`. */
  binding: Binding & ListenBinding;
  /** Drains the outbox until nothing is left to deliver. No alarm here, so somebody has to ask. */
  deliver(): Promise<number>;
  close(): void;
}

/** The file a database records which hosts it has, so reopening finds them before the directory is
 *  consulted. The directory knows too, but it cannot be opened without knowing where it is. */
const ROSTER = "hosts.json";

/**
 * Opens a database in a directory, creating it if it is not there.
 *
 * Reopening is the same call: the directory's own tables say what exists, and a host's file says
 * what format it is in, so nothing is inferred from the arguments that the storage can answer.
 */
export async function open(opts: OpenOptions): Promise<NodeHlekk> {
  mkdirSync(opts.dir, { recursive: true });
  const path = (name: string) => join(opts.dir, `${name}.sqlite`);
  const roster = join(opts.dir, ROSTER);
  const known: number[] = existsSync(roster) ? (JSON.parse(readFileSync(roster, "utf8")) as number[]) : [];

  const opened = new Map<string, ReturnType<typeof nodeSql>>();
  const storage = (name: string) => {
    let sql = opened.get(name);
    if (!sql) {
      opened.set(name, (sql = nodeSql(path(name))));
      if (name.startsWith("h-")) {
        const index = Number(name.slice(2));
        if (!known.includes(index)) {
          known.push(index);
          writeFileSync(roster, JSON.stringify(known));
        }
      }
    }
    return sql;
  };

  const cluster = new LocalCluster({
    database: "db",
    uri: opts.uri,
    format: opts.format,
    batch: opts.batch,
    storage,
  });
  // Hosts the directory already knows about are opened before anything routes, because a host that
  // is not open owns nothing as far as this process can see.
  for (const index of [...new Set([...known, ...cluster.directory.hostIndexes()])]) cluster.host(index);
  cluster.adoptAll();

  if (opts.lock !== undefined && opts.lock.version > cluster.directory.catalog().version) {
    cluster.directory.applyLock(opts.lock);
  }
  cluster.spreadCatalog();
  await cluster.publish();

  const catalog = cluster.directory.catalog();
  const cache = new ResponseCache();
  const guard = privateAddressGuard({ allowLoopback: opts.allowLoopback ?? false });
  const identity = opts.identity ?? true;
  const own = () => cluster.directory.databaseUri() ?? undefined;

  const pins: Pins = {
    pinOf: async (uri) => ({
      pinned: cluster.directory.pinnedOf(uri) ?? null,
      state: cluster.directory.stateOf(uri) ?? null,
    }),
    pin: async (uri, keyId) => cluster.directory.pin(uri, keyId, Date.now()),
    repudiate: async (uri) => cluster.directory.repudiate(uri),
  };
  const openForeign = (database: string): HostClient =>
    foreignClient(database, {
      catalog,
      guard,
      cache,
      agree: true,
      self: own(),
      identity: identity ? async () => ({ database: own() ?? null, pair: await cluster.directory.identity(Date.now()) }) : undefined,
      pins: identity ? pins : undefined,
      ...opts.foreign,
    });

  Hlekk.forget(cluster.transport);
  const db = Hlekk.from(cluster.transport, cluster.runtime.clock, openForeign);

  if (identity) await cluster.directory.identity(Date.now());
  const binding: Binding & ListenBinding = {
    // Filled in by whoever listens, which is the only party that knows the port. `adapters/node/http.ts`
    // does it.
    get database() { return own() ?? "https://localhost"; },
    bindUri(socketUri, configured) {
      const uri = configured ?? own() ?? socketUri;
      cluster.directory.setDatabaseUri(uri);
      return uri;
    },
    catalog,
    source: db,
    surface: surfaceOf(catalog, opts.projection),
    policy: opts.policy,
    publishedKeys: identity ? () => cluster.directory.publishedKeys() : undefined,
    get keys() { return identity ? cluster.directory.publishedKeys() : undefined; },
    pins: identity ? pins : undefined,
    callerKeys: identity ? async (uri) => (await discover(uri, { guard, ...opts.foreign })).keys : undefined,
  };

  return {
    cluster,
    db,
    catalog,
    binding,
    deliver: () => cluster.deliverAll(),
    close: () => {
      for (const sql of opened.values()) sql.close();
    },
  };
}
