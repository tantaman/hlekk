// The asking half: a database reached over HTTP, as a `HostClient`.
//
// The coordinator's drivers batch by client identity and ask a `HostClient` for a batch of misses.
// A foreign database is one more of those, which is the whole reason routing needed so little
// change — and it is why a database holding a hundred of a query's targets costs one request per
// batching window rather than a hundred.
//
// **The responder is a stranger.** Not a host of this database, not a deployment anyone here
// operates, and not necessarily honest. So:
//
// - HTTPS only, loopback excepted for development, which is the one place `canonicalDb` allows http.
// - **No redirects.** A database that moved is a different database: its URI is its identity, and
//   following a redirect would mean accepting objects from a name nobody drew an edge to.
// - A deadline and a cap on response bytes, because one tenant's query latency is otherwise another
//   tenant's to decide.
// - **Object keys must be bare ids** (`decodeRead` enforces it), which is what stops a responder
//   supplying objects for any database but itself.
// - Nothing is kept that was not asked for. A responder that volunteers objects is answering a
//   question nobody asked, and caching those would let it seed this database's view of a third.
// - On Node, a URI that resolves to a private address is refused. That check needs DNS, which is a
//   platform thing, so it arrives as `guard` from `adapters/node/`.
//
// **Failure is stated, never inferred.** A timeout, a refusal or a malformed answer is a named error
// and fails the query. A caller that would rather have a partial answer opts in with `omit`, and
// then gets a report of which databases could not be reached and how many references were left
// unresolved — because an empty list must never be the way a failure is reported.

import { BudgetSpent } from "../client/client.ts";
import { Catalog, idFieldsOf } from "../catalog/catalog.ts";
import type { HostClient, HostReply } from "../query/driver.ts";
import { canonicalDb, formatRef, parseRef } from "../query/ref.ts";
import type { Ref } from "../query/ref.ts";
import { listKey, tokenCursor } from "../query/types.ts";
import type { Cursor, Edge, Fields, Id, Miss, Obj, Plan } from "../query/types.ts";
import type { EdgeSegment, ReadSet } from "../query/stores.ts";
import { describe, DEFAULT_HOP_LIMIT } from "../query/request.ts";
import type { CountSpec, Hop } from "../query/request.ts";
import type { ReadRequest } from "../query/serve.ts";
import { DESCRIPTOR_VERSION } from "./http.ts";
import { WIRE_VERSION, decodeRead } from "./wire.ts";
import { reachable, signRequest, wellFormed } from "./identity.ts";
import type { KeyPair, SignedHeaders } from "./identity.ts";
import type { Descriptor } from "./http.ts";

/** How long one request to another database may take. */
export const DEADLINE_MS = 5_000;
/** How many bytes of answer to read before giving up on it. */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Ids per request, until the responder's descriptor says what it will take. */
export const DEFAULT_BATCH = 100;

export class ForeignRefused extends Error {
  readonly database: string;
  constructor(database: string, why: string) {
    super(`${database} refused a read: ${why}`);
    this.name = "ForeignRefused";
    this.database = database;
  }
}

export class ForeignUnreachable extends Error {
  readonly database: string;
  constructor(database: string, why: string) {
    super(`${database} could not be read: ${why}`);
    this.name = "ForeignUnreachable";
    this.database = database;
  }
}

/** The origin advertised a different key without a valid rotation from the pin. */
export class Repudiated extends Error {
  readonly database: string;
  constructor(database: string, why: string) {
    super(`${database} is repudiated: ${why}`);
    this.name = "Repudiated";
    this.database = database;
  }
}

/**
 * A read this client cannot turn into a request, named rather than answered as empty.
 *
 * Objects, lists and counts in another database are all fetched. What is left are the two things
 * that cannot be asked for at all: an edge type whose name this catalog does not have, since the
 * wire carries names and not integers; and a continuation of a foreign list by this database's own
 * sort key, since only the responder's token can place a page in a list whose hidden rows it
 * dropped. An empty list for either would be a wrong answer wearing a right one's clothes.
 */
export class NotFollowed extends Error {
  constructor(database: string, what: string) {
    super(`${what}: ${database} holds it, and this is not a read that can be asked for`);
    this.name = "NotFollowed";
  }
}

