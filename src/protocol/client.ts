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

import { Catalog, idFieldsOf } from "../catalog/catalog.ts";
import type { HostClient, HostReply } from "../query/driver.ts";
import { canonicalDb, formatRef, parseRef } from "../query/ref.ts";
import type { Ref } from "../query/ref.ts";
import type { Fields, Id, Miss, Obj, Plan } from "../query/types.ts";
import type { ReadSet } from "../query/stores.ts";
import { WIRE_VERSION, decodeRead } from "./wire.ts";
import { reachable, signRequest, wellFormed } from "./identity.ts";
import type { KeyPair, PublicKey, SignedHeaders } from "./identity.ts";
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

/** The database at this URI answered with a key its pin cannot reach.
 *
 *  A URI can be reassigned: a database torn down and another brought up at the same name is, to
 *  everyone holding an edge into it, a different database. An allocated identifier would make that
 *  detectable by having a second name, and would reintroduce the central allocator the whole design
 *  exists to avoid. The pin is the answer instead, and this is what it buys — the edge fails rather
 *  than resolving to a stranger's objects under a name that meant someone else. Only an operator
 *  clears it. */
export class Repudiated extends Error {
  readonly database: string;
  constructor(database: string, why: string) {
    super(`${database} is repudiated: ${why}`);
    this.name = "Repudiated";
    this.database = database;
  }
}

/** A read this step does not build. Step 6 turns a list or a count that lives elsewhere into a
 *  one-hop request; until then it is named rather than silently answered as empty. */
