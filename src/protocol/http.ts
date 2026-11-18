// The HTTP binding: one function from a WHATWG `Request` to a `Response`.
//
// No Cloudflare import, and no `node:http` import either, so the Worker and a Node server mount the
// same code and a test can call it with a `Request` it constructed and no network at all. That is
// not tidiness: step 4's tests need two databases talking over real HTTP, and the only way to be
// sure the thing under test is the same thing deployed is for there to be one of it.
//
// The routes:
//
//   GET   {db}                        the descriptor: protocol versions, keys and limits
//   GET   {db}/vocabulary             the exposed types and edges
//   POST  {db}/read                   a bounded read            (QUERY is the same request)
//   POST  {db}/price                  what that read would cost (QUERY is the same request)
//   GET   {db}/objects/{id}           one object: the read `{ ids: [id] }`, by URL
//   GET   {db}/objects/{id}/{edge}    one page of one of its lists: that read with one hop
//   POST  {db}/hint                   "look at this edge of mine" — only where the database takes them
//
// `{db}` is the database URI, so mounting under a path prefix is what gives a deployment its
// identity: `https://<host>/<prefix>`. The prefix is derived from the URI rather than configured
// beside it, so the thing advertised and the thing served cannot drift.
//
// **What a status code means here.** A `Refused` is the caller's request being wrong and is a 400
// carrying its `at`, because a caller that cannot tell which part was rejected retries blind. A body
// over the cap is a 413 decided *before* parsing, since parsing it is the work being refused. A
// fault inside the engine is a 500 that says nothing about itself: a stranger learns that this
// database broke and not how. A 429 and a 503 are the only two that are about the moment and not
// the request, and they say when.
//
// **What HTTP is used for, and what it is not.** One test decides both: a mechanism is adopted when
// a party that does not speak this protocol benefits from it — a cache, a browser, an agent with
// nothing but a fetch tool — and when nothing breaks if it is stripped on the way. So the body stays
// normative and every header here restates it: `Cache-Control` restates `cache`, `ETag` is a digest
// of the bytes, `Retry-After` is the only thing a 429 says that its body does not. And the places
// where HTTP's defaults are permissive stay refused on purpose: no redirects, no unknown members,
// and no status that tells a hidden object from an absent one.

import { Refused } from "../query/request.ts";
import type { Cost, Hop, Limits } from "../query/request.ts";
import { DEFAULT_LIMITS } from "../query/request.ts";
import { MAX_IDS, price, serve } from "../query/serve.ts";
import type { Policy, ReadRequest, ReadSource, ServeOptions } from "../query/serve.ts";
import type { Cacheability } from "../query/serve.ts";
import type { Catalog } from "../catalog/catalog.ts";
import { canonicalDb, isLoopbackDb } from "../query/ref.ts";
import { WIRE_VERSION, encodeRead } from "./wire.ts";
import { CALLER_HEADER, SignatureRefused, reachable, verifyRequest } from "./identity.ts";
import type { Caller, PublicKey } from "./identity.ts";
import type { Pins } from "./client.ts";
import type { Surface } from "./surface.ts";
import { Backoff } from "./backoff.ts";
import { parseHint } from "./hint.ts";
import type { HintSink } from "./hint.ts";

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
  /**
   * `hint` is stated only by a database that takes hints, and is how a caller tells one that does
   * from one that does not without sending anything.
   *
   * `object` and `list` are URI Templates (RFC 6570) for the two routes that read by `GET`. They are
   * templates because the id is the caller's to fill in, and they are stated rather than assumed
   * because a database that does not serve them answers 404 there — which, on a route whose 404
   * also means "no such object", a caller could not otherwise tell apart.
   */
  routes: { read: string; price: string; vocabulary: string; hint?: string; object?: string; list?: string };
}

/** What a deployment's admission check is told. */
export interface Admission {
  /** The verified caller, or null for the anonymous one. */
  caller: Caller | null;
  route: "read" | "price" | "object" | "list";
  /** What the request was priced at. Known before anything is read, which is the point: a limit on
   *  answer nodes per caller per minute is arithmetic over this. */
  cost: Cost;
  /** The request itself, for whatever a platform puts on one — an address, a region. */
  request: Request;
}

