// The HTTP binding: one function from a WHATWG `Request` to a `Response`.
//
// No Cloudflare import, and no `node:http` import either, so the Worker and a Node server mount the
// same code and a test can call it with a `Request` it constructed and no network at all. That is
// not tidiness: step 4's tests need two databases talking over real HTTP, and the only way to be
// sure the thing under test is the same thing deployed is for there to be one of it.
//
// The routes, from the plan's decision table:
//
//   GET  {db}              the descriptor: protocol versions, keys and limits
//   POST {db}/read         a bounded read
//   POST {db}/price        what that read would cost, with nothing read
//   GET  {db}/vocabulary   the exposed types and edges
//
// `{db}` is the database URI, so mounting under a path prefix is what gives a deployment its
// identity: `https://<host>/<prefix>`. The prefix is derived from the URI rather than configured
// beside it, so the thing advertised and the thing served cannot drift.
//
// **What a status code means here.** A `Refused` is the caller's request being wrong and is a 400
// carrying its `at`, because a caller that cannot tell which part was rejected retries blind. A body
// over the cap is a 413 decided *before* parsing, since parsing it is the work being refused. A
// fault inside the engine is a 500 that says nothing about itself: a stranger learns that this
// database broke and not how.

import { Refused } from "../query/request.ts";
import type { Limits } from "../query/request.ts";
import { DEFAULT_LIMITS } from "../query/request.ts";
import { MAX_IDS, price, serve } from "../query/serve.ts";
import type { Policy, ReadRequest, ReadSource, ServeOptions } from "../query/serve.ts";
import type { Cacheability } from "../query/serve.ts";
import type { Catalog } from "../catalog/catalog.ts";
import { canonicalDb } from "../query/ref.ts";
import { WIRE_VERSION, encodeRead } from "./wire.ts";
import { SignatureRefused, reachable, verifyRequest } from "./identity.ts";
import type { Caller, PublicKey } from "./identity.ts";
import type { Pins } from "./client.ts";
import type { Surface } from "./surface.ts";

/** Bytes a request body may hold. A read with the maximum 100 ids and a full tree of filters is a
 *  few kilobytes; this is two orders of magnitude of headroom and still a bound. */
export const MAX_BODY = 64 * 1024;

export const DESCRIPTOR_VERSION = 1;

/** A published signing key. `identity.ts` owns the shape; it is re-exported here because the
 *  descriptor is where a caller finds one, and an empty list means this database authenticates
 *  nobody — which a caller has to be able to tell from one that does and did not say so. */
export type DescriptorKey = PublicKey;

export interface Descriptor {
  v: number;
  protocol: "hlekk";
  /** Wire versions this database can speak, newest last. */
  wire: number[];
  /** The canonical URI this database answers at, so a caller can check it reached the database it
   *  meant rather than whatever a redirect or a misconfigured proxy put in front of it. */
  database: string;
  catalog: number;
  limits: Limits & { maxIds: number; maxBody: number };
  keys: DescriptorKey[];
  routes: { read: string; price: string; vocabulary: string };
}

/** What one database serves. `database` is its canonical URI; everything else is the serving half
 *  already built in `query/serve.ts` plus the surface it exposes. */
export interface Binding {
  database: string;
  catalog: Catalog;
  source: ReadSource;
  surface: Surface;
  /** The policy for every caller alike. `policyFor` overrides it per caller. */
  policy?: Policy;
  /**
   * The policy for one caller, and whether this database distinguished it.
   *
   * Called with the verified caller, or null for the anonymous one — a request that carries no
   * signature at all, which is not an error: a database serving public data authenticates nobody.
   * `serve` does not change for any of this, because `Policy` is already per request.
   *
   * `remember` is how **strangers do not grow the registry**. A responder records a caller only when
   * its policy distinguishes that caller; anyone else is verified and forgotten. Without that, every
   * stranger who ever called would be a row, and the registry is the one piece of per-database state
   * outside the lock.
   */
  policyFor?: (caller: Caller | null) => Promise<{ policy: Policy; remember?: boolean }>;
  /**
   * How this database learns a caller's published keys: by reading the caller's own descriptor at
   * its own URI, with the same defences a read of it gets. Absent, no signature can be verified, so
   * every caller is the anonymous one.
   */
  callerKeys?: (database: string) => Promise<readonly PublicKey[]>;
  /** Where a remembered caller's key is pinned. */
  pins?: Pins;
  limits?: Limits;
  maxIds?: number;
  maxBody?: number;
  /** The path the routes hang off, when it is not the path of the database URI. Only for a
   *  deployment whose public URI is not its mount point. */
  prefix?: string;
  /** The keys this database publishes in its descriptor. */
  keys?: DescriptorKey[];
  /** Seconds since the epoch, as this database sees it, for the signature's creation window. */
  now?: () => number;
  maxSkewSeconds?: number;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });

/** Where the routes hang off: the database URI's own path, with the root case spelled as the empty
 *  string so that joining never produces a double slash. */
export function mountOf(binding: Binding): string {
  if (binding.prefix !== undefined) return binding.prefix === "/" ? "" : binding.prefix.replace(/\/$/, "");
  const path = new URL(canonicalDb(binding.database)).pathname;
  return path === "/" ? "" : path;
}

/** The descriptor, which is also what a caller reads to learn the limits before it sends anything.
 *  Exported because a client builds its requests against these numbers and a test asserts on them. */
export function descriptorOf(binding: Binding): Descriptor {
  const database = canonicalDb(binding.database);
  // Relative to the database URI, which is the only address a caller has. Where the handler is
  // mounted is this deployment's business and appears nowhere a caller can see.
  const at = (route: string) => `${database}/${route}`;
  return {
    v: DESCRIPTOR_VERSION,
    protocol: "hlekk",
    wire: [WIRE_VERSION],
    database,
    catalog: binding.catalog.version,
    limits: {
      ...(binding.limits ?? DEFAULT_LIMITS),
      maxIds: binding.maxIds ?? MAX_IDS,
      maxBody: binding.maxBody ?? MAX_BODY,
    },
    keys: binding.keys ?? [],
    routes: { read: at("read"), price: at("price"), vocabulary: at("vocabulary") },
  };
}

const serveOptions = (binding: Binding, policy?: Policy): ServeOptions => ({
  catalog: binding.catalog,
  source: binding.source,
  vocabulary: binding.surface.vocabulary,
  exposes: (otype) => binding.surface.typeName(otype) !== undefined,
  policy: policy ?? binding.policy,
  limits: binding.limits,
  maxIds: binding.maxIds,
});

/**
 * Who is calling, and what they may see.
 *
 * The responder reads the caller's keys from the caller's own descriptor, which is an outbound
 * request made during an inbound one — that is what "a URI resolves to a key at a well-known path
 * under it" costs, and it is cached per caller by whatever supplies `callerKeys`.
 */
async function authorize(request: Request, binding: Binding, body: string): Promise<{ policy?: Policy } | Response> {
  let caller: Caller | null = null;
  if (binding.callerKeys !== undefined) {
    try {
      caller = await verifyRequest({
        method: request.method,
        url: request.url,
        body,
        headers: request.headers,
        now: binding.now?.() ?? Math.floor(Date.now() / 1000),
        maxSkewSeconds: binding.maxSkewSeconds,
        keysOf: binding.callerKeys,
      });
    } catch (e) {
      if (e instanceof SignatureRefused) return json({ error: e.message, at: "signature" }, 401);
      throw e;
    }
  }
  if (binding.policyFor === undefined) return {};
  const decided = await binding.policyFor(caller);
  // Pinned only when the policy said this caller is one it distinguishes. The registry is symmetric
  // — this database pins a caller's key the way it pins one it interns — and only the alias is
  // outbound-only.
  if (decided.remember === true && caller !== null && binding.pins !== undefined) {
    const held = await binding.pins.pinOf(caller.database);
    if (held.state === "repudiated") return json({ error: "this caller is repudiated here", at: "signature" }, 403);
    if (held.pinned === null) await binding.pins.pin(caller.database, caller.key.id);
    else if (held.pinned !== caller.key.id) {
      // The caller signed with a key this database has not seen before. A rotation it has not caught
      // up with looks exactly like a substitution from here, and the descriptor is what tells them
      // apart — which is `pinned()` on the asking side. A responder that cannot walk the chain
      // refuses rather than advancing the pin on the strength of the request itself.
      const keys = await binding.callerKeys!(caller.database);
      const reached = await reachable(keys, held.pinned);
      if (reached === null || reached.id !== caller.key.id) {
        await binding.pins.repudiate(caller.database);
        return json({ error: "this caller's key is not reachable from the one it proved before", at: "signature" }, 403);
      }
      await binding.pins.pin(caller.database, reached.id);
    }
  }
  return { policy: decided.policy };
}

