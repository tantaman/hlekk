// Turns the enwiki dumps into the record stream the loader consumes. See docs/wikimedia-import.md,
// and docs/wikimedia-demo.md for the demo it feeds.
//
// This is the import side of the seam, and only that side. Per record it emits an affinity key, a
// type, a field map and outbound edges **in MediaWiki's own page ids**. It mints no hlekk ids,
// chooses no vshard, resolves no reference to a hlekk id, writes nothing to a host and talks to no
// Worker. Everything downstream of that is the loader's, which is what lets this side be checked
// against the dumps alone.
//
//   node scripts/import-enwiki.mjs --wiki simplewiki --date 20261001
//   node scripts/import-enwiki.mjs --wiki enwiki --date 20261001 --affinity category
//   node scripts/import-enwiki.mjs --wiki simplewiki --date 20261001 --affinity graph
//
// Run it on `simplewiki` first: same schema, about 1% of the size, finishes in minutes, and every
// pass either works there or is broken everywhere.
//
// Output, in the work directory:
//   records.jsonl   one record per page, with its outbound edges
//   report.json     counts, and the share of links that resolved to nothing
//
// Seven passes. Everything joins on dense integer keys, so the only state held is one flat array;
// everything else is a stream or an external sort.
//
//   0   page.sql.gz           -> pages.tsv     page_id, ns, title, redirect, len
//   0b  categorylinks.sql.gz  -> affinity.tsv  each page's first category
//   1   linktarget.sql.gz     -> lt.bin        lt_id -> page_id, by (ns, title); 0 means red
//   2   pagelinks.sql.gz      -> edges.tsv     wiki.page_links
//   3   pagelinks.sql.gz      -> edges.tsv     wiki.linked_from, the same rows reversed
//   4   categorylinks.sql.gz  -> edges.tsv     wiki.page_categories and wiki.category_pages
//   5   the above, merged     -> records.jsonl one record per page
//
// Passes 2-4 materialize both directions of both relations rather than declaring either an inverse.
// wikimedia-demo.md puts outbox delivery out of scope, and a bulk load cannot route 1.78 billion
// backlinks through it anyway. The cost is that nothing in the engine enforces that the two
// directions agree, which is why invariants.ts has to check them as if they were pairs.

import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const WIKI = args.get("wiki") ?? "simplewiki";
const DATE = args.get("date") ?? "20261001";
const WORK = args.get("work") ?? join(".wrangler", `import-${WIKI}-${DATE}`);
const AFFINITY = args.get("affinity") ?? "category"; // category | graph | namespace | initial | hash
const SORT_MEM = args.get("sortMem") ?? "2G";
const LIMIT = Number(args.get("limit") ?? Infinity);
const PASSES = new Set((args.get("passes") ?? "0,0b,1,2,3,4,5").split(","));

const path = (f) => join(WORK, f);
const url = (table) => `https://dumps.wikimedia.org/${WIKI}/${DATE}/${WIKI}-${DATE}-${table}.sql.gz`;
const started = Date.now();
const log = (...m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...m);
const report = {};

// ---------------------------------------------------------------- reading dumps

/**
 * Yields one array of raw field strings per row of a MariaDB dump.
 *
 * The format is `INSERT INTO \`t\` VALUES\n(a,b,'c'),\n(d,e,NULL);` — one row per line, but a
 * quoted field may itself contain a newline, a comma or an escaped quote, so the rows cannot be
 * split on either character and this is a scanner rather than a `split`. Quoted fields come back
 * unescaped; `NULL` comes back as null; numbers come back as strings.
 */
export async function* rows(stream) {
  let buf = "";
  let at = 0;
  for await (const chunk of stream) {
    buf = at > 0 ? buf.slice(at) + chunk : buf + chunk;
    at = 0;
    for (;;) {
      // A row begins at `(` just after a newline: true of the first row of an INSERT, which follows
      // `VALUES\n`, and of every later one, which follows `),\n`.
      const start = buf.indexOf("\n(", at);
      if (start < 0) break;
      const parsed = parseRow(buf, start + 2);
      if (parsed === null) break; // cut by the chunk boundary; wait for more
      at = parsed.end;
      yield parsed.fields;
    }
    if (at === 0 && buf.length > 1 << 26) throw new Error("no row boundary in 64 MiB; format changed?");
  }
}