/** What one database serves. `database` is its canonical URI; everything else is the serving half
 *  already built in `query/serve.ts` plus the surface it exposes. */
export interface Binding {
  database: string;
  catalog: Catalog;
  source: ReadSource;
  surface: Surface;
  /** The policy for every caller alike, defaulting to `PUBLIC` — see its own note for why reads are
   *  public by default and what that rests on. `policyFor` overrides it per caller. */
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
  /**
   * `wanted` is the id of the key the request says it was signed with. An implementation that keeps
   * descriptors for a while uses it to tell a key it has never heard of from a rotation it has not
   * seen yet, and looks again for the second; one that reads the descriptor every time ignores it.
   */
  callerKeys?: (database: string, wanted?: string) => Promise<readonly PublicKey[]>;
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
  publishedKeys?: () => DescriptorKey[];
  /** Seconds since the epoch, as this database sees it, for the signature's creation window. */
  now?: () => number;
  maxSkewSeconds?: number;
  /**
   * Where a received hint goes. Absent, this database takes none: the route is a 404 and the
   * descriptor does not state it.
   *
   * Taking hints needs `callerKeys` as well, and without it the route is equally absent. A hint is
   * an instruction to make a request — the read that checks it — so the one thing that has to be
   * known before queueing one is whose database that request will go to. That is the signature, and
   * a database that verifies none cannot take a hint from anybody.
   */
  hints?: HintSink;
  /**
   * Decides whether a priced request runs now. Throws `Backoff` to say it does not, and how long to
   * wait; returns to let it through.
   *
   * Called after the price and before any storage is read, for the same reason the price exists: a
   * limit that fires after the work is not a limit. What it counts is the deployment's own — answer
   * nodes per caller, requests per address — and nothing here supplies one, because who a caller
   * *is* when it does not sign is something only the platform in front of this knows.
   */
  admit?: (asked: Admission) => void | Promise<void>;
  /**
   * Seconds a caller may reuse the descriptor and the vocabulary without asking again. 60 by
   * default; 0 means "ask every time", which the `ETag` keeps cheap.
   *
   * This is also how long a caller that trusts it goes without re-checking this database's keys
   * against its pin, so it is a statement about rotation as much as about bytes: **a retired key has
   * to stay published at least this long**, or a caller holding yesterday's descriptor meets a
   * signature it cannot place.
   */
  describedFor?: number;
  /**
   * Whether a page in a browser, on any origin, may read this database's answers.
   *
   * On by default, for the reason reads are public by default: an answer here depends on the
   * request and on nothing the browser adds — no cookie, no ambient credential — so a page can learn
   * nothing through a visitor's browser that it could not have fetched itself. **That argument is
   * about the request, and it is false wherever the network is the gate.** A database reachable only
   * from inside a network, or only from this machine, is readable through the browser of anyone
   * inside it, by any page they open. So the default is off for a loopback database URI — the one
   * place `http` is allowed, and for the same reason — and a deployment whose protection is where it
   * sits rather than what it checks must turn this off.
   */
  cors?: boolean;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });

// ---- refusals

/** The prefix of every problem type this protocol defines. An identifier first and an address
 *  second: RFC 9457 asks that a type be a URI, not that anything be served at it. */
export const PROBLEMS = "https://hlekk.dev/spec/problems/";

/**
 * What kind of refusal this is, as something a program can branch on.
 *
 * The first three are `Refused`'s own and say which document the caller should go back to. The rest
 * are one per status, because for those the status already is the kind — they are here so that a
 * caller holding only the body, which is what most agents are handed, has the same information as
 * one holding the response.
 */
export type ProblemKind =
  | "malformed"
  | "vocabulary"
  | "limit"
  | "signature"
  | "forbidden"
  | "not-found"
  | "method"
  | "too-large"
  | "media-type"
  | "too-many"
  | "unavailable"
  | "fault";

