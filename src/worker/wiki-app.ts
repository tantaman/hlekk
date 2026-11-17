// The Wikimedia demo on real Cloudflare: a Worker over the wiki catalog spread across many host
// Durable Objects, with the ingest endpoints a driver feeds it through.
//
// WHAT THIS IS FOR. `scripts/ingest-local.ts` proved the schema, the record shape and the title
// entry point against a LocalCluster — one process, real SQLite, no network. Everything below the
// client was the same code a deployment runs, but the transport was not, so what it could not say
// anything about is exactly what this says something about: DO RPC, the published map in real KV,
// routing across tens of real Durable Objects, and the one number docs/wikimedia-import.md calls
// the only figure worth planning on — `databaseSize` after a pilot load.
//
// WHAT THIS IS NOT. Still not the loader wikimedia-demo.md asks for. The ingest routes write one
// mutation per row through the ordinary client, so the chunked snapshot remains untouched and
// nothing here is a throughput claim for 300 GB. What they add over the local script is that every
// one of those mutations now crosses a real RPC boundary to a real Durable Object.
//
// Ingest is two passes over HTTP, for the reason the demo doc gives: ids must exist before edges can
// reference them. The driver keeps the `page_id -> hlekk id` map between them, which is also what
// keeps this Worker stateless.

import { Hlekk } from "../client/client.ts";
import { ValueTaken } from "../client/client.ts";
import { vshardOf } from "../host/ids.ts";
import type { Id, Json } from "../query/types.ts";
import { chunkKey } from "../directory/map.ts";
import { databaseOf, directoryStub, hostStub } from "../adapters/cloudflare/bindings.ts";
import type { Env } from "../adapters/cloudflare/bindings.ts";
import { call } from "../adapters/cloudflare/rpc.ts";
import { cloudflareTransport } from "../adapters/cloudflare/transport.ts";
import { isOperatorPath, refuseOperator } from "./guard.ts";
import { ROSTER_TTL_MS, narrowRoster, rosterOf } from "./roster.ts";
import { OG_CARD, OG_CARD_ETAG } from "./wiki-og.ts";
import { wikiUi } from "./wiki-ui.ts";
import { QueryRefused, build as buildQuery, check as checkQuery, parseQuery, schemaView, unparse } from "./wiki-query.ts";
import type { QuerySpec } from "./wiki-query.ts";
import {
  LOCK,
  Page,
  TITLE_IDX,
  categoryPages,
  linkedFrom,
  pageCategories,
  pageLinks,
  legacyTitleKey,
  storedTitle,
  titleKey,
} from "./wiki.ts";

export { HlekkHostDO } from "../adapters/cloudflare/host.ts";
export { HlekkDirectoryDO } from "../adapters/cloudflare/directory.ts";

/** What the roster is held under. One deployment is one database, so one slot per isolate is the
 *  whole of it — and a module-level object is that without assuming anything about whether the
 *  runtime hands every request the same `env`. */
const THIS_DEPLOYMENT = {};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The edge types by the name the import emits, which is the only vocabulary the driver has. An
 *  unknown name is a mismatch between the two sides and is refused rather than skipped. */
const ATYPE: Record<string, number> = {
  [pageLinks.name]: pageLinks.atype,
  [linkedFrom.name]: linkedFrom.atype,
  [pageCategories.name]: pageCategories.atype,
  [categoryPages.name]: categoryPages.atype,
};

/** The relations `/relation` will page through, by schema name. Separate from ATYPE because paging
 *  needs the typed edge rather than its integer. */
const RELATION: Record<string, typeof pageLinks> = {
  [pageLinks.name]: pageLinks,
  [linkedFrom.name]: linkedFrom,
  [pageCategories.name]: pageCategories,
  [categoryPages.name]: categoryPages,
};

/** The page card's read: four counts from maintained counters, and the first page of the two lists
 *  the card shows. Exported because the card is half of a contract -- `/relation` continues these
 *  lists, and the join between them is the cursor this hands back -- and a test of that contract
 *  should run the query the Worker runs rather than a copy that can drift from it.
 *
 *  Paged, not plain `related`: without a cursor the card's "show more" had nowhere to resume from,
 *  so it re-read each list from the start and appended rows that were already on screen. `more` is
 *  the other half of it -- a list that fits the limit gets no button at all. */
export const cardQuery = (id: Id, limit: number) =>
  Page.gen(id)
    .countAs("linkCount", pageLinks)
    .countAs("backlinkCount", linkedFrom)
    .countAs("categoryCount", pageCategories)
    .countAs("memberCount", categoryPages)
    .relatedPage("links", pageLinks, (q) => q.limit(limit))
    .relatedPage("categories", pageCategories, (q) => q.limit(limit));

