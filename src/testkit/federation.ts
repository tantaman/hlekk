// Two or more databases, each complete, joined by foreign edges and talking over the protocol.
//
// Each one is a `LocalCluster` — a real directory, real hosts, real SQLite — behind the real HTTP
// handler, reached through a `fetch` that calls that handler in this process. So the code under test
// is the code a deployment runs, down to the status codes and the wire format, with the socket taken
// out. `adapters/node/federation.test.ts` puts the socket back, which is what says that taking it
// out changed nothing.
//
// The thing this makes possible is the federation oracle: the differential oracle one level up. The
// same query over a graph split across two databases has to equal the query over one database
// holding both graphs, after mapping ids — and nothing about that is true by construction, since one
// side crosses a boundary, a protocol, a policy and a type-name agreement.

import { Catalog } from "../catalog/catalog.ts";
import type { Lock } from "../catalog/catalog.ts";
import { Hlekk } from "../client/client.ts";
import { LocalCluster } from "../client/local.ts";
import type { LocalOptions } from "../client/local.ts";
import { handle } from "../protocol/http.ts";
import type { Binding } from "../protocol/http.ts";
import { foreignClient } from "../protocol/client.ts";
import type { ForeignOptions, Omitted, Pins } from "../protocol/client.ts";
import type { Caller, PublicKey } from "../protocol/identity.ts";
import { HintQueue } from "../protocol/hint.ts";
import type { HintQueueOptions, ReceivedHint } from "../protocol/hint.ts";
import { sendHint, settleHint } from "../protocol/backlinks.ts";
import type { HintSent, Reach, Settled } from "../protocol/backlinks.ts";
import { surfaceOf } from "../protocol/surface.ts";
import type { Projection } from "../catalog/projection.ts";
import type { Policy } from "../query/serve.ts";
import type { HostClient } from "../query/driver.ts";
import type { Op, Outcome } from "./generate.ts";
import type { Shape } from "./shape.ts";
import type { Random } from "../runtime/runtime.ts";
import type { Fields, Id, Json } from "../query/types.ts";
import type { Ref } from "../query/ref.ts";

export interface MemberOptions extends Omit<LocalOptions, "uri"> {
  /** What this database is served under, and what an edge into it names. */
  uri: string;
  /** The policy for one caller, and whether this database distinguishes it. See `Binding.policyFor`. */
  policyFor?: (caller: Caller | null) => Promise<{ policy: Policy; remember?: boolean }>;
  /** The lock, or the chain of versions to apply in order — a database gets to version N by
   *  applying 1..N, and a test that hands in a v2 lock has to hand in the v1 it was planned over. */
  lock: Lock | Lock[];
  /** What it exposes over the protocol. Everything in its catalog by default. */
  projection?: Projection;
  policy?: Policy;
  /**
   * Takes hints, and records what they turn out to be true of under the edge type this names — the
   * policy `settleHint` asks before it reads anything. Needs `identity` on the federation, as a
   * deployment's would: a hint is signed.
   */
  backlinks?: (hint: ReceivedHint, targetType: string) => string | undefined;
  /** Whether the checking read is signed. Anonymous by default. */
  backlinksAs?: "anonymous" | "self";
  hintQueue?: HintQueueOptions;
}

export interface Member {
  uri: string;
  cluster: LocalCluster;
  catalog: Catalog;
  /** The client an application uses, which follows an edge out of this database. */
  db: Hlekk;
  binding: Binding;
  /** Requests this database has ANSWERED over the protocol, by route. */
  served: { read: number; price: number; descriptor: number; vocabulary: number; hint: number };
  /** The hints it has received and not yet looked at, when it takes any. */
  hints?: HintQueue;
  /** Tells the database `target` is in to look at this one's `source`. */
  hint(edge: string, source: Id, target: Ref): Promise<HintSent>;
  /** Looks at every hint received so far. */
  confirm(): Promise<Settled[]>;
}

export interface Federation {
  members: Map<string, Member>;
  member(uri: string): Member;
  /** What could not be reached, for the members built with `omit`. */
  omitted: Omitted;
  /** A `fetch` that serves every member in this federation, for a client built by hand. */
  fetch: typeof fetch;
}