const TITLES: Record<ProblemKind, string> = {
  malformed: "Not a request this protocol defines",
  vocabulary: "A name the vocabulary does not have, or does not allow there",
  limit: "Over a limit this database states",
  signature: "The request's signature was not accepted",
  forbidden: "This database will not serve this caller",
  "not-found": "Nothing is served at this URI",
  method: "Not a method this route takes",
  "too-large": "The body is over the stated cap",
  "media-type": "Not a media type this route takes",
  "too-many": "This caller has asked for more than it will be given now",
  unavailable: "This database is not taking requests now",
  fault: "This database failed",
};

/** A refusal's body. `error` is version 1's own member and stays required; the four before it are
 *  RFC 9457's, and `detail` says what `error` says so that a reader of either finds it. */
export interface RefusalBody {
  type: string;
  title: string;
  status: number;
  detail: string;
  error: string;
  at?: string;
  offset?: number;
}

/**
 * The body of a refusal, as an RFC 9457 problem.
 *
 * Exported for whatever stands in front of the handler and has to refuse something itself — a
 * socket that will not read a body past the cap — so that every refusal a caller can meet from one
 * database has one shape.
 *
 * Served as `application/json` and not `application/problem+json`. Version 1 says every body is the
 * former, and that sentence was written before this one; a caller built against it is owed the
 * header it was promised. The members are what a program branches on, and they are all here.
 */
export function refusal(status: number, kind: ProblemKind, error: string, where: { at?: string; offset?: number } = {}): RefusalBody {
  return {
    type: PROBLEMS + kind,
    title: TITLES[kind],
    status,
    detail: error,
    error,
    ...(where.at === undefined ? {} : { at: where.at }),
    ...(where.offset === undefined ? {} : { offset: where.offset }),
  };
}

/** A refusal, as a response. Not to be kept by anything in between unless the caller of this says
 *  otherwise: a route that is a 404 today is one a deployment may start serving tomorrow. */
const refuse = (
  status: number,
  kind: ProblemKind,
  error: string,
  where: { at?: string; offset?: number } = {},
  headers: Record<string, string> = {},
): Response => json(refusal(status, kind, error, where), status, { "cache-control": "no-store", ...headers });

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
    keys: binding.publishedKeys?.() ?? binding.keys ?? [],
    routes: {
      read: at("read"),
      price: at("price"),
      vocabulary: at("vocabulary"),
      ...(takesHints(binding) ? { hint: at("hint") } : {}),
      object: at("objects/{id}"),
      list: at("objects/{id}/{edge}{?limit,after}"),
    },
  };
}

/** Whether this database takes hints at all: somewhere to put one, and a way to know who sent it. */
const takesHints = (binding: Binding): boolean => binding.hints !== undefined && binding.callerKeys !== undefined;

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
 * Who is calling: the verified caller, null for the anonymous one, or the response that refuses.
 *
 * The responder reads the caller's keys from the caller's own descriptor, which is an outbound
 * request made during an inbound one — that is what "a URI resolves to a key at a well-known path
 * under it" costs, and it is cached per caller by whatever supplies `callerKeys`.
 */
async function authenticate(
  request: Request,
  binding: Binding,
  body: Uint8Array,
): Promise<{ caller: Caller | null; keys: readonly PublicKey[] } | Response> {
  if (binding.callerKeys === undefined) {
    // This database verifies nothing, and its descriptor says so by publishing no key. A signature
    // presented anyway is refused rather than ignored: the caller took the trouble to make a claim,
    // and silently reading it as anonymous would leave it unable to tell whether the claim was
    // honoured — which is the same hazard as a downgrade, from the other side.
    if (request.headers.get(CALLER_HEADER) !== null || request.headers.get("signature") !== null) {
      return refuse(400, "signature", "this database verifies no signatures; its descriptor publishes no key", { at: "signature" });
    }
    return { caller: null, keys: [] };
  }
  let keys: readonly PublicKey[] = [];
  try {
    const caller = await verifyRequest({
      method: request.method,
      url: binding.database + new URL(request.url).pathname.slice(mountOf(binding).length) + new URL(request.url).search,
      body,
      headers: request.headers,
      now: binding.now?.() ?? Math.floor(Date.now() / 1000),
      maxSkewSeconds: binding.maxSkewSeconds,
      keysOf: async (uri, wanted) => {
        try {
          return (keys = await binding.callerKeys!(uri, wanted));
        } catch {
          // The caller's descriptor could not be read: no such host, a refused connection, an address
          // this deployment will not reach. That is a signature this database cannot verify, which
          // is a 401 and the caller's to fix — not a fault here, which is what letting it propagate
          // reported. Nothing about why is said: the URI is the caller's own claim, and "that
          // address is private" is a fact about this network that a stranger did not have before.
          throw new SignatureRefused("the caller's keys could not be read from its descriptor");
        }
      },
    });
    return { caller, keys };
  } catch (e) {
    if (e instanceof SignatureRefused) return refuse(401, "signature", e.message, { at: "signature" });
    throw e;
  }
}