/** One page of one of those lists, continued from a cursor the card returned. `/relation` is this,
 *  and so is the second half of the test that the two agree. */
export const relationPage = (id: Id, edge: typeof pageLinks, limit: number, after: string | null) =>
  Page.gen(id).relatedPage("items", edge, (q) => (after ? q.limit(limit).after(after) : q.limit(limit)));

/**
 * A title's id, under the current index key or the one this database may have been loaded with.
 *
 * `lookup` is the index read, passed in so this can be driven without a cluster: both halves are
 * worth a test and neither was reachable while this lived inside the request handler. The halves are
 * the normalization -- a typed title has to land on the key the loader wrote, which is the dump's
 * own spelling -- and the legacy fallback, one extra lookup taken only on a miss.
 */
export async function titleLookup(
  lookup: (key: string) => Promise<Id | null>,
  ns: number,
  typed: string,
): Promise<Id | null> {
  const stored = storedTitle(typed);
  const key = titleKey(ns, stored);
  const id = await lookup(key);
  if (id !== null) return id;
  const legacy = legacyTitleKey(ns, stored);
  return legacy === key ? null : lookup(legacy);
}

/** A page as the import emits it, with its edges stripped off by the driver. */
interface PageIn {
  key: string;
  affinity: string;
  fields: { ns: number; title: string; redirect: boolean; len: number; extract?: string };
}

/** An edge with both ends already resolved to hlekk ids: `[type, from, to, time]`. A tuple rather
 *  than an object because at 46.9 bytes per edge in JSON the field names are most of the payload. */
type EdgeIn = [string, Id, Id, number];

/**
 * The wiki demo's own bindings, on top of what the database layer needs.
 */
interface WikiEnv extends Env {
  /**
   * The bearer token that opens `/admin/*` and `/ingest/*`, and the only thing that does.
   *
   * A SECRET, NOT A VAR. Set it with `wrangler secret put HLEKK_ADMIN_TOKEN --config <this config>`,
   * never under `vars`, where it would be committed and readable in the dashboard. Absent — which is
   * the state every committed config deploys to — those paths refuse everything, so a deployment
   * nobody is operating carries no working way to change it. See `guard.ts` for why this is a token
   * where `HLEKK_WIPE` and `HLEKK_R2PROBE` are arming flags, and why those two still apply on top.
   *
   * Each deployment holds its own. A forwarded request carries the caller's header to the other
   * deployment, which checks it against its own token, so `?placement=b` on an operator path works
   * only where the two were deliberately given the same one.
   */
  HLEKK_ADMIN_TOKEN?: string;

  /**
   * A second deployment of this same Worker, holding the same wiki under a placement that buys no
   * locality. `?placement=b` is forwarded to it; absent the binding, that parameter is an error
   * rather than a quietly wrong answer.
   *
   * WHY A WHOLE DEPLOYMENT, and not a parameter picking a second database name. A Durable Object's
   * env comes from the deployment that defines its namespace, never from whoever called it: a
   * Worker can address the object named `other/h-3` perfectly well, but that object then resolves
   * *its* peers and *its* KV chunk key from *its own* HLEKK_DATABASE. So a Worker holding two
   * database names does not get two databases. It gets one set of host objects that the second
   * database's directory adopts vshards on, and one set of map chunks that the second database
   * publishes over the first's. That was tried, and workerd showed it as
   * `indexLookup: host does not hold index vshard 155`, with two "databases" sharing all 43 hosts.
   *
   * The database name is therefore deployment-wide by construction, and a second placement is a
   * second deployment — which is also how a second tenant would really be run. A service binding
   * keeps that off the public internet and out of the browser's CORS rules, and the control
   * deployment has no binding of its own, so a forward cannot loop.
   */
  HLEKK_ALT?: { fetch(request: Request): Promise<Response> };

  /**
   * A third deployment of this same Worker, holding the same wiki under a placement derived from the
   * link graph. `?placement=c` is forwarded to it, on the same reasoning as `HLEKK_ALT`.
   *
   * Separate from `HLEKK_ALT` rather than a list, because the two are not interchangeable to a
   * reader: one is the no-locality control every number is quoted against, the other is the
   * placement under test.
   */
  HLEKK_ALT2?: { fetch(request: Request): Promise<Response> };