export interface FederationOptions {
  members: MemberOptions[];
  /**
   * Signs every request and pins every descriptor.
   *
   * Off by default, which is the deployed wiki's state in step 2: public data, no identity, and a
   * caller that is the anonymous one. On, each member publishes its keys, signs as itself, verifies
   * its callers against their own descriptors and pins what they prove.
   */
  identity?: boolean;
  /** Collects unreachable databases instead of failing a query. Off by default, which is the
   *  behaviour PLAN.md proposes: a failed hop fails the query. */
  omit?: boolean;
  /** Wraps each foreign client's fetch, for a test that injects faults or counts requests. */
  wrap?: (inner: typeof fetch) => typeof fetch;
  foreign?: Partial<ForeignOptions>;
}

/** Builds every member, then wires each one's foreign clients to the others. */
export async function federate(opts: FederationOptions): Promise<Federation> {
  const members = new Map<string, Member>();
  const omitted: Omitted = { databases: {} };

  for (const m of opts.members) {
    // Format 2 whatever the environment says. A foreign edge type cannot be applied to a format 1
    // database at all — the alias would have nowhere to go — so a federation is a format 2 thing by
    // definition, and these tests say so rather than failing when the suite is run on the old key.
    const cluster = new LocalCluster({ ...m, uri: m.uri, format: m.format ?? 2 });
    // One version at a time, as a real database would.
    const chain = Array.isArray(m.lock) ? m.lock : [m.lock];
    for (const lock of chain) cluster.directory.applyLock(lock);
    cluster.spreadCatalog();
    await cluster.publish();
    const catalog = Catalog.compile(chain[chain.length - 1]!);
    const served = { read: 0, price: 0, descriptor: 0, vocabulary: 0, hint: 0 };
    const binding: Binding = {
      database: m.uri,
      catalog,
      source: cluster.client(),
      surface: surfaceOf(catalog, m.projection),
      policy: m.policy,
      policyFor: m.policyFor,
      keys: opts.identity === true ? (await cluster.directory.identity(0), cluster.directory.publishedKeys()) : undefined,
    };
    members.set(m.uri, {
      uri: m.uri,
      cluster,
      catalog,
      db: cluster.client(),
      binding,
      served,
      // Filled in below, once there is a `fetch` that reaches every member.
      hint: () => Promise.reject(new Error("the federation is not wired yet")),
      confirm: () => Promise.resolve([]),
    });
  }

  /** One `fetch` over the whole federation: the handler of whichever member the URL belongs to. */
  const serve: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    for (const m of members.values()) {
      const path = new URL(m.uri).pathname;
      const at = new URL(url);
      if (`${at.origin}${path}` !== m.uri) continue;
      const route = at.pathname.slice(path === "/" ? 1 : path.length + 1);
      if (route === "read") m.served.read++;
      else if (route === "price") m.served.price++;
      else if (route === "vocabulary") m.served.vocabulary++;
      else if (route === "hint") m.served.hint++;
      else if (at.pathname === path) m.served.descriptor++;
      return handle(new Request(url, init as RequestInit), m.binding);
    }
    // Not a member: a reference into a database nobody is running, which is a thing the design
    // allows to be written and so a thing a read has to be able to fail on.
    return new Response(JSON.stringify({ error: "no such database" }), { status: 404 });
  };

  const fetchWith = opts.wrap ? opts.wrap(serve) : serve;

  if (opts.identity === true) {
    for (const m of members.values()) {
      // How a responder learns a caller's keys: by reading the caller's own descriptor, at the
      // caller's own URI. An outbound request made during an inbound one, which is what "a URI
      // resolves to a key at a well-known path under it" costs — and the reason it needs no PKI.
      m.binding.callerKeys = async (database: string) => {
        const res = await fetchWith(database);
        if (!res.ok) throw new Error(`${database} would not serve its descriptor: ${res.status}`);
        return ((await res.json()) as { keys?: PublicKey[] }).keys ?? [];
      };
      m.binding.pins = pinsOf(m);
    }
  }

  // Rebuilt with foreign clients now that every member can be reached. `Hlekk.from` memoizes per
  // transport, so the client built above is the same object — which is why the factory is installed
  // by replacing the member's `db` rather than by mutating one.
  for (const m of members.values()) {
    m.db = hlekkWithForeign(m, fetchWith, omitted, opts);
  }

  // Hints, in both directions. Wired after the clients, because the edge a confirmed hint records is
  // written by the member's own client and that is the one built just above.
  for (const given of opts.members) {
    const m = members.get(given.uri)!;
    const reach: Reach = {
      fetch: fetchWith,
      deadlineMs: opts.foreign?.deadlineMs,
      now: opts.foreign?.now,
      ...(opts.identity === true
        ? { identity: async () => ({ database: m.uri, pair: await m.cluster.directory.identity(0) }), pins: pinsOf(m) }
        : {}),
    };
    m.hint = (edge, source, target) => sendHint(target, source, edge, reach);
    if (given.backlinks === undefined) continue;
    const queue = new HintQueue(given.hintQueue);
    m.hints = queue;
    m.binding.hints = queue;
    m.confirm = async () => {
      const settled: Settled[] = [];
      for (const hint of queue.take()) {
        settled.push(
          await settleHint(hint, { ...reach, db: m.db, catalog: m.catalog, self: m.uri, edgeFor: given.backlinks!, as: given.backlinksAs }),
        );
      }
      return settled;
    };
  }

  return {
    members,
    member: (uri) => {
      const m = members.get(uri);
      if (!m) throw new Error(`no member at ${uri}`);
      return m;
    },
    omitted,
    fetch: fetchWith,
  };
}

