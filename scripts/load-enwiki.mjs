// Loads the Wikipedia link and category graph into hlekk. Build A of docs/demo-dataset.md.
//
// Six passes, each one a stream over a published dump. Nothing is held in memory except two flat
// id maps, because the tables are billions of rows and the joins are all on dense integer keys:
//
//   0  page.sql.gz          -> pages.tsv            every page's id, namespace, title, length
//   0b categorylinks.sql.gz -> affinity.tsv         each page's first category, as a placement key
//   1  pages.tsv            -> ids.bin              create the pages; page_id -> hlekk id
//   2  linktarget.sql.gz    -> lt.bin               lt_id -> hlekk id, by title; 0 means a red link
//   3  pagelinks.sql.gz     -> wiki.page_links      grouped by source page
//   4  pagelinks.sql.gz     -> wiki.linked_from     the same rows, grouped by target page
//   5  categorylinks.sql.gz -> wiki.page_categories grouped by source; the inverse rides the outbox
//
// Run it against `simplewiki` first. It is the same schema at about 1% of the size, so it finishes
// in minutes and every pass either works there or is broken everywhere.
//
//   node scripts/load-enwiki.mjs --wiki simplewiki --date 20261001 --passes 0,0b,1,2,3,4,5
//   node scripts/load-enwiki.mjs --wiki enwiki --date 20261001 --concurrency 96
//
// WHAT THE WORKER OWES. Two routes, neither of which exists yet:
//
//   POST /ingest/pages  { pages: [{ pageId, ns, title, redirect, len, extract, affinity }] }
//                    -> { ids: [[pageId, hlekkId], ...] }
//      Per page: createUnique(TITLE_IDX, titleKey(ns, title), Page.otype, {...}, { affinity }).
//
//   POST /ingest/edges  { groups: [{ anchor, atype, ops: [[id2, time], ...] }] }
//                    -> { applied }
//      Every op in a group shares `anchor` as its id1, so the whole group is one vshard's worth of
//      writes and belongs in one transaction.
//
// AND THE MUTATION THAT MAKES IT FINISH. `Mutation` in src/client/transport.ts has no batch kind:
// design.md specifies `db.txn(anchorId, …)` and *Transactions* says it runs on the anchor's host,
// but it is not built, so today each edge is its own round trip. That is the difference between
// ~380 million requests and ~4 billion for Build A — hours against days, before SQLite throughput
// is even considered. An edge always lives on id1's vshard, so a group above touches exactly one
// vshard and satisfies the rule that every id share the anchor's. Build `txn` first.

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { open } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const WIKI = args.get("wiki") ?? "simplewiki";
const DATE = args.get("date") ?? "20261001";
const ENDPOINT = (args.get("endpoint") ?? "http://127.0.0.1:8788").replace(/\/$/, "");
const WORK = args.get("work") ?? join(".wrangler", `load-${WIKI}-${DATE}`);
const PASSES = new Set((args.get("passes") ?? "0,0b,1,2,3,4,5").split(","));
const CONCURRENCY = Number(args.get("concurrency") ?? 32);
const GROUPS_PER_POST = Number(args.get("groups") ?? 200);
const PAGES_PER_POST = Number(args.get("pagesPerPost") ?? 500);
const MAX_OPS_PER_GROUP = Number(args.get("maxOps") ?? 500);
const SORT_MEM = args.get("sortMem") ?? "2G";
const LIMIT = Number(args.get("limit") ?? Infinity); // rows per pass, for smoke runs

const path = (f) => join(WORK, f);
const url = (table) => `https://dumps.wikimedia.org/${WIKI}/${DATE}/${WIKI}-${DATE}-${table}.sql.gz`;

const started = Date.now();
const log = (...m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...m);

// ---------------------------------------------------------------- reading dumps

/**
 * Yields one array of raw field strings per row of a MariaDB dump.
 *
 * The format is `INSERT INTO \`t\` VALUES\n(a,b,'c'),\n(d,e,NULL);` — one row per line, but a
 * quoted field may itself contain a newline, a comma or an escaped quote, so the rows cannot be
 * split on either character and this is a scanner rather than a `split`. Quoted fields come back
 * unescaped; `NULL` comes back as null; numbers come back as strings and the caller converts.
 */