/**
 * Checks a verified caller against what this database recorded about it, or returns the refusal.
 *
 * `remember` is the difference between a caller this database distinguishes and a stranger. With it,
 * a first contact is pinned. Without it, nothing is written — but a pin that is ALREADY held is
 * still checked, because a caller this database once pinned does not become a stranger by being
 * asked about on a route that would not have pinned it.
 */
async function pinned(binding: Binding, caller: Caller, keys: readonly PublicKey[], remember: boolean): Promise<Response | null> {
  if (binding.pins === undefined) return null;
  const held = await binding.pins.pinOf(caller.database);
  if (held.state === "repudiated") return refuse(403, "forbidden", "this caller is repudiated here", { at: "signature" });
  if (held.pinned === null) {
    if (remember) await binding.pins.pin(caller.database, caller.key.id);
    return null;
  }
  if (held.pinned === caller.key.id) return null;
  // The caller signed with a key this database has not seen before. A rotation it has not caught
  // up with looks exactly like a substitution from here, and the descriptor is what tells them
  // apart — which is `pinned()` on the asking side. A responder that cannot walk the chain
  // refuses rather than advancing the pin on the strength of the request itself.
  const reached = await reachable(keys, held.pinned);
  if (reached === null || reached.id !== caller.key.id) {
    await binding.pins.repudiate(caller.database);
    return refuse(403, "forbidden", "this caller's key is not reachable from the one it proved before", { at: "signature" });
  }
  await binding.pins.pin(caller.database, reached.id);
  return null;
}

/** Who is calling a read, and what they may see. */
async function authorize(
  request: Request,
  binding: Binding,
  body: Uint8Array,
): Promise<{ caller: Caller | null; policy?: Policy } | Response> {
  const who = await authenticate(request, binding, body);
  if (who instanceof Response) return who;
  if (binding.policyFor === undefined) return { caller: who.caller };
  const decided = await binding.policyFor(who.caller);
  // Pinned only when the policy said this caller is one it distinguishes. The registry is symmetric
  // — this database pins a caller's key the way it pins one it interns — and only the alias is
  // outbound-only.
  if (decided.remember === true && who.caller !== null) {
    const refusal = await pinned(binding, who.caller, who.keys, true);
    if (refusal !== null) return refusal;
  }
  return { caller: who.caller, policy: decided.policy };
}

/** `Cache-Control` for what the body already states. The body is normative — a proxy may strip a
 *  header and a caller must not have to trust one — but a responder that states reuse in the body
 *  and contradicts it in the header is asking for the header to be believed, so they agree. */
function cacheControl(cache: Cacheability): string {
  if (cache.reuse === "never") return "no-store";
  return `${cache.reuse === "public" ? "public" : "private"}, max-age=${cache.seconds}`;
}

/** `Cache-Control` for the two documents that describe the database rather than answer about it,
 *  and for a price, which is arithmetic over one of them. The same for every caller. */
function described(binding: Binding): string {
  const seconds = Math.max(0, Math.floor(binding.describedFor ?? DESCRIBED_FOR));
  return seconds === 0 ? "no-cache" : `public, max-age=${seconds}`;
}

/** Seconds a descriptor and a vocabulary may be reused by default. The same minute `PUBLIC` gives an
 *  answer, so that a caller's view of what a database is goes stale no slower than its view of what
 *  the database said. */
export const DESCRIBED_FOR = 60;

// ---- routing

type Route =
  | { name: "descriptor" | "vocabulary" | "read" | "price" | "hint" }
  | { name: "object"; id: string }
  | { name: "list"; id: string; edge: string };

