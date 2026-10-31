// Derives an affinity key from the link graph itself, because the demo's first answer was that
// metadata cannot supply one. See docs/wikimedia-demo.md.
//
// WHY THIS EXISTS. Placement in hlekk is decided by one string per object: objects sharing an
// affinity key land in one vshard, and a vshard lives on one host. So the key is a *guess about
// which objects get read together*, and the demo measures how good the guess is by how many hosts
// one page's links are spread over.
//
// The first guess was a page's first category. Measured, it buys 1.27x over a title hash — because
// a page's categories describe the page and its links point *away* from it. `April` is in
// `Category:Months` and links to `Gregorian_calendar`, `Aries`, `Easter`: its ~65 outlinks carry
// 32-50 *distinct* first categories, so there is almost nothing to colocate. That is not a flaw in
// simplewiki; it is what an encyclopedia is.
//
// This stops guessing. The edge list is a recorded copy of the traversals the demo performs, so the
// key is derived from it: partition the graph so that few edges cross a part, then name the part.
// The partitioner's objective — edges cut — *is* the metric the A/B measures, which is the whole
// reason to do it this way rather than hunt for a cleverer piece of metadata.
//
//   node scripts/partition-wiki.mjs --cluster cluster.json
//   node scripts/partition-wiki.mjs --parts 43 --rounds 20 --eps 0.05
//
// `--cluster` is a copy of `GET /admin/where`, and with it the partition is computed against the
// real cluster: one part per host, split across that host's own vshards. Without it there is
// nothing to align to and `--parts` is taken at its word.
//
// Output, in the work directory:
//   graph.bin       the symmetric adjacency, cached — building it reads 1.4 GB
//   parts-<k>.bin   one Int32 part number per page, in pages.tsv order
//   partition.tsv   page_id -> affinity key, for `--affinity graph` to join on
//
// The algorithm is capacity-constrained asynchronous label propagation: start from an exactly
// balanced random assignment, then repeatedly move each page to whichever part most of its
// neighbours are already in, refusing a move that would overfill. Asynchronous — a move is visible
// to the next page in the same round — because it converges in far fewer passes than recomputing
// every label from the previous round, and nothing here needs the determinism that would buy.
//
// Balance is a constraint and not an afterthought. Unconstrained label propagation collapses to one
// label per connected component, which is a perfect score for a useless partition. The category
// placement showed the other end of the same problem from the other direction: one host held 20.1%
// of all edges, and the skew cost 4.8x on write throughput. A partition that is not balanced is not
// an improvement.

import { createReadStream, createWriteStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const WIKI = args.get("wiki") ?? "simplewiki";
const DATE = args.get("date") ?? "20261001";
const WORK = args.get("work") ?? join(".wrangler", `import-${WIKI}-${DATE}`);
const PARTS = Number(args.get("parts") ?? 192);
const ROUNDS = Number(args.get("rounds") ?? 40);
/**
 * How far a part may run over its share before a move into it is refused.
 *
 * 0.20, chosen by measurement rather than taste: tighter costs locality for balance nobody needs,
 * and looser buys almost nothing. At this setting the heaviest host holds 1.20x the average edge
 * count -- better balanced than the title-hash control's 1.46x, which matters because a placement
 * that won on balance rather than on locality would be answering a different question.
 */
const EPS = Number(args.get("eps") ?? 0.2);
/** How hard a part's current load pushes back, in units of "one neighbour's vote". A page with 45
 *  neighbours is the average, so a few votes' worth of pressure is enough to keep parts level
 *  without letting load decide a placement the graph has a clear opinion about. */
const GAMMA = Number(args.get("gamma") ?? 6);
/**
 * What a part's load counts: `degree` for stored edges, `page` for a flat count per page.
 *
 * `degree` by default, because the edges are the bytes. simplewiki holds 950,421 pages and
 * 42,817,596 edges, so a part holding average pages with twice the average degree holds twice the
 * data while looking perfectly balanced by count — and host skew is not cosmetic here: the category
 * placement put 20.9% of all edges on one host and paid 4.8x on write throughput for it, because
 * the loader keeps one batch in flight per host and the whole load waits on the straggler.
 */
const WEIGHT = args.get("weight") ?? "degree";
const SEED = Number(args.get("seed") ?? 12345);
/**
 * Where the first assignment comes from: `bfs` or `random`.
 *
 * It matters more than it sounds. Label propagation is local search, so it improves whatever it is
 * handed and cannot undo a bad start; from a random assignment every part is smeared across the
 * whole graph and the first rounds are spent undoing that. A breadth-first walk hands it blocks that
 * are already connected, and the search starts from somewhere the graph suggested.
 */
const INIT = args.get("init") ?? "bfs";

const path = (f) => join(WORK, f);
const started = Date.now();
const log = (...m) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, ...m);
const lines = (file) => createInterface({ input: createReadStream(file), crlfDelay: Infinity });

