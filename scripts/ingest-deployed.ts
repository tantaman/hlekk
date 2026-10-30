// The same low-scale Wikimedia ingest as `ingest-local.ts`, against a real Cloudflare deployment.
//
//   npm run ingest:deployed -- --base https://hlekk-wiki.tantaman.workers.dev --pages 10000
//
// WHY BOTH. `ingest-local.ts` stands the whole cluster up in one process over real SQLite, so
// everything above the transport is the code a deployment runs — which is why it could establish
// that the schema, the record shape and the title entry point are right. What it could not touch is
// the transport itself. This script changes exactly that one thing: every mutation and every read
// now crosses a real RPC boundary to a real Durable Object, the shard map is read from real KV, and
// the hosts are tens of separate Durable Objects in Cloudflare's network rather than tables in one
// process. The checks are deliberately the same, so a difference in a result is a difference in the
// deployment and not in what was asked.
//
// WHAT IT STILL IS NOT. Not the loader wikimedia-demo.md asks for. It writes one mutation per row
// through the ordinary client — `createUnique` is five DO calls per page and `assocAdd` is one per
// edge — so the throughput it reports is the ordinary write path's over a network, which is the
// figure the build plan owed, and *not* a claim about loading 300 GB. The chunked snapshot that a
// real load needs is still untouched.
//
// Both passes are idempotent, so a run that dies partway can simply be run again: a title already
// taken resolves to the id holding it, and an edge write is `ON CONFLICT DO UPDATE` whose count is
// bumped only when the edge is new.

import { selectSubset } from "./wiki-subset.ts";
import type { Rec } from "./wiki-subset.ts";
import { vshardOf } from "../src/host/ids.ts";
import { categoryPages, linkedFrom, pageCategories, pageLinks } from "../src/worker/wiki.ts";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);

/** A positive integer argument, refused rather than coerced. `Number("16 48 2000")` is NaN, a NaN
 *  batch size makes a worker pool of NaN workers, and a pool of NaN workers processes nothing and
 *  reports success — which is a worse way to find out than being told. */
function count(name: string, fallback: number): number {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer, got ${raw}`);
  return value;
}

const BASE = (args.get("base") ?? "").replace(/\/$/, "");
if (!BASE) throw new Error("--base is required, e.g. --base https://hlekk-wiki.tantaman.workers.dev");
const PAGES = count("pages", 2000);
const WORK = args.get("work") ?? ".wrangler/import-simplewiki-20261001";
/** Pages per request. Each costs five DO calls, so this is the subrequest budget divided by five. */
const PAGE_BATCH = count("pageBatch", 150);
/** Edges per request, one DO call each. */
const EDGE_BATCH = count("edgeBatch", 1000);
/** Requests the driver keeps in flight. */
const INFLIGHT = count("inflight", 48);
/** Mutations the Worker keeps in flight within one request. */
const CONCURRENCY = count("concurrency", 12);
/**
 * Pass A's own concurrency, which has to be far lower than pass B's, and not by taste.
 *
 * An edge write goes to its page's host, so pass B spreads over every host the pages landed on — 43
 * here. A `createUnique` writes through the *index* vshard its title hashes to, and there are four
 * of those in the whole database, so every page in pass A funnels through four Durable Objects. A
 * Durable Object is single-threaded, so the two passes have completely different ceilings: at pass
 * B's settings pass A queued hundreds deep on each index vshard and the platform refused with
 * `Durable Object is overloaded. Requests queued for too long.`
 *
 * This is the pilot's most load-bearing finding for the real load, and it is a capacity decision
 * taken at `init`: `indexVshards` is fixed when the directory first opens and cannot be raised
 * afterwards.
 */
const PAGE_INFLIGHT = count("pageInflight", 12);
const PAGE_CONCURRENCY = count("pageConcurrency", 8);
/** How many titles to check by lookup. Every page is covered by the object count; a sample is what
 *  gets checked through the index, since that is the part a count cannot see. */
const SAMPLE = count("sample", 300);
const LIMIT = count("limit", 25);

const started = Date.now();
const log = (...m: unknown[]) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...m);
const checks: { ok: boolean; name: string; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ ok, name, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail === undefined ? "" : `  (${detail})`}`);
};
const n = (x: number) => x.toLocaleString();

// ---- talking to the deployment

/** One request, retried on a network error or a 5xx. The far side is on the public internet and a
 *  pilot is thousands of requests long, so a transient failure is expected rather than exceptional;
 *  both passes are idempotent, which is what makes retrying safe rather than double-counting. */