  /**
   * Arms `/admin/wipe` for the databases this names, comma separated, and for no others.
   *
   * Absent — which is the committed state — the route refuses everything, so a public demo does not
   * carry a working way to destroy data. Setting it is a deliberate deploy, and it is the operator
   * naming the victims in configuration rather than a request choosing one.
   *
   * A list rather than one name because abandoned databases accumulate: changing `HLEKK_DATABASE`
   * leaves one behind every time, and this account had three of them before anything could erase
   * any. One name would have meant one deploy per database, and three deploys of a public Worker
   * carrying a destructive route is worse than one.
   */
  HLEKK_WIPE?: string;

  /**
   * Arms `/admin/r2probe` for the R2 keys this names, comma separated, and for no others.
   *
   * On the same reasoning as `HLEKK_WIPE`, and for a route that does not look dangerous at all. The
   * probe answers one question — can a Durable Object read R2, and a byte range of it — and
   * answering it needs one key the operator put there. Taking the key from the request instead made
   * a public deployment with `HLEKK_BULK` bound into a read oracle over the whole bucket: `found`
   * enumerates keys, `size` measures them, and `head` returns the bytes, so walking `offset` in
   * 24-byte steps reads out any object in it. The bucket holds the pre-partitioned import slices,
   * which is to say the whole wiki and anything else that lands in `hlekk-bulk`.
   *
   * Absent — which is the committed state — the route refuses everything, so the capability answer
   * costs a deliberate deploy rather than nothing at all.
   */
  HLEKK_R2PROBE?: string;
}

/**
 * The database this deployment may erase, if the request names one of them.
 *
 * Both halves are required and neither is sufficient: the var lists which databases may be wiped,
 * and the request has to name one of that list exactly. So a stray or probing request does nothing,
 * and a request can never widen the target — the worst it can do is agree with configuration.
 */
