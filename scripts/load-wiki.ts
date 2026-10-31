// Loading a whole wiki into a deployed hlekk cluster, as a stream.
//
//   node scripts/load-wiki.ts --base https://hlekk-wiki.tantaman.workers.dev
//
// WHY THIS EXISTS, given `ingest-deployed.ts`. That script proves a deployment at low scale in
// minutes and is kept for exactly that, but it cannot load a wiki, and the three reasons are all in
// `selectSubset`: it scans at most 200,000 distinct keys and then stops, it drops every edge whose
// target falls outside the subset, and it holds the whole subset in memory as a `Map`. Each is the
// right choice for a subset and the wrong one for a full load. This script replaces them with the
// shape docs/wikimedia-demo.md asks for and changes nothing else: the record stream straight
// through, two passes, batched per (host, vshard) in key order, resumable.
//
// WHAT IT DOES NOT DO. It still writes through the ordinary mutation path — `createUnique` per page,
// `assocAddMany` per batch of edges — so it is not the chunked snapshot, and at enwiki scale the
// snapshot is still the answer. What it is, is the loader that makes a 950,421-page wiki reachable
// without one, which is what the demo needs and what nothing here could do before.
//
// THE FOUR THINGS THAT MAKE IT WORK, each of them measured rather than guessed (the figures are in
// docs/wikimedia-import.md and docs/next-session.md):
//
// 1. STREAM, NEVER MATERIALIZE. `records()` is an async generator over the merged intermediates and
//    is the seam the demo doc specifies. The only thing held for the whole run is the
//    `page_id -> hlekk id` map, which pass B cannot avoid because an edge names its target by page
//    id and only pass A knows what id that page got.
//
// 2. TWO PASSES. Ids must exist before an edge can reference one. The alternative buffers 1.78
//    billion unresolved references.
//
// 3. BATCH PER (HOST, VSHARD), IN KEY ORDER, ONE BATCH IN FLIGHT PER HOST. `assocs` is keyed
//    `(id1, atype, id2)`, so a shuffled insert lands at a random point in its host's B-tree: that
//    collapsed to ~23 writes/s per host as the tables grew and the platform eventually refused
//    outright. Grouped in key order it reached ~6,300/s. A vshard is one contiguous key range, so a
//    batch holding one vshard's edges is a run of sequential appends into one tree, and
//    `assocAddMany` turns it into one transaction. Parallelism comes from working every host at
//    once, never from several batches at one host, because a Durable Object is single-threaded.
//
// 4. FOLD CONTINUATION RECORDS. A page whose edge list exceeded the importer's cap arrives as
//    several records repeating the same key with `more: true`. Treating a repeat as a second page
//    both loses edges and double-counts the page.
//
// AND IT IS RESUMABLE, because hours of ingest will be interrupted. Both passes are idempotent by
// construction — `createUnique` resolves an already-taken title to the id holding it, and an edge
// write is an upsert whose count moves only for a new edge — so the only thing missing was a record
// of where the run had got to. Pass A appends every `key -> id` it mints to a checkpoint, which is
// also what pass B reads its map from. Pass B checkpoints a watermark: a page key below which every
// edge has been acknowledged, held back by anything still buffered or in flight, so a resume can
// only ever redo work and never skip it.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { records } from "./import-enwiki.mjs";
import { RESERVATION_TTL_MS } from "../src/client/client.ts";
import { makeId, vshardOf } from "../src/host/ids.ts";
import type { Id } from "../src/query/types.ts";

/** A record as the importer emits it. `more` marks a continuation: the same page, more edges. */
interface Rec {
  key: string;
  affinity: string;
  fields: { ns: number; title: string; redirect: boolean; len: number; extract?: string };
  edges: { type: string; to: string; time?: number }[];
  more?: boolean;
}

/** An edge with both ends resolved: `[type, from, to, time]`, the tuple `/ingest/edges` takes. */
type Edge = [string, Id, Id, number];

/** One unit of work for a host: one vshard's edges, in key order, plus the oldest page key that
 *  contributed to it — which is what holds the resume watermark back until this lands. */
interface Batch {
  edges: Edge[];
  minKey: string;
}

// ---- arguments

/**
 * Arguments, with boolean flags that do not eat the next one.
 *
 * The obvious loop — step two at a time, name then value — is wrong the moment a flag like `--fresh`
 * carries no value: everything after it shifts by one, so `--fresh --affinity hash` sets `fresh` to
 * `"--affinity"` and leaves `affinity` unset at its default. Nothing complains, the run does
 * something reasonable, and the number it reports is for a configuration nobody chose. That cost a
 * measurement here — a run meant to load the hash placement loaded the category one instead — which
 * is the same failure `count()` below refuses for NaN, one level up.
 *
 * So: a token is a value only if it does not itself look like a flag, and an unknown name is refused
 * rather than ignored, because a silently misspelled flag is the same bug wearing a different hat.
 */