async function hit<T>(path: string, body?: unknown, tries = 4): Promise<T> {
  let last: Error | null = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: body === undefined ? "GET" : "POST",
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
      return JSON.parse(text) as T;
    } catch (e) {
      last = e instanceof Error ? e : new Error(String(e));
      if (attempt === tries) break;
      await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`${path}: ${last?.message}`);
}

/** Runs `f` over `items` with at most `limit` in flight. */
async function pooled<T, R>(items: readonly T[], limit: number, f: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await f(items[i], i);
      }
    }),
  );
  return out;
}

const batches = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

// ---- the subset, selected exactly as the in-process run selects it

const { subset, kept, dropped } = await selectSubset({
  work: WORK,
  pages: PAGES,
  window: args.has("window") ? Number(args.get("window")) : undefined,
});
log(
  `${n(subset.size)} pages, ${n(kept)} edges inside the subset, ` +
    `${n(dropped)} pointing outside it (${((dropped / (kept + dropped)) * 100).toFixed(1)}%)`,
);

// ---- what is there before the load

interface Where {
  database: string;
  catalog: number;
  mapVersion: number;
  indexVshards: string[];
  inFlight: number;
  hosts: { host: number; vshards: number; objects: number; pending: number }[];
}
interface Size {
  hosts: number;
  total: number;
  nonEmpty: number;
  bytes: number[];
}

const health = await hit<{ ok: boolean; database: string; vshards: string | null }>("/health");
const before = await hit<Where>("/admin/where");
if (before.catalog === 0) throw new Error("the database is not laid out; GET /admin/init first");
/** The hosts the directory actually created, which `/admin/size` also measures over. */
const HOSTS = before.hosts.length;
const baseline = await hit<Size>("/admin/size");
/** Objects already in the database. Only a run against an empty one can read the storage multiplier
 *  off `databaseSize`, so this decides whether the figure below is that or merely a delta. */
const baselineObjects = before.hosts.reduce((s, h) => s + h.objects, 0);
log(
  `deployment: database ${health.database}, catalog ${before.catalog}, ${before.hosts.length} hosts, ` +
    `${before.hosts.reduce((s, h) => s + h.vshards, 0)} vshards, ${before.indexVshards.length} index vshards`,
);
log(
  `baseline: ${n(before.hosts.reduce((s, h) => s + h.objects, 0))} objects, ` +
    `${n(baseline.total)} bytes over ${HOSTS} hosts`,
);

// ---- pass A: the pages, each through the global unique index on title

const pageBatches = batches([...subset.values()], PAGE_BATCH);
const idOf = new Map<string, string>();
let existed = 0;
const passAStarted = Date.now();
let donePages = 0;
let retriedPages = 0;
await pooled(pageBatches, PAGE_INFLIGHT, async (batch) => {
  // Retry the items that failed, not the batch. An overloaded index vshard refuses some of a
  // batch and accepts the rest, and a load that gives up on the whole run for that is a load that
  // cannot be completed — wikimedia-demo.md puts resumability above throughput for exactly this.
  // Safe because the pass is idempotent: a title already taken resolves to the id holding it.
  let todo = batch;
  for (let attempt = 1; ; attempt++) {
    const reply = await hit<{
      ids: Record<string, string>;
      existed: number;
      failed: number;
      failedKeys: string[];
      failures: unknown[];
    }>("/ingest/pages", {
      pages: todo.map((r) => ({ key: r.key, affinity: r.affinity, fields: r.fields })),
      concurrency: PAGE_CONCURRENCY,
    });
    for (const [key, id] of Object.entries(reply.ids)) idOf.set(key, id);
    existed += reply.existed;
    if (reply.failed === 0) break;
    if (attempt >= 6) {
      throw new Error(`/ingest/pages: ${reply.failed} still failing after ${attempt} attempts, e.g. ${JSON.stringify(reply.failures[0])}`);
    }
    const again = new Set(reply.failedKeys);
    todo = todo.filter((r) => again.has(r.key));
    retriedPages += todo.length;
    await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
  }
  donePages += batch.length;
  if (donePages % (PAGE_BATCH * PAGE_INFLIGHT * 4) < PAGE_BATCH) {
    log(`  pass A: ${n(donePages)}/${n(subset.size)} pages, ${(donePages / ((Date.now() - passAStarted) / 1000)).toFixed(0)}/s`);
  }
});
const passAMs = Date.now() - passAStarted;
log(
  `pass A: ${n(idOf.size)} pages in ${(passAMs / 1000).toFixed(1)}s ` +
    `(${(idOf.size / (passAMs / 1000)).toFixed(0)} pages/s, ${existed} already present, ${retriedPages} retried)`,
);