/**
 * Refuses a row whose shape is not what the pass was written against.
 *
 * Not defensive padding. `categorylinks` dropped `cl_to` and replaced it with a `linktarget`
 * reference, and without this check the import read the binary collation sortkey as a category
 * title, produced millions of garbage affinity keys and resolved no category edges at all —
 * silently, because every field still parsed. Principle 7: a changed schema should stop the run.
 */
function expect(table, f, width) {
  if (f.length !== width) {
    throw new Error(
      `${table}: ${f.length} fields, expected ${width} — the dump schema has changed. ` +
        `First row: ${JSON.stringify(f).slice(0, 300)}`,
    );
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

/** The decompressed text of one dump table, from the Wikimedia mirror or a local copy beside the
 *  work directory. A text stream, never a buffer: the largest of these is tens of GB decompressed. */
async function dump(table) {
  const local = path(`${table}.sql.gz`);
  let src;
  if (existsSync(local)) {
    src = createReadStream(local);
  } else {
    const res = await fetch(url(table), { headers: { "user-agent": `hlekk-wikimedia-import (${WIKI})` } });
    if (!res.ok) throw new Error(`${url(table)}: ${res.status}`);
    src = Readable.fromWeb(res.body);
  }
  const gunzip = createGunzip();
  src.pipe(gunzip);
  gunzip.setEncoding("utf8");
  return gunzip;
}

/**
 * Streams through GNU sort. Every key is an integer or a byte string in a fixed column, so this is
 * the right tool.
 *
 * `LC_ALL=C` is not optional. A merge join below walks two sorted files in step, and that is only
 * correct while the order `sort` produced and the order the comparison uses are the *same relation*
 * — so the sort runs in byte order and the comparison compares bytes. Under a locale collation they
 * diverge on case and on accents, and a merge join whose comparison disagrees with its input's order
 * does not fail: it silently walks past matches.
 */
function sorted(inFile, outFile, keys) {
  const sort = spawn(
    "sort",
    ["-t", "\t", ...keys.flatMap((k) => ["-k", k]), "-S", SORT_MEM, "-T", WORK, "-o", outFile, inFile],
    { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, LC_ALL: "C" } },
  );
  return new Promise((done, fail) =>
    sort.on("exit", (code) => (code === 0 ? done() : fail(new Error(`sort exited ${code}`)))),
  );
}

const lines = (file) => createInterface({ input: createReadStream(file), crlfDelay: Infinity });

/** A buffered line writer that respects backpressure. */
function writer(file) {
  const out = createWriteStream(file);
  return {
    async write(s) {
      if (!out.write(s)) await new Promise((r) => out.once("drain", r));
    },
    end: () => new Promise((r) => out.end(r)),
  };
}

/**
 * A dense `lt_id -> page_id` map, 4 bytes per slot in one Buffer.
 *
 * `lt_id` is dense and bounded — enwiki's run to roughly 1.3 × 10^8 — so a flat array indexed by it
 * beats any hash: ~520 MB off-heap, O(1) reads, and the passes that use it are sorted by the key.
 * 0 means absent, which is also what a red link is: a title somebody linked and nobody wrote.
 */
class LtMap {
  constructor(slots = 1 << 20) {
    this.buf = Buffer.alloc(slots * 4);
  }
  #grow(slot) {
    let slots = this.buf.length / 4;
    while (slot >= slots) slots *= 2;
    const next = Buffer.alloc(slots * 4);
    this.buf.copy(next);
    this.buf = next;
  }
  set(slot, pageId) {
    if (slot * 4 + 4 > this.buf.length) this.#grow(slot);
    this.buf.writeUInt32BE(pageId, slot * 4);
  }
  get(slot) {
    if (slot * 4 + 4 > this.buf.length) return 0;
    return this.buf.readUInt32BE(slot * 4);
  }
}