/** What could not be reached, for a caller that opted into an answer without it. */
export interface Omitted {
  /** Databases that failed, and how many references were left unresolved in each. */
  databases: Record<string, number>;
}

export interface ForeignOptions {
  /** The catalog this database reads by. Type names in an answer resolve through it, and one it does
   *  not declare is declined rather than guessed at. */
  catalog: Catalog;
  /** Injected, so a test can hand in the handler itself and two databases can talk in one process
   *  over the same code a deployment runs. */
  fetch?: typeof fetch;
  deadlineMs?: number;
  maxResponseBytes?: number;
  /** Refuses a URI before it is reached, where the platform can tell. See `adapters/node/guard.ts`. */
  guard?: ((database: string) => Promise<void>) & { fetch?: typeof fetch };
  /** Collects what could not be reached instead of failing the query. Absent, a failure throws,
   *  which is the default [`PLAN.md`](../../PLAN.md) settled on and the one this leaves reversible. */
  omit?: Omitted;
  /**
   * The asking database's own URI, when it has one.
   *
   * Used to collapse a reference that points back here to a bare id, so the one object does not end
   * up reachable under two spellings. Absent, a reference home stays qualified — which is correct
   * but not canonical, and is the state a database that was never told its own URI is in.
   */
  self?: string;
  /**
   * The asking database's own identity, for signing. Absent, requests go unsigned, which is the
   * ANONYMOUS caller and not an error: a responder serving public data authenticates nobody, and
   * step 2's deployed wiki is exactly that.
   */
  identity?: () => Promise<{ database: string | null; pair: KeyPair }>;
  /**
   * Where this database records what another proved about itself. Absent, the responder's published
   * keys are taken at face value every time, which is trust on every use rather than on first use —
   * fine for a test and not for a deployment.
   */
  pins?: Pins;
  /** Milliseconds since the epoch. Injectable so a test can pin a signature's `created` and drive
   *  the response cache without waiting. */
  now?: () => number;
  /**
   * Keeps answers for as long as the responder said they may be kept.
   *
   * Enforcement granularity decides what a caller may reuse, and only the responder knows its
   * granularity — which is why every answer states its own (`docs/protocol.md`). `never` is not
   * cached at all. `public` and `caller` are both reusable here, because this cache belongs to one
   * asking database and every request through it is that caller's.
   *
   * Keyed by the request, so two frames asking the same thing of the same database in one query cost
   * one request. Absent, nothing is cached.
   */
  cache?: ResponseCache;
  /**
   * Checks that the two catalogs mean the same thing by a type name, once per database and type.
   *
   * A globally unique name says nothing about whether the reader knows the shape behind it, so a
   * reader has to be able to decline a type it does not understand. Absent, names are taken on
   * trust, which is where step 4 left it.
   */
  agree?: boolean;
}

/** The limits a responder's descriptor states, as the asking half uses them. */
type Advertised = Partial<Descriptor["limits"]>;

/** Answers kept for as long as the responder permitted. One per (asking database, foreign database),
 *  held for the life of an isolate. */
export class ResponseCache {
  readonly #held = new Map<string, { body: unknown; until: number }>();
  readonly #now: () => number;
  /** Requests answered from here rather than sent, for a test that counts them. */
  hits = 0;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  get(key: string): unknown | undefined {
    const held = this.#held.get(key);
    if (held === undefined) return undefined;
    if (held.until <= this.#now()) {
      this.#held.delete(key);
      return undefined;
    }
    this.hits++;
    return held.body;
  }