// ---- pass B: both directions of both relations, as the import emitted them

/** Every writable edge, with both ends resolved to the ids pass A minted. */
const edges: [string, string, string, number][] = [];
for (const rec of subset.values()) {
  const from = idOf.get(rec.key)!;
  for (const e of rec.edges) edges.push([e.type, from, idOf.get(e.to)!, e.time ?? 0]);
}

/**
 * Grouped by host and sorted by key, which is what makes the load survive its own size.
 *
 * An edge is routed by `id1`, so every edge of one page lands on that page's host. The first version
 * of this script shuffled the whole list, reasoning that a batch taken in record order is one page
 * on one Durable Object and a Durable Object is single-threaded. That got parallelism and paid for
 * it twice. Measured: throughput held at ~970 edge writes/s and then one host refused with `Durable
 * Object is overloaded. Requests queued for too long.` at about 2 million edges, and no number of
 * retries cleared it.
 *
 * The reason is the index, not the queue. `assocs` is keyed `(id1, atype, id2)`, so a shuffled
 * insert lands at a random point in its host's B-tree. While a host holds 3,700 rows that tree is
 * entirely in cache and the write is free; at 46,000 rows and climbing it is not, and every insert
 * dirties a different page. Per-host throughput fell from ~101 writes/s to ~23 as the tables grew,
 * the queue grew with it, and the platform eventually refused.
 *
 * So each batch is one host's edges in key order — sequential appends into one tree — and the
 * parallelism comes from working every host at once with at most one batch in flight per host, so
 * no Durable Object ever queues deeply. This is the shape docs/wikimedia-demo.md already prescribes
 * for the real loader: batch per `(host, vshard)`, a vshard being one contiguous key range.
 *
 * Grouping by host is sound here only because nothing moves: the demo keeps every vshard at epoch 0,
 * so a vshard's host is fixed for the run. Under a live placement controller this map would be a
 * cache and a refused write would mean re-grouping.
 */
const vshardKey = (id: string) => vshardOf(id).toString();
const byVshard = new Map<string, [string, string, string, number][]>();
for (const e of edges) {
  const v = vshardKey(e[1]);
  const held = byVshard.get(v);
  if (held) held.push(e);
  else byVshard.set(v, [e]);
}
// One representative id per vshard is enough to learn where that vshard lives, and the whole map
// costs one request rather than one per edge.
const reps = [...byVshard].map(([v, list]) => ({ vshard: v, id: list[0][1] }));
const routed = await hit<{ hosts: Record<string, number | null> }>(
  `/admin/route?ids=${reps.map((r) => r.id).join(",")}`,
);
const hostOfVshard = new Map<string, number>();
for (const r of reps) {
  const host = routed.hosts[r.id];
  if (host === null || host === undefined) throw new Error(`no route for vshard ${r.vshard}`);
  hostOfVshard.set(r.vshard, host);
}

const byHost = new Map<number, [string, string, string, number][]>();
for (const [v, list] of byVshard) {
  const host = hostOfVshard.get(v)!;
  let held = byHost.get(host);
  if (!held) byHost.set(host, (held = []));
  // Appended one at a time. `held.push(...list)` passes every edge as a separate argument, and a
  // vshard here holds tens of thousands of them — `RangeError: Maximum call stack size exceeded`,
  // which is a spread of a large array and not a recursion.
  for (const e of list) held.push(e);
}
byVshard.clear();
// Key order, the order the table is stored in: id1, then atype, then id2. Ids are decimal strings
// of unequal length, so they compare as BigInt rather than as text.
for (const list of byHost.values()) {
  list.sort((a, b) => {
    const i1 = BigInt(a[1]) - BigInt(b[1]);
    if (i1 !== 0n) return i1 < 0n ? -1 : 1;
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    const i2 = BigInt(a[2]) - BigInt(b[2]);
    return i2 === 0n ? 0 : i2 < 0n ? -1 : 1;
  });
}
log(
  `pass B: ${n(edges.length)} edges grouped onto ${byHost.size} hosts ` +
    `(largest ${n(Math.max(...[...byHost.values()].map((l) => l.length)))}), sorted in key order`,
);