/** Mulberry32, so a run can be replayed from its seed. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the graph

/**
 * Reads `pages.tsv` into a dense node numbering.
 *
 * Page ids are sparse — simplewiki's 950,421 pages run to id 1,285,132 — and every array below is
 * indexed by node number, so the gap is worth closing once rather than carrying it through a
 * 42.8-million-entry adjacency.
 */
async function nodes() {
  const ids = [];
  for await (const line of lines(path("pages.tsv"))) ids.push(Number(line.slice(0, line.indexOf("\t"))));
  const index = new Int32Array(ids[ids.length - 1] + 1).fill(-1);
  for (let i = 0; i < ids.length; i++) index[ids[i]] = i;
  return { ids: Int32Array.from(ids), index };
}

/**
 * Scans `edges.tsv` for the two integers that matter, without allocating a string per line.
 *
 * At 42.8 million lines the parse is the cost of this script, so the file is walked as raw bytes
 * and `from` and `to` are accumulated digit by digit. `visit(from, to)` is called once per row.
 */
async function scanEdges(file, visit) {
  const stream = createReadStream(file, { highWaterMark: 1 << 22 });
  let field = 0; // 0: from, 1: type, 2: to, 3: time
  let from = 0;
  let to = 0;
  let rows = 0;
  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (c === 9) {
        field++;
      } else if (c === 10) {
        visit(from, to);
        rows++;
        field = 0;
        from = 0;
        to = 0;
      } else if (field === 0) {
        from = from * 10 + (c - 48);
      } else if (field === 2) {
        to = to * 10 + (c - 48);
      }
    }
  }
  return rows;
}

/**
 * The symmetric adjacency, in CSR, cached on disk.
 *
 * `edges.tsv` already holds both directions of both relations — `wiki.page_links` A->B and
 * `wiki.linked_from` B->A are the same edge written twice, and the two category relations likewise
 * — so taking every row as a directed entry yields a symmetric adjacency with no extra work and no
 * deduplication. Links and category membership both go in: the read the demo measures fetches both,
 * so both are edges the partition should try not to cut.
 */
async function graph(node) {
  const n = node.ids.length;
  const cache = path("graph.bin");
  if (existsSync(cache) && statSync(cache).mtimeMs > statSync(path("edges.tsv")).mtimeMs) {
    const buf = readFileSync(cache);
    const off = new Int32Array(buf.buffer, buf.byteOffset, n + 1);
    const adj = new Int32Array(buf.buffer, buf.byteOffset + (n + 1) * 4, (buf.length - (n + 1) * 4) / 4);
    log(`graph: ${adj.length} entries from cache`);
    return { off, adj };
  }

  const deg = new Int32Array(n);
  let dropped = 0;
  const count = (from, to) => {
    const u = from <= node.index.length - 1 ? node.index[from] : -1;
    const v = to <= node.index.length - 1 ? node.index[to] : -1;
    if (u < 0 || v < 0) dropped++;
    else deg[u]++;
  };
  const rows = await scanEdges(path("edges.tsv"), count);
  log(`graph: ${rows} rows, ${dropped} with an endpoint outside pages.tsv`);

  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + deg[i];
  const adj = new Int32Array(off[n]);
  const at = Int32Array.from(off.subarray(0, n));
  await scanEdges(path("edges.tsv"), (from, to) => {
    const u = from <= node.index.length - 1 ? node.index[from] : -1;
    const v = to <= node.index.length - 1 ? node.index[to] : -1;
    if (u >= 0 && v >= 0) adj[at[u]++] = v;
  });

  const out = createWriteStream(cache);
  out.write(Buffer.from(off.buffer, off.byteOffset, off.byteLength));
  out.write(Buffer.from(adj.buffer, adj.byteOffset, adj.byteLength));
  await new Promise((done) => out.end(done));
  log(`graph: ${adj.length} entries, cached`);
  return { off, adj };
}

// ---------------------------------------------------------------- partitioning

/** Edges cut, and how many distinct parts an average page's neighbourhood spans. The second is the
 *  one that matters: it is the simulated host count, before the vshard mapping rounds it down. */