export function wipeTarget(env: WikiEnv, url: URL): string | null {
  const armed = (env.HLEKK_WIPE ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const asked = url.searchParams.get("database");
  if (asked === null || asked === "") return null;
  return armed.includes(asked) ? asked : null;
}

/**
 * The R2 key `/admin/r2probe` may read, if the request names one of them.
 *
 * Both halves again, and for the same reason as `wipeTarget`: the var lists the keys, the request
 * has to name one of that list exactly, and so a request can only ever agree with configuration. A
 * probe is a question about the platform rather than about the data, so one key the operator placed
 * answers it as well as any — and an allowlist is what keeps the answer from being a way to read
 * everything else in the bucket.
 *
 * There is no default key. `probe.bin` used to be one, which meant a deployment that never set this
 * var still answered for `probe.bin`, and a reader could not tell from the route whether anything
 * was armed.
 */
export function probeKey(env: WikiEnv, url: URL): string | null {
  const armed = (env.HLEKK_R2PROBE ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key !== "");
  const asked = url.searchParams.get("key");
  if (asked === null || asked === "") return null;
  return armed.includes(asked) ? asked : null;
}

/**
 * A byte range a probe may ask for, or an error naming what was wrong with it.
 *
 * `Number()` on a query parameter yields NaN for anything that is not a number, and NaN reached R2
 * as `{range: {offset: NaN}}` rather than as a complaint. A range is two non-negative integers or it
 * is not a range.
 */
export function probeRange(url: URL): { offset?: number; length?: number } | { error: string } {
  const out: { offset?: number; length?: number } = {};
  for (const name of ["offset", "length"] as const) {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return { error: `${name} must be a non-negative integer, got ${raw}` };
    out[name] = n;
  }
  if (out.length !== undefined && out.offset === undefined) return { error: "length needs an offset" };
  return out;
}

/**
 * Where a request goes when it asks for the control placement, or null to serve it here.
 *
 * The parameter is stripped on the way: the control deployment runs this same code, and a forward
 * that kept it would be a request asking to be forwarded again.
 */
export function altTarget(url: URL): { to: URL; which: "b" | "c" } | null {
  const which = url.searchParams.get("placement");
  if (which !== "b" && which !== "c") return null;
  const to = new URL(url);
  to.searchParams.delete("placement");
  return { to, which };
}

export default {
  async fetch(request: Request, env: WikiEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Before anything else, the forward included. A refused request touches no binding and reaches
    // no other deployment — a forward is a way in as much as a route is, and the deployment behind
    // it may be running code older than this check.
    if (isOperatorPath(path)) {
      const refused = await refuseOperator(request, env.HLEKK_ADMIN_TOKEN);
      if (refused !== null) return refused;
    }

    // Then, and still before any binding is touched: this deployment holds one database, and the
    // other placement is somewhere else entirely.
    const alt = altTarget(url);
    if (alt !== null) {
      const to = alt.which === "b" ? env.HLEKK_ALT : env.HLEKK_ALT2;
      if (to === undefined) {
        const what = alt.which === "b" ? "control" : "graph";
        return json({ error: `no ${what} deployment is bound to this one`, placement: alt.which }, 503);
      }
      return to.fetch(new Request(alt.to, request));
    }

    const db = Hlekk.from(cloudflareTransport(env));
    const directory = directoryStub(env);
    const body = async <T>(): Promise<T> => (await request.json()) as T;
    const num = (k: string, fallback: number) => Number(url.searchParams.get(k) ?? fallback);
    /**
     * A title's id, under the current index key or the one this database may have been loaded with.
     *
     * One extra index lookup, and only on a miss, so a hit costs nothing. See `legacyTitleKey` for
     * why a loaded database cannot simply be re-keyed. The second lookup is skipped when the two
     * spellings agree, which is 99.67% of simplewiki's titles.
     */
    const byTitle = (n: number, t: string): Promise<Id | null> =>
      titleLookup((key) => db.lookupUnique(TITLE_IDX, key), n, t);

    try {
      // ---- the demo you can look at

      /** The page view. Served from the Worker as one document so the demo has nothing to build and
       *  no asset host to depend on; it calls the same `/page` route the ingest driver checks. */
      if (path === "/" || path === "/wiki") {
        return new Response(wikiUi(url.origin), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
        });
      }

      /** The social card the page's og:image points at, in the bundle for the same reason the page
       *  is: a link shared anywhere should not depend on an asset host this demo does not have.
       *
       *  Cached hard, and by its own hash rather than by a name: the path never changes, so a
       *  re-render would otherwise serve stale bytes for as long as the max-age. A crawler that
       *  already holds the card sends If-None-Match and gets 304 and no body. */
      if (path === "/og.png") {
        if (request.headers.get("if-none-match") === OG_CARD_ETAG) {
          return new Response(null, { status: 304, headers: { etag: OG_CARD_ETAG } });
        }
        return new Response(OG_CARD, {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=86400",
            etag: OG_CARD_ETAG,
          },
        });
      }

      /** The host roster the page draws its grid from. What `/admin/where` used to be asked for by
       *  every visitor — see `rosterOf` for what that cost and what this returns instead. */
      if (path === "/cluster") {
        const roster = await rosterOf(THIS_DEPLOYMENT, Date.now(), async () =>
          narrowRoster(await call<Parameters<typeof narrowRoster>[0]>(directory, "where")),
        );
        return new Response(JSON.stringify(roster), {
          headers: { "content-type": "application/json", "cache-control": `public, max-age=${ROSTER_TTL_MS / 1000}` },
        });
      }

      // ---- operating it

      if (path === "/health") {
        return json({
          ok: true,
          database: databaseOf(env),
          // Whether the comparison is reachable from here at all, which is what the A/B tab needs
          // to know before it offers one.
          alt: env.HLEKK_ALT === undefined ? null : "bound",
          alt2: env.HLEKK_ALT2 === undefined ? null : "bound",
          vshards: env.HLEKK_VSHARDS ?? null,
        });
      }

      /** Lays the database out. Once: `init` refuses a second call, because re-spreading vshards
       *  whose rows have already been adopted would point them at hosts that do not hold them. */
      if (path === "/admin/init") {
        return json(await call(directory, "init", LOCK, num("hosts", 50), num("indexVshards", 4)));
      }
      if (path === "/admin/where") {
        return json({ ...(await call<object>(directory, "where")), database: databaseOf(env) });
      }

      /** Every host's `databaseSize`, which is the storage multiplier the import doc leaves open.
       *  Summing payload lengths undercounts real storage by 1.05x to 4.7x, and this is the figure
       *  that settles which.
       *
       *  The hosts come from the directory rather than from a count in the query string. A Durable
       *  Object is created by being addressed, so asking about a host the directory never created
       *  brings an empty one into existence and then counts its schema -- a measurement that
       *  inflates the thing it measures, by 45 KB a time. */
      if (path === "/admin/size") {
        const known = await call<{ hosts: { host: number }[] }>(directory, "where");
        const hosts = known.hosts.map((h) => h.host);
        const sizes = await pooled(hosts, 16, (h) => call<number>(hostStub(env, h), "size"));
        const bytes = sizes.map((s) => (s instanceof Error ? -1 : s));
        const total = bytes.filter((b) => b >= 0).reduce((n, b) => n + b, 0);
        return json({
          hosts: bytes.length,
          total,
          nonEmpty: bytes.filter((b) => b > 0).length,
          errors: sizes.filter((s) => s instanceof Error).length,
          of: hosts,
          bytes,
        });
      }

      /**
       * Erases a database: its published map first, then every host, then its directory.
       *
       * This exists because changing `HLEKK_DATABASE` is how a clean slate is had here, and that
       * *abandons* the old database rather than removing it — its host objects keep their rows, and
       * nothing outside a Durable Object can delete one. See `Ctx.storage.deleteAll`.
       *
       * The map is unpublished first, deliberately. While a chunk is still readable a client can
       * still route into those hosts, and a read served out of a half-erased database is a wrong
       * answer rather than a missing one. POST only, so no link or prefetch can trigger it.
       *
       * Addressing another database's objects is sound *here* and is not sound in `init`, which is
       * worth stating because the two look alike. A Durable Object resolves its peers and its KV key
       * from its own env, so telling one to act on another database makes it act on the wrong
       * objects — that is why there is one database per deployment. A wipe resolves nothing: each
       * object only erases itself, and the host list comes from the dead directory's own
       * `inventory` rather than from `where`, which would have asked the live database's hosts.
       */
      if (path === "/admin/wipe") {
        if (request.method !== "POST") return json({ error: "wiping is POST only" }, 405);
        const dead = wipeTarget(env, url);
        if (dead === null) {
          return json(
            { error: "this deployment is not armed to wipe the database named in ?database=" },
            403,
          );
        }
        const at = { ...env, HLEKK_DATABASE: dead };
        const inv = await call<{ hosts: number[]; chunks: number[] }>(directoryStub(at), "inventory");
        for (const i of inv.chunks) await env.HLEKK_MAP.delete(chunkKey(dead, i));
        const results = await pooled(inv.hosts, 8, (h) =>
          call<{ bytes: number; vshards: number }>(hostStub(at, h), "wipe"),
        );
        const failed: { host: number; error: string }[] = [];
        let bytes = 0;
        let wiped = 0;
        results.forEach((r, i) => {
          if (r instanceof Error) failed.push({ host: inv.hosts[i]!, error: `${r.name}: ${r.message}` });
          else {
            bytes += r.bytes;
            wiped++;
          }
        });
        // The directory last: until it is gone it is the only record of which hosts to revisit if
        // any of them refused.
        const directory = failed.length > 0 ? null : await call<{ bytes: number }>(directoryStub(at), "wipe");
        return json({
          database: dead,
          chunksUnpublished: inv.chunks.length,
          hosts: inv.hosts.length,
          wiped,
          failed,
          directoryWiped: directory !== null,
          bytes: bytes + (directory?.bytes ?? 0),
        });
      }

      /** Asks a host whether it can read R2, and a byte range of it. See `r2probe` on the host for
       *  why this is worth a route: it is the undocumented fact a bulk import would rest on.
       *
       *  Gated like `/admin/wipe`, and POST only for the same reason — no link or prefetch can
       *  trigger it. A route that returns bytes out of a bucket is not safer than one that erases a
       *  database just because it reads; see `HLEKK_R2PROBE` for what taking the key from the
       *  request made this. */
      if (path === "/admin/r2probe") {
        if (request.method !== "POST") return json({ error: "probing is POST only" }, 405);
        const key = probeKey(env, url);
        if (key === null) {
          return json(
            { error: "this deployment is not armed to probe the R2 key named in ?key=" },
            403,
          );
        }
        const range = probeRange(url);
        if ("error" in range) return json({ error: range.error }, 400);
        const host = num("host", 0);
        if (!Number.isInteger(host) || host < 0) return json({ error: "host must be a non-negative integer" }, 400);
        return json({
          host,
          key,
          ...(await call<object>(hostStub(env, host), "r2probe", key, range.offset, range.length)),
        });
      }

      /** Burns a counted amount of CPU on purpose. The Workers free plan allows 10 ms per
       *  invocation and the paid plan 30 seconds, so a request that asks for a second of
       *  arithmetic and gets an answer has established which plan this account is on — which
       *  decides whether a 50-host fan-out is possible at all, and has to be known *before*
       *  `/admin/init`, since init is once-only and a half-completed layout cannot be retried.
       *
       *  Counted iterations, not a deadline. `Date.now()` does not advance during synchronous
       *  execution on Workers — it is pinned to the last I/O — so `while (Date.now() - started <
       *  ms)` is an infinite loop that terminates only by hitting the CPU limit, whatever the
       *  limit is. It tells you nothing about which plan you are on. */
      if (path === "/admin/cpu") {
        const mops = num("mops", 1);
        let spins = 0;
        for (let m = 0; m < mops; m++) for (let i = 0; i < 1_000_000; i++) spins += i & 7;
        return json({ mops, spins });
      }

      // ---- ingest, pass A: the pages, each through the global unique index on title

      if (path === "/ingest/pages" && request.method === "POST") {
        const { pages, concurrency = 16 } = await body<{ pages: PageIn[]; concurrency?: number }>();
        const started = Date.now();
        const results = await pooled(pages, concurrency, async (p) => {
          const key = titleKey(p.fields.ns, p.fields.title);
          try {
            return { id: await db.createUnique(TITLE_IDX, key, Page.otype, { ...p.fields }, { affinity: p.affinity }) };
          } catch (e) {
            // A retried batch finds its own earlier writes. Resumability matters more than
            // throughput here — wikimedia-demo.md says so about the real loader — so a title that
            // is already taken resolves to the id holding it instead of failing the run.
            if (e instanceof ValueTaken || (e as Error).name === "ValueTaken") {
              const held = await db.lookupUnique(TITLE_IDX, key);
              if (held !== null) return { id: held, existed: true };
            }
            throw e;
          }
        });

        const ids: Record<string, Id> = {};
        let existed = 0;
        // Every failed key, not a sample of them. A caller can only retry what it is told about,
        // and `Durable Object is overloaded` is transient — the index vshards are few and every
        // title insert writes through one, so under load they queue. Truncating this list to a
        // sample is what turns a retryable batch into a failed load.
        const failedKeys: string[] = [];
        const failures: { key: string; error: string }[] = [];
        results.forEach((r, i) => {
          if (r instanceof Error) {
            failedKeys.push(pages[i].key);
            if (failures.length < 5) failures.push({ key: pages[i].key, error: `${r.name}: ${r.message}` });
          } else {
            ids[pages[i].key] = r.id;
            if (r.existed) existed++;
          }
        });
        return json({ ids, existed, failed: failedKeys.length, failedKeys, failures, ms: Date.now() - started });
      }

      // ---- ingest, pass B: both directions of both relations, as the import emitted them

      if (path === "/ingest/edges" && request.method === "POST") {
        const { edges, concurrency = 16, bulk = true } = await body<{
          edges: EdgeIn[];
          concurrency?: number;
          bulk?: boolean;
        }>();
        const started = Date.now();
        const unknown = [...new Set(edges.map((e) => e[0]))].filter((t) => ATYPE[t] === undefined);
        if (unknown.length > 0) return json({ error: `unknown edge types: ${unknown.join(", ")}` }, 400);

        // The fast path is one transaction per vshard group rather than one per edge. The slow path
        // is the old per-edge write, and it is kept because it is the only one that can say *which*
        // edge failed: a batch is one unit, so a throw indicts all of it. So bulk first, and on a
        // failure replay that batch edge at a time to find the culprits. A load that is working pays
        // the fast path; a load that is in trouble pays for precision, which is what it needs.
        //
        // Retrying coarsely is safe either way — an edge write is an upsert whose count is bumped
        // only when the edge is new — so the fallback cannot double-count what the batch landed
        // before it threw.
        let bulkError: string | null = null;
        if (bulk) {
          try {
            const written = await db.assocAddMany(
              edges.map(([type, from, to, time]) => ({ atype: ATYPE[type]!, id1: from, id2: to, time })),
            );
            return json({
              written,
              failed: 0,
              failedIndexes: [] as number[],
              failures: [] as { edge: EdgeIn; error: string }[],
              path: "bulk",
              ms: Date.now() - started,
            });
          } catch (e) {
            bulkError = `${(e as Error).name}: ${(e as Error).message}`;
          }
        }

        const results = await pooled(edges, concurrency, ([type, from, to, time]) =>
          db.assocAdd(ATYPE[type]!, from, to, time),
        );
        // Positions, so the caller retries exactly the edges that failed. An edge write is an
        // upsert whose count is bumped only when the edge is new, so a retry cannot double-count.
        const failed: number[] = [];
        const failures: { edge: EdgeIn; error: string }[] = [];
        results.forEach((r, i) => {
          if (r instanceof Error) {
            failed.push(i);
            if (failures.length < 5) failures.push({ edge: edges[i], error: `${r.name}: ${r.message}` });
          }
        });
        return json({
          written: edges.length - failed.length,
          failed: failed.length,
          failedIndexes: failed,
          failures,
          path: bulkError === null ? "per-edge" : "per-edge after bulk failed",
          bulkError,
          ms: Date.now() - started,
        });
      }

      // ---- the demo's read surface

      /** Title lookup alone, for checking that every page can be entered by `(ns, title)` without
       *  paying for a card to find out. Several titles per call, since the question is asked of a
       *  sample rather than of one page. */
      if (path === "/lookup") {
        const titles = (url.searchParams.get("titles") ?? "").split("|").filter(Boolean);
        const ns = num("ns", 0);
        const found = await pooled(titles, 8, (t) => {
          // `ns:title`, so a sample can span namespaces in one call. Titles hold no `:` in
          // MediaWiki's `page_title` form; a namespace prefix is a separate column.
          const at = t.indexOf(":");
          const [n, title] = at < 0 ? [ns, t] : [Number(t.slice(0, at)), t.slice(at + 1)];
          return byTitle(n, title);
        });
        return json({
          ids: Object.fromEntries(titles.map((t, i) => [t, found[i] instanceof Error ? null : found[i]])),
          errors: found.filter((f) => f instanceof Error).length,
        });
      }

      /** Title lookup, then the page card. The only way in: there is no scan and no non-unique
       *  index, and for a wiki that is a fit rather than a compromise. */
      if (path === "/page") {
        const ns = num("ns", 0);
        const title = url.searchParams.get("title") ?? "";
        const limit = num("limit", 25);
        const lookupStarted = Date.now();
        const id = await byTitle(ns, title);
        const lookupMs = Date.now() - lookupStarted;
        if (id === null) return json({ found: false, ns, title, lookupMs }, 404);

        const stats = { rounds: 0, requests: 0 };
        const started = Date.now();
        const rows = await cardQuery(id, limit)
          .run(db, { driver: url.searchParams.get("driver") === "rounds" ? "rounds" : "async", stats });
        const ms = Date.now() - started;

        // Which hosts the answer was assembled from. Not something an application would ask; it is
        // the claim the demo exists to make.
        const ids = idsIn(rows as unknown as Json);
        await db.routes.routeAll([...new Set(ids.map(vshardOf))]);
        const hosts = [...new Set(ids.map((i) => db.routes.peek(vshardOf(i))?.host))].filter((h) => h !== undefined);
        return json({
          found: true,
          id,
          page: rows[0] ?? null,
          read: { ...stats, ms, lookupMs, objects: ids.length, hosts: hosts.sort((a, b) => a - b) },
        });
      }

      /** One relation of one page, as a page of rows with a cursor to continue from.
       *
       *  `/page` reads a fixed card; this is how the rest of a list is read. A hub page here has
       *  thousands of backlinks, so "show more" is the only way to see the whole detail of a page,
       *  and `relatedPage` is what carries the cursor — only the gathered graph knows whether a list
       *  was exhausted, since the rows handed back are the ones that fit a limit. */
      if (path === "/relation") {
        const id = url.searchParams.get("id") ?? "";
        const name = url.searchParams.get("edge") ?? "";
        const edge = RELATION[name];
        if (!edge) return json({ error: `no edge "${name}"; have ${Object.keys(RELATION).join(", ")}` }, 400);
        const limit = Math.max(1, Math.min(100, num("limit", 50)));
        const after = url.searchParams.get("after");
        const stats = { rounds: 0, requests: 0 };
        const started = Date.now();
        const rows = (await relationPage(id, edge, limit, after)
          .run(db, { stats })) as unknown as { items: { items: { id: Id; title: string; ns: number }[]; cursor: string | null; more: boolean } }[];
        const page = rows[0]?.items ?? { items: [], cursor: null, more: false };
        const ids = page.items.map((i) => i.id);
        await db.routes.routeAll([...new Set(ids.map(vshardOf))]);
        const hosts = [...new Set(ids.map((i) => db.routes.peek(vshardOf(i))?.host))].filter((h) => h !== undefined);
        return json({
          ...page,
          read: { ...stats, ms: Date.now() - started, hosts: hosts.sort((a, b) => a - b) },
        });
      }

      // ---- the query editor
      //
      // A different exposure from the page view, and treated as one: see wiki-query.ts for the three
      // holes a typed plan can reach in the engine and which of them are guarded versus made
      // unrepresentable. The editor submits a nested description, never a Plan.

      /** What the editor autocompletes from, and the budget it prices against. The same values the
       *  guard uses, so an author is never shown a limit the server does not apply. */
      if (path === "/schema") return json(schemaView());

      /** The cost of a query without running it, so an editor can price what is being typed —
       *  including something over budget, which `check` refuses but an author still wants to see,
       *  and text that does not parse, where the offset is what puts the caret on the mistake. */
      if (path === "/price" && request.method === "POST") {
        const sent = await body<{ text?: string } & QuerySpec>();
        try {
          const spec = typeof sent.text === "string" ? parseQuery(sent.text) : sent;
          return json({ ...checkQuery(spec), spec, text: unparse(spec) });
        } catch (e) {
          if (e instanceof QueryRefused) return json({ error: e.message, at: e.at, offset: e.offset });
          throw e;
        }
      }

      /** Runs an authored query. Checked before any I/O, then entered by title like every other read
       *  here, then compiled through the typed builder. */
      if (path === "/query" && request.method === "POST") {
        const sent = await body<{ text?: string } & QuerySpec>();
        let spec: QuerySpec;
        let cost;
        try {
          // Text is parsed into the same spec the form submitted, and then checked. A text front
          // end does not widen what a query may say, and nothing here evaluates what was sent.
          spec = typeof sent.text === "string" ? parseQuery(sent.text) : sent;
          cost = checkQuery(spec);
        } catch (e) {
          if (e instanceof QueryRefused) return json({ refused: e.message, at: e.at, offset: e.offset }, 400);
          throw e;
        }
        const id = await byTitle(spec.from.ns, spec.from.title);
        if (id === null) {
          // Named by the key that was actually looked up. A demo whose entry story is "one exact
          // key" owes an author the spelling it tried, especially when it is not the one they typed.
          const stored = storedTitle(spec.from.title);
          const asked = stored === spec.from.title ? "" : ` (from "${spec.from.title}")`;
          return json({ refused: `no page "${stored}"${asked} in namespace ${spec.from.ns}`, at: "from" }, 404);
        }
        const stats = { rounds: 0, requests: 0 };
        const started = Date.now();
        const rows = await buildQuery(spec, id).run(db, {
          driver: url.searchParams.get("driver") === "rounds" ? "rounds" : "async",
          stats,
        });
        const ms = Date.now() - started;
        const ids = idsIn(rows as unknown as Json);
        await db.routes.routeAll([...new Set(ids.map(vshardOf))]);
        const hosts = [...new Set(ids.map((i) => db.routes.peek(vshardOf(i))?.host))].filter((h) => h !== undefined);
        return json({
          rows,
          cost,
          read: { ...stats, ms, objects: ids.length, hosts: hosts.sort((a, b) => a - b) },
        });
      }

      /** The four maintained counts for one id, which is the exact-count oracle's question. A
       *  counter rather than a `COUNT(*)`, which is what makes a 5,000-backlink page cheap. */
      if (path === "/counts") {
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
        const rows = await pooled(ids, 8, async (id) => {
          const [row] = (await Page.gen(id)
            .countAs("links", pageLinks)
            .countAs("backlinks", linkedFrom)
            .countAs("cats", pageCategories)
            .countAs("members", categoryPages)
            .run(db)) as unknown as Record<string, number>[];
          return row;
        });
        return json({
          counts: Object.fromEntries(
            ids.map((id, i) => [id, rows[i] instanceof Error ? { error: String(rows[i]) } : rows[i]]),
          ),
        });
      }

      /** Where a set of ids actually lives, so a spread can be checked from outside. */
      if (path === "/admin/route") {
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
        await db.routes.routeAll([...new Set(ids.map(vshardOf))]);
        return json({
          hosts: Object.fromEntries(ids.map((id) => [id, db.routes.peek(vshardOf(id))?.host ?? null])),
        });
      }

      return json({ error: `no route for ${request.method} ${path}` }, 404);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      return json({ error: error.message, name: error.name }, 500);
    }
  },
};

/**
 * Runs `f` over `items` with at most `limit` in flight, keeping each result in its item's place and
 * returning a rejection as a value rather than losing the rest of the batch to it.
 *
 * Bounded rather than `Promise.all`: a batch is sized for the subrequest budget, not for how many
 * sockets a Worker will open at once, and a thousand simultaneous DO calls would queue anyway.
 */
async function pooled<T, R>(
  items: readonly T[],
  limit: number,
  f: (item: T, index: number) => Promise<R>,
): Promise<(R | Error)[]> {
  const out = new Array<R | Error>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        try {
          out[i] = await f(items[i], i);
        } catch (e) {
          out[i] = e instanceof Error ? e : new Error(String(e));
        }
      }
    }),
  );
  return out;
}

/** Every id in an answer, so the demo can say which hosts it was assembled from. */
function idsIn(value: Json): Id[] {
  if (Array.isArray(value)) return value.flatMap(idsIn);
  if (value === null || typeof value !== "object") return [];
  const out: Id[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (k === "id" && typeof v === "string") out.push(v);
    else out.push(...idsIn(v));
  }
  return out;
}
