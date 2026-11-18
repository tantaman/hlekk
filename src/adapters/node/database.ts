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
import { DescriptorCache, ResponseCache } from "../../protocol/client.ts";
import { surfaceOf } from "../../protocol/surface.ts";
import type { Binding } from "../../protocol/http.ts";
import type { Projection } from "../../catalog/projection.ts";
import type { Policy } from "../../query/serve.ts";
import type { Ref } from "../../query/ref.ts";
import type { Id } from "../../query/types.ts";
import { HintQueue } from "../../protocol/hint.ts";
import type { HintQueueOptions, ReceivedHint } from "../../protocol/hint.ts";
import { sendHint, settleHint } from "../../protocol/backlinks.ts";
import type { HintSent, Settled } from "../../protocol/backlinks.ts";
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
  /**
   * Records edges that other databases draw at this one. Absent, this database takes no hints: the
   * route is a 404 and the descriptor does not state it.
   *
   * Needs `identity`, which is on by default — a hint is signed, and a database that verifies no
   * signature cannot tell whose database a hint asks it to read.
   */
  backlinks?: BacklinkOptions;
}

export interface BacklinkOptions {
  /**
   * Which of this database's edge types records a confirmed edge.
   *
   * A name records every confirmed hint whose target is of the type that edge starts at, whoever
   * sent it — the open policy, and the right one only for a database that wants to be cited by
   * strangers. A function is the policy in full: it is told who is hinting, what they call their
   * edge and the type of the object it points at, and it answers before anything is read.
   */
  edge: string | ((hint: ReceivedHint, targetType: string) => string | undefined);
  /** Whether the checking read is signed. `"anonymous"`, the default, is what makes a recorded edge
   *  safe to serve to anyone — see `CheckOptions.as`. */
  as?: "anonymous" | "self";
  maxPages?: number;
  queue?: HintQueueOptions;
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
  /**
   * Tells the database `target` is in that `source` has, or no longer has, an edge `edge` to it.
   *
   * Called by the application, after it writes the edge and after it removes it. Not automatic,
   * because sending one is consent: it discloses the edge to the database it points at and lets that
   * database record it. Never throws for what the other database did — see `sendHint`.
   */
  hint(edge: string, source: Id, target: Ref): Promise<HintSent>;
  /**
   * Looks at every hint received so far: reads each one's source and records or removes an edge.
   * Like `deliver`, there is no alarm, so somebody has to ask. Empty when this database takes none.
   */
  confirm(): Promise<Settled[]>;
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
  // What this database knows of every other's keys, limits and routes, kept for as long as each said
  // it may be. One for the process, so a read, a hint and a caller's signature all look at the same
  // copy of a database's descriptor.
  const descriptors = new DescriptorCache();
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
  const signAs = identity
    ? async () => ({ database: own() ?? null, pair: await cluster.directory.identity(Date.now()) })
    : undefined;
  const openForeign = (database: string): HostClient =>
    foreignClient(database, {
      catalog,
      guard,
      cache,
      descriptors,
      agree: true,
      self: own(),
      identity: signAs,
      pins: identity ? pins : undefined,
      ...opts.foreign,
    });
  /** How this database reaches another outside of a query: to hint, and to check a hint. */
  const reach = () => ({
    guard,
    descriptors,
    identity: signAs,
    pins: identity ? pins : undefined,
    fetch: opts.foreign?.fetch,
    deadlineMs: opts.foreign?.deadlineMs,
    maxResponseBytes: opts.foreign?.maxResponseBytes,
    now: opts.foreign?.now,
  });

  Hlekk.forget(cluster.transport);
  const db = Hlekk.from(cluster.transport, cluster.runtime.clock, openForeign);

  if (identity) await cluster.directory.identity(Date.now());
  const hints = opts.backlinks === undefined ? undefined : new HintQueue(opts.backlinks.queue);
  const edgeFor = (hint: ReceivedHint, targetType: string): string | undefined => {
    const edge = opts.backlinks!.edge;
    if (typeof edge === "function") return edge(hint, targetType);
    return catalog.edgeNamed(edge)?.from === targetType ? edge : undefined;
  };
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
    callerKeys: identity
      ? async (uri, wanted) => {
          const transport = { guard, descriptors, ...opts.foreign };
          const remembered = descriptors.fresh(uri, transport.now?.() ?? Date.now());
          const keys = (await discover(uri, transport)).keys;
          // A key id the remembered descriptor does not list is either a key nobody published or a
          // rotation since it was read. One more look, past the lifetime the caller's database gave
          // it, tells them apart — and only when the first answer came from memory, so a stranger
          // inventing key ids buys one request here and not two.
          if (remembered && wanted !== undefined && !keys.some((k) => k.id === wanted)) {
            return (await discover(uri, { ...transport, fresh: true })).keys;
          }
          return keys;
        }
      : undefined,
    hints,
  };

  return {
    cluster,
    db,
    catalog,
    binding,
    deliver: () => cluster.deliverAll(),
    hint: (edge, source, target) => sendHint(target, source, edge, reach()),
    async confirm() {
      const settled: Settled[] = [];
      const self = own();
      if (hints === undefined || self === undefined) return settled;
      const failures: unknown[] = [];
      for (const hint of hints.take()) {
        try {
          settled.push(
            await settleHint(hint, {
              ...reach(),
              db,
              catalog,
              self,
              edgeFor,
              as: opts.backlinks!.as,
              maxPages: opts.backlinks!.maxPages,
            }),
          );
        } catch (e) {
          // One hint that cannot be settled must not cost the ones queued behind it, which came
          // from other databases. It is still reported: a policy naming an edge type that cannot
          // hold a backlink is the operator's to hear about, not to find in an empty list.
          failures.push(e);
          settled.push("unknown");
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `${failures.length} of ${settled.length} hints could not be settled`);
      }
      return settled;
    },
    close: () => {
      for (const sql of opened.values()) sql.close();
    },
  };
}