/**
 * What each route takes.
 *
 * `QUERY` (RFC 10008) beside `POST` on the two routes that carry a request, as the same request. A
 * read is safe and idempotent and always was; `POST` cannot say so, which is why nothing between a
 * caller and this database will ever keep a `POST`'s answer however plainly `Cache-Control` invites
 * it to. `POST` stays because it is what version 1 named and what every client can send.
 */
const METHODS: Record<Route["name"], readonly string[]> = {
  descriptor: ["GET", "HEAD"],
  vocabulary: ["GET", "HEAD"],
  object: ["GET", "HEAD"],
  list: ["GET", "HEAD"],
  read: ["POST", "QUERY"],
  price: ["POST", "QUERY"],
  hint: ["POST"],
};

const allowOf = (route: Route): string => [...METHODS[route.name], "OPTIONS"].join(", ");

/** The media type a `QUERY` to this route carries, as RFC 10008's `Accept-Query` spells it. */
const ACCEPT_QUERY = "application/json";

/** Which of this database's routes a path is, or the 404 that says it is none of them. */
function routeOf(path: string, binding: Binding): Route | Response {
  const mount = mountOf(binding);
  // The descriptor's path is the database URI's own, which has no trailing slash by construction —
  // except at the origin root, where the path is `/` and there is nothing to strip.
  if (path === (mount === "" ? "/" : mount)) return { name: "descriptor" };
  // The slashed spelling of a prefixed database is not that database's URI, and is told so rather
  // than quietly repaired — see `canonicalDb` for why this is refused in one direction only.
  if (mount !== "" && path === `${mount}/`) {
    return refuse(404, "not-found", `not this database's URI; it is ${canonicalDb(binding.database)}`);
  }
  const none = () => refuse(404, "not-found", "no such route");
  if (!path.startsWith(`${mount}/`)) return none();

  const rest = path.slice(mount.length + 1);
  if (rest === "vocabulary" || rest === "read" || rest === "price") return { name: rest };
  if (rest === "hint") return takesHints(binding) ? { name: "hint" } : none();

  const segments = rest.split("/");
  if (segments[0] !== "objects" || segments.length < 2 || segments.length > 3) return none();
  let id: string;
  let edge: string | undefined;
  try {
    id = decodeURIComponent(segments[1]!);
    edge = segments[2] === undefined ? undefined : decodeURIComponent(segments[2]);
  } catch {
    return none();
  }
  if (id === "" || edge === "") return none();
  return edge === undefined ? { name: "object", id } : { name: "list", id, edge };
}

/**
 * Answers one HTTP request against one database.
 *
 * Returns a 404 for a path that is not one of this database's routes, so a deployment can mount this
 * beside its own routes and fall through.
 */
export async function handle(request: Request, binding: Binding): Promise<Response> {
  const route = routeOf(new URL(request.url).pathname, binding);
  if (route instanceof Response) return finish(request, binding, null, route);
  return finish(request, binding, route, await dispatch(request, binding, route));
}

async function dispatch(request: Request, binding: Binding, route: Route): Promise<Response> {
  if (request.method === "OPTIONS") return options(request, binding, route);
  if (!METHODS[route.name].includes(request.method)) {
    return refuse(405, "method", `method not allowed; use ${METHODS[route.name].join(" or ")}`, {}, { allow: allowOf(route) });
  }
  try {
    switch (route.name) {
      case "descriptor":
        return json(descriptorOf(binding), 200, {
          "cache-control": described(binding),
          link: `<${canonicalDb(binding.database)}/vocabulary>; rel="service-desc"`,
        });
      case "vocabulary":
        return json(binding.surface.document(), 200, {
          "cache-control": described(binding),
          link: `<${canonicalDb(binding.database)}>; rel="service-meta"`,
        });
      case "read":
      case "price":
        return await requested(request, binding, route.name);
      case "object":
      case "list":
        return await addressed(request, binding, route);
      case "hint":
        return await hint(request, binding);
    }
  } catch (e) {
    return fault(e);
  }
}