/** A client for one member that can follow an edge out of it. */
function hlekkWithForeign(m: Member, call: typeof fetch, omitted: Omitted, opts: FederationOptions): Hlekk {
  const open = (database: string): HostClient =>
    foreignClient(database, {
      catalog: m.catalog,
      fetch: call,
      self: m.uri,
      omit: opts.omit ? omitted : undefined,
      ...(opts.identity === true
        ? {
            identity: async () => ({ database: m.uri, pair: await m.cluster.directory.identity(0) }),
            pins: pinsOf(m),
          }
        : {}),
      ...opts.foreign,
    });
  // `Hlekk.from` is memoized per transport and the factory is part of the client, so the pool entry
  // is dropped first. A deployment builds its client once with the factory already in hand.
  Hlekk.forget(m.cluster.transport);
  return Hlekk.from(m.cluster.transport, m.cluster.runtime.clock, open);
}

// ---- the federation oracle's split

/**
 * Which database each of a script's objects goes into.
 *
 * A coin per object would not work: an operation can only land in one database, so a pair of objects
 * joined by anything that has to be local must be in the same one. Those are, in order of how easy
 * they are to forget:
 *
 * - **`with`**, which colocates in the parent's vshard. One vshard belongs to one database.
 * - **An edge of a type that may not cross**, which is every type with an inverse (delivery routes
 *   through the host's own client, scoped to one database) and every cascade (a remote write). The
 *   catalog refuses `foreign` on both, so the split has to respect that rather than discover it.
 * - **A payload id field**, unless `payloadRefsCross` says the field relationships following them are
 *   declared foreign too — which they can be, since a payload reference carries the URI itself and
 *   there is no alias to intern.
 *
 * So the objects are unioned along those, and the coin is flipped per component.
 */
export function splitOf(
  script: { ops: readonly Op[] },
  crossing: ReadonlySet<number>,
  r: Random,
  databases: readonly string[],
  opts: { payloadRefsCross?: boolean } = {},
): string[] {
  const parent: number[] = [];
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const join = (a: number, b: number) => {
    const [x, y] = [find(a), find(b)];
    if (x !== y) parent[x] = y;
  };

  let at = 0;
  const position: number[] = []; // op index -> object position, for creates
  for (const op of script.ops) {
    if (op.kind === "create" || op.kind === "with") {
      parent.push(at);
      position.push(at);
      at++;
    } else position.push(-1);
  }

  const payload = opts.payloadRefsCross === true ? () => {} : join;
  let made = 0;
  for (const op of script.ops) {
    if (op.kind === "create") {
      for (const to of Object.values(op.refs)) payload(made, to);
      made++;
    } else if (op.kind === "with") {
      join(made, op.parent);
      for (const to of Object.values(op.refs)) payload(made, to);
      made++;
    } else if (op.kind === "update") {
      for (const to of Object.values(op.refs)) payload(op.at, to);
    } else if (op.kind === "assoc" || op.kind === "unassoc") {
      if (!crossing.has(op.atype)) join(op.from, op.to);
    }
  }

  const byComponent = new Map<number, string>();
  return parent.map((_, i) => {
    const root = find(i);
    let db = byComponent.get(root);
    if (db === undefined) byComponent.set(root, (db = r.pick(databases)));
    return db;
  });
}