function measure(g, label, k, n) {
  let cut = 0;
  let spanTotal = 0;
  let isolated = 0;
  const seen = new Int32Array(k).fill(-1);
  for (let i = 0; i < n; i++) {
    const mine = label[i];
    let span = 0;
    for (let e = g.off[i]; e < g.off[i + 1]; e++) {
      const p = label[g.adj[e]];
      if (p !== mine) cut++;
      if (seen[p] !== i) {
        seen[p] = i;
        span++;
      }
    }
    if (g.off[i + 1] === g.off[i]) isolated++;
    else spanTotal += span;
  }
  return { cut: cut / 2, cutShare: cut / g.adj.length, span: spanTotal / (n - isolated), isolated };
}

/**
 * Capacity-constrained asynchronous label propagation.
 *
 * Each page moves to whichever part holds most of its neighbours, scored against that part's
 * current load so that the parts stay level, and refused outright past a hard ceiling. The ceiling
 * is what stops the whole graph collapsing onto one label; the soft term is what keeps it from
 * jamming against the ceiling, which is what a hard constraint alone does when every part starts
 * exactly full.
 */
function partition(g, n, k) {
  const random = rng(SEED);
  const label = new Int32Array(n);
  const load = new Float64Array(k);
  const weight = WEIGHT === "page" ? () => 1 : (i) => g.off[i + 1] - g.off[i];
  let totalWeight = 0;
  for (let i = 0; i < n; i++) totalWeight += weight(i);
  const target = totalWeight / k;
  const cap = target * (1 + EPS);
  log(`parts: ${k} of ${Math.round(target)} ${WEIGHT === "page" ? "pages" : "edges"} each, ceiling ${Math.round(cap)}`);

  // A random visiting order, which is also the random initial assignment when asked for one.
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }

  if (INIT === "random") {
    // Exactly balanced and entirely unlocal: every part smeared over the whole graph.
    for (let i = 0; i < n; i++) {
      const p = i % k;
      label[order[i]] = p;
      load[p] += weight(order[i]);
    }
  } else {
    // Breadth-first from the heaviest page, filling one part to its share before opening the next,
    // so each part starts as a connected region. Components are walked in turn: simplewiki's link
    // graph is not connected, and an unvisited page would otherwise never be reached.
    const queue = new Int32Array(n);
    const seen = new Uint8Array(n);
    let head = 0;
    let tail = 0;
    let p = 0;
    const share = totalWeight / k;
    const seeds = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => g.off[b + 1] - g.off[b] - (g.off[a + 1] - g.off[a]),
    );
    let si = 0;
    for (let placed = 0; placed < n; ) {
      if (head === tail) {
        while (si < n && seen[seeds[si]]) si++;
        if (si >= n) break;
        queue[tail++] = seeds[si];
        seen[seeds[si]] = 1;
      }
      const i = queue[head++];
      if (p < k - 1 && load[p] >= share) p++;
      label[i] = p;
      load[p] += weight(i);
      placed++;
      for (let e = g.off[i]; e < g.off[i + 1]; e++) {
        const v = g.adj[e];
        if (!seen[v]) {
          seen[v] = 1;
          queue[tail++] = v;
        }
      }
    }
    // Anything the walk never reached -- a page with no edges at all -- to the emptiest part.
    for (let i = 0; i < n; i++) {
      if (seen[i]) continue;
      let best = 0;
      for (let q = 1; q < k; q++) if (load[q] < load[best]) best = q;
      label[i] = best;
      load[best] += weight(i);
    }
  }
  log(`init ${INIT}: load ${(Math.min(...load) / target).toFixed(2)}..${(Math.max(...load) / target).toFixed(2)} of target`);

  const count = new Int32Array(k);
  const touched = new Int32Array(k);
  for (let round = 1; round <= ROUNDS; round++) {
    let moves = 0;
    for (let oi = 0; oi < n; oi++) {
      const i = order[oi];
      const lo = g.off[i];
      const hi = g.off[i + 1];
      if (lo === hi) continue; // nothing links here: its part is the balancer's business, not the graph's

      let touchedN = 0;
      for (let e = lo; e < hi; e++) {
        const p = label[g.adj[e]];
        if (count[p] === 0) touched[touchedN++] = p;
        count[p]++;
      }

      const mine = label[i];
      const wi = weight(i);
      let best = mine;
      // The incumbent is scored without the load penalty of its own occupancy, so a page only
      // leaves when another part genuinely holds more of its neighbours.
      let bestScore = count[mine] - GAMMA * ((load[mine] - wi) / target);
      for (let j = 0; j < touchedN; j++) {
        const p = touched[j];
        if (p === mine || load[p] + wi > cap) continue;
        const score = count[p] - GAMMA * (load[p] / target);
        if (score > bestScore) {
          bestScore = score;
          best = p;
        }
      }
      for (let j = 0; j < touchedN; j++) count[touched[j]] = 0;

      if (best !== mine) {
        load[mine] -= wi;
        load[best] += wi;
        label[i] = best;
        moves++;
      }
    }
    const m = measure(g, label, k, n);
    log(
      `round ${round}: ${moves} moves, cut ${(m.cutShare * 100).toFixed(1)}%, ` +
        `span ${m.span.toFixed(1)} parts, load ${(Math.min(...load) / target).toFixed(2)}..` +
        `${(Math.max(...load) / target).toFixed(2)} of target`,
    );
    if (moves < n / 1000) {
      log(`round ${round}: converged`);
      break;
    }
  }
  return { label, load };
}