/**
 * `OPTIONS`: what a route takes, and — for a browser about to send something it has to ask about
 * first — that it may.
 *
 * A read with a JSON body is not a "simple" request and a `QUERY` is not a safelisted method, so a
 * browser sends this before either. Answering 405 here, which is what this did, is refusing every
 * browser before it has asked anything.
 */
function options(request: Request, binding: Binding, route: Route): Response {
  const headers: Record<string, string> = { allow: allowOf(route) };
  if (corsOf(binding) && request.headers.get("access-control-request-method") !== null) {
    headers["access-control-allow-methods"] = allowOf(route);
    headers["access-control-allow-headers"] = CORS_REQUEST_HEADERS;
    // A day. What is allowed here does not depend on who asks or on anything that changes.
    headers["access-control-max-age"] = "86400";
  }
  return new Response(null, { status: 204, headers });
}

const corsOf = (binding: Binding): boolean => binding.cors ?? !isLoopbackDb(canonicalDb(binding.database));

/** What a browser may send: the body's type, a validator, and the four headers of a signature. */
const CORS_REQUEST_HEADERS = ["content-type", "accept", "if-none-match", CALLER_HEADER, "content-digest", "signature-input", "signature"].join(", ");

/** What a page may read off an answer beyond the few headers a browser shows it anyway. */
const CORS_EXPOSED_HEADERS = ["etag", "retry-after", "allow", "accept-query", "link"].join(", ");

/**
 * Everything that is true of a response whichever route made it.
 *
 * Gathered here so that no route can forget one: a validator on anything a cache may keep, `Vary`
 * on anything that depends on who asked, the links that lead from one document to the others, and
 * the headers that let a browser read any of it.
 */
async function finish(request: Request, binding: Binding, route: Route | null, response: Response): Promise<Response> {
  const headers = new Headers(response.headers);
  const reads = route !== null && (route.name === "read" || route.name === "object" || route.name === "list");

  if (reads) {
    // The answer depends on who signed the request, and that is not in `Authorization`, which is the
    // one header a shared cache already knows to be careful about. Without this, an answer kept for
    // the anonymous caller is handed to a signed one who was owed more — a wrong answer that looks
    // exactly like a right one. A `caller` answer is `private` and is not kept at all; this is for
    // the `public` ones.
    headers.set("vary", CALLER_HEADER);
  }
  if (route !== null && (route.name === "read" || route.name === "price")) headers.set("accept-query", ACCEPT_QUERY);
  if (route !== null && (route.name === "object" || route.name === "list") && response.status === 200) {
    const db = canonicalDb(binding.database);
    headers.set("link", `<${db}>; rel="service-meta", <${db}/vocabulary>; rel="service-desc"`);
  }
  if (corsOf(binding)) {
    // `*`, and never with credentials: nothing a browser attaches of its own accord changes an
    // answer here. See `Binding.cors` for the one case where that is not the whole story.
    headers.set("access-control-allow-origin", "*");
    headers.set("access-control-expose-headers", CORS_EXPOSED_HEADERS);
  }

  const safe = request.method === "GET" || request.method === "HEAD" || request.method === "QUERY";
  if (!safe || response.status !== 200) return new Response(response.body, { status: response.status, headers });

  // A validator, as a digest of the bytes. Not the object's version: what a caller is shown also
  // depends on the projection, the catalog and the policy for that caller, and a tag that is a fact
  // about the bytes cannot be wrong about any of them. It costs one hash of an answer already built.
  const bytes = new Uint8Array(await response.arrayBuffer());
  const etag = `"${await digestOf(bytes)}"`;
  headers.set("etag", etag);
  if (matches(request.headers.get("if-none-match"), etag)) {
    headers.delete("content-type");
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : bytes, { status: 200, headers });
}

/** Enough of a SHA-256 to tell two answers apart, base64url. 22 characters is 132 bits. */
async function digestOf(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));
  return btoa(String.fromCharCode(...hash)).replace(/\+/g, "-").replace(/\//g, "_").slice(0, 22);
}

/** `If-None-Match` against one tag, by the weak comparison RFC 9110 gives it: a list, a `*`, and a
 *  `W/` prefix that does not matter. */
function matches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

// ---- reading

