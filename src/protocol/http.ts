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
import type { Surface } from "./surface.ts";

/** Bytes a request body may hold. A read with the maximum 100 ids and a full tree of filters is a
 *  few kilobytes; this is two orders of magnitude of headroom and still a bound. */
export const MAX_BODY = 64 * 1024;

export const DESCRIPTOR_VERSION = 1;

/** A published signing key. Empty until step 5, and empty means this database authenticates nobody —
 *  which a caller has to be able to tell from a database that does and did not say so. */
export interface DescriptorKey {
  id: string;
  alg: "ed25519";
  /** The public key, base64url, no padding. */
  key: string;
}

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
  policy?: Policy;
  limits?: Limits;
  maxIds?: number;
  maxBody?: number;
  /** The path the routes hang off, when it is not the path of the database URI. Only for a
   *  deployment whose public URI is not its mount point. */
  prefix?: string;
  keys?: DescriptorKey[];
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

const serveOptions = (binding: Binding): ServeOptions => ({
  catalog: binding.catalog,
  source: binding.source,
  vocabulary: binding.surface.vocabulary,
  exposes: (otype) => binding.surface.typeName(otype) !== undefined,
  policy: binding.policy,
  limits: binding.limits,
  maxIds: binding.maxIds,
});

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
    const body = await read(request, binding.maxBody ?? MAX_BODY);
    if (body instanceof Response) return body;
    const req = body as ReadRequest;
    try {
      if (route === "price") return json({ v: WIRE_VERSION, cost: price(req, serveOptions(binding)) });
      const served = await serve(req, serveOptions(binding));
      return json(encodeRead(served, binding.surface), 200, { "cache-control": cacheControl(served.cache) });
    } catch (e) {
      if (e instanceof Refused) return json({ error: e.message, at: e.at, offset: e.offset }, 400);
      // Everything else, a `WireError` included, is this database failing: naming its own types is
      // not something the caller did, so it is a fault here and not a 400.
      return fault();
    }
  }

  return json({ error: "no such route" }, 404);
}

/** A 500 that says nothing. A stranger learns that this database broke, not how. */
const fault = (): Response => json({ error: "internal error" }, 500);

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
async function read(request: Request, maxBody: number): Promise<unknown | Response> {
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
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return json({ error: "body is not JSON" }, 400);
  }
}