export async function* rows(stream) {
  let buf = "";
  let at = 0;
  for await (const chunk of stream) {
    buf = at > 0 ? buf.slice(at) + chunk : buf + chunk;
    at = 0;
    for (;;) {
      // A row begins at `(` immediately after a newline: that is true of the first row of an
      // INSERT (which follows `VALUES\n`) and of every later one (which follows `),\n`).
      const start = buf.indexOf("\n(", at);
      if (start < 0) break;
      const parsed = parseRow(buf, start + 2);
      if (parsed === null) break; // the row is cut by the chunk boundary; wait for more
      at = parsed.end;
      yield parsed.fields;
    }
    if (at === 0 && buf.length > 1 << 26) throw new Error("no row boundary in 64 MiB; format changed?");
  }
}

/** Refuses a row whose shape is not what the pass was written against.
 *
 *  This is not defensive padding. `categorylinks` dropped `cl_to` and replaced it with a
 *  `linktarget` reference, and without this check the loader read the binary collation sortkey as a
 *  category title, wrote millions of garbage affinity keys and resolved no category edges at all —
 *  silently, because every field still parsed. Principle 7: a changed schema should stop the load. */
function expect(table, f, width) {
  if (f.length !== width) {
    throw new Error(`${table}: ${f.length} fields, expected ${width} — the dump schema has changed. ` +
      `First row: ${JSON.stringify(f).slice(0, 300)}`);
  }
  return f;
}

/** Parses one `(…)` row starting at `i`, or null if the buffer ends mid-row. */
export function parseRow(s, i) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (;;) {
    if (i >= s.length) return null;
    const c = s[i];
    if (quoted) {
      if (c === "\\") {
        if (i + 1 >= s.length) return null;
        const e = s[i + 1];
        field += e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "0" ? "\0" : e;
        i += 2;
        continue;
      }
      if (c === "'") {
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === "'") {
      quoted = true;
      i++;
      continue;
    }
    if (c === "," || c === ")") {
      fields.push(field === "NULL" ? null : field);
      field = "";
      i++;
      if (c === ")") return { fields, end: i };
      continue;
    }
    field += c;
    i++;
  }
}

/** The decompressed text of one dump table, streamed from the Wikimedia mirror or from a local copy
 *  if one has been downloaded beside the work directory. Returns a text stream, not a buffer: the
 *  biggest of these tables is tens of gigabytes decompressed and is never held. */
async function dump(table) {
  const local = path(`${table}.sql.gz`);
  let src;
  if (existsSync(local)) {
    src = createReadStream(local);
  } else {
    const res = await fetch(url(table), { headers: { "user-agent": `hlekk-demo-loader (${WIKI})` } });
    if (!res.ok) throw new Error(`${url(table)}: ${res.status}`);
    src = Readable.fromWeb(res.body);
  }
  const gunzip = createGunzip();
  src.pipe(gunzip);
  gunzip.setEncoding("utf8");
  return gunzip;
}

/** Streams through GNU sort. The keys are all integers in fixed columns, so this is the right tool
 *  and reimplementing an external sort in JS would be strictly worse. */
function sorted(inFile, outFile, keys) {
  const sort = spawn(
    "sort",
    ["-t", "\t", ...keys.flatMap((k) => ["-k", k]), "-S", SORT_MEM, "-T", WORK, "-o", outFile, inFile],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  return new Promise((done, fail) =>
    sort.on("exit", (code) => (code === 0 ? done() : fail(new Error(`sort exited ${code}`)))),
  );
}

const lines = (file) => createInterface({ input: createReadStream(file), crlfDelay: Infinity });

// ------------------------------------------------------------------- the id maps

/**
 * A dense `integer key -> hlekk id` map, 8 bytes per slot, in one Buffer.
 *
 * MediaWiki's `page_id` and `lt_id` are dense and bounded — enwiki's run to roughly 10^8 — so a
 * flat array indexed by the key beats any hash: ~800 MB off-heap for 10^8 slots, O(1) reads, and
 * the passes that use it are already sorted by the key so the access pattern is sequential. 0
 * means absent, which doubles as "red link" in the linktarget map.
 */
class IdMap {
  constructor(slots = 1 << 20) {
    this.buf = Buffer.alloc(slots * 8);
  }
  #grow(slot) {
    let slots = this.buf.length / 8;
    while (slot >= slots) slots *= 2;
    const next = Buffer.alloc(slots * 8);
    this.buf.copy(next);
    this.buf = next;
  }
  set(slot, id) {
    if (slot * 8 + 8 > this.buf.length) this.#grow(slot);
    this.buf.writeBigUInt64BE(BigInt(id), slot * 8);
  }
  /** The hlekk id as a decimal string, or null. Ids are strings everywhere above the engine. */
  get(slot) {
    if (slot * 8 + 8 > this.buf.length) return null;
    const v = this.buf.readBigUInt64BE(slot * 8);
    return v === 0n ? null : v.toString();
  }
  async save(file) {
    const fh = await open(file, "w");
    await fh.write(this.buf);
    await fh.close();
  }
  static async load(file) {
    const m = new IdMap(1);
    const fh = await open(file, "r");
    m.buf = Buffer.alloc(statSync(file).size);
    await fh.read(m.buf, 0, m.buf.length, 0);
    await fh.close();
    return m;
  }
}