// ------------------------------------------------------------------- the passes

/** 0. Every page's identity. */
async function pass0() {
  const out = writer(path("pages-raw.tsv"));
  let n = 0;
  // page: (page_id, page_namespace, page_title, page_is_redirect, page_is_new, page_random,
  //        page_touched, page_links_updated, page_latest, page_len, page_content_model, page_lang)
  for await (const f of rows(await dump("page"))) {
    expect("page", f, 12);
    await out.write(`${f[0]}\t${f[1]}\t${f[2]}\t${f[3]}\t${f[9] ?? 0}\n`);
    if (++n % 5_000_000 === 0) log(`pass 0: ${n.toLocaleString()} pages`);
    if (n >= LIMIT) break;
  }
  await out.end();
  await sorted(path("pages-raw.tsv"), path("pages.tsv"), ["1,1n"]);
  report.pages = n;
  log(`pass 0: ${n.toLocaleString()} pages`);
}

/**
 * 0b. Each page's affinity key.
 *
 * This import creates one object type and an edge already lives on its id1's vshard, so there is
 * nothing to colocate and `with:` never comes into it. The affinity key is the only placement lever
 * there is, which is why wikimedia-demo.md is right that it is *the* knob: hash the title and
 * placement spreads perfectly with no locality, key it on something that clusters and related pages
 * land on a host together. So it is a parameter, and the database can be loaded twice and compared.
 */
async function pass0b() {
  const out = writer(path("aff-raw.tsv"));
  let n = 0;
  if (AFFINITY === "category") {
    // categorylinks, as of the 2026 dumps:
    //   (cl_from, cl_sortkey, cl_timestamp, cl_sortkey_prefix, cl_type, cl_collation_id, cl_target_id)
    // `cl_to` is gone: a category is named by a linktarget id now, and cl_sortkey is a binary
    // collation key rather than a readable title. So the key is the target id — arbitrary but
    // stable, which is all a placement key has to be, and resolving it to a title would mean
    // reading linktarget here as well.
    for await (const f of rows(await dump("categorylinks"))) {
      expect("categorylinks", f, 7);
      await out.write(`${f[0]}\t${f[6]}\n`);
      if (++n % 10_000_000 === 0) log(`pass 0b: ${n.toLocaleString()} category rows`);
      if (n >= LIMIT) break;
    }
    await out.end();
    // Lowest target id per page. Which category that is, is arbitrary; that it is the same one on
    // every run is what matters, since the affinity key decides placement.
    await sorted(path("aff-raw.tsv"), path("aff-sorted.tsv"), ["1,1n", "2,2n"]);
    const aff = writer(path("affinity.tsv"));
    let last = null;
    for await (const line of lines(path("aff-sorted.tsv"))) {
      const t = line.indexOf("\t");
      const from = line.slice(0, t);
      if (from === last) continue;
      last = from;
      await aff.write(`${from}\tcat:${line.slice(t + 1)}\n`);
    }
    await aff.end();
  } else {
    // The other functions need nothing but pages.tsv, so they are derived in pass 5 instead.
    await out.end();
    await writer(path("affinity.tsv")).end();
  }
  log(`pass 0b: affinity by ${AFFINITY}`);
}

/**
 * 1. lt_id -> page_id.
 *
 * `pagelinks` carries `pl_target_id` into `linktarget`, whose rows are `(lt_id, lt_namespace,
 * lt_title)` — titles, which need not be pages. So the join is on `(ns, title)` and whatever does
 * not match is a red link. Both sides are keyed and sorted, then merged.
 */