/** A read or a price, as a request in a body. */
async function requested(request: Request, binding: Binding, route: "read" | "price"): Promise<Response> {
  if (request.method === "QUERY") {
    // RFC 10008 is stricter than this protocol was about one thing: a `QUERY` says what its content
    // is, and a server must not guess. `POST` is left as version 1 had it.
    const type = request.headers.get("content-type");
    if (type === null) {
      return refuse(400, "malformed", "a QUERY states its Content-Type; this route takes application/json", { at: "content-type" });
    }
    if (type.split(";")[0]!.trim().toLowerCase() !== "application/json") {
      return refuse(415, "media-type", `this route takes application/json, not ${type.split(";")[0]!.trim()}`, { at: "content-type" });
    }
  }
  const raw = await body(request, binding.maxBody ?? MAX_BODY);
  if (raw instanceof Response) return raw;
  // Who is calling is settled before the body is parsed as a request, so an unauthorized caller is
  // told so rather than told what is wrong with a request it may not submit at all.
  const authorized = await authorize(request, binding, raw);
  if (authorized instanceof Response) return authorized;
  let req: ReadRequest;
  try {
    req = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as ReadRequest;
  } catch {
    return refuse(400, "malformed", "body is not JSON");
  }
  return answer(request, binding, route, req, authorized);
}

/**
 * A read, as a URL: one object, or one page of one of its lists.
 *
 * **Exactly a read, and not a second way to say one.** `GET {db}/objects/5` is the request
 * `{ "ids": ["5"] }` and `GET {db}/objects/5/a.b?limit=3` is that with the one hop
 * `{ "edge": "a.b", "limit": 3 }`; both go through the same price, the same policy and the same
 * encoder as a body would, and a refusal's `at` is a path into that request. There is one hop and no
 * more because a tree in a query string is two spellings of every request, and the second spelling
 * is where a cache key and a signature stop agreeing.
 *
 * What it is for is everything that can only `GET`: a cache, a link on a page, and an agent whose
 * one tool fetches a URL — which could read this database's vocabulary and, until this, none of its
 * objects.
 */
async function addressed(request: Request, binding: Binding, route: Extract<Route, { name: "object" | "list" }>): Promise<Response> {
  // No body, so a signature here covers the digest of nothing — which is still a signature over the
  // method and the URI, and the URI is the whole of this request.
  const authorized = await authorize(request, binding, new Uint8Array());
  if (authorized instanceof Response) return authorized;

  const params = new URL(request.url).searchParams;
  const taken = route.name === "list" ? ["limit", "after"] : [];
  for (const name of new Set(params.keys())) {
    if (!taken.includes(name)) {
      return refuse(400, "malformed", `no such parameter "${name}"; this route takes ${taken.length === 0 ? "none" : taken.join(", ")}`, { at: `?${name}` });
    }
    if (params.getAll(name).length > 1) return refuse(400, "malformed", `"${name}" is given more than once`, { at: `?${name}` });
  }

  const req: ReadRequest = { ids: [route.id] };
  if (route.name === "list") {
    const hop: Hop = { edge: route.edge };
    const limit = params.get("limit");
    if (limit !== null) {
      if (!/^[1-9][0-9]{0,8}$/.test(limit)) return refuse(400, "malformed", "limit must be an integer", { at: "hops[0].limit" });
      hop.limit = Number(limit);
    }
    const after = params.get("after");
    if (after !== null) hop.after = after;
    req.hops = [hop];
  }
  return answer(request, binding, route.name, req, authorized);
}