// ------------------------------------------------------------------- posting

/** A bounded pool of in-flight POSTs. Retries on anything retryable, because a host mid-move
 *  answers `moved` and the client reroutes, but a host over its request ceiling answers 429 and
 *  only backing off helps. */
class Poster {
  constructor(route, concurrency) {
    this.route = route;
    this.limit = concurrency;
    this.inflight = new Set();
    this.sent = 0;
    this.rows = 0;
  }
  async post(body, rows) {
    while (this.inflight.size >= this.limit) await Promise.race(this.inflight);
    const p = this.#send(body, rows).finally(() => this.inflight.delete(p));
    this.inflight.add(p);
    return p;
  }
  async #send(body, rows, attempt = 0) {
    try {
      const res = await fetch(`${ENDPOINT}${this.route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
      this.sent++;
      this.rows += rows;
      return await res.json();
    } catch (e) {
      if (attempt >= 6) throw e;
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      return this.#send(body, rows, attempt + 1);
    }
  }
  async drain() {
    while (this.inflight.size) await Promise.race(this.inflight);
  }
}

/** Groups a stream of `[anchor, id2, time]` triples that is already sorted by anchor, and posts one
 *  batch of groups at a time. Each group is one anchor's whole edge list, which is one vshard. */
async function postGroups(atype, triples, label) {
  const poster = new Poster("/ingest/edges", CONCURRENCY);
  let groups = [];
  let ops = [];
  let anchor = null;
  let rows = 0;
  const flushGroup = () => {
    if (anchor === null || ops.length === 0) return;
    groups.push({ anchor, atype, ops });
    ops = [];
  };
  const flushPost = async () => {
    if (groups.length === 0) return;
    const batch = groups;
    groups = [];
    await poster.post({ groups: batch }, batch.reduce((n, g) => n + g.ops.length, 0));
  };
  for await (const [a, id2, time] of triples) {
    if (a !== anchor) {
      flushGroup();
      if (groups.length >= GROUPS_PER_POST) await flushPost();
      anchor = a;
    }
    ops.push([id2, time]);
    // A page with a very long edge list is split across transactions. The colocation group limit is
    // undecided (design.md, Design limits) and this is where the load would find it.
    if (ops.length >= MAX_OPS_PER_GROUP) flushGroup();
    if (++rows % 5_000_000 === 0) log(`${label}: ${rows.toLocaleString()} edges, ${poster.sent} posts`);
    if (rows >= LIMIT) break;
  }
  flushGroup();
  await flushPost();
  await poster.drain();
  log(`${label}: done, ${rows.toLocaleString()} edges in ${poster.sent} posts`);
  return rows;
}

// ------------------------------------------------------------------- the passes

/** 0. Every page's identity, as TSV: page_id, ns, title, redirect, len. */
async function pass0() {
  const out = createWriteStream(path("pages.tsv"));
  let n = 0;
  // page: (page_id, page_namespace, page_title, page_is_redirect, page_is_new, page_random,
  //        page_touched, page_links_updated, page_latest, page_len, page_content_model, page_lang)
  for await (const f of rows(await dump("page"))) {
    expect("page", f, 12);
    if (!out.write(`${f[0]}\t${f[1]}\t${f[2]}\t${f[3]}\t${f[9] ?? 0}\n`)) {
      await new Promise((r) => out.once("drain", r));
    }
    if (++n % 5_000_000 === 0) log(`pass 0: ${n.toLocaleString()} pages`);
    if (n >= LIMIT) break;
  }
  await new Promise((r) => out.end(r));
  log(`pass 0: ${n.toLocaleString()} pages -> pages.tsv`);
}

/**
 * 0b. Each page's first category, used as its placement affinity.
 *
 * Build A creates only one kind of object, and an edge always lives on its id1's vshard, so `with:`
 * never comes into it — the only placement lever is the affinity key a page is created under.
 * Pages sharing one land together and stay together as the database spreads, so keying on a page's
 * primary category makes browsing within a topic stay on a few hosts while browsing across topics
 * fans out. That contrast is the thing query 6 is for; with no affinity at all, every traversal is
 * a full fan-out and the demo shows one case instead of two.
 */
async function pass0b() {
  const raw = path("cats-by-page.tsv");
  const out = createWriteStream(raw);
  let n = 0;
  // categorylinks, as of the 2026 dumps:
  //   (cl_from, cl_sortkey, cl_timestamp, cl_sortkey_prefix, cl_type, cl_collation_id, cl_target_id)
  // `cl_to` is gone — a category is named by a `linktarget` id now, exactly as a link target is,
  // and cl_sortkey is a binary collation key, not a readable title. So the affinity key is the
  // target id rather than a category name: arbitrary but stable, which is all a placement key has
  // to be. Resolving it to a title would mean reading linktarget here too, and pass 0b runs before
  // any id exists.
  for await (const f of rows(await dump("categorylinks"))) {
    expect("categorylinks", f, 7);
    if (!out.write(`${f[0]}\t${f[6]}\n`)) await new Promise((r) => out.once("drain", r));
    if (++n % 10_000_000 === 0) log(`pass 0b: ${n.toLocaleString()} category rows`);
    if (n >= LIMIT) break;
  }
  await new Promise((r) => out.end(r));
  // Lowest target id per page: which category that is, is arbitrary; that it is the same one on
  // every run is what matters, since the affinity key decides placement.
  await sorted(raw, path("cats-sorted.tsv"), ["1,1n", "2,2n"]);
  const aff = createWriteStream(path("affinity.tsv"));
  let last = null;
  for await (const line of lines(path("cats-sorted.tsv"))) {
    const [from, to] = line.split("\t");
    if (from === last) continue; // first category only
    last = from;
    aff.write(`${from}\tcat:${to}\n`);
  }
  await new Promise((r) => aff.end(r));
  log("pass 0b: affinity.tsv written");
}

/** 1. Create the pages, and record page_id -> hlekk id. */
async function pass1() {
  const affinity = new Map();
  if (existsSync(path("affinity.tsv"))) {
    for await (const line of lines(path("affinity.tsv"))) {
      const t = line.indexOf("\t");
      affinity.set(Number(line.slice(0, t)), line.slice(t + 1));
    }
    log(`pass 1: ${affinity.size.toLocaleString()} affinity keys`);
  }
  const ids = new IdMap();
  const poster = new Poster("/ingest/pages", CONCURRENCY);
  let batch = [];
  let n = 0;
  const flush = async () => {
    if (!batch.length) return;
    const sending = batch;
    batch = [];
    const reply = await poster.post({ pages: sending }, sending.length);
    for (const [pageId, hlekkId] of reply.ids) ids.set(Number(pageId), hlekkId);
  };
  for await (const line of lines(path("pages.tsv"))) {
    const [pageId, ns, title, redirect, len] = line.split("\t");
    batch.push({
      pageId: Number(pageId),
      ns: Number(ns),
      title,
      redirect: redirect === "1",
      len: Number(len),
      affinity: affinity.get(Number(pageId)) ?? `ns:${ns}`,
    });
    if (batch.length >= PAGES_PER_POST) await flush();
    if (++n % 1_000_000 === 0) log(`pass 1: ${n.toLocaleString()} pages created`);
  }
  await flush();
  await poster.drain();
  await ids.save(path("ids.bin"));
  log(`pass 1: ${n.toLocaleString()} pages created -> ids.bin`);
}

/**
 * 2. lt_id -> hlekk id, by title.
 *
 * `pagelinks` no longer carries a target title or page id; it carries `pl_target_id` into
 * `linktarget`, whose rows are `(lt_id, lt_namespace, lt_title)` — titles, which need not be
 * pages. So the join is on `(ns, title)` and whatever does not match is a red link: a title
 * somebody linked to that nobody has written. Those get id 0 and are dropped from the edge passes,
 * and the share dropped is reported, because it is the difference between the dump's row count and
 * the database's edge count.
 */
async function pass2() {
  const ids = await IdMap.load(path("ids.bin"));

  // Both sides keyed by `ns\ttitle`, sorted, then merged.
  const ltRaw = path("lt.tsv");
  const out = createWriteStream(ltRaw);
  let n = 0;
  for await (const f of rows(await dump("linktarget"))) {
    expect("linktarget", f, 3);
    if (!out.write(`${f[1]}\t${f[2]}\t${f[0]}\n`)) await new Promise((r) => out.once("drain", r));
    if (++n % 10_000_000 === 0) log(`pass 2: ${n.toLocaleString()} link targets`);
    if (n >= LIMIT) break;
  }
  await new Promise((r) => out.end(r));

  const pagesKeyed = path("pages-keyed.tsv");
  const pk = createWriteStream(pagesKeyed);
  for await (const line of lines(path("pages.tsv"))) {
    const [pageId, ns, title] = line.split("\t");
    pk.write(`${ns}\t${title}\t${pageId}\n`);
  }
  await new Promise((r) => pk.end(r));

  await sorted(ltRaw, path("lt-sorted.tsv"), ["1,1n", "2,2"]);
  await sorted(pagesKeyed, path("pages-sorted.tsv"), ["1,1n", "2,2"]);

  const lt = new IdMap();
  let red = 0;
  let blue = 0;
  const pageIter = lines(path("pages-sorted.tsv"))[Symbol.asyncIterator]();
  let page = await pageIter.next();
  const keyOf = (line) => line.slice(0, line.lastIndexOf("\t"));
  for await (const line of lines(path("lt-sorted.tsv"))) {
    const key = keyOf(line);
    while (!page.done && keyOf(page.value) < key) page = await pageIter.next();
    const ltId = Number(line.slice(line.lastIndexOf("\t") + 1));
    if (!page.done && keyOf(page.value) === key) {
      const hlekkId = ids.get(Number(page.value.slice(page.value.lastIndexOf("\t") + 1)));
      if (hlekkId) {
        lt.set(ltId, hlekkId);
        blue++;
        continue;
      }
    }
    red++;
  }
  await lt.save(path("lt.bin"));
  const redShare = red / (red + blue);
  log(`pass 2: ${blue.toLocaleString()} resolved, ${red.toLocaleString()} red (${(redShare * 100).toFixed(1)}%)`);
  // Red links are ordinary — someone linked a title nobody has written. Almost *everything* being
  // red is not: it means the `(ns, title)` key is not matching, which is a broken join rather than
  // a sparse wiki, and every edge pass downstream would quietly write nothing.
  if (redShare > 0.9) throw new Error(`pass 2: ${(redShare * 100).toFixed(1)}% red — the (ns, title) join is not matching`);
}

/** The `pagelinks` rows as `(pl_from, pl_target_id)`, written once and reused by passes 3 and 4. */
async function extractPagelinks() {
  const raw = path("pl.tsv");
  if (existsSync(raw)) return raw;
  const out = createWriteStream(raw);
  let n = 0;
  // pagelinks: (pl_from, pl_from_namespace, pl_target_id)
  for await (const f of rows(await dump("pagelinks"))) {
    expect("pagelinks", f, 3);
    if (!out.write(`${f[0]}\t${f[2]}\n`)) await new Promise((r) => out.once("drain", r));
    if (++n % 50_000_000 === 0) log(`pagelinks: ${n.toLocaleString()} rows`);
    if (n >= LIMIT) break;
  }
  await new Promise((r) => out.end(r));
  log(`pagelinks: ${n.toLocaleString()} rows -> pl.tsv`);
  return raw;
}

/** 3 and 4. The same links, each direction grouped by the page whose vshard the edges live on. */
async function passLinks(direction, atype) {
  const raw = await extractPagelinks();
  const bySource = direction === "forward";
  const file = path(bySource ? "pl-by-from.tsv" : "pl-by-target.tsv");
  if (!existsSync(file)) await sorted(raw, file, bySource ? ["1,1n"] : ["2,2n"]);

  const ids = await IdMap.load(path("ids.bin"));
  const lt = await IdMap.load(path("lt.bin"));
  async function* triples() {
    for await (const line of lines(file)) {
      const t = line.indexOf("\t");
      const from = ids.get(Number(line.slice(0, t)));
      const target = lt.get(Number(line.slice(t + 1)));
      if (!from || !target) continue; // a red link, or a page the limit skipped
      // `time` is 0: see wiki.ts. The anchor is whichever end owns the row.
      yield bySource ? [from, target, 0] : [target, from, 0];
    }
  }
  await postGroups(atype, triples(), bySource ? "pass 3 page_links" : "pass 4 linked_from");
}

/** 5. Category membership. The only paired edge type, so every row written here produces an outbox
 *  op for the category's own vshard, and `category_pages` fills in behind it.
 *
 *  Since `cl_to` became `cl_target_id`, a category is a `linktarget` id like any other link target,
 *  so this pass reuses `lt.bin` from pass 2 instead of doing its own join on title. One fewer join,
 *  and category edges now resolve by exactly the mechanism link edges do. It does mean pass 5
 *  depends on pass 2, which it did not before.
 */
async function pass5(atype) {
  const raw = path("cl.tsv");
  if (!existsSync(raw)) {
    const out = createWriteStream(raw);
    let n = 0;
    for await (const f of rows(await dump("categorylinks"))) {
      expect("categorylinks", f, 7);
      // cl_timestamp is a DATETIME, `2025-02-17 19:20:02`, and becomes the edge's sort key.
      const ts = Math.floor(new Date(`${f[2].replace(" ", "T")}Z`).getTime() / 1000) || 0;
      if (!out.write(`${f[0]}\t${f[6]}\t${ts}\n`)) await new Promise((r) => out.once("drain", r));
      if (++n % 10_000_000 === 0) log(`pass 5: ${n.toLocaleString()} rows read`);
      if (n >= LIMIT) break;
    }
    await new Promise((r) => out.end(r));
  }

  const ids = await IdMap.load(path("ids.bin"));
  const lt = await IdMap.load(path("lt.bin"));
  const sortedFile = path("cl-by-from.tsv");
  if (!existsSync(sortedFile)) await sorted(raw, sortedFile, ["1,1n"]);
  let dropped = 0;
  async function* triples() {
    for await (const line of lines(sortedFile)) {
      const [from, to, ts] = line.split("\t");
      const a = ids.get(Number(from));
      const b = lt.get(Number(to));
      // A category nobody has created is a red link like any other: the membership is recorded
      // against a title with no page behind it.
      if (!a || !b) {
        dropped++;
        continue;
      }
      yield [a, b, Number(ts)];
    }
  }
  const written = await postGroups(atype, triples(), "pass 5 page_categories");
  log(`pass 5: ${dropped.toLocaleString()} dropped (uncreated category or skipped page), ${written.toLocaleString()} written`);
  // This number is also the check on an assumption. `cl_target_id` is read here as a `linktarget`
  // id, by analogy with `pl_target_id` and because `cl_to` is gone — which was confirmed from the
  // dump's column shape but not by resolving an id end to end. If the column indexes something
  // else, nearly every row drops, and that is what this refuses to pass over in silence.
  if (written > 0 && dropped / (dropped + written) > 0.9) {
    throw new Error(
      `pass 5: ${((dropped / (dropped + written)) * 100).toFixed(1)}% dropped — cl_target_id does not ` +
        `look like a linktarget id after all. Check the categorylinks column layout.`,
    );
  }
  if (written === 0 && dropped > 0) throw new Error(`pass 5: every one of ${dropped} rows dropped; see above`);
}

// ------------------------------------------------------------------- run
//
// Guarded, so the parser above can be imported and tested without starting a load.

if (realpathSync(process.argv[1] ?? "") !== fileURLToPath(import.meta.url)) {
  // imported for its parser; nothing to do
} else {
  await run();
}

async function run() {
mkdirSync(WORK, { recursive: true });
const ATYPES = await fetch(`${ENDPOINT}/admin/atypes`)
  .then((r) => r.json())
  .catch(() => {
    throw new Error(`cannot reach ${ENDPOINT}; is the worker running and initialized?`);
  });

log(`loading ${WIKI} ${DATE} into ${ENDPOINT}, work dir ${WORK}`);
if (PASSES.has("0")) await pass0();
if (PASSES.has("0b")) await pass0b();
if (PASSES.has("1")) await pass1();
if (PASSES.has("2")) await pass2();
if (PASSES.has("3")) await passLinks("forward", ATYPES["wiki.page_links"]);
if (PASSES.has("4")) await passLinks("backward", ATYPES["wiki.linked_from"]);
if (PASSES.has("5")) await pass5(ATYPES["wiki.page_categories"]);
log("done");
}