async function pass1() {
  const out = writer(path("lt-raw.tsv"));
  let n = 0;
  for await (const f of rows(await dump("linktarget"))) {
    expect("linktarget", f, 3);
    await out.write(`${f[1]}\t${f[2]}\t${f[0]}\n`);
    if (++n % 10_000_000 === 0) log(`pass 1: ${n.toLocaleString()} link targets`);
    if (n >= LIMIT) break;
  }
  await out.end();

  const pk = writer(path("pages-keyed.tsv"));
  for await (const line of lines(path("pages.tsv"))) {
    const [pageId, ns, title] = line.split("\t");
    await pk.write(`${ns}\t${title}\t${pageId}\n`);
  }
  await pk.end();

  // Both keys sorted as bytes, on both fields, NOT numerically on the namespace. The merge below
  // compares `ns\ttitle` as one unit, and a numeric first field puts ns 14 after ns 2 in the file
  // while a byte comparison puts it before — so the page iterator, which only ever moves forward,
  // walks past every namespace above 9 and resolves nothing in it. That is exactly what happened:
  // categories are ns 14, and the first run resolved 0 of 2,258,768 memberships while links in ns 0
  // partly worked. The sort order and the comparison have to be the same relation.
  await sorted(path("lt-raw.tsv"), path("lt-sorted.tsv"), ["1,1", "2,2"]);
  await sorted(path("pages-keyed.tsv"), path("pages-by-title.tsv"), ["1,1", "2,2"]);

  const lt = new LtMap();
  let red = 0;
  let blue = 0;
  // Bytes, to match `LC_ALL=C sort`. Titles are not all ASCII, and JS compares UTF-16 code units
  // where sort compared UTF-8 bytes, which disagree above the BMP.
  const keyOf = (line) => Buffer.from(line.slice(0, line.lastIndexOf("\t")), "utf8");
  const tailOf = (line) => line.slice(line.lastIndexOf("\t") + 1);
  const pageIter = lines(path("pages-by-title.tsv"))[Symbol.asyncIterator]();
  let page = await pageIter.next();
  let pageKey = page.done ? null : keyOf(page.value);
  for await (const line of lines(path("lt-sorted.tsv"))) {
    const key = keyOf(line);
    while (!page.done && Buffer.compare(pageKey, key) < 0) {
      page = await pageIter.next();
      pageKey = page.done ? null : keyOf(page.value);
    }
    if (!page.done && Buffer.compare(pageKey, key) === 0) {
      lt.set(Number(tailOf(line)), Number(tailOf(page.value)));
      blue++;
    } else red++;
  }
  const share = red / (red + blue || 1);
  report.linkTargets = { resolved: blue, red, redShare: Number(share.toFixed(4)) };
  log(`pass 1: ${blue.toLocaleString()} resolved, ${red.toLocaleString()} red (${(share * 100).toFixed(1)}%)`);
  // Red links are ordinary — someone linked a title nobody wrote. Almost everything being red is
  // not: it means the (ns, title) key is not matching, and every edge pass would quietly emit
  // nothing.
  if (share > 0.9) throw new Error(`pass 1: ${(share * 100).toFixed(1)}% red — the (ns, title) join is not matching`);
  return lt;
}

/** The `pagelinks` rows as `(pl_from, pl_target_id)`, written once and read by passes 2 and 3. */
async function extractPagelinks() {
  const raw = path("pl.tsv");
  if (existsSync(raw)) return raw;
  const out = writer(raw);
  let n = 0;
  // pagelinks: (pl_from, pl_from_namespace, pl_target_id)
  for await (const f of rows(await dump("pagelinks"))) {
    expect("pagelinks", f, 3);
    await out.write(`${f[0]}\t${f[2]}\n`);
    if (++n % 50_000_000 === 0) log(`pagelinks: ${n.toLocaleString()} rows`);
    if (n >= LIMIT) break;
  }
  await out.end();
  report.pagelinks = n;
  log(`pagelinks: ${n.toLocaleString()} rows`);
  return raw;
}