/** Prices, admits, reads and encodes — the one path every read takes, whatever it arrived as. */
async function answer(
  request: Request,
  binding: Binding,
  route: Admission["route"],
  req: ReadRequest,
  authorized: { caller: Caller | null; policy?: Policy },
): Promise<Response> {
  const options = serveOptions(binding, authorized.policy);
  try {
    const cost = price(req, options);
    await binding.admit?.({ caller: authorized.caller, route, cost, request });
    if (route === "price") return json({ v: WIRE_VERSION, cost }, 200, { "cache-control": described(binding) });
    const served = await serve(req, options);
    if (route !== "read" && served.result.roots.length === 0) {
      // Not there, for this caller. One answer for an object that does not exist and one the policy
      // hides, as everywhere else — and it is `roots` that says so, because that is what `enforce`
      // left after walking the answer, so the two cases arrive here already the same. As keepable as
      // the object would have been: an absence is an answer too.
      return refuse(404, "not-found", "no such object", {}, { "cache-control": cacheControl(served.cache) });
    }
    return json(encodeRead(served, binding.surface), 200, { "cache-control": cacheControl(served.cache) });
  } catch (e) {
    if (e instanceof Refused) return refuse(400, e.kind, e.message, { at: e.at, offset: e.offset });
    if (e instanceof Backoff) return later(e);
    // Everything else, a `WireError` included, is this database failing: naming its own types is
    // not something the caller did, so it is a fault here and not a 400.
    return fault(e);
  }
}

// ---- hints

/**
 * Takes a hint, and answers the same thing whatever it thinks of it.
 *
 * `202` means "received" and nothing more. It does not say the target exists, that this database
 * will look, or that it would keep anything if it did — because each of those is something a read
 * would not have told this caller. Forbidden is indistinguishable from absent on `/read`, and a hint
 * that answered differently for an object the caller may not see would be the way around that.
 *
 * So everything decided here is decided from the request alone: its size, its signature, its shape.
 * The claim inside it is not looked at on this path at all. Checking it means reading the caller's
 * database, and a request that makes this one wait on a stranger's server is a request whose
 * latency the stranger sets.
 */
async function hint(request: Request, binding: Binding): Promise<Response> {
  const raw = await body(request, binding.maxBody ?? MAX_BODY);
  if (raw instanceof Response) return raw;
  const who = await authenticate(request, binding, raw);
  if (who instanceof Response) return who;
  if (who.caller === null) {
    // The one route where the anonymous caller is not a caller. Without a signature there is no
    // telling whose database the checking read would be sent to, and "whoever the body says" is how
    // a third party aims this database at one of its choosing.
    return refuse(401, "signature", "a hint is signed: it names the database that will be read to check it", { at: "signature" });
  }
  const known = await pinned(binding, who.caller, who.keys, false);
  if (known !== null) return known;
  if (who.caller.database === canonicalDb(binding.database)) {
    return refuse(400, "malformed", "a hint is about an edge from another database, and this is signed as this one", { at: "signature" });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return refuse(400, "malformed", "body is not JSON");
  }
  try {
    await binding.hints!.offer({ ...parseHint(parsed), caller: who.caller.database });
  } catch (e) {
    if (e instanceof Refused) return refuse(400, e.kind, e.message, { at: e.at });
    if (e instanceof Backoff) return later(e);
    return fault(e);
  }
  return json({ v: WIRE_VERSION }, 202, { "cache-control": "no-store" });
}

/** "Not now", with how long. 429 when it is this caller's doing and 503 when it is nobody's. */
const later = (e: Backoff): Response =>
  e.whose === "caller"
    ? refuse(429, "too-many", e.message, {}, { "retry-after": String(e.seconds) })
    : refuse(503, "unavailable", e.message, {}, { "retry-after": String(e.seconds) });

/** A 500 that says nothing. A stranger learns that this database broke, not how. */
const fault = (e?: unknown): Response => {
  // Logged, not sent: a deployment's operator has to be able to find this, and a stranger must not.
  if (e !== undefined) console.error("hlekk: a request faulted", e);
  return refuse(500, "fault", "internal error");
};

/**
 * The body, or the response that refuses it.
 *
 * The size is checked twice on purpose. `content-length` is the cheap check and refuses before a
 * byte is read, but it is a claim and a chunked body carries none, so the stream is counted before
 * decoding it. The digest covers these exact bytes.
 */
async function body(request: Request, maxBody: number): Promise<Uint8Array | Response> {
  const over = () => refuse(413, "too-large", `body too large, the maximum is ${maxBody} bytes`);
  if (Number(request.headers.get("content-length")) > maxBody) {
    void request.body?.cancel().catch(() => {});
    return over();
  }
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBody) {
        void reader.cancel().catch(() => {});
        return over();
      }
      chunks.push(value);
    }
  } catch {
    return refuse(400, "malformed", "could not read the body");
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