export class NotFollowed extends Error {
  constructor(database: string, what: string) {
    super(
      `${what} lives in ${database}, and only objects are fetched across a database boundary yet.` +
        " A list or a count in another database is PLAN.md step 6.",
    );
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
  guard?: (database: string) => Promise<void>;
  /** Collects what could not be reached instead of failing the query. Absent, a failure throws,
   *  which is the default `docs/../PLAN.md` proposes and the one this leaves reversible. */
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
  /** Seconds since the epoch. Injectable so a test can pin a signature's `created`. */
  now?: () => number;
}

/** The registry's pin columns, as the asking half needs them. */
export interface Pins {
  pinOf(uri: string): Promise<{ pinned: string | null; state: string | null }>;
  pin(uri: string, keyId: string): Promise<void>;
  repudiate(uri: string): Promise<void>;
}

/**
 * A client for one other database.
 *
 * Built once per database per isolate, so the descriptor it reads to learn the responder's limits is
 * read once too.
 */
export function foreignClient(database: string, opts: ForeignOptions): HostClient {
  const db = canonicalDb(database);
  const call = opts.fetch ?? fetch;
  const deadline = opts.deadlineMs ?? DEADLINE_MS;
  const cap = opts.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  let descriptor: Promise<Descriptor | null> | null = null;
  let guarded: Promise<void> | null = null;

  /** The responder's own limits, or null when it would not say. A caller that cannot read the
   *  descriptor still reads: the defaults are this implementation's, which are what the protocol
   *  states as the floor. */
  const limits = (): Promise<Descriptor | null> => {
    if (!descriptor) {
      descriptor = request(db, "", undefined).then(
        (body) => body as Descriptor,
        () => null,
      );
    }
    return descriptor;
  };

  async function request(base: string, route: string, body: unknown): Promise<unknown> {
    if (opts.guard !== undefined) {
      if (!guarded) guarded = opts.guard(db);
      await guarded;
    }
    const url = route === "" ? base : `${base}/${route}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let res: Response;
    try {
      res = await call(url, {
        method: payload === undefined ? "GET" : "POST",
        headers:
          payload === undefined
            ? {}
            : { "content-type": "application/json", ...(await signature("POST", url, payload)) },
        body: payload,
        // A database that moved is a different database.
        redirect: "error",
        signal: AbortSignal.timeout(deadline),
      });
    } catch (e) {
      throw new ForeignUnreachable(db, (e as Error).message);
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      // The responder answered, and said no. A caller cannot retry its way out of any of these — a
      // malformed request, an unverifiable signature, a caller this database will not serve — so
      // they are refusals with a reason rather than a transport failure to back off from.
      const refusal = (await text(res, cap).then(parse, () => null)) as { error?: string; at?: string } | null;
      throw new ForeignRefused(db, `${refusal?.at ?? "?"}: ${refusal?.error ?? `status ${res.status}`}`);
    }
    if (!res.ok) throw new ForeignUnreachable(db, `status ${res.status}`);
    const raw = await text(res, cap).catch((e: Error) => {
      throw new ForeignUnreachable(db, e.message);
    });
    try {
      return parse(raw);
    } catch {
      throw new ForeignUnreachable(db, "the answer is not JSON");
    }
  }

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
  async function signature(method: string, url: string, body: string): Promise<SignedHeaders> {
    if (opts.identity === undefined) return {};
    const { database, pair } = await opts.identity();
    if (database === null) return {};
    return signRequest({
      method,
      url,
      body,
      caller: database,
      seed: pair.seed,
      keyId: pair.public.id,
      created: opts.now?.() ?? Math.floor(Date.now() / 1000),
    });
  }

  /**
   * Trust on first use, checked on later contact.
   *
   * The descriptor is public and unsigned — it has to be, or verifying it would need the key it
   * carries — so what makes it trustworthy is TLS for the first contact and the pin for every one
   * after.
   *
   * **The recorded state is read on every batch**, and the descriptor only when the pin has moved.
   * That is deliberate: a repudiation has to make every read through the alias fail, and a check
   * memoized for the life of a client would let an isolate that happened to verify first keep
   * reading a database another isolate has already refused. The cost is one directory call per
   * foreign batch, beside an internet round trip — which is to say, not the expensive part. The
   * alternative, caching the state with a short window, trades a guarantee for a few milliseconds
   * and is not worth it while a foreign hop costs what it costs.
   */
  async function identify(): Promise<void> {
    const pins = opts.pins;
    if (pins === undefined) return;
    const held = await pins.pinOf(db);
    if (held.state === "repudiated") {
      throw new Repudiated(db, "an operator has to clear this before a read through it can run again");
    }
    if (verified !== null && held.pinned === verified) return; // nothing has moved since the last check
    const descriptor = (await limits()) as (Descriptor & { keys?: PublicKey[] }) | null;
    const keys = descriptor?.keys ?? [];
    if (keys.length === 0) {
      // A database that publishes no key cannot be pinned, and a pin held against one that used to
      // publish keys is not something to quietly forget.
      if (held.pinned !== null) {
        await pins.repudiate(db);
        throw new Repudiated(db, "it published a key before and publishes none now");
      }
      verified = null; // nothing to pin, so nothing is settled: the next batch asks again
      return;
    }
    if (!(await wellFormed(keys))) throw new ForeignUnreachable(db, "its descriptor's keys are malformed");

    if (held.pinned === null) {
      // First contact. The current key — the one it has not retired — is what gets pinned.
      const current = keys.find((k) => k.retired === undefined) ?? keys[keys.length - 1]!;
      await pins.pin(db, current.id);
      verified = current.id;
      return;
    }
    const reached = await reachable(keys, held.pinned);
    if (reached === null) {
      await pins.repudiate(db);
      throw new Repudiated(db, `it publishes no key reachable from the pinned ${held.pinned}`);
    }
    // The pin advances along the rotation chain, so the next contact starts from the newest key it
    // has proved rather than from one that may fall out of the grace window.
    if (reached.id !== held.pinned) await pins.pin(db, reached.id);
    verified = reached.id;
  }

  /** The pin this client last checked a descriptor against. */
  let verified: string | null = null;

  return {
    async exec(_plan: Plan, tasks: Miss[]): Promise<HostReply> {
      // Only objects cross a boundary in this step. A list or a count that lives elsewhere is named
      // rather than answered as empty, because an empty list is never the report of something not
      // being fetched.
      for (const t of tasks) {
        if (t.kind === "edges") throw new NotFollowed(db, `the ${t.atype} list of ${t.id1}`);
        if (t.kind === "count") throw new NotFollowed(db, `the ${t.atype} count of ${t.id1}`);
      }
      const asked = [...new Set(tasks.map((t) => (t as { id: Ref }).id))];
      const ids = asked.map((ref) => parseRef(ref).id);

      const objects: [Ref, Obj | null][] = [];
      try {
        await identify();
        const max = (await limits())?.limits?.maxIds ?? DEFAULT_BATCH;
        for (let i = 0; i < ids.length; i += max) {
          const slice = ids.slice(i, i + max);
          const body = await request(db, "read", { ids: slice });
          const decoded = decodeRead(body, opts.catalog);
          for (const local of slice) {
            const ref = formatRef(db, local);
            const entry = decoded.result.objects[local];
            // Every id asked for is answered. The object, or null — which a caller must be able to
            // read as "not there" and nothing else, so it covers an object that does not exist, one
            // the responder's policy hides (indistinguishable, by design) and a type this catalog
            // does not understand and therefore declined.
            objects.push([ref, entry === undefined ? null : { id: ref, otype: entry.otype, version: entry.version, data: absolute(entry.otype, entry.data) }]);
          }
        }
      } catch (e) {
        // `omit` covers a database that could not be reached. A repudiated one was reached and
        // answered — with a key that is not the one it proved before — and omitting that would turn
        // the loudest signal in the design into an empty list.
        if (opts.omit === undefined || e instanceof Repudiated) throw e;
        // Opted into an answer without it. Every reference this batch asked for comes back null and
        // the database is named in the report, so the answer says what is missing instead of
        // looking complete.
        opts.omit.databases[db] = (opts.omit.databases[db] ?? 0) + asked.length;
        for (const ref of asked) objects.push([ref, null]);
      }

      // Nothing kept that was not asked for: the reply holds exactly the references in `tasks`.
      const reads: ReadSet = { objects, lists: [], counts: [] };
      return { reads, misses: [] };
    },
  };
}

/** The body, up to the cap. A stranger's Content-Length is a claim, so the bytes are counted as they
 *  arrive and the read stops rather than filling this isolate's memory on request. */
async function text(res: Response, cap: number): Promise<string> {
  const claimed = res.headers.get("content-length");
  if (claimed !== null && Number(claimed) > cap) throw new Error(`the answer claims ${claimed} bytes, over the ${cap} cap`);
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