/** 2 and 3. Both directions of the link graph, as edges keyed by the page they hang off. */
async function passLinks(lt, out) {
  const raw = await extractPagelinks();
  let fwd = 0;
  let dropped = 0;
  for await (const line of lines(raw)) {
    const t = line.indexOf("\t");
    const from = line.slice(0, t);
    const target = lt.get(Number(line.slice(t + 1)));
    if (!target) {
      dropped++;
      continue;
    }
    // `time` is 0: the dump does not record where in an article a link appeared, so there is no
    // ordinal and the primary key's id2 breaks the tie. Stable, and arbitrary.
    await out.write(`${from}\twiki.page_links\t${target}\t0\n`);
    await out.write(`${target}\twiki.linked_from\t${from}\t0\n`);
    if (++fwd % 20_000_000 === 0) log(`passes 2-3: ${fwd.toLocaleString()} links both ways`);
  }
  report.links = { emitted: fwd, droppedRed: dropped };
  log(`passes 2-3: ${fwd.toLocaleString()} links, ${dropped.toLocaleString()} dropped as red`);
}

/** 4. Both directions of category membership. */
async function passCategories(lt, out) {
  let n = 0;
  let dropped = 0;
  for await (const f of rows(await dump("categorylinks"))) {
    expect("categorylinks", f, 7);
    const target = lt.get(Number(f[6]));
    if (!target) {
      // A category nobody has created is a red link like any other.
      dropped++;
      continue;
    }
    // cl_timestamp is a DATETIME, `2025-02-17 19:20:02`, and becomes the edge's sort key.
    const ts = Math.floor(new Date(`${f[2].replace(" ", "T")}Z`).getTime() / 1000) || 0;
    await out.write(`${f[0]}\twiki.page_categories\t${target}\t${ts}\n`);
    await out.write(`${target}\twiki.category_pages\t${f[0]}\t${ts}\n`);
    if (++n % 10_000_000 === 0) log(`pass 4: ${n.toLocaleString()} memberships`);
    if (n >= LIMIT) break;
  }
  report.categories = { emitted: n, droppedRed: dropped };
  log(`pass 4: ${n.toLocaleString()} memberships, ${dropped.toLocaleString()} dropped`);
  // This number also checks an assumption: cl_target_id is read as a linktarget id, by analogy with
  // pl_target_id and because cl_to is gone. The column shape says so; no id was resolved end to end
  // to prove it. If the column indexes something else, nearly everything drops.
  if (n > 0 && dropped / (dropped + n) > 0.9) {
    throw new Error(
      `pass 4: ${((dropped / (dropped + n)) * 100).toFixed(1)}% dropped — cl_target_id does not look ` +
        `like a linktarget id after all. Check the categorylinks column layout.`,
    );
  }
  if (n === 0 && dropped > 0) throw new Error(`pass 4: every one of ${dropped} rows dropped; see above`);
}

/**
 * The affinity key for a page: which objects this one expects to be read with.
 *
 * `preKey` is whatever an earlier pass computed for this page and `records` joined back on by page
 * id -- the first category under `category`, the graph part under `graph`. Everything else needs
 * only the page itself.
 */
function affinityOf(ns, title, preKey, which = AFFINITY) {
  switch (which) {
    case "category":
      // Spread the pages that have no category rather than collapsing them onto one key. 48% of
      // simplewiki pages have none, and `ns:0` for all of them is one affinity key, which is one
      // vshard on one host.
      return preKey ?? affinityOf(ns, title, null, "hash");
    case "graph":
      // Placement derived from the link graph: see scripts/partition-wiki.mjs, which writes
      // partition.tsv. Measured against this wiki it touches 8.6 hosts of 43 where the first
      // category touches 20.8 and a title hash 27.7 -- because a page's categories describe the
      // page and its links point away from it, so a category colocates almost nothing a traversal
      // actually reads.
      //
      // The fallback should never fire: partition.tsv covers every page in pages.tsv. It is a hash
      // rather than a throw because one unpartitioned page is worth a slightly worse placement and
      // not a failed import -- and `records` counts them, so it cannot pass unnoticed.
      return preKey ?? affinityOf(ns, title, null, "hash");
    case "namespace":
      return `ns:${ns}`;
    case "initial":
      return `ns:${ns}:${title.slice(0, 1).toLowerCase()}`;
    case "hash": {
      // Spreads perfectly and buys no locality at all — the control case the comparison needs.
      let h = 2166136261;
      for (let i = 0; i < title.length; i++) h = ((h ^ title.charCodeAt(i)) * 16777619) >>> 0;
      return `h:${h % 4096}`;
    }
    default:
      throw new Error(`unknown --affinity ${which}`);
  }
}