const passBStarted = Date.now();
let written = 0;
let doneEdges = 0;
let retriedEdges = 0;
// Every host at once, one batch in flight each: the DOs work in parallel and none of them queues.
await pooled([...byHost.entries()], Math.min(INFLIGHT, byHost.size), async ([, list]) => {
  for (const batch of batches(list, EDGE_BATCH)) {
    let todo = batch;
    for (let attempt = 1; ; attempt++) {
      const reply = await hit<{ written: number; failed: number; failedIndexes: number[]; failures: unknown[] }>(
        "/ingest/edges",
        { edges: todo, concurrency: CONCURRENCY },
      );
      written += reply.written;
      if (reply.failed === 0) break;
      if (attempt >= 8) {
        throw new Error(
          `/ingest/edges: ${reply.failed} still failing after ${attempt} attempts, e.g. ${JSON.stringify(reply.failures[0])}`,
        );
      }
      todo = reply.failedIndexes.map((i) => todo[i]);
      retriedEdges += todo.length;
      // Long enough to outlast an overloaded object draining its queue, which 12 s did not.
      await new Promise((r) => setTimeout(r, Math.min(15_000, 500 * 2 ** (attempt - 1))));
    }
    doneEdges += batch.length;
    if (doneEdges % (EDGE_BATCH * 64) < EDGE_BATCH) {
      log(`  pass B: ${n(doneEdges)}/${n(edges.length)} edges, ${(doneEdges / ((Date.now() - passBStarted) / 1000)).toFixed(0)}/s`);
    }
  }
});
const passBMs = Date.now() - passBStarted;
const edgeRate = written / (passBMs / 1000);
log(
  `pass B: ${n(written)} edges in ${(passBMs / 1000).toFixed(1)}s ` +
    `(${edgeRate.toFixed(0)} edge writes/s, ${retriedEdges} retried)`,
);

// ---- did it work?

check("every edge the import emitted was written", written === kept, `${n(written)} of ${n(kept)}`);

const after = await hit<Where>("/admin/where");
const pending = after.hosts.reduce((s, h) => s + h.pending, 0);
check("no outbox op was needed, because no edge type is a pair", pending === 0, `${pending} queued`);

const occupied = after.hosts.filter((h) => h.objects > 0);
check(
  "the pages spread across many hosts",
  occupied.length > after.hosts.length / 2,
  `${occupied.length} of ${after.hosts.length} hosts hold pages`,
);

const objects = after.hosts.reduce((s, h) => s + h.objects, 0);
check("every page is stored exactly once", objects === subset.size, `${n(objects)} objects for ${n(subset.size)} pages`);

// Entry by title is the demo's only way in. Every page is covered by the object count above; this
// checks that the index can reach a sample of them, which the count cannot see.
const sample = [...subset.values()].slice(0, SAMPLE);
let found = 0;
let wrong = 0;
await pooled(batches(sample, 50), INFLIGHT, async (batch) => {
  const reply = await hit<{ ids: Record<string, string | null>; errors: number }>(
    `/lookup?titles=${batch.map((r) => encodeURIComponent(`${r.fields.ns}:${r.fields.title}`)).join("|")}`,
  );
  for (const r of batch) {
    const id = reply.ids[`${r.fields.ns}:${r.fields.title}`];
    if (id === null || id === undefined) continue;
    found++;
    if (id !== idOf.get(r.key)) wrong++;
  }
});
check(
  "every sampled page is findable by (ns, title)",
  found === sample.length && wrong === 0,
  `${found} of ${sample.length} found, ${wrong} wrong`,
);

// The exact-count oracle: a maintained counter against the degree the records say it has.
const expected = (rec: Rec, type: string) => rec.edges.filter((e) => e.type === type).length;
const busiest = [...subset.values()].sort((a, b) => b.edges.length - a.edges.length).slice(0, 25);
const countReply = await hit<{
  counts: Record<string, { links: number; backlinks: number; cats: number; members: number }>;
}>(`/counts?ids=${busiest.map((r) => idOf.get(r.key)!).join(",")}`);
let countsAgree = 0;
const degrees: string[] = [];
for (const rec of busiest) {
  const row = countReply.counts[idOf.get(rec.key)!];
  const ok =
    row !== undefined &&
    row.links === expected(rec, pageLinks.name) &&
    row.backlinks === expected(rec, linkedFrom.name) &&
    row.cats === expected(rec, pageCategories.name) &&
    row.members === expected(rec, categoryPages.name);
  if (ok) countsAgree++;
  if (degrees.length < 3 && row) degrees.push(`${rec.fields.title}: ${row.links}/${row.backlinks}`);
}
check(
  "every maintained count equals the degree the records say",
  countsAgree === busiest.length,
  `${countsAgree}/${busiest.length} pages checked, e.g. ${degrees.join(", ")}`,
);