/** The same script, replayed across a federation: each object in the database the split names, and a
 *  crossing edge written as a reference. */
export async function replaySplit(
  f: Federation,
  shape: Shape,
  script: { ops: readonly Op[] },
  split: readonly string[],
  settle?: () => Promise<unknown>,
): Promise<SplitReplay> {
  const refs: Ref[] = []; // position -> the reference this object is known by, from outside
  const local: Id[] = []; // position -> its own database's bare id
  const where: string[] = []; // position -> which database holds it
  const outcomes: Outcome[] = [];
  const kinds: string[] = [];
  const otypeOf = (type: string) => shape.types[type].otype;

  /** A payload, with each id field filled in — a bare id in the same database and a reference out of
   *  it, which is the second place `query/ref.ts` allows a qualified one. */
  const fill = (from: string, w: { data: Fields; refs: Record<string, number> }): Record<string, Json> => {
    const data: Record<string, Json> = { ...w.data };
    for (const [field, at] of Object.entries(w.refs)) data[field] = where[at] === from ? local[at]! : refs[at]!;
    return data;
  };

  /** How `from` names `to`: a bare id in its own database, and a reference out of it. */
  const name = (from: number, to: number): Ref => (where[from] === where[to] ? local[to]! : refs[to]!);

  let made = 0;
  for (const op of script.ops) {
    try {
      switch (op.kind) {
        case "create":
        case "with": {
          const uri = split[made]!;
          const db = f.member(uri).db;
          const id =
            op.kind === "create"
              ? await db.create(otypeOf(op.type), fill(uri, op), { vshard: op.vshard })
              : await db.create(otypeOf(op.type), fill(uri, op), { with: local[op.parent]! });
          local.push(id);
          refs.push(`${uri}#${id}`);
          where.push(uri);
          kinds.push(op.type);
          made++;
          break;
        }
        case "update":
          await f
            .member(where[op.at]!)
            .db.update(local[op.at]!, fill(where[op.at]!, op), op.expect === null ? {} : { expect: op.expect });
          break;
        case "erase":
          await f.member(where[op.at]!).db.delete(local[op.at]!);
          break;
        case "assoc":
          await f
            .member(where[op.from]!)
            .db.assocAdd(op.atype, local[op.from]!, name(op.from, op.to), op.time, op.data as Record<string, Json> | null);
          break;
        case "unassoc":
          await f.member(where[op.from]!).db.assocRemove(op.atype, local[op.from]!, name(op.from, op.to));
          break;
      }
      outcomes.push({ ok: true });
    } catch (e) {
      if (op.kind === "create" || op.kind === "with") throw e;
      outcomes.push({ ok: false, error: e instanceof Error ? e.name : String(e) });
    }
    if (settle) await settle();
  }
  return { local, refs, where, types: kinds, outcomes };
}

/** The registry's pin columns, over one member's directory. */
export const pinsOf = (m: Member): Pins => ({
  pinOf: async (uri) => ({ pinned: m.cluster.directory.pinnedOf(uri) ?? null, state: m.cluster.directory.stateOf(uri) ?? null }),
  pin: async (uri, keyId) => m.cluster.directory.pin(uri, keyId, 0),
  repudiate: async (uri) => m.cluster.directory.repudiate(uri),
});

export interface SplitReplay {
  local: Id[];
  refs: Ref[];
  where: string[];
  types: string[];
  outcomes: Outcome[];
}