  put(key: string, body: unknown, seconds: number): void {
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return;
    const now = this.#now();
    for (const [name, entry] of this.#held) if (entry.until <= now) this.#held.delete(name);
    this.#held.delete(key);
    if (this.#held.size >= 128) this.#held.delete(this.#held.keys().next().value!);
    this.#held.set(key, { body, until: now + seconds * 1000 });
  }
}

/** The registry's pin columns, as the asking half needs them. */
export interface Pins {
  pinOf(uri: string): Promise<{ pinned: string | null; state: string | null }>;
  pin(uri: string, keyId: string): Promise<void>;
  repudiate(uri: string): Promise<void>;
}

/** A client for one database. Each execution checks its current descriptor. */
export function foreignClient(database: string, opts: ForeignOptions): HostClient {
  const db = canonicalDb(database);
  /**
   * A payload's id fields, made absolute.
   *
   * `docs/protocol.md`: ids in an answer are relative to the database answering. A payload id field
   * is an id, so a bare one in a foreign object means an object in the RESPONDER's database — and
   * the asker resolving it against itself would read whichever of its own objects shares that
   * number, which is the same failure the alias in the edge key exists to prevent, one level down in
   * the JSON.
   *
   * So this is the second translation a foreign answer needs, beside the alias seam in
   * `Hlekk.#exec`: there an alias becomes a URI, here a responder-relative id does. A reference that
   * is already qualified is already absolute and is left alone, except one pointing back at the
   * asking database, which collapses to a bare id so that one object has one spelling.
   */
  function absolute(otype: number, data: Fields): Fields {
    const fields = opts.catalog.object(otype)?.fields;
    if (fields === undefined) return data;
    const ids = idFieldsOf(fields);
    if (ids.length === 0) return data;
    const out: Fields = { ...data };
    for (const field of ids) {
      const value = out[field];
      if (typeof value !== "string" || value === "") continue;
      const { db: holder, id } = parseRef(value);
      if (holder === null) out[field] = formatRef(db, id);
      else if (opts.self !== undefined && holder === opts.self) out[field] = id;
    }
    return out;
  }

  /**
   * The headers that name this database and prove it.
   *
   * Nothing is signed when there is no identity to sign with, or no URI to sign as: a signature
   * names the caller, and a database that was never told its own URI has no name to claim. The
   * responder then sees the anonymous caller, which is a thing its policy decides about rather than
   * an error.
   */
  async function signature(url: string, body: string, descriptor: Descriptor): Promise<SignedHeaders> {
    if (opts.identity === undefined || descriptor.keys.length === 0) return {};
    const { database, pair } = await opts.identity();
    if (database === null) return {};
    return signRequest({
      method: "POST",
      url,
      body,
      caller: database,
      seed: pair.seed,
      keyId: pair.public.id,
      created: Math.floor((opts.now?.() ?? Date.now()) / 1000),
    });
  }

  async function discoverPeer(spend?: () => AbortSignal): Promise<Descriptor> {
    const pins = opts.pins;
    if (!pins) return discover(db, opts, spend);
    const held = await pins.pinOf(db);
    if (held.state === "repudiated") {
      throw new Repudiated(db, "an operator has to clear this before a read through it can run again");
    }
    const descriptor = await discover(db, opts, spend);
    const keys = descriptor.keys;
    if (keys.length === 0) {
      // A database that publishes no key cannot be pinned, and a pin held against one that used to
      // publish keys is not something to quietly forget.
      if (held.pinned !== null) {
        await pins.repudiate(db);
        throw new Repudiated(db, "it published a key before and publishes none now");
      }
      return descriptor;
    }
    const current = keys.find((k) => k.retired === undefined)!;

    if (held.pinned === null) {
      // First contact. The current key — the one it has not retired — is what gets pinned.
      await pins.pin(db, current.id);
      return descriptor;
    }
    const reached = await reachable(keys, held.pinned);
    if (reached?.id !== current.id) {
      await pins.repudiate(db);
      throw new Repudiated(db, `it publishes no key reachable from the pinned ${held.pinned}`);
    }
    // The pin advances along the rotation chain, so the next contact starts from the newest key it
    // has proved rather than from one that may fall out of the grace window.
    if (reached.id !== held.pinned) await pins.pin(db, reached.id);
    return descriptor;
  }

  let agreed: ReadonlySet<string> | undefined;

  return {
    metersRequests: true,
    async exec(plan, tasks, spend): Promise<HostReply> {
      const gathered: Gathered = { objects: new Map(), lists: [], counts: new Map() };
      try {
        const descriptor = await discoverPeer(spend);
        const advertised = descriptor.limits;
        const max = advertised.maxIds;
        for (const batch of group(tasks, plan, opts.catalog, max, advertised)) {
          await send(batch, plan, gathered, descriptor, spend);
        }
      } catch (e) {
        // `omit` covers a database that could not be reached. A repudiated one was reached and
        // answered — with a key that is not the one it proved before — and omitting that would turn
        // the loudest signal in the design into an empty list.
        if (opts.omit === undefined || e instanceof Repudiated || e instanceof BudgetSpent) throw e;
        // Opted into an answer without it. Every reference this batch asked for comes back null and
        // the database is named in the report, so the answer says what is missing instead of
        // looking complete.
        const refs = tasks.filter((t) => t.kind === "object").map((t) => (t as { id: Ref }).id);
        opts.omit.databases[db] = (opts.omit.databases[db] ?? 0) + refs.length;
        for (const ref of refs) gathered.objects.set(ref, null);
        // A list or a count that could not be read is NOT answered as empty: an empty list is never
        // the report of a failure. Those tasks simply go unanswered, and the coordinator's store
        // raises them by name.
      }

      // Every object miss is answered, as the object or as null. The coordinator waits on its store
      // otherwise, and surfaces that as an internal error about a host rather than as "not there".
      for (const t of tasks) {
        if (t.kind === "object" && !gathered.objects.has(t.id)) gathered.objects.set(t.id, null);
      }

      const reads: ReadSet = {
        // Nothing kept that was not asked for: an object is kept when it is one this batch named or
        // one a list in the answer points at. A responder that volunteers others is answering a
        // question nobody asked.
        objects: [...gathered.objects],
        lists: gathered.lists,
        counts: [...gathered.counts],
      };
      return { reads, misses: [] };
    },
  };

  /** What one batch of requests gathered, before it becomes a `ReadSet`. */
  interface Gathered {
    objects: Map<Ref, Obj | null>;
    lists: EdgeSegment[];
    counts: Map<string, number>;
  }

  /** One request, and what of the asking plan it corresponds to. */
  interface Batch {
    body: ReadRequest;
    /** The asking frame each alias in the request stands for, so the answer maps back. */
    frames: Map<string, number>;
  }

  async function send(batch: Batch, plan: Plan, into: Gathered, descriptor: Descriptor, spend?: () => AbortSignal): Promise<void> {
    // Keyed by the request, which is canonical because this side built it. Two frames asking the
    // same thing of the same database in one query then cost one request.
    const payload = JSON.stringify(batch.body);
    const key = JSON.stringify([db, descriptor.keys.find(k => k.retired === undefined)?.id, payload]);
    const held = opts.cache?.get(key);
    const url = db + "/read";
    const body = held ?? await readJson(db, url, opts, {
      method: "POST", body: payload,
      headers: { "content-type": "application/json", ...await signature(url, payload, descriptor) },
    }, spend);
    const decoded = decodeRead(body, opts.catalog);
    const declined = new Set([...decoded.declined, ...(await disagreeing(spend))]);
    // The responder numbers the frames of the plan IT compiled, which are not this plan's numbers.
    // `shape` is how the two are joined: this side chose the aliases, so walking `shape` from the
    // root with those aliases gives the responder's frame for each of this plan's.
    const lists = new Map<string, { frame: number; after: Cursor | null; requested: number }>();
    const allowedObjects = new Set<Id>(batch.body.ids);
    const visitedFrames = new Set<number>();
    function walk(frame: number, parents: Set<Id>, node: Pick<ReadRequest, "hops" | "counts">) {
      if (visitedFrames.has(frame)) throw new ForeignRefused(db, "a response frame appears twice");
      visitedFrames.add(frame);
      for (const parent of parents) {
        const byAlias = decoded.result.counts[`${frame}:${parent}`];
        if (!byAlias) continue;
        for (const count of node.counts ?? []) {
          if (typeof count === "string") continue;
          const n = byAlias[count.as];
          const atype = opts.catalog.edgeNamed(count.edge)?.atype;
          if (atype !== undefined && Number.isSafeInteger(n) && n >= 0) into.counts.set(listKey(refOf(parent), atype), n);
        }
      }
      for (const hop of node.hops ?? []) {
        const alias = hop.as!;
        const child = decoded.result.shape[frame]?.[alias];
        const ours = batch.frames.get(alias);
        if (child === undefined || ours === undefined) continue;
        const targets = new Set<Id>();
        for (const parent of parents) {
          const key = `${child}:${parent}`;
          const list = decoded.result.lists[key];
          if (!list) continue;
          lists.set(key, { frame: ours, requested: hop.limit ?? DEFAULT_HOP_LIMIT, after: hop.after === undefined ? null : tokenCursor(hop.after) });
          for (const id of list.ids) {
            if (parseRef(id).db !== null) continue;
            targets.add(id);
            allowedObjects.add(id);
          }
        }
        walk(child, targets, hop);
      }
    }
    walk(0, new Set(batch.body.ids), batch.body);

    for (const [local, entry] of Object.entries(decoded.result.objects)) {
      if (!allowedObjects.has(local)) continue;
      const ref = formatRef(db, local);
      const name = opts.catalog.object(entry.otype)?.name;
      if (name !== undefined && declined.has(name)) {
        // A type the two catalogs do not mean the same thing by. Declined as absent, not as a guess
        // at the fields: an object that resolves while being uninterpretable is worse than one that
        // does not resolve.
        into.objects.set(ref, null);
        continue;
      }
      into.objects.set(ref, {
        id: ref,
        otype: entry.otype,
        version: entry.version,
        data: absolute(entry.otype, declaredOnly(entry.otype, entry.data)),
      });
    }

    for (const [key, list] of Object.entries(decoded.result.lists)) {
      const cut = key.indexOf(":");
      const allowed = lists.get(key);
      if (!allowed) continue;
      const parent = refOf(key.slice(cut + 1));
      const source = plan.frames[allowed.frame]?.source;
      if (source?.kind !== "edge") continue; // a field hop stores nothing and has no list to hold
      const rows: Edge[] = list.ids.map((id, i) => {
        const edge = list.edges?.[i] ?? null;
        const target = refOf(id);
        // `db` is 0 and `target` carries the reference. There is nothing for an alias to mean in a
        // list another database ordered: the order is the responder's and the continuation is its
        // token, so the alias would be a number this side never uses. `targetOf` reads `target`.
        return {
          id1: parent,
          atype: source.atype,
          db: 0,
          id2: parseRef(target).id,
          target,
          time: edge?.time ?? 0,
          data: edge?.data ?? null,
        };
      });
      into.lists.push({
        id1: parent,
        atype: source.atype,
        after: allowed.after,
        requested: allowed.requested,
        rows,
        complete: !list.more,
        // The responder's own cursor IS the continuation, and this side does not read it: a page
        // stops where the policy stopped it, and only the responder knows where the next one begins.
        ...(list.cursor !== null ? { next: list.cursor } : {}),
      });
    }

    if (held === undefined && decoded.cache.reuse !== "never") opts.cache?.put(key, body, decoded.cache.seconds);
  }

  /**
   * The fields THIS catalog declares for the type, and no others.
   *
   * A responder may expose more than the reader declares — the two catalogs are planned separately
   * and one may be ahead — and keeping those would put a field in this database's view of an object
   * that its own schema does not know. A reader reads what it declares; `disagreeing` is what
   * catches the case where that is not enough.
   */
  function declaredOnly(otype: number, data: Fields): Fields {
    const fields = opts.catalog.object(otype)?.fields;
    if (fields === undefined) return data;
    const out: Fields = {};
    for (const name of Object.keys(fields)) if (name in data) out[name] = data[name];
    return out;
  }

  /**
   * Type names the two catalogs do not mean the same thing by, read from the responder's vocabulary
   * once per database.
   *
   * A name is only half of an agreement. The vocabulary states each exposed type's fields, so the
   * comparison is possible: a type this catalog declares a REQUIRED field for that the responder
   * does not expose is one this side cannot read through, because every object of it would arrive
   * missing something its own schema says is always there. A field the responder exposes and this
   * side does not is the other direction and is fine — `declaredOnly` drops it.
   */
  async function disagreeing(spend?: () => AbortSignal): Promise<ReadonlySet<string>> {
    if (!opts.agree) return new Set();
    if (agreed) return agreed;
    const out = new Set<string>();
    const doc = await readJson(db, db + "/vocabulary", opts, {}, spend) as {
      types?: Record<string, { fields?: Record<string, { type: string; optional: boolean }> }>;
    };
    for (const type of opts.catalog.objectTypes()) {
      const theirs = doc.types?.[type.name];
      if (theirs === undefined) continue; // not exposed at all: nothing of it will arrive
      for (const [field, spec] of Object.entries(type.fields)) {
        const mine = describe(spec);
        const match = theirs.fields?.[field];
        if (mine.optional && match === undefined) continue;
        if (match === undefined || match.type !== mine.type || (!mine.optional && match.optional)) {
          out.add(type.name);
          break;
        }
      }
    }
    agreed = out;
    return agreed;
  }

  /** A bare id in the responder's answer means an object in the RESPONDER's database; a qualified one
   *  is already absolute. Which is `docs/protocol.md`'s rule, applied to a list's members.
   *
   *  A declaration rather than a const, because `send` runs before this line is reached. */
  function refOf(id: string): Ref {
    const { db: holder, id: local } = parseRef(id);
    if (holder === null) return formatRef(db, local);
    return opts.self !== undefined && holder === opts.self ? local : id;
  }

  /**
   * Groups a batch of misses into requests.
   *
   * Three shapes, because there are three kinds of miss and they batch differently. Object misses
   * batch by frame, and carry that frame's subtree as hops — which is what makes **the query ride
   * inside one database**: the responder's own engine does the traversal below the objects, so a
   * traversal of depth n inside one database costs one request rather than n. A head read of a list
   * batches by edge type across parents. A count batches by edge type too. A continued list is one
   * request, because a token places exactly one page.
   */
  function group(tasks: readonly Miss[], plan: Plan, catalog: Catalog, max: number, advertised?: Advertised): Batch[] {
    const out: Batch[] = [];

    const byFrame = new Map<number, Ref[]>();
    const heads = new Map<string, { atype: number; frame: number; n: number; parents: Ref[] }>();
    const counts = new Map<number, Ref[]>();

    for (const t of tasks) {
      if (t.kind === "object") {
        byFrame.set(t.frame, [...(byFrame.get(t.frame) ?? []), t.id]);
        continue;
      }
      if (t.kind === "count") {
        counts.set(t.atype, [...(counts.get(t.atype) ?? []), t.id1]);
        continue;
      }
      const name = catalog.edge(t.atype)?.name;
      if (name === undefined) throw new NotFollowed(db, `an edge type this catalog does not name (${t.atype})`);
      if (t.after === null) {
        const key = `${t.atype}:${t.n}:${t.frame}`;
        const held = heads.get(key);
        if (held) held.parents.push(t.id1);
        else heads.set(key, { atype: t.atype, frame: t.frame, n: t.n, parents: [t.id1] });
        continue;
      }
      if (t.after.token === undefined && !t.after.resume) {
        // A sort-key cursor into a list this database does not hold. The coordinator only ever holds
        // a token for one of those, so reaching here means a cursor was carried across a boundary it
        // does not cross.
        throw new NotFollowed(db, `a continuation of the ${name} list of ${t.id1} by sort key rather than by its token`);
      }
      out.push(listBatch(plan, catalog, t.atype, t.frame, t.n, [t.id1], t.after, advertised));
    }

    for (const [frame, refs] of byFrame) {
      for (let i = 0; i < refs.length; i += max) {
        const slice = refs.slice(i, i + max);
        out.push({
          body: { ids: slice.map((r) => parseRef(r).id), ...subtree(plan, frame, catalog, advertised, 1) },
          frames: labels(plan, frame),
        });
      }
    }
    for (const { atype, frame, n, parents } of heads.values()) {
      for (let i = 0; i < parents.length; i += max) {
        out.push(listBatch(plan, catalog, atype, frame, n, parents.slice(i, i + max), null, advertised));
      }
    }
    for (const [atype, parents] of counts) {
      const name = catalog.edge(atype)?.name;
      if (name === undefined) throw new NotFollowed(db, `an edge type this catalog does not name (${atype})`);
      for (let i = 0; i < parents.length; i += max) {
        const slice = parents.slice(i, i + max);
        out.push({
          body: { ids: slice.map((r) => parseRef(r).id), counts: [{ as: `a${atype}`, edge: name }] },
          frames: new Map(),
        });
      }
    }
    return out;
  }

  /** One request for a page of one edge type, over however many parents share it. */
  function listBatch(
    plan: Plan,
    catalog: Catalog,
    atype: number,
    frame: number,
    n: number,
    parents: readonly Ref[],
    after: Cursor | null,
    advertised?: Advertised,
  ): Batch {
    const name = catalog.edge(atype)!.name;
    const hop: Hop = {
      as: `f${frame}`,
      edge: name,
      // Clamped to what the responder said it will take, rather than sent and refused. A refusal
      // costs a round trip and tells the caller nothing it could not have read in the descriptor.
      limit: Math.min(Math.max(n, after?.resume?.limit ?? 0), advertised?.maxLimit ?? Infinity),
      ...(after?.token !== undefined ? { after: after.token } : {}),
      ...subtree(plan, frame, catalog, advertised, 2),
    };
    return {
      body: { ids: parents.map((r) => parseRef(r).id), hops: [hop] },
      frames: new Map([[`f${frame}`, frame], ...labels(plan, frame)]),
    };
  }

  /**
   * The hops and counts below a frame, labelled by this plan's frame numbers.
   *
   * **Filters are not sent.** The cache keys a list by object and edge type, so a filtered list
   * merged into it would answer another frame's read wrongly — two aliases over one edge type with
   * different filters are two answers, and the cache has one slot. The coordinator holds the objects,
   * so it applies the filter itself; what it loses is that the responder reads more rows than the
   * filter keeps, which `EdgeHop` already handles by asking for a larger page. Sending them means
   * keying foreign lists by frame, and that is a later optimization.
   */
  function subtree(
    plan: Plan,
    frame: number,
    catalog: Catalog,
    advertised: Advertised | undefined,
    depth: number,
  ): { hops?: Hop[]; counts?: CountSpec[] } {
    const f = plan.frames[frame];
    if (f === undefined) return {};
    // Past the depth the responder advertised, the subtree stops and the coordinator reads those
    // levels itself — one request each instead of one for all of them, which is slower and is an
    // answer rather than a refusal.
    if (depth > (advertised?.maxDepth ?? Infinity)) return {};
    const hops: Hop[] = [];
    for (const child of f.children) {
      const source = plan.frames[child.frame]?.source;
      const name =
        source?.kind === "edge"
          ? catalog.edge(source.atype)?.name
          : source?.kind === "field"
            ? fieldEdge(catalog, source.field)
            : undefined;
      // A type this catalog cannot name is one the two sides do not agree on, so the hop is left out
      // and the coordinator reads that level itself — which will fail by name rather than quietly.
      if (name === undefined) continue;
      const frame = plan.frames[child.frame];
      // The coordinator requests continued lists explicitly, with their own cursor.
      if (frame.after) continue;
      const limit = Math.min(frame.limit ?? DEFAULT_HOP_LIMIT, advertised?.maxLimit ?? Infinity);
      hops.push({
        as: `f${child.frame}`,
        edge: name,
        limit,
        ...subtree(plan, child.frame, catalog, advertised, depth + 1),
      });
    }
    const counts: CountSpec[] = [];
    for (const atype of new Set(f.counts.map(c => c.atype))) {
      const name = catalog.edge(atype)?.name;
      if (name !== undefined) counts.push({ as: `a${atype}`, edge: name });
    }
    return { ...(hops.length > 0 ? { hops } : {}), ...(counts.length > 0 ? { counts } : {}) };
  }

  /** Every alias this request will use, and the frame it stands for. */
  function labels(plan: Plan, frame: number): Map<string, number> {
    const out = new Map<string, number>();
    const walk = (at: number): void => {
      for (const child of plan.frames[at]?.children ?? []) {
        out.set(`f${child.frame}`, child.frame);
        walk(child.frame);
      }
    };
    walk(frame);
    return out;
  }
}

function fieldEdge(catalog: Catalog, field: string): string | undefined {
  const matches = catalog.edgeTypes().filter(edge => edge.field === field);
  return matches.length === 1 ? matches[0].name : undefined;
}

type TransportOptions = Pick<ForeignOptions, "fetch" | "guard" | "maxResponseBytes" | "deadlineMs">;

async function readJson(db: string, url: string, opts: TransportOptions, init: RequestInit, spend?: () => AbortSignal): Promise<unknown> {
  const budget = spend?.();
  const timeout = AbortSignal.timeout(opts.deadlineMs ?? DEADLINE_MS);
  const signal = budget ? AbortSignal.any([budget, timeout]) : timeout;
  const cap = opts.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const call = opts.fetch ?? opts.guard?.fetch ?? fetch;
  async function exchange() {
    if (opts.guard && call !== opts.guard.fetch) await opts.guard(db);
    signal.throwIfAborted();
    const res = await call(url, { ...init, signal, redirect: "error", cache: "no-store" });
    if ([400, 401, 403].includes(res.status)) {
      const refusal = await text(res, cap).then(parse).catch(() => null) as { error?: string; at?: string } | null;
      throw new ForeignRefused(db, `${refusal?.at ?? "?"}: ${refusal?.error ?? `status ${res.status}`}`);
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      throw new ForeignUnreachable(db, `status ${res.status}`);
    }
    const raw = await text(res, cap);
    try {
      return parse(raw);
    } catch {
      throw new ForeignUnreachable(db, "the answer is not JSON");
    }
  }
  let abort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([exchange(), aborted]);
  } catch (e) {
    if (budget?.aborted) throw budget.reason;
    if (e instanceof ForeignRefused || e instanceof ForeignUnreachable || (e as Error).name === "PrivateAddress") throw e;
    throw new ForeignUnreachable(db, (e as Error).message);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function discover(database: string, opts: TransportOptions, spend?: () => AbortSignal): Promise<Descriptor> {
  const db = canonicalDb(database);
  const d = await readJson(db, db, opts, {}, spend) as Descriptor;
  if (!d || d.protocol !== "hlekk" || d.v !== DESCRIPTOR_VERSION || d.database !== db ||
      !Array.isArray(d.wire) || !d.wire.includes(WIRE_VERSION) || d.wire.some(v => !Number.isSafeInteger(v) || v < 1) ||
      !Number.isSafeInteger(d.catalog) || d.catalog < 0 ||
      !Array.isArray(d.keys) || !(await wellFormed(d.keys)) ||
      (d.keys.length && d.keys.filter(k => k.retired === undefined).length !== 1)) {
    throw new ForeignUnreachable(db, "invalid descriptor identity, wire version or keys");
  }
  for (const key of ["maxDepth", "maxLimit", "maxIds", "maxBody", "maxFrames", "maxNodes", "maxWhere", "maxCounts"] as const) {
    const n = d.limits?.[key];
    const min = key === "maxWhere" || key === "maxCounts" ? 0 : 1;
    if (!Number.isSafeInteger(n) || n < min) throw new ForeignUnreachable(db, `invalid descriptor limit ${key}`);
  }
  for (const route of ["read", "price", "vocabulary"] as const) {
    if (d.routes?.[route] !== db + "/" + route) throw new ForeignUnreachable(db, `invalid descriptor route ${route}`);
  }
  return d;
}

/** The body, up to the cap. A stranger's Content-Length is a claim, so the bytes are counted as they
 *  arrive and the read stops rather than filling this isolate's memory on request. */
async function text(res: Response, cap: number): Promise<string> {
  const claimed = res.headers.get("content-length");
  if (claimed !== null && Number(claimed) > cap) {
    void res.body?.cancel().catch(() => {});
    throw new Error(`the answer claims ${claimed} bytes, over the ${cap} cap`);
  }
  const body = res.body;
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new Error(`the answer is over the ${cap} byte cap`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const parse = (raw: string): unknown => JSON.parse(raw) as unknown;

/** A factory for `Hlekk.from`: one client per database, each over the same options. */
export const foreignClients =
  (opts: ForeignOptions) =>
  (database: string): HostClient =>
    foreignClient(database, opts);

export { WIRE_VERSION };
export type { Id };