/**
 * 5. One record per page, with its outbound edges.
 *
 * Three streams all ordered by page id — pages, affinity keys and edges — merged in one pass, so
 * nothing but the current page's edge list is ever in memory. A page with a million backlinks is the
 * one that makes that worth doing.
 */
/** Default ceiling on edges carried in one record. See `records`. */
export const MAX_EDGES_PER_RECORD = 50_000;

/**
 * 5. The record stream: one record per page, with its outbound edges.
 *
 * **A generator, not a file.** The seam is the record shape, so a loader in the same process can
 * `for await (const r of records())` and partition by `(host, vshard)` as it reads — 128 open
 * buffers in one pass, not a sort. Materializing this as JSONL instead costs ~164 GB at enwiki
 * scale, duplicates a checkpoint `edges.tsv` already provides, and is discarded by the second
 * affinity load anyway; `writeRecords` below still writes it, because handing someone a file is
 * worth one function. docs/wikimedia-import.md has the arithmetic.
 *
 * Three streams all ordered by page id — pages, affinity keys and edges — merged in one pass, so
 * nothing but the current page's edge list is ever held.
 *
 * **That edge list is the thing to bound.** A page with a million backlinks would otherwise
 * materialize a million objects, which is the high-degree hazard arriving in the importer rather
 * than in a vshard. So a page's edges are split across **continuation records**: the same `key`,
 * `affinity`, `type` and `fields` repeated, `more: true` on every record but the last. Edge writes
 * are independent and an object write is idempotent, so a consumer can apply them in order and
 * needs no special case beyond not treating a repeated key as a duplicate page.
 */