// ---------------------------------------------------------------- parts onto hosts

/**
 * The cluster this placement is computed against: which vshards take new roots, and whose host each
 * one is on. Taken from `GET /admin/where` on the live database rather than assumed, because every
 * number below depends on it — `Allocator.place` indexes into exactly this set, and a key tuned
 * against the wrong size lands somewhere arbitrary.
 *
 * `init` is deterministic, so the two deployments already loaded have byte-identical maps and a
 * third built the same way will match. That is a convenience, not a guarantee: it is read, not
 * recomputed.
 */
function cluster(file) {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const index = new Set(raw.index.map(Number));
  const active = Object.keys(raw.map)
    .map(Number)
    .filter((v) => !index.has(v))
    .sort((a, b) => a - b);
  const hostOf = new Map(Object.entries(raw.map).map(([v, h]) => [Number(v), h]));
  const hosts = [...new Set(active.map((v) => hostOf.get(v)))].sort((a, b) => a - b);
  // A host's own vshards, in order, which is the capacity it has for parts.
  const slotsOf = new Map(hosts.map((h) => [h, active.map((v, i) => [v, i]).filter(([v]) => hostOf.get(v) === h)]));
  return { active, hostOf, hosts, slotsOf };
}

/**
 * Splits each host's pages across the vshards that host holds.
 *
 * This is deliberately the dumb half. The demo counts *hosts*, and every page of a host-part is on
 * that host whichever of its vshards it lands on — so which one is free, and the only thing it has
 * to get right is balance. Longest-processing-time-first: heaviest page to the emptiest vshard,
 * which lands within a page's degree of perfect.
 *
 * A vshard is still the unit of movement, so the split is not pointless: it is what leaves the
 * database able to shed a quarter of a host later instead of all of it. It is simply not what the
 * placement question is about.
 */
function splitWithinHosts(g, n, hostPart, cl) {
  const H = cl.hosts.length;
  const byHost = Array.from({ length: H }, () => []);
  for (let i = 0; i < n; i++) byHost[hostPart[i]].push(i);

  const part = new Int32Array(n);
  const slotOfPart = [];
  const partLoad = [];
  for (let h = 0; h < H; h++) {
    const slots = cl.slotsOf.get(cl.hosts[h]).map(([, i]) => i);
    const first = slotOfPart.length;
    for (const s of slots) {
      slotOfPart.push(s);
      partLoad.push(0);
    }
    const nodes = byHost[h].sort((a, b) => g.off[b + 1] - g.off[b] - (g.off[a + 1] - g.off[a]));
    for (const i of nodes) {
      let best = first;
      for (let j = first + 1; j < first + slots.length; j++) if (partLoad[j] < partLoad[best]) best = j;
      part[i] = best;
      partLoad[best] += g.off[i + 1] - g.off[i];
    }
  }
  const lo = Math.min(...partLoad);
  const hi = Math.max(...partLoad);
  const mean = partLoad.reduce((a, b) => a + b, 0) / partLoad.length;
  log(
    `vshards: ${slotOfPart.length} parts over ${H} hosts, ` +
      `edge load ${(lo / mean).toFixed(2)}..${(hi / mean).toFixed(2)} of even`,
  );
  return { part, slotOfPart: Int32Array.from(slotOfPart) };
}

// ---------------------------------------------------------------- the key