/** `Cache-Control` for what the body already states. The body is normative — a proxy may strip a
 *  header and a caller must not have to trust one — but a responder that states reuse in the body
 *  and contradicts it in the header is asking for the header to be believed, so they agree. */
function cacheControl(cache: Cacheability): string {
  if (cache.reuse === "never") return "no-store";
  return `${cache.reuse === "public" ? "public" : "private"}, max-age=${cache.seconds}`;
}

/**
 * Answers one HTTP request against one database.
 *
 * Returns a 404 for a path that is not one of this database's routes, so a deployment can mount this
 * beside its own routes and fall through.
 */
export async function handle(request: Request, binding: Binding): Promise<Response> {
  const mount = mountOf(binding);
  const path = new URL(request.url).pathname;

  // The descriptor's path is the database URI's own, which has no trailing slash by construction —
  // except at the origin root, where the path is `/` and there is nothing to strip.
  if (path === (mount === "" ? "/" : mount)) {
    return method(request, "GET") ?? json(descriptorOf(binding));
  }
  // The slashed spelling of a prefixed database is not that database's URI, and is told so rather
  // than quietly repaired — see `canonicalDb` for why this is refused in one direction only.
  if (mount !== "" && path === `${mount}/`) {
    return json({ error: `not this database's URI; it is ${canonicalDb(binding.database)}` }, 404);
  }
  if (!path.startsWith(`${mount}/`)) return json({ error: "no such route" }, 404);

  const route = path.slice(mount.length + 1);

  if (route === "vocabulary") {
    return method(request, "GET") ?? json(binding.surface.document());
  }

  if (route === "read" || route === "price") {
    const refusal = method(request, "POST");
    if (refusal !== null) return refusal;
    const raw = await body(request, binding.maxBody ?? MAX_BODY);
    if (raw instanceof Response) return raw;
    // Who is calling is settled before the body is parsed as a request, so an unauthorized caller is
    // told so rather than told what is wrong with a request it may not submit at all.
    const authorized = await authorize(request, binding, raw);
    if (authorized instanceof Response) return authorized;
    let req: ReadRequest;
    try {
      req = JSON.parse(raw) as ReadRequest;
    } catch {
      return json({ error: "body is not JSON" }, 400);
    }
    const options = serveOptions(binding, authorized.policy);
    try {
      if (route === "price") return json({ v: WIRE_VERSION, cost: price(req, options) });
      const served = await serve(req, options);
      return json(encodeRead(served, binding.surface), 200, { "cache-control": cacheControl(served.cache) });
    } catch (e) {
      if (e instanceof Refused) return json({ error: e.message, at: e.at, offset: e.offset }, 400);
      // Everything else, a `WireError` included, is this database failing: naming its own types is
      // not something the caller did, so it is a fault here and not a 400.
      return fault(e);
    }
  }

  return json({ error: "no such route" }, 404);
}

/** A 500 that says nothing. A stranger learns that this database broke, not how. */
const fault = (e?: unknown): Response => {
  // Logged, not sent: a deployment's operator has to be able to find this, and a stranger must not.
  if (e !== undefined) console.error("hlekk: a read faulted", e);
  return json({ error: "internal error" }, 500);
};

function method(request: Request, allowed: "GET" | "POST"): Response | null {
  if (request.method === allowed) return null;
  if (allowed === "GET" && request.method === "HEAD") return null;
  return json({ error: `method not allowed; use ${allowed}` }, 405, { allow: allowed });
}

/**
 * The body, or the response that refuses it.
 *
 * The size is checked twice on purpose. `content-length` is the cheap check and refuses before a
 * byte is read, but it is a claim and a chunked body carries none, so the decoded text is checked as
 * well — before `JSON.parse`, which is the work a 413 exists to refuse.
 */
async function body(request: Request, maxBody: number): Promise<string | Response> {
  const claimed = request.headers.get("content-length");
  if (claimed !== null && Number(claimed) > maxBody) {
    return json({ error: `body of ${claimed} bytes, the maximum is ${maxBody}` }, 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return json({ error: "could not read the body" }, 400);
  }
  // Bytes, not characters: a body of multi-byte text is as expensive as its bytes.
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > maxBody) return json({ error: `body of ${bytes} bytes, the maximum is ${maxBody}` }, 413);
  // Returned as text and not as parsed JSON, because the signature covers a digest OF THE BYTES: a
  // body re-serialized from a parse is a different body, and verifying against one would make the
  // signature depend on this implementation's JSON writer.
  return text;
}