// ---- and the read the demo is for

const top = busiest[0];
interface Card {
  found: boolean;
  id: string;
  page: {
    title: string;
    linkCount: number;
    backlinkCount: number;
    links: { id: string; title: string }[];
    categories: { id: string; title: string }[];
  };
  read: { rounds: number; requests: number; ms: number; lookupMs: number; objects: number; hosts: number[] };
}
const card = await hit<Card>(`/page?ns=${top.fields.ns}&title=${encodeURIComponent(top.fields.title)}&limit=${LIMIT}`);
check(
  "a page card reads a real page across hosts",
  card.found &&
    card.page.title === top.fields.title &&
    card.page.links.length > 0 &&
    card.page.links.every((l) => typeof l.title === "string"),
  `${card.page.title}: ${card.page.linkCount} links, ${card.page.backlinkCount} backlinks, ` +
    `${card.page.links.length} shown from ${card.read.hosts.length} host(s), ` +
    `${card.read.requests} host requests, ${card.read.rounds} rounds, ${card.read.ms}ms ` +
    `(+${card.read.lookupMs}ms title lookup)`,
);
check(
  "a limit is honoured against the real list",
  card.page.links.length === Math.min(LIMIT, expected(top, pageLinks.name)),
  `${card.page.links.length} of ${expected(top, pageLinks.name)}, limit ${LIMIT}`,
);

// ---- what it cost on disk, which is the figure the import doc leaves open

const size = await hit<Size>("/admin/size");
const grew = size.total - baseline.total;
// What the rows would weigh if storage were only their payloads: ~90 B per page object, ~57 B per
// edge, ~60 B per title index entry, as docs/wikimedia-import.md costs them. That doc puts the real
// multiplier between 1.05x and 4.7x and says only a pilot's databaseSize settles which.
const arithmetic = subset.size * 90 + written * 57 + subset.size * 60;
const created = subset.size - existed;

/**
 * What a host DO's SQLite weighs with the schema in place and nothing stored, measured on 43
 * deployed hosts. It is the floor the loaded bytes are counted from, and it is *not* the 40,960 the
 * same thing weighs on local workerd — a 10% difference that matters here only because the figure
 * below is a ratio, and mattered in wrangler.app.jsonc because a shed threshold was set between the
 * two.
 */
const EMPTY_HOST_BYTES = 45_056;
/** The bytes this pilot's data occupies, counted from the empty floor rather than from whatever the
 *  database held when this run started. That makes the multiplier readable after a resumed load,
 *  which a delta against a mid-load baseline is not. */
const loaded = size.total - HOSTS * EMPTY_HOST_BYTES;
if (created === 0 && grew === 0) {
  console.log(`info  every page was already present and nothing grew, so this run added nothing`);
}
check(
  "the stored bytes are within a sane multiple of the payload arithmetic",
  loaded > 0 && loaded / arithmetic > 0.5 && loaded / arithmetic < 6,
  `${n(loaded)} bytes of data over ${size.nonEmpty} hosts, ` +
    `${(loaded / arithmetic).toFixed(2)}x the ~${n(arithmetic)} bytes of payload arithmetic` +
    `${created === 0 ? "" : `; ${n(grew)} of it added by this run`}`,
);

const passed = checks.filter((x) => x.ok).length;
console.log(
  `\n${passed}/${checks.length} checks against ${n(subset.size)} real pages and ${n(written)} edges ` +
    `on ${occupied.length} deployed hosts`,
);
console.log(
  `throughput: ${(idOf.size / (passAMs / 1000)).toFixed(0)} pages/s through 4 index vshards, ` +
    `${edgeRate.toFixed(0)} edge writes/s across ${occupied.length} hosts ` +
    `(pages: batch ${PAGE_BATCH} x ${PAGE_INFLIGHT} inflight x ${PAGE_CONCURRENCY} concurrent; ` +
    `edges: batch ${EDGE_BATCH} x ${INFLIGHT} inflight x ${CONCURRENCY} concurrent; ` +
    `${retriedPages + retriedEdges} items retried)`,
);
console.log(
  `storage: ${n(size.total)} bytes total, ${n(HOSTS * EMPTY_HOST_BYTES)} of it empty schema, ` +
    `${n(loaded)} of data — ${(loaded / Math.max(1, subset.size + written)).toFixed(1)} bytes per row ` +
    `over ${n(subset.size)} pages and ${n(written)} edges, ${(loaded / arithmetic).toFixed(2)}x arithmetic`,
);
process.exit(passed === checks.length ? 0 : 1);