export async function* records(opts = {}) {
  const dir = opts.work ?? WORK;
  const at = (f) => join(dir, f);
  const affinity = opts.affinity ?? AFFINITY;
  const maxEdges = opts.maxEdges ?? MAX_EDGES_PER_RECORD;

  // Sort only when the spool is newer than the sorted copy. A consumer that iterates records many
  // times should not pay a 1.4 GB sort per iteration — measured at 40 s for simplewiki, which at
  // enwiki scale would be the whole run again.
  const raw = at("edges-raw.tsv");
  const sortedFile = at("edges.tsv");
  const stale = existsSync(raw) && (!existsSync(sortedFile) || statSync(raw).mtimeMs > statSync(sortedFile).mtimeMs);
  if (stale) await sorted(raw, sortedFile, ["1,1n"]);
  else if (!existsSync(sortedFile)) throw new Error(`${sortedFile} is missing; run passes 2-4 first`);

  // The side file holding the key an earlier pass computed per page, which differs by mode but not
  // in shape: `page_id \t key`, ascending by page id, so it merges the same way either way.
  const sideFile = affinity === "graph" ? "partition.tsv" : "affinity.tsv";
  if (affinity === "graph" && !existsSync(at(sideFile))) {
    throw new Error(`--affinity graph needs ${at(sideFile)}; run scripts/partition-wiki.mjs first`);
  }
  const affIter = lines(at(sideFile))[Symbol.asyncIterator]();
  let aff = await affIter.next();
  let unkeyed = 0;
  const edgeIter = lines(at("edges.tsv"))[Symbol.asyncIterator]();
  let edge = await edgeIter.next();

  for await (const line of lines(at("pages.tsv"))) {
    const [pageIdStr, ns, title, redirect, len] = line.split("\t");
    const pageId = Number(pageIdStr);

    while (!aff.done && Number(aff.value.slice(0, aff.value.indexOf("\t"))) < pageId) aff = await affIter.next();
    let preKey = null;
    if (!aff.done) {
      const t = aff.value.indexOf("\t");
      if (Number(aff.value.slice(0, t)) === pageId) preKey = aff.value.slice(t + 1);
    }
    if (preKey === null && affinity === "graph") unkeyed++;

    while (!edge.done && Number(edge.value.slice(0, edge.value.indexOf("\t"))) < pageId) edge = await edgeIter.next();

    const head = {
      key: pageIdStr,
      affinity: affinityOf(Number(ns), title, preKey, affinity),
      type: "wiki.page",
      fields: { ns: Number(ns), title, redirect: redirect === "1", len: Number(len) },
    };

    // Gather up to maxEdges, then look one further: a record claims `more` only when another edge
    // for this page really exists, so a page with exactly maxEdges edges yields one record.
    let edges = [];
    for (;;) {
      while (!edge.done && edges.length < maxEdges) {
        const parts = edge.value.split("\t");
        if (Number(parts[0]) !== pageId) break;
        const e = { type: parts[1], to: parts[2] };
        if (parts[3] !== "0") e.time = Number(parts[3]);
        edges.push(e);
        edge = await edgeIter.next();
      }
      const more = !edge.done && Number(edge.value.slice(0, edge.value.indexOf("\t"))) === pageId;
      yield more ? { ...head, edges, more: true } : { ...head, edges };
      if (!more) break;
      edges = [];
    }
  }

  // A page the partition missed is placed by title hash, which is correct and unplaced. Said out
  // loud because it is otherwise invisible: the load succeeds and the comparison quietly measures a
  // mixture of two placements.
  if (unkeyed > 0) console.warn(`records: ${unkeyed} page(s) absent from ${sideFile}, placed by title hash`);
}

/** Writes the record stream to `records.jsonl`. A convenience, not the intended path. */
async function writeRecords() {
  const out = writer(path("records.jsonl"));
  let n = 0;
  let pages = 0;
  let edgesOut = 0;
  let continued = 0;
  for await (const r of records()) {
    await out.write(JSON.stringify(r) + "\n");
    edgesOut += r.edges.length;
    if (r.more) continued++;
    else pages++;
    if (++n % 2_000_000 === 0) log(`pass 5: ${n.toLocaleString()} records`);
  }
  await out.end();
  report.records = { pages, edges: edgesOut, continuations: continued };
  log(
    `pass 5: ${pages.toLocaleString()} pages, ${edgesOut.toLocaleString()} edges, ` +
      `${continued.toLocaleString()} continuation record(s) -> records.jsonl`,
  );
}

// ------------------------------------------------------------------- run
//
// Guarded, so the parser above can be imported and tested without starting an import.

if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await run();

async function run() {
  mkdirSync(WORK, { recursive: true });
  log(`importing ${WIKI} ${DATE}, affinity=${AFFINITY}, work dir ${WORK}`);
  if (PASSES.has("0")) await pass0();
  if (PASSES.has("0b")) await pass0b();
  let lt;
  if (PASSES.has("1")) lt = await pass1();
  if (PASSES.has("2") || PASSES.has("3") || PASSES.has("4")) {
    if (!lt) throw new Error("passes 2-4 need pass 1's lt map in the same run");
    const out = writer(path("edges-raw.tsv"));
    if (PASSES.has("2") || PASSES.has("3")) await passLinks(lt, out);
    if (PASSES.has("4")) await passCategories(lt, out);
    await out.end();
  }
  if (PASSES.has("5")) await writeRecords();
  writeFileSync(path("report.json"), JSON.stringify({ wiki: WIKI, date: DATE, affinity: AFFINITY, ...report }, null, 2));
  log(`done; report at ${path("report.json")}`);
}