const KNOWN = new Set([
  "base", "work", "affinity", "pass", "placement", "pages", "checkpoint", "fresh",
  "pageBatch", "pageInflight", "pageConcurrency", "pageAttempts",
  "edgeBatch", "inflight", "maxQueued", "flushEvery", "sample", "degreeSample",
]);
const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; ) {
  const token = process.argv[i];
  if (!token.startsWith("--")) throw new Error(`expected a --flag, got ${JSON.stringify(token)}`);
  const name = token.slice(2);
  if (!KNOWN.has(name)) {
    throw new Error(`unknown flag --${name}; known: ${[...KNOWN].sort().join(", ")}`);
  }
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) {
    args.set(name, "");
    i += 1;
  } else {
    args.set(name, next);
    i += 2;
  }
}

/** A positive integer argument, refused rather than coerced, for the reason ingest-deployed.ts gives:
 *  a NaN pool size processes nothing and reports success. */
function count(name: string, fallback: number): number {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (raw === "" || !Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const BASE = (args.get("base") ?? "").replace(/\/$/, "");
if (!BASE) throw new Error("--base is required, e.g. --base https://hlekk-wiki.tantaman.workers.dev");
const text = (name: string, fallback: string): string => {
  const raw = args.get(name);
  if (raw === undefined) return fallback;
  if (raw === "") throw new Error(`--${name} needs a value`);
  return raw;
};
const WORK = text("work", ".wrangler/import-simplewiki-20261001");
/** Which placement to load under. The affinity mode is applied when a record is *read*, not when the
 *  wiki was imported, so the A/B control needs no re-import — only a different database. */
const AFFINITY = text("affinity", "category");
/** Which of the deployment's two databases to load. The Worker serves both so the demo can compare
 *  them, and the alias is appended to every path rather than baked into --base, which would put a
 *  query string in the middle of every URL. */
const PLACEMENT = text("placement", "");
const at = (path: string): string =>
  PLACEMENT === "" ? path : `${path}${path.includes("?") ? "&" : "?"}placement=${encodeURIComponent(PLACEMENT)}`;
const PASS = text("pass", "AB").toUpperCase();
if (!["A", "B", "AB"].includes(PASS)) throw new Error(`--pass must be A, B or AB, got ${args.get("pass")}`);
/** Stop after this many distinct pages. For probing a setting, not for a load. */
const PAGES = args.has("pages") ? count("pages", 0) : Infinity;

/** Pages per request. Each is five DO calls, and the paid plan allows 10,000 subrequests. */
const PAGE_BATCH = count("pageBatch", 150);
/** Page requests in flight. Pass A's ceiling is the index vshard count, not the host count: a
 *  `createUnique` writes through the one index vshard its title hashes to. See --indexVshards on
 *  /admin/init, which is fixed for the life of the database. */
const PAGE_INFLIGHT = count("pageInflight", 12);
/** Mutations the Worker keeps in flight inside one page request. */
const PAGE_CONCURRENCY = count("pageConcurrency", 8);
/** Edges per batch, and — deliberately the same number — the cap on edges in one record, so that
 *  flushing a whole buffer can never produce a batch larger than twice this. */
const EDGE_BATCH = count("edgeBatch", 1000);
/** Edge requests in flight across all hosts. Per host it is always exactly one. */
const INFLIGHT = count("inflight", 64);
/** Batches allowed to sit in the host queues before the producer stops reading. Backpressure: the
 *  stream produces faster than the network drains, and without this the queues are the whole wiki. */
const MAX_QUEUED = count("maxQueued", 256);
/**
 * How far, in pages, a buffer is allowed to hold the resume watermark back.
 *
 * Measured, not chosen: a 20,000-page run read to page 19,673 with the watermark still at page 5,
 * because one vshard's buffer took an early page and then filled too slowly to flush. The watermark
 * is deliberately conservative, so that run would have resumed from the very beginning.
 *
 * Every this many pages the open buffers are swept and the ones lagging by more than this are
 * flushed, which bounds the lag at about twice it. Only the stale ones: a buffer that flushed
 * recently is already holding nothing back, and flushing all hundred-odd of them on every sweep
 * would trade a tenth of the run's requests for nothing.
 */
const FLUSH_EVERY = count("flushEvery", 25_000);
/**
 * Pass A's retry window, which has to outlast a reservation rather than merely a blip.
 *
 * `createUnique` reserves the title, creates the object, then confirms. If a batch's response is
 * lost *after* the reservations are taken — a timeout, a 5xx, anything that makes `hit` send the
 * batch again — the retry meets its own predecessor's reservations, and an unconfirmed reservation is
 * the one state `lookupUnique` cannot resolve: there is no id to hand back yet, so the Worker rethrows
 * `ValueTaken: already taken by a reservation in flight`. Nothing can clear that but the reservation
 * lapsing, so the retries have to be willing to wait longer than one lives.
 *
 * This is not hypothetical. A 12.4 s window against a 30 s TTL killed a load 290,400 pages in, on a
 * title that appears exactly once in the dump — the collision was the loader meeting itself, not two
 * pages colliding. The check below is why the window cannot quietly fall back under the TTL.
 */
const PAGE_ATTEMPTS = count("pageAttempts", 8);
const pageBackoff = (attempt: number) => Math.min(15_000, 800 * 2 ** (attempt - 1));
const pageRetryWindow = Array.from({ length: PAGE_ATTEMPTS - 1 }, (_, i) => pageBackoff(i + 1)).reduce(
  (a, b) => a + b,
  0,
);
if (pageRetryWindow <= RESERVATION_TTL_MS) {
  throw new Error(
    `pass A would give up after ${pageRetryWindow}ms, which is not longer than the ` +
      `${RESERVATION_TTL_MS}ms reservation TTL; raise --pageAttempts`,
  );
}

/** How many titles to check by lookup afterwards. */
const SAMPLE = count("sample", 200);
/** How many pages' maintained counts to check against the degree the records say. */
const DEGREE_SAMPLE = count("degreeSample", 25);

const started = Date.now();
const since = () => (Date.now() - started) / 1000;
const log = (...m: unknown[]) => console.log(`[${since().toFixed(1)}s]`, ...m);
const n = (x: number) => x.toLocaleString();
const checks: { ok: boolean; name: string; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ ok, name, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail === undefined ? "" : `  (${detail})`}`);
};
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

// ---- talking to the deployment

/** One request, retried on a network error or a 5xx, with a deadline. The far side is on the public
 *  internet and a load is tens of thousands of requests long, so a transient failure is expected
 *  rather than exceptional; both passes are idempotent, which is what makes retrying safe. The
 *  deadline matters more here than in a short pilot: without one a single stalled socket parks a
 *  host's worker for the rest of the run, and that host simply stops being loaded. */
async function hit<T>(path: string, body?: unknown, tries = 5): Promise<T> {
  let last: Error | null = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(`${BASE}${at(path)}`, {
        method: body === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(180_000),
        ...(body === undefined
          ? {}
          : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
      return JSON.parse(text) as T;
    } catch (e) {
      last = asError(e);
      if (attempt === tries) break;
      await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
    }
  }
  throw new Error(`${path}: ${last?.message}`);
}

/** Runs `f` over an async iterable with at most `limit` in flight, without materializing it.
 *
 *  Concurrent `next()` on one async generator is well defined — the generator queues the requests
 *  and each caller gets a distinct value — which is what lets several workers share one file reader
 *  with no buffer between them. */
async function streamPooled<T>(items: AsyncIterable<T>, limit: number, f: (item: T) => Promise<void>): Promise<void> {
  const it = items[Symbol.asyncIterator]();
  let failure: Error | null = null;
  await Promise.all(
    Array.from({ length: Math.max(1, limit) }, async () => {
      for (;;) {
        if (failure) return;
        const next = await it.next();
        if (next.done) return;
        try {
          await f(next.value);
        } catch (e) {
          failure ??= asError(e);
          return;
        }
      }
    }),
  );
  if (failure) throw failure;
}

/** Gathers an async iterable into arrays of `size`. */
async function* batched<T>(items: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  let batch: T[] = [];
  for await (const item of items) {
    batch.push(item);
    if (batch.length >= size) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

/** A counting semaphore. A released slot is handed straight to a waiter rather than decremented and
 *  re-acquired, so the ceiling cannot be briefly exceeded by a caller arriving in between. */
function semaphore(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    acquire(): Promise<void> {
      if (active < limit) {
        active++;
        return Promise.resolve();
      }
      return new Promise<void>((r) => waiting.push(r));
    },
    release(): void {
      const next = waiting.shift();
      if (next) next();
      else active--;
    },
  };
}

/**
 * Compares two decimal id strings numerically, without BigInt.
 *
 * Exact for non-negative integers with no leading zeros: a shorter string is the smaller number, and
 * at equal length the lexicographic order *is* the numeric order. This is the hot comparator — the
 * BigInt version ingest-deployed.ts uses would allocate two BigInts per comparison, and sorting 42.8
 * million edges a thousand at a time is hundreds of millions of comparisons.
 */
const cmpNum = (a: string, b: string): number =>
  a.length !== b.length ? a.length - b.length : a < b ? -1 : a > b ? 1 : 0;

/** Key order, which is storage order: id1, then atype, then id2. */
const inKeyOrder = (list: Edge[]): Edge[] =>
  list.sort((x, y) => cmpNum(x[1], y[1]) || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0) || cmpNum(x[2], y[2]));

// ---- what we are loading into

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
const HOSTS = before.hosts.length;
const DATA_VSHARDS = Number(health.vshards ?? 128);
log(
  `deployment: database ${health.database}, catalog ${before.catalog}, ${HOSTS} hosts, ` +
    `${DATA_VSHARDS} data vshards, ${before.indexVshards.length} index vshards`,
);
log(
  `loading ${WORK} with affinity=${AFFINITY}, pass ${PASS}` +
    `${PLACEMENT === "" ? "" : `, placement ${PLACEMENT}`}${PAGES === Infinity ? "" : `, first ${n(PAGES)} pages`}`,
);

/** Checkpoints are named after the database, not the wiki. The ids in them are the ids *that*
 *  database minted, so pointing a second database at the first one's map would write edges between
 *  ids that do not exist in it. The A/B control is a second database, so this is not hypothetical. */
const slug = health.database.replace(/[^a-zA-Z0-9._-]/g, "_");
const IDS_FILE = args.get("checkpoint") ?? `${WORK}/ids-${slug}.tsv`;
const POS_FILE = `${WORK}/edges-${slug}.pos`;
mkdirSync(dirname(IDS_FILE), { recursive: true });
if (args.has("fresh")) {
  rmSync(IDS_FILE, { force: true });
  rmSync(POS_FILE, { force: true });
  log(`--fresh: cleared ${IDS_FILE} and ${POS_FILE}`);
}

// ---- the page_id -> hlekk id map, which both passes need and only pass A can mint

const ids = new Map<string, Id>();
if (existsSync(IDS_FILE)) {
  const text = readFileSync(IDS_FILE, "utf8");
  let lines = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    ids.set(line.slice(0, tab), line.slice(tab + 1));
    lines++;
  }
  log(`checkpoint: ${n(ids.size)} ids already minted (${n(lines)} lines in ${IDS_FILE})`);
}

/** (ns, title) for the first few pages the stream offers, so the title index can be checked
 *  afterwards. Captured in passing: the ids map is keyed by page id and holds no titles, and
 *  re-reading the record stream a third time to recover a couple of hundred of them would read
 *  1.44 GB of edges to do it. */
const sampleTitles = new Map<string, { ns: number; title: string }>();
const noteTitle = (r: Rec) => {
  if (sampleTitles.size < SAMPLE && !sampleTitles.has(r.key)) {
    sampleTitles.set(r.key, { ns: r.fields.ns, title: r.fields.title });
  }
};

/** One record per page, continuations folded away: pass A needs each page exactly once, and a
 *  continuation repeats a key it has already seen. The repeats are consecutive, so comparing with
 *  the previous key is enough and nothing has to be remembered. */
async function* distinctPages(): AsyncGenerator<Rec> {
  let last: string | null = null;
  let seen = 0;
  for await (const r of records({ work: WORK, affinity: AFFINITY, maxEdges: EDGE_BATCH }) as AsyncIterable<Rec>) {
    if (r.key === last) continue;
    last = r.key;
    if (++seen > PAGES) return;
    noteTitle(r);
    yield r;
  }
}

// ---- pass A: the pages, each through the global unique index on title

let pagesMinted = 0;
let pagesExisted = 0;
let pagesSkipped = 0;
let pagesRetried = 0;
let passAMs = 0;

if (PASS.includes("A")) {
  const passAStarted = Date.now();
  let done = 0;
  /** Only the pages this run still has to mint. A resumed run skips what the checkpoint already
   *  holds, which is the difference between resuming and starting again — the writes would be
   *  harmless either way, but an hour of them is not. */
  async function* todo(): AsyncGenerator<Rec> {
    for await (const r of distinctPages()) {
      if (ids.has(r.key)) {
        pagesSkipped++;
        continue;
      }
      yield r;
    }
  }

  await streamPooled(batched(todo(), PAGE_BATCH), PAGE_INFLIGHT, async (batch) => {
    // Retry the items that failed, not the batch. An overloaded index vshard refuses some of a batch
    // and accepts the rest, and a load that abandons the run for that is a load that cannot be
    // completed. Safe because the pass is idempotent: a title already taken resolves to the id
    // holding it.
    let left = batch;
    for (let attempt = 1; ; attempt++) {
      const reply = await hit<{
        ids: Record<string, Id>;
        existed: number;
        failed: number;
        failedKeys: string[];
        failures: unknown[];
      }>("/ingest/pages", {
        pages: left.map((r) => ({ key: r.key, affinity: r.affinity, fields: r.fields })),
        concurrency: PAGE_CONCURRENCY,
      });
      // Appended as soon as they are acknowledged, so a kill between batches loses nothing but the
      // batches that were in flight. `appendFileSync` from several workers cannot interleave: it is
      // synchronous, and this is one thread.
      const minted = Object.entries(reply.ids);
      if (minted.length > 0) {
        appendFileSync(IDS_FILE, minted.map(([k, id]) => `${k}\t${id}`).join("\n") + "\n");
        for (const [k, id] of minted) ids.set(k, id);
      }
      pagesMinted += minted.length;
      pagesExisted += reply.existed;
      if (reply.failed === 0) break;
      if (attempt >= PAGE_ATTEMPTS) {
        throw new Error(
          `/ingest/pages: ${reply.failed} still failing after ${attempt} attempts over ` +
            `${(pageRetryWindow / 1000).toFixed(1)}s, e.g. ${JSON.stringify(reply.failures[0])}`,
        );
      }
      const again = new Set(reply.failedKeys);
      left = left.filter((r) => again.has(r.key));
      pagesRetried += left.length;
      await new Promise((r) => setTimeout(r, pageBackoff(attempt)));
    }
    done += batch.length;
    if (done % (PAGE_BATCH * PAGE_INFLIGHT * 8) < PAGE_BATCH) {
      const rate = done / ((Date.now() - passAStarted) / 1000);
      log(`  pass A: ${n(done)} pages minted, ${rate.toFixed(0)}/s`);
    }
  });

  passAMs = Date.now() - passAStarted;
  const rate = pagesMinted / (passAMs / 1000);
  log(
    `pass A: ${n(pagesMinted)} pages in ${(passAMs / 1000).toFixed(1)}s (${rate.toFixed(0)} pages/s ` +
      `through ${before.indexVshards.length} index vshards, ${n(pagesExisted)} already present, ` +
      `${n(pagesSkipped)} skipped from the checkpoint, ${n(pagesRetried)} retried)`,
  );
}

// ---- pass B: both directions of both relations, as the import emitted them

let edgesWritten = 0;
let edgesSeen = 0;
let unresolvedTargets = 0;
let unresolvedPages = 0;
let edgesRetried = 0;
let passBMs = 0;
let batchesSent = 0;
/** Per-type degree for a small sample of pages, so the maintained counts have something to be
 *  checked against without holding a counter for all 950,421 of them. */
const degreeSample = new Map<string, Map<string, number>>();
let resumedFrom = 0;

if (PASS.includes("B")) {
  const passBStarted = Date.now();

  // Where every vshard lives. Routing is by vshard, so one representative id per vshard answers for
  // all of it, and the whole map costs a couple of requests rather than one per edge. Sound here
  // only because nothing moves: the demo keeps every vshard at epoch 0, so a vshard's host is fixed
  // for the run. Under a live placement controller this would be a cache, and a refused write would
  // mean re-routing.
  //
  // A representative is minted through `makeId` rather than assembled here, because the vshard field
  // is anchored at SEQ_BITS and a second copy of that layout is a copy that can disagree.
  const hostOfVshard = new Map<string, number>();
  const repOf = (v: string) => makeId(BigInt(v), 1n);

  async function route(vshards: string[]): Promise<void> {
    for (let i = 0; i < vshards.length; i += 128) {
      const slice = vshards.slice(i, i + 128);
      const reply = await hit<{ hosts: Record<string, number | null> }>(
        `/admin/route?ids=${slice.map(repOf).join(",")}`,
      );
      for (const v of slice) {
        const host = reply.hosts[repOf(v)];
        if (host !== null && host !== undefined) hostOfVshard.set(v, host);
      }
    }
  }

  /**
   * The host holding a vshard, resolved once and then remembered.
   *
   * HLEKK_VSHARDS is the size of the *first* batch, not the number of vshards that exist. `init`
   * calls `allocator.grow()` to open the index vshards, and grow opens a whole batch and assigns all
   * of it — `.slice(0, indexVshards)` only decides which of them the index gets, so the rest join
   * the active set and take root objects like any other. A load that assumed ids stay inside the
   * first batch died on `no host for vshard 208`, which is a page that landed in the second one.
   * Pre-warming two batches covers the layout `init` actually produces; the lazy path covers a
   * database that has grown again since.
   */
  async function hostFor(vshard: string): Promise<number> {
    const known = hostOfVshard.get(vshard);
    if (known !== undefined) return known;
    await route([vshard]);
    const host = hostOfVshard.get(vshard);
    if (host === undefined) throw new Error(`no route for vshard ${vshard}`);
    return host;
  }

  await route(Array.from({ length: DATA_VSHARDS * 2 }, (_, v) => String(v)));
  log(`routed ${n(hostOfVshard.size)} vshards onto ${n(new Set(hostOfVshard.values()).size)} hosts`);

  // The resume watermark: every edge belonging to a page below it has been acknowledged. Held back
  // by anything still buffered or queued or in flight, so it can only ever make a resume redo work.
  if (existsSync(POS_FILE)) {
    resumedFrom = Number(readFileSync(POS_FILE, "utf8").trim()) || 0;
    if (resumedFrom > 0) log(`resuming pass B from page key ${n(resumedFrom)} (${POS_FILE})`);
  }

  // ---- the host pipeline: one worker per host, one request in flight each
  const queues = new Map<number, Batch[]>();
  const idleWorkers = new Map<number, () => void>();
  const workers: Promise<void>[] = [];
  const gate = semaphore(INFLIGHT);
  let producing = true;
  let failure: Error | null = null;
  let queued = 0;
  let roomWaiter: (() => void) | null = null;
  const openRoom = () => {
    const w = roomWaiter;
    roomWaiter = null;
    w?.();
  };

  /** Page keys that something still unacknowledged depends on, as a multiset. The watermark is the
   *  smallest of them, which is why it is a count per key and not a single number. */
  const holding = new Map<string, number>();
  const hold = (key: string, by: number) => {
    const held = (holding.get(key) ?? 0) + by;
    if (held <= 0) holding.delete(key);
    else holding.set(key, held);
  };

  async function sendEdges(batch: Batch): Promise<void> {
    let left = batch.edges;
    for (let attempt = 1; ; attempt++) {
      const reply = await hit<{
        written: number;
        failed: number;
        failedIndexes: number[];
        failures: unknown[];
      }>("/ingest/edges", { edges: left, concurrency: 12 });
      edgesWritten += reply.written;
      if (reply.failed === 0) return;
      if (attempt >= 8) {
        throw new Error(
          `/ingest/edges: ${reply.failed} still failing after ${attempt} attempts, ` +
            `e.g. ${JSON.stringify(reply.failures[0])}`,
        );
      }
      left = reply.failedIndexes.map((i) => left[i]);
      edgesRetried += left.length;
      // Long enough to outlast an overloaded object draining its queue, which 12 s did not.
      await new Promise((r) => setTimeout(r, Math.min(15_000, 500 * 2 ** (attempt - 1))));
    }
  }

  function startWorker(host: number): void {
    const queue = queues.get(host)!;
    workers.push(
      (async () => {
        for (;;) {
          if (failure) return;
          const batch = queue.shift();
          if (batch === undefined) {
            if (!producing) return;
            await new Promise<void>((r) => idleWorkers.set(host, r));
            continue;
          }
          queued--;
          openRoom();
          await gate.acquire();
          try {
            await sendEdges(batch);
          } catch (e) {
            failure ??= asError(e);
            // Wake the producer on the way out. It may be parked on the backpressure gate, and a
            // worker that dies silently is one fewer thing that will ever open it again -- if this
            // was the last live worker, the run would hang instead of reporting the failure.
            openRoom();
            return;
          } finally {
            gate.release();
          }
          batchesSent++;
          hold(batch.minKey, -1);
        }
      })(),
    );
  }

  function submit(host: number, batch: Batch): void {
    let queue = queues.get(host);
    if (!queue) {
      queues.set(host, (queue = []));
      startWorker(host);
    }
    queue.push(batch);
    queued++;
    hold(batch.minKey, 1);
    const wake = idleWorkers.get(host);
    if (wake) {
      idleWorkers.delete(host);
      wake();
    }
  }

  // ---- the producer: resolve, buffer per vshard, flush in key order
  /** One open buffer per vshard — the shape the record stream's own comment prescribes: a hundred-odd
   *  open buffers in one pass, not a sort. `minKey` is the oldest page still represented in it, which
   *  is that buffer's claim on the resume watermark; the whole buffer is flushed at once, so it is a
   *  single key and not a range. `host` is carried so a flush needs no lookup and no await. */
  const buffers = new Map<string, { edges: Edge[]; minKey: string; host: number }>();

  function flush(vshard: string): void {
    const buf = buffers.get(vshard);
    if (buf === undefined || buf.edges.length === 0) return;
    buffers.delete(vshard);
    submit(buf.host, { edges: inKeyOrder(buf.edges), minKey: buf.minKey });
  }

  let producedUpTo = "0";
  /** The watermark: the smallest page key anything unacknowledged still depends on, counting what is
   *  merely buffered as well as what is in flight. Nothing is held once the stream is done, so it
   *  falls through to how far the stream was read. */
  function watermark(): number {
    let min = Infinity;
    for (const key of holding.keys()) min = Math.min(min, Number(key));
    for (const buf of buffers.values()) min = Math.min(min, Number(buf.minKey));
    return min === Infinity ? Number(producedUpTo) : min;
  }
  let lastCheckpoint = Date.now();
  const checkpoint = () => {
    writeFileSync(POS_FILE, String(watermark()));
    lastCheckpoint = Date.now();
  };

  let pagesRead = 0;
  let sinceFlush = 0;
  /** The current page's per-type degree, so the largest page in the wiki can be reported without a
   *  counter per page. */
  let currentKey: string | null = null;
  let currentDegree = new Map<string, number>();
  let busiest = { key: "", total: 0, degree: new Map<string, number>() };
  const finishPage = () => {
    if (currentKey === null) return;
    let total = 0;
    for (const v of currentDegree.values()) total += v;
    if (total > busiest.total) {
      busiest = { key: currentKey, total, degree: new Map(currentDegree) };
    }
  };

  for await (const r of records({ work: WORK, affinity: AFFINITY, maxEdges: EDGE_BATCH }) as AsyncIterable<Rec>) {
    if (failure) break;
    if (r.key !== currentKey) {
      finishPage();
      currentKey = r.key;
      currentDegree = new Map();
      noteTitle(r);
      pagesRead++;
      if (pagesRead > PAGES) break;
      producedUpTo = r.key;
      if (++sinceFlush >= FLUSH_EVERY) {
        sinceFlush = 0;
        const cutoff = Number(r.key) - FLUSH_EVERY;
        for (const [v, buf] of [...buffers]) if (Number(buf.minKey) < cutoff) flush(v);
      }
    }
    // Below the watermark the edges are already in, and re-sending them would be the whole run again
    // after a late interruption. The watermark is conservative, so this can only skip what landed.
    if (resumedFrom > 0 && Number(r.key) < resumedFrom) continue;

    const from = ids.get(r.key);
    if (from === undefined) {
      unresolvedPages++;
      continue;
    }
    // Once per record, never once per edge: every edge of a page is routed by that page's id, so
    // the vshard is the same for all of them, and `vshardOf` parses a BigInt out of a string.
    const vshard = vshardOf(from).toString();
    let buf = buffers.get(vshard);
    if (buf === undefined) {
      buffers.set(vshard, (buf = { edges: [], minKey: r.key, host: await hostFor(vshard) }));
    }
    for (const e of r.edges) {
      edgesSeen++;
      const to = ids.get(e.to);
      // Every red link was already dropped by the importer, so a target with no id is not a red
      // link — it is a page the import listed and pass A did not mint. Counted and reported rather
      // than silently skipped, because a non-zero count here means the two passes disagree.
      if (to === undefined) {
        unresolvedTargets++;
        continue;
      }
      buf.edges.push([e.type, from, to, e.time ?? 0]);
      currentDegree.set(e.type, (currentDegree.get(e.type) ?? 0) + 1);
    }
    if (degreeSample.size < DEGREE_SAMPLE && !degreeSample.has(r.key)) degreeSample.set(r.key, currentDegree);

    if (buf.edges.length >= EDGE_BATCH) flush(vshard);

    while (queued >= MAX_QUEUED && !failure) await new Promise<void>((res) => (roomWaiter = res));
    if (Date.now() - lastCheckpoint > 10_000) {
      checkpoint();
      const rate = edgesWritten / ((Date.now() - passBStarted) / 1000);
      log(
        `  pass B: ${n(pagesRead)} pages read, ${n(edgesWritten)} edges written, ${rate.toFixed(0)}/s, ` +
          `${n(queued)} queued, watermark ${n(watermark())}`,
      );
    }
  }
  finishPage();
  for (const v of [...buffers.keys()]) flush(v);
  producing = false;
  for (const [, wake] of idleWorkers) wake();
  idleWorkers.clear();
  await Promise.all(workers);
  if (failure) throw failure;
  checkpoint();

  passBMs = Date.now() - passBStarted;
  const rate = edgesWritten / (passBMs / 1000);
  log(
    `pass B: ${n(edgesWritten)} edges in ${(passBMs / 1000).toFixed(1)}s (${rate.toFixed(0)} edge writes/s ` +
      `in ${n(batchesSent)} batches over ${n(queues.size)} hosts, ${n(edgesRetried)} retried)`,
  );
  if (unresolvedTargets > 0 || unresolvedPages > 0) {
    log(
      `  ${n(unresolvedTargets)} edges had no id for their target and ${n(unresolvedPages)} pages had ` +
        `no id of their own; both should be 0 after a complete pass A`,
    );
  }
  if (busiest.total > 0) {
    log(
      `  busiest page: key ${busiest.key}, ${n(busiest.total)} edges ` +
        `(${[...busiest.degree].map(([t, c]) => `${t.replace("wiki.", "")} ${n(c)}`).join(", ")})`,
    );
  }
}

// ---- did it work?

const after = await hit<Where>("/admin/where");
const objects = after.hosts.reduce((s, h) => s + h.objects, 0);
const pending = after.hosts.reduce((s, h) => s + h.pending, 0);
const occupied = after.hosts.filter((h) => h.objects > 0);

if (PASS.includes("B")) {
  check(
    "every edge the records offered was written",
    edgesWritten === edgesSeen - unresolvedTargets,
    `${n(edgesWritten)} written of ${n(edgesSeen)} seen, ${n(unresolvedTargets)} unresolvable`,
  );
  // Only a whole wiki can expect this. A `--pages N` run loads the first N pages and most of their
  // targets lie outside that set, which is the same dangling-edge arithmetic `selectSubset` reports
  // for a subset -- an artifact of truncating, not data loss. Asserting it there would make every
  // probe fail.
  if (PAGES === Infinity) {
    check("no edge target was missing an id", unresolvedTargets === 0, `${n(unresolvedTargets)} unresolved`);
  } else {
    console.log(
      `info  ${n(unresolvedTargets)} of ${n(edgesSeen)} edges pointed outside the first ${n(PAGES)} pages ` +
        `(${((unresolvedTargets / Math.max(1, edgesSeen)) * 100).toFixed(1)}%), which truncating is expected to do`,
    );
  }
}
check("no outbox op was needed, because no edge type is a pair", pending === 0, `${n(pending)} queued`);
check(
  "the pages spread across the hosts",
  occupied.length > HOSTS / 2,
  `${occupied.length} of ${HOSTS} hosts hold pages`,
);
check(
  "every page is stored exactly once",
  objects === ids.size,
  `${n(objects)} objects for ${n(ids.size)} known ids`,
);

// Entry by title is the demo's only way in, and the object count above cannot see the index.
const want = [...sampleTitles.keys()].filter((k) => ids.has(k));
if (want.length > 0) {
  let found = 0;
  let wrong = 0;
  for (let i = 0; i < want.length; i += 50) {
    const slice = want.slice(i, i + 50);
    const reply = await hit<{ ids: Record<string, Id | null> }>(
      `/lookup?titles=${slice
        .map((k) => encodeURIComponent(`${sampleTitles.get(k)!.ns}:${sampleTitles.get(k)!.title}`))
        .join("|")}`,
    );
    for (const k of slice) {
      const t = sampleTitles.get(k)!;
      const got = reply.ids[`${t.ns}:${t.title}`];
      if (got === null || got === undefined) continue;
      found++;
      if (got !== ids.get(k)) wrong++;
    }
  }
  check(
    "every sampled page is findable by (ns, title)",
    found === want.length && wrong === 0,
    `${found} of ${want.length} found, ${wrong} wrong`,
  );
}

// The exact-count oracle: a maintained counter against the degree the records say it has.
if (PASS.includes("B") && degreeSample.size > 0) {
  const keys = [...degreeSample.keys()].filter((k) => ids.has(k));
  const reply = await hit<{
    counts: Record<string, { links: number; backlinks: number; cats: number; members: number }>;
  }>(`/counts?ids=${keys.map((k) => ids.get(k)!).join(",")}`);
  const of = (k: string, type: string) => degreeSample.get(k)!.get(type) ?? 0;
  let agree = 0;
  for (const k of keys) {
    const row = reply.counts[ids.get(k)!];
    if (
      row !== undefined &&
      row.links === of(k, "wiki.page_links") &&
      row.backlinks === of(k, "wiki.linked_from") &&
      row.cats === of(k, "wiki.page_categories") &&
      row.members === of(k, "wiki.category_pages")
    ) {
      agree++;
    }
  }
  check(
    "every maintained count equals the degree the records say",
    agree === keys.length,
    `${agree}/${keys.length} pages checked`,
  );
}

// ---- what it cost on disk

const size = await hit<Size>("/admin/size");
/** What a host DO's SQLite weighs with the schema in place and nothing stored, measured on deployed
 *  hosts — and not the 40,960 the same thing weighs on local workerd. */
const EMPTY_HOST_BYTES = 45_056;
const loaded = size.total - HOSTS * EMPTY_HOST_BYTES;
const rows = ids.size + edgesWritten;
log(
  `storage: ${n(size.total)} bytes over ${size.nonEmpty} non-empty hosts, ` +
    `${n(HOSTS * EMPTY_HOST_BYTES)} of it empty schema, ${n(loaded)} of data` +
    (rows > 0 ? ` — ${(loaded / rows).toFixed(1)} bytes per row over ${n(ids.size)} pages and ${n(edgesWritten)} edges` : ""),
);

const passed = checks.filter((x) => x.ok).length;
console.log(
  `\n${passed}/${checks.length} checks after ${n(ids.size)} pages and ${n(edgesWritten)} edges ` +
    `on ${occupied.length} hosts in ${(since() / 60).toFixed(1)} min`,
);
if (passAMs > 0) {
  console.log(
    `pass A: ${(pagesMinted / (passAMs / 1000)).toFixed(0)} pages/s through ${before.indexVshards.length} ` +
      `index vshards (batch ${PAGE_BATCH} x ${PAGE_INFLIGHT} inflight x ${PAGE_CONCURRENCY} concurrent)`,
  );
}
if (passBMs > 0) {
  console.log(
    `pass B: ${(edgesWritten / (passBMs / 1000)).toFixed(0)} edge writes/s over ${occupied.length} hosts ` +
      `(batch ${EDGE_BATCH}, one in flight per host, ${INFLIGHT} across all)`,
  );
}
process.exit(passed === checks.length ? 0 : 1);