/**
 * Names each part so that it lands on the vshard chosen for it.
 *
 * `Allocator.place` does `active[fnv(key) % active.length]`, so the key alone decides the vshard.
 * That is the whole seam this script works through: it writes no placement, holds no table and
 * needs no change to the engine — it chooses a string, and the engine does what it always does with
 * one. The nonce is the search for a string that lands where the partition says.
 *
 * Collisions are what the nonce avoids. Two parts sharing a vshard would merge neighbourhoods the
 * partitioner worked to separate and unbalance the hosts, for reasons having nothing to do with the
 * graph — noise from a hash function, reported as a result about locality.
 */
function keys(k, slots, slotOfPart) {
  const fnv = (key) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
    return h >>> 0;
  };
  const out = new Array(k);
  let tries = 0;
  for (let p = 0; p < k; p++) {
    const want = slotOfPart[p];
    for (let nonce = 0; ; nonce++) {
      const key = `g${p}.${nonce}`;
      tries++;
      if (fnv(key) % slots === want) {
        out[p] = key;
        break;
      }
      if (nonce > 1_000_000) throw new Error(`no key for part ${p} landing on slot ${want}`);
    }
  }
  log(`keys: ${k} parts, ${tries} hashes, ${(tries / k).toFixed(0)} per part`);
  return out;
}

// ---------------------------------------------------------------- run

async function run() {
  const clusterFile = args.get("cluster");
  const cl = clusterFile === undefined ? null : cluster(clusterFile);
  const slots = cl === null ? Number(args.get("slots") ?? 192) : cl.active.length;

  const node = await nodes();
  const n = node.ids.length;
  log(`nodes: ${n} pages, ids to ${node.ids[n - 1]}`);
  const g = await graph(node);

  /**
   * Partition at the granularity the question is asked at.
   *
   * With the cluster's shape in hand that is the *host* count, not the vshard count, and getting
   * this the wrong way round is the mistake worth naming: a read's cost is the number of hosts it
   * touches, so the host boundary is the one the cut has to avoid. Partitioning into 192 vshards
   * and then grouping those onto 43 hosts was tried and is worse — the first level spends its
   * effort on boundaries the second level then dissolves, and the measured gap was 11.2 hosts
   * against 9.1 for partitioning into 43 directly.
   *
   * Without a cluster file there is nothing to align to and `--parts` means what it says.
   */
  const k = cl === null ? PARTS : cl.hosts.length;
  log(`partitioning ${WORK} into ${k} parts${cl === null ? ` over ${slots} vshards` : ` -- one per host`}`);
  const { label, load } = partition(g, n, k);
  writeFileSync(path(`parts-${k}.bin`), Buffer.from(label.buffer, label.byteOffset, label.byteLength));

  let part = label;
  let slotOfPart;
  if (cl === null) {
    slotOfPart = Int32Array.from({ length: k }, (_, p) => Math.floor((p * slots) / k) % slots);
  } else {
    const split = splitWithinHosts(g, n, label, cl);
    part = split.part;
    slotOfPart = split.slotOfPart;
  }

  const key = keys(slotOfPart.length, slots, slotOfPart);
  const out = createWriteStream(path("partition.tsv"));
  for (let i = 0; i < n; i++) {
    if (!out.write(`${node.ids[i]}\t${key[part[i]]}\n`)) await new Promise((d) => out.once("drain", d));
  }
  await new Promise((done) => out.end(done));

  const m = measure(g, label, k, n);
  const report = {
    wiki: WIKI,
    date: DATE,
    parts: k,
    vshardParts: slotOfPart.length,
    slots,
    weight: WEIGHT,
    rounds: ROUNDS,
    eps: EPS,
    gamma: GAMMA,
    seed: SEED,
    cluster: clusterFile ?? null,
    hosts: cl === null ? null : cl.hosts.length,
    pages: n,
    edges: g.adj.length / 2,
    isolated: m.isolated,
    cut: m.cut,
    cutShare: m.cutShare,
    span: m.span,
    load: {
      min: Math.min(...load) / (load.reduce((a, b) => a + b, 0) / k),
      max: Math.max(...load) / (load.reduce((a, b) => a + b, 0) / k),
    },
  };
  writeFileSync(path(`partition-${k}.json`), JSON.stringify(report, null, 2));
  log(`wrote partition.tsv and partition-${k}.json`);
  log(`cut ${(m.cutShare * 100).toFixed(1)}% of edges, mean neighbourhood spans ${m.span.toFixed(1)} of ${k} hosts`);
}

await run();
