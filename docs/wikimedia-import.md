# The Wikimedia import

Oct 30, 2026 · @Matt Wonlaw

The import side of [`wikimedia-demo.md`](wikimedia-demo.md): which dumps, how big they really are,
how they map onto the catalog, and the record stream the loader consumes. That doc owns the demo —
the topology, the measured fan-out, the chunked-snapshot primitive, the query surface and the
editor's risks. This one owns everything upstream of *What the import branch needs to emit*, and
stops at that seam.

Figures marked **measured** were read from the dumps' own artifacts; the method is named each time.
Figures marked *arithmetic* are derived, and say what they assume — which matters more than it used
to, for a reason in *What it costs*.

## What this settles

Five of the demo doc's open questions have measured answers now.

- **Redirects: 15,551,165, exact** — not "roughly 10M". Counted from the whole `redirect` table. And
  they should be **pages, not a field**: a redirect has its own title, its own row in `page`, and its
  own outbound link, and `pagelinks` resolves through `linktarget` to *titles*, so demoting one to a
  field breaks link resolution for every link that points at it. They are 23% of the page count,
  which is the cost of keeping them.
- **`MAX_PAYLOAD` does not bind.** The 2 MB row cap is only a question if article wikitext is stored,
  and this import stores a ~300-character lead extract instead — 7.26 M of them, ~2.2 GB. Full
  wikitext is a different import and a much larger one. If it is ever wanted, `page.page_len` is in
  the `page` table and gives the maximum without parsing anything.
- **Two passes, not one.** Ids must exist before edges can reference them, and the alternative is
  buffering unresolved references for 1.78 billion links. Both dumps sort cheaply on their join keys,
  so two sorted passes cost an external sort and no memory.
- **The affinity function is a parameter of the import**, which is what makes the load-it-twice
  comparison possible rather than retrospective. The default is the page's first category.
- **No non-unique index is needed.** Every read in the demo's query surface enters by `(ns, title)`
  — unique per namespace — and traverses from there. The deferred non-unique global index stays
  deferred.

And two findings that land on the demo side rather than here; both are live bugs, not preferences:

- **`client.normalize` lowercases every index key**, and MediaWiki titles are case-sensitive after the
  first character. A `${ns}:${title}` key is not enough: `Ash` and `ASH` are both real enwiki pages
  and collide under it, so the second one loaded is refused with `ValueTaken` and silently dropped.
  `titleKey` in `src/worker/wiki.ts` escapes uppercase letters to lowercase hex, which makes the key
  lowercase-stable — verified on that pair. The real fix is normalization per index rather than one
  function per database; *Global lookups and uniqueness* says values are normalized "once, in one
  place", and is right that the place has to be per index.
- **`categorylinks` has dropped `cl_to`.** As of the 2026 dumps its columns are `(cl_from,
  cl_sortkey, cl_timestamp, cl_sortkey_prefix, cl_type, cl_collation_id, cl_target_id)`: a category
  is named by a `linktarget` id now, exactly as a link target is, and `cl_sortkey` is a binary
  collation key rather than a readable title. Found by reading the bytes, and since confirmed by
  resolving ids end to end: 2,244,809 of 2,258,768 simplewiki memberships resolve through the
  `linktarget` map, so `cl_target_id` is a `linktarget` id. It is good news — category edges resolve
  through the same map the link edges use — but anything written against `cl_to` reads a collation
  blob as a title and fails silently, which is what it did here.

## The dumps, measured

`enwiki`, dump of 2026-10-01.

**Totals** — measured, from `action=query&meta=siteinfo&siprop=statistics` on en.wikipedia.org:

| | Count |
| --- | --- |
| Pages, all namespaces | 66,505,524 |
| Articles (ns 0, non-redirect) | 7,257,179 |
| Revisions (total edits) | 1,378,088,750 |
| Registered users | 55,226,076 |

`site_stats` in the SQL dump disagrees with every one of these by an order of magnitude — 137 M
edits, 724,955 articles, across seven near-identical rows. It is MediaWiki's legacy sharded counter
and it has drifted. **Do not size anything from it.**

**Row counts** — measured by streaming a 300 MiB compressed prefix of each dump, counting `),\n(`
separators and scaling by total compressed size. The method validates against the one table whose
count is known independently: it predicts 64.27 M `page` rows against the API's 66.51 M, so it runs
about 3.4% low.

| Table | Dump (gz) | gz bytes/row | Rows |
| --- | --- | --- | --- |
| `pagelinks` | 6,835 MiB | 4.02 | **~1.78 billion** |
| `templatelinks` | 4,415 MiB | 2.70 | ~1.71 billion |
| `categorylinks` | 2,432 MiB | 10.52 | **~242 million** |
| `page` | 2,320 MiB | 37.85 | ~64.3 M (true: 66.5 M) |
| `linktarget` | 1,376 MiB | 11.71 | ~123 million |
| `redirect` | 179 MiB | 12.07 | **15,551,165** (exact — whole file read) |

`templatelinks` is excluded: same shape as `pagelinks`, another ~1.7 billion edges, and it shows the
demo nothing `pagelinks` does not.

**One schema detail that shapes the mapping.** `pagelinks` stores `(pl_from, pl_from_namespace,
pl_target_id)` into `linktarget`, whose rows are `(lt_id, lt_namespace, lt_title)` — *titles*, which
need not be pages. So a link's target resolves through `linktarget` and may resolve to nothing: a red
link. The import keeps only links whose target is a real page, and reports the share dropped, since
that is the difference between the dump's row count and the database's edge count.

## The catalog

`src/worker/wiki.ts`. One object type and four edge types; the lock plans, and the query compiles.

**One object type for every namespace.** In MediaWiki a category *is* a page, and so is a template.
Giving categories their own object type would mean two types for one row in `page` and an edge whose
target type depends on a namespace — the polymorphic-target problem recorded under *Later* below.
`ns` on the payload avoids it.

**No edge type is a maintained pair, and that is a change from the first draft.** The demo doc puts
outbox delivery out of scope and says the loader materializes both halves of every pair and
`assoc_counts` for both directions, because a bulk load cannot route backlinks through the outbox —
at this volume that is millions of queued ops. An earlier version of this import kept
`page_categories`/`category_pages` as a real pair specifically to exercise the outbox at 242 million.
That is the wrong trade for a read-only demo: it buys a mechanism demonstration the demo has
explicitly excluded, and pays for it with 242 million queued ops on the critical path. So all four
types are independent, each loaded from its own sorted pass:

| Edge type | From | Sort key | Source |
| --- | --- | --- | --- |
| `wiki.page_links` | page | 0 | `pagelinks` by `pl_from` |
| `wiki.linked_from` | page | 0 | `pagelinks` by `pl_target_id` |
| `wiki.page_categories` | page | `cl_timestamp` | `categorylinks` by `cl_from` |
| `wiki.category_pages` | page (ns 14) | `cl_timestamp` | `categorylinks` by `cl_target_id` |

What that gives up is real: **nothing in the engine is enforcing that the two halves agree.**
`src/testkit/invariants.ts` checks paired types; it does not check these, so it should be extended to
check them as if they were paired. A live mirror would have to make them pairs and pay the outbox.

**`time` is 0 on the link types.** The dump does not record where in an article a link appeared, so
there is no ordinal and the primary key's `id2` breaks the tie — stable, and arbitrary. This is what
rules out the link-order demos: the "first link leads to Philosophy" walk needs link position, which
lives only in the wikitext dump. The category types get `cl_timestamp`, which the table still
carries, so "recently added to this category" is a real query.

**`with:` is never used.** There is one object type and an edge already lives on its `id1`'s vshard,
so there is nothing to colocate and no decision to make. A page's outlink list and category list are
one host and one hop by the storage layout. The only placement lever is the affinity key — which is
exactly why the demo doc is right that affinity is *the* knob here. It is also why this import
avoids the open hazard that `with` does not consult the vshard cap: it never takes that path.

## What the import emits

The seam the demo doc names: per record an **affinity key**, a **type**, a **field map**, and
**outbound edges in the source's own identifiers**. `scripts/import-enwiki.mjs` writes it as JSONL,
and owns nothing downstream — not vshard choice, not id minting, not reference resolution, not
batching, not counts, not index entries.

```jsonc
// records.jsonl
{"key":"12","affinity":"cat:1375777","type":"wiki.page",
 "fields":{"ns":0,"title":"April","redirect":false,"len":22079},
 "edges":[{"type":"wiki.page_links","to":"4"},{"type":"wiki.page_categories","to":"6","time":1739820002}]}
```

`key` and `to` are MediaWiki `page_id`s — the source's own identifiers, as the seam asks. Resolving
them to hlekk ids is the loader's, which is what lets this side be verified against the dump alone.

**It is a generator, and a file only on request.** `records()` in `scripts/import-enwiki.mjs` is an
async generator, so a loader in the same process consumes it and partitions by `(host, vshard)` as
it reads. `writeRecords` spills it to `records.jsonl` for when handing someone a file is what is
wanted; that is a convenience, not the intended path, for the reasons below.

**One addition to the shape: continuation records.** A page with a million backlinks would otherwise
materialize a million objects in the generator, which is the high-degree hazard arriving in the
importer instead of in a vshard. So a page's edges are split at `MAX_EDGES_PER_RECORD` (50,000) into
records that repeat the same `key`, `affinity`, `type` and `fields`, with `more: true` on every one
but the last. Edge writes are independent and an object write is idempotent — `install` is already
`INSERT OR REPLACE` — so a consumer applies them in order and needs no special case beyond not
treating a repeated key as a second page. Measured on simplewiki: 15 continuation records across
950,421 pages at the default, and streaming 22.3 million edges in process held **65 MB of heap**.
Folding the continuations back reproduces all 950,421 pre-split records exactly.

### The passes

| Pass | Reads | Writes | Why |
| --- | --- | --- | --- |
| 0 | `page.sql.gz` | `pages.tsv` | Every page's id, namespace, title, redirect flag, length |
| 0b | `categorylinks.sql.gz` | `affinity.tsv` | Each page's first category, as its affinity key |
| 1 | `linktarget.sql.gz` + `pages.tsv` | `lt.tsv` | `lt_id → page_id` by `(ns, title)`; misses are red |
| 2 | `pagelinks.sql.gz` | edges, by `pl_from` | Forward links |
| 3 | `pagelinks.sql.gz` | edges, by `pl_target_id` | Backlinks, materialized rather than derived |
| 4 | `categorylinks.sql.gz` | edges, both directions | Memberships and their inverse |
| 5 | the above, merged by page | `records.jsonl` | One record per page with its outbound edges |

- **Sorting is GNU `sort`.** Every join key is an integer in a fixed column.
- **The row parser is a scanner, not a `split`.** A dump is `INSERT INTO \`t\` VALUES\n(…),\n(…);`,
  one row per line, but a quoted field can hold a newline, a comma or an escaped quote, so neither
  character can be split on. Verified against 200,000 real `page` rows and against a unit case for
  each escape plus a row cut by a chunk boundary.
- **Every pass asserts its table's column count**, because `categorylinks` already proved that a
  changed schema parses fine and produces nonsense. Principle 7.
- **The two joins refuse to continue past 90% unresolved.** A sparse wiki has red links; a wrong key
  column has almost nothing else. This is not a theoretical guard — it caught the bug below on the
  first run.

**It has run, on `simplewiki`, end to end: 139 seconds for 950,421 pages and 42,817,596 edges.**

| | |
| --- | --- |
| Pages | 950,421 |
| `pagelinks` rows read | 25,392,774 |
| Links emitted | 19,163,989 each way; 6,228,785 dropped as red (24.5%) |
| Memberships emitted | 2,244,809 each way; 13,959 dropped (0.6%) |
| Records | 950,421, carrying 42,817,596 edges |
| `records.jsonl` | 1.9 GB |

Edges cross-check exactly — `links × 2 + categories × 2` is the reported 42,817,596 — and the record
for page 1 is `April`, ns 0, with 414 outlinks, 156 backlinks and 2 categories. 52% of pages got a
category affinity key; the other 48% have no categories at all and fall back to `ns:`, which is
worth knowing before treating category affinity as the only knob.

### The intermediate should not be a file

`records.jsonl` is 1.9 GB for 1% of enwiki, which extrapolates to **~164 GB** — the file is ~94%
edge bytes at a measured **46.9 bytes per edge**, and enwiki should carry ~3.5 billion edges once
red links are dropped. (An earlier draft said ~130 GB by scaling page counts; the file scales with
edges.)

Three reasons it is a generator the loader pulls from rather than a file, in decreasing order of how
much they settle:

- **The checkpoint already exists one step earlier.** The one good reason to materialize is
  resumability, which this doc's demo counterpart rightly puts above throughput. But `edges.tsv` has
  to exist regardless — the external sort produces it — and it holds the same information at 33.7
  bytes/edge. Pass 5 is a deterministic three-way merge over already-sorted files: **measured at 58
  seconds** to regenerate all 42,817,596 simplewiki records from the existing intermediates,
  touching no dump and re-sorting nothing. So `records.jsonl` is a second copy of a checkpoint that
  already exists, 1.4× larger, buying no resumability the first one does not.
- **The affinity comparison invalidates it anyway.** Loading twice to show the affinity knob varies a
  per-page field and leaves every edge alone — verified over 300,000 records: 100% identical edge
  lists, 100% changed affinity keys. A materialized `records.jsonl` is an artifact the second load
  discards, while `edges.tsv`, the expensive thing, survives both. `--passes 0b,5` is the re-run.
- **JSON spends most of the file on a constant.** 25 of those 46.9 bytes per edge are the literal
  `"type":"wiki.linked_from"`, repeated per edge, to carry an atype with four possible values. TSV
  with an integer atype holds the same 3.5 billion edges in ~49 GB. If a materialized form is wanted
  — to hand someone the file, say — it should be that one.

What made this less trivial than "just stream it", and is now handled: the loader needs records
grouped by `(host, vshard)`, not by `page_id`, so it cannot consume a stream and write directly —
but at 128 vshards that is 128 open buffers in one pass, not a sort. And a generator yielding whole
records puts a high-degree page's entire edge list in memory, which is what continuation records
above are for. **The seam itself did not move** — the contract is the record shape, not a file.

**Peak disk is the figure this rolls up into.** At enwiki scale: `edges-raw` ~118 GB, `edges.tsv`
another ~118 GB, `sort`'s own temp space ~118 GB while it merges, `records.jsonl` ~164 GB, and ~20 GB
for everything else — **~540 GB of intermediate to build a ~250–300 GB database.** Dropping the
JSONL takes that under 400 GB; an integer atype in `edges.tsv` takes it further.

### The bug the guard caught

Worth recording because it is the shape of bug that this kind of pipeline produces: **silence, not
failure.**

The first run resolved **0 of 2,258,768 memberships**, and it was not `cl_target_id`. The merge join
in pass 1 walked two files sorted with `sort -k1,1n -k2,2` — the namespace *numeric* — while
comparing the combined `ns\ttitle` key as a **string**. Numerically ns 14 follows ns 2; as a string
it precedes it. The page iterator only moves forward, so it ran past every namespace above 9 and
resolved nothing in any of them. Categories are ns 14, so they resolved nothing at all; links are
mostly ns 0, which happens to sort first either way, so they partly worked and looked fine.

Both files now sort in byte order on both fields under `LC_ALL=C`, and the comparison compares UTF-8
bytes with `Buffer.compare` — because JS compares UTF-16 code units where `sort` compared bytes, and
those disagree above the BMP. The rule it violated is worth stating plainly: **a merge join is
correct only while the order its input was sorted in and the order its comparison uses are the same
relation.** Nothing fails when they differ; matches are just missed.

The fix moved link resolution from 17,257,881 to 19,163,989 and memberships from 0 to 2,244,809.

## A low-scale ingest, which works

`npm run ingest:local` — `scripts/ingest-local.ts`. A `LocalCluster`: the directory, the hosts, the
allocator and the query plane in one process over real SQLite, fed real records from the import
generator. It is **not** the loader `wikimedia-demo.md` asks for and says nothing about scale — it
writes one mutation per row through the ordinary client, and the chunked snapshot is untouched. What
it establishes is that the schema, the record shape and the entry point are right, which is worth
knowing first and costs a minute.

At 10,000 pages and 3,125,310 edges over 128 vshards and 50 hosts, in 64 seconds, **7/7**:

| Check | Result |
| --- | --- |
| Every emitted edge written | 3,125,310 of 3,125,310 |
| No outbox op needed | 0 queued — nothing is a pair, as intended |
| Pages spread across hosts | 43 of 50 |
| Every page findable by `(ns, title)` | 10,000 found, 0 wrong |
| Maintained counts equal the records' degrees | 25/25 sampled, e.g. `France` 209 links / 3,697 backlinks |
| A page card reads across hosts | `Stub`: 14 links, **5,861 backlinks**, from 13 hosts in 13 requests |
| A limit is honoured against the real list | 14 of 14, limit 25 |

The count check is the exact-count oracle this doc promised, at a scale where the right answer is
derivable from the records. A page with 5,861 backlinks answering from a counter rather than a scan
is the demo's own claim, met on real data.

**Three things it turned up.**

- **A subset of a link graph keeps very few of its edges**, and this is an artifact of subsetting
  rather than data loss. The first 400 pages by id keep 1.2% of their edges; the 10,000
  most-linked keep 33.9%, because hub pages interlink and peripheral ones point outward. So the
  script selects by in-degree over a scanned window, and no subset figure here should be read as a
  red-link share — `report.json` has that separately.
- **A category-less page must not fall back to one affinity key.** `ns:${ns}` was the fallback, and
  48% of pages have no category, so nearly half the wiki shared one key — which is one vshard on one
  host. It now falls back to the title hash, which spreads, while pages that do have a category still
  cluster by it.
- **Write throughput, with heavy caveats: ~76,000 edge writes/sec** in process, one mutation each
  through client → directory → host → SQLite. No network, no DO RPC, no per-object request ceiling,
  so it is an upper bound on the engine rather than a figure for a deployment. It is the first number
  of its kind this repo has, and build-plan step 1 still owes the real one.

**And one thing it did not explain.** The first run reported pages on 4 of 16 hosts, which failed the
spread check. It does not reproduce: the same arguments now give 16 of 16. An A/B of the two
plausible causes — opening index vshards before versus after `scatter` — gives an identical active
set and an identical spread either way, because `grow()` already places a batch lightest-first. So
the reorder in the script is tidiness, not the fix, and the original is recorded as unexplained
rather than given a mechanism it did not have.

## The same ingest, deployed, which also works

`npm run ingest:deployed -- --base https://hlekk-wiki.tantaman.workers.dev --pages 10000` —
`scripts/ingest-deployed.ts` against `src/worker/wiki-app.ts`, deployed with `wrangler.wiki.jsonc`:
43 host Durable Objects, one directory Durable Object, a real KV namespace holding the published
shard map, 128 vshards, four index vshards.

**It changes exactly one thing from the run above: the transport.** Every mutation and every read
now crosses a real RPC boundary to a real Durable Object, the map is read from real KV, and the hosts
are tens of separate objects in Cloudflare's network rather than tables in one process. The subset
selection moved to `scripts/wiki-subset.ts` so both runs load the *same* pages — a subset chosen two
ways drifts, and then a difference between the two results cannot be told from a difference in what
was asked. The checks are the same for the same reason.

It reached **9/9 at 2,000 pages and 158,058 edges**, the same checks the in-process run passes:
every emitted edge written, nothing queued in any outbox, pages on 43 of 43 hosts, every sampled page
findable by `(ns, title)`, the exact-count oracle agreeing on 25 pages, a limit honoured against the
real list, and a page card reading a real page across hosts — `Country`, 25 links **shown from 17
hosts in 17 host requests, 95 ms** plus 28 ms to turn the title into an id. The 10,000-page load is
the same thing with a skew problem in front of it; see *The affinity key that ate the cluster*.

Two of those checks had to be weakened honestly rather than dropped. "Every page is findable" reads
the index for a 300-page sample rather than all 10,000, because over HTTP that is one request per
title; every page is still covered for existence by the object count, which the index cannot fake.
And disk growth is only asserted when the run actually created something, since a re-run over loaded
data writes nothing — which turned out to be worth having, because a re-ingest of 158,058 identical
edges changed `databaseSize` by **exactly 0 bytes**, which is idempotency demonstrated at the storage
layer rather than argued from the SQL.

**The deployment also carries the demo's read surface**, at `/` — a title box, a page card, and which
host Durable Objects each answer was assembled from, served as one document from the Worker so there
is nothing to build and no asset host to depend on. It identifies itself as a dated mirror under
CC BY-SA 4.0 and the GFDL, which *Why this dataset* records as a requirement rather than a courtesy.

### What only a deployment could find

Five things. The first two are bugs that every local test passed, and the third is the one that
decides the shape of the real loader.

**1. The directory published the whole shard map to KV on every object create.** `place` ends with
`if (this.#opened.length === 0 && mapVersion() > 0) await this.#publish()`, meant to say *only if the
allocator opened a vshard*. But `#flush()` immediately above it does `this.#opened.splice(0)`, so by
the time the guard reads that list it is always empty and the condition is always true. Classic KV
allows **one write per second per key** and refuses the rest with 429, so the pilot died 7 pages in
with `place: KV PUT failed: 429 Too Many Requests`. Local workerd's KV rate limits nothing, which is
why 232 unit tests, the DO smoke harness and the whole app harness passed over it.

`#flush()` now returns how many vshards it adopted and `place` publishes only on a non-zero count —
nothing else can tell, since the list it used to consult is spliced empty by then. The publish is
also no longer fatal at that one site: the map is a cache and the directory is authoritative, so a
vshard missing from a stale chunk is *absent* rather than wrong and the client falls through to
`resolve`. `scripts/app.mjs` now asserts the shape rather than the effect — it counts publishes
across 62 creates, 38 of them placed, and requires at most 2. It reports 0, and would have reported
38 before the fix.

**2. A bulk insert in shuffled order does not survive its own size.** The first version of the driver
shuffled the whole edge list, reasoning that an edge routes by `id1`, so a batch taken in record
order is one page on one Durable Object, and a Durable Object is single-threaded. That bought
parallelism and paid for it twice: throughput sat at **973 edge writes/s** and then one host refused
with `Durable Object is overloaded. Requests queued for too long.` at about 2 million edges, which no
amount of retrying cleared.

The cause is the index, not the queue. `assocs` is keyed `(id1, atype, id2)`, so a shuffled insert
lands at a random point in its host's B-tree. While a host holds 3,700 rows that tree is entirely in
cache and the insert is nearly free; at 46,000 rows and climbing it is not, and every insert dirties
a different page. **Per-host throughput fell from ~101 writes/s to ~23** as the tables grew, the
queues grew with it, and the platform eventually refused. Grouping each batch onto one host in key
order — sequential appends into one tree, every host worked at once, at most one batch in flight per
host so nothing queues deeply — took it to **~6,300 edge writes/s, a 6.5x gain, and no refusals**.

That is the shape [`wikimedia-demo.md`](wikimedia-demo.md#what-the-loader-owes) already prescribes
for the real loader: batch per `(host, vshard)`, a vshard being one contiguous key range. It is now
measured rather than assumed, and the measurement is the argument for it.

**3. The global unique index is the write bottleneck, and its size is fixed at `init`.** An edge
write goes to its page's host, so pass B spreads over all 43. A `createUnique` writes through the
*index* vshard its title hashes to, and there are **four** in the database, so every page in pass A
funnels through four Durable Objects — reserve, then confirm, two writes each. At pass B's
concurrency that queued hundreds deep on each and the platform refused with `Durable Object is
overloaded`. Pass A now runs at its own much lower concurrency and reports 0 retries.

The part that matters beyond the pilot: `indexVshards` is read once, when the directory first opens,
and cannot be raised afterwards. Four is enough for 10,000 pages at a throttled rate and is not a
number to carry into a 66.5-million-page load, where the title index is both the only entry point and
the narrowest part of the write path. **It belongs in the pre-load decision beside `HLEKK_VSHARDS`**,
and there is no import, export or truncate for a deployed Durable Object's SQLite to fix it after the
fact — only a new `HLEKK_DATABASE` name and a reload.

Two corrections to that paragraph, both measured since. The index vshard count turned out **not** to
be the narrow part of the write path — the directory DO is, because `createUnique` asks it which
index vshard a title belongs to, and there is one per database. See *Which makes pass A the
bottleneck* in [`wikimedia-demo.md`](wikimedia-demo.md). And a new `HLEKK_DATABASE` name is no longer
the end of the story: it still *abandons* the old database rather than removing it, but
`POST /admin/wipe?database=<name>` now tells each of that database's objects to erase itself, which is
the only way to reclaim the storage. It is armed by `HLEKK_WIPE` in the deployment's own vars and
refuses any database that var does not name.

**4. An empty host Durable Object weighs 45,056 bytes deployed, not the 40,960 it weighs on
workerd.** Measured across 43 of them with the schema in place and nothing stored. A 10% difference
that matters twice: the figure below is a ratio counted from this floor, and `wrangler.app.jsonc` set
`HLEKK_SHED_BYTES` to 45,000 — *below* the real empty size — on the strength of the workerd number,
so that threshold would shed before a single row existed if that config were ever deployed. It is a
local harness and 40,960 is right there, but the margin is 56 bytes on one platform and negative on
the other, which is too thin to leave unsaid. Corrected in place.

**5. Two smaller platform facts, both of which cost real time.** `Date.now()` does not advance during
synchronous execution on Workers — it is pinned to the last I/O — so `while (Date.now() - started <
ms) {}` is an infinite loop that terminates only by hitting the CPU limit, whatever the limit is. It
cannot be used to measure or probe CPU; count iterations instead. And `/admin/where` fans out 86
calls across 43 hosts, so under ingest load the *directory* itself returns `Durable Object is
overloaded` — the operator view is unavailable exactly when it would be most wanted. Relatedly,
`/admin/size` now takes its host list from the directory rather than a count in the query string,
because a Durable Object is created by being addressed: asking about hosts the directory never made
brings empty ones into existence and then counts their schema, inflating the thing being measured by
45 KB a time.

### Throughput, and what it says about the real load

**~5,400 edge writes/s is wrong, and the way it was wrong is the lesson.** That figure came from
re-running the driver over edges that already existed, which takes the `ON CONFLICT DO UPDATE` path
with no row insert and no count bump. It is a no-op upsert rate read as an insert rate, and it was
measured three times before the mistake showed. A rate measured over data that is already loaded is
not a load rate, and the only defence is to check whether the run reported `already present`.

The honest figures for the ordinary write path, deployed:

| | Rate | Note |
| --- | --- | --- |
| Pages, through 4 index vshards | **~280/s** | five DO calls each; throttled to avoid overloading the index |
| Edges, shuffled across 43 hosts | **~970/s** | ~23/s per host, and it fails at ~2 M — see finding 2 |
| Edges, grouped per host in key order | **~6,300/s** | ~570/s on a single host, a 25x per-host gain |
| Edges, in process with no network | ~76,000/s | the figure above, for comparison |
| Edges, batched into one transaction | **not yet deployed** | 95,080/s on one host over a real file; see below |

**What that says about enwiki is the useful part.** At ~6,300 writes/s, 3.5 billion edges is
**~154 hours, or 6.4 days** of sustained ingest. (An earlier draft of this line said *~6,400 hours*,
which was the 6.4 with the unit slipped from days to hours — 6,400 hours would imply ~152 writes/s,
not 6,300. The corrected figure is 41x smaller and weakens the claim below, so it is worth stating
plainly rather than quietly fixing.)

Even granting a perfect spread and no skew, the ordinary write path is the wrong primitive for this
dataset — one durable commit per edge, which is what *Every mutation commits in one transaction*
(`host.ts`) means at 3.5 billion of them. But 6.4 days is not impossible the way 267 days would have
been, so the honest claim is narrower than the one this section used to make: the chunked snapshot is
not the only way the load *can* happen, it is the only way it happens **repeatably**. The affinity
comparison alone means loading twice, and a primitive that makes a reload cost hours instead of a
working week is what turns the load from a one-shot event into something the demo can iterate on.
A pilot that had merely succeeded would not have said so.

### What the per-edge ceiling actually was

Every rate above is a rate of **durable commits**, not of inserts. `assocAdd` is one mutation and
*every mutation commits in one transaction* (`host.ts`), so a thousand edges were a thousand commits,
and `/ingest/edges` accepting a thousand per request only ever bought concurrency against a
single-threaded Durable Object — the batching stopped at the HTTP boundary.

`Host.assocAddMany` moves it past that: N edges, one transaction, one commit. Measured on one host
over real SQLite, 20,000 edges in chunks of 1,000:

| Backing | Per-edge | Batched | |
| --- | --- | --- | --- |
| In memory | 62,599/s | 135,010/s | 2.2x |
| File-backed, `COMMIT` reaching the filesystem | 791/s | 95,080/s | 120x |
| Through `/ingest/edges` on workerd DO SQLite, one host | **525/s** | **4,425/s** | **8.4x** |

The in-memory row explains why none of this was visible locally: `LocalCluster` is backed by
`:memory:`, which never pays for durability, so the harness could not have measured the thing that
bounds a deployment. It also means `ingest:local` will show ~2x and nothing like 120x — the figure
belongs to the file-backed row, whose per-edge rate of **791/s** sits beside the **~570/s per host**
measured above. The same number in a local file and on a Durable Object is the evidence that the
ceiling was commit cost in both places.

This is not a deployed figure and does not claim to be one. Removing commits exposes whatever was
behind them — RPC round trips, request CPU, the 2 MB payload cap — and only a deployed run locates
that. What it settles is that the per-edge write is no longer the thing in the way, which moves the
binding constraint to pass A and the `indexVshards` count fixed at `init`.

### The storage multiplier, which was the open question

**43 host DOs weigh 45,056 bytes each empty, so 1,937,408 bytes is the floor**, and the data is
counted from it rather than from whatever a run started with — which is what makes the figure
readable after a resumed load.

Measured at 2,000 pages and 158,058 edges: **8,556,544 bytes** of data, which is **54.1 bytes per
edge** against the ~57 this doc costs one at, and **0.85x the payload arithmetic** overall. So the
multiplier is at the *bottom* of the 1.05x-4.7x range this doc gave, and below 1.0 because the
arithmetic's ~90 bytes for a page object is generous for rows this small while every row here stays
well under the threshold that would spill it to an overflow page.

**So `linked_from` stays.** The open question was whether the multiplier would force dropping
backlinks, halving the database and costing the demo its best query. At 0.85x it does not: ~251 GB of
arithmetic lands near ~215 GB of storage rather than past 300 GB. That is the question this pilot
existed to answer, and it is answered on real Durable Object SQLite rather than estimated.

One caveat kept rather than buried: this is a 2,000-page sample whose rows are all small, and
`databaseSize` moves in 4 KB pages, so it is a floor reading on a small database. The figure to carry
forward is "at or below 1x", not "0.85".

### The affinity key that ate the cluster

The 10,000-page load did not finish, and why is the most important thing the pilot found.

Edges group onto hosts by their source page, and **the largest host held 2,145,020 of 3,125,310
edges — 68.2% on one of 43**. With one batch in flight per host that is a sequential straggler and
the load would have taken another hour.

It is not the allocator's doing. Placement is by affinity key, the import's default key is the page's
**first category**, and the mass is in the keys:

| Share of edges | Pages | Affinity key |
| --- | --- | --- |
| **68.2%** | 2,875 | `cat:217683` — `Category:France_geography_stubs` |
| 11.4% | 1,001 | `cat:215663` |
| 1.8% | 224 | `cat:340576` |

2,875 of the 10,000 pages share one key, and one key is one vshard on one host **by design**. Packing
those keys onto 43 hosts best-first still puts 68.2% on the heaviest, so no placement decision could
have improved it. simplewiki has thousands of auto-generated French commune articles; they were
created early so they have low page ids and fall inside the scan window, they interlink densely so
they dominate a most-linked selection, and they share a stub maintenance category.

**The lesson generalizes past the subset.** This doc already fixed the case where a page has *no*
category — 48% of them, all landing in one `ns:` key — by falling back to the title hash. It did not
consider that a category which *is* present can be arbitrarily large. `Category:Living people` on
enwiki has roughly a million members. So **category affinity does not survive the real load**: it
would put ~1M pages and their edges on one vshard, past the 9 GB vshard cap and the 10 GB per-object
limit, and no amount of rebalancing fixes it because a vshard is the unit that moves.

That makes the demo doc's *affinity is a knob* beat sharper than it was written. The knob does not
just trade locality against spread; past a point it produces a key no topology can hold. What a
loader needs is a **bounded** key: cap a key's membership and spill the remainder to the title hash,
or compose the category with a hash bucket. Which is a decision for the real load, now with a
measurement behind it instead of an intuition.

## What it costs

| Component | Rows | Each | Total |
| --- | --- | --- | --- |
| `wiki.page` objects | 66.5 M | ~90 B | 6 GB |
| `page_links` | 1.78 B | ~57 B | 101 GB |
| `linked_from` | 1.78 B | ~57 B | 101 GB |
| `page_categories` + `category_pages` | 242 M each | ~60 B | 29 GB |
| `assoc_counts`, four directions | ~300 M | ~25 B | 7.5 GB |
| Title index entries | 66.5 M | ~60 B | 4 GB |
| Lead extracts | 7.26 M | ~300 B | 2.2 GB |
| | | | **~251 GB of payload and index** |

**And that figure is a floor, by a factor this repo has now measured.** Summing payload lengths
undercounts real storage by **1.05× to 4.7×**, because it sees neither the keys and indexes nor the
page overhead, and a `WITHOUT ROWID` row whose payload passes the max-local threshold spills to an
overflow page and costs a whole one — a 1,000-byte object costs 4.7 KB where a 980-byte one costs
1.03 KB. The table above already counts index entries, and every row in it is small enough not to
spill, so it should sit at the low end. But "should" is the word doing the work: **the only figure
worth planning on is `ctx.storage.sql.databaseSize` after a pilot load**, which is what the demo
doc's "prove at ~3 GB, then scale" already buys. A 1% load of this import reads the multiplier
directly.

So: ~251 GB of arithmetic against a ~300 GB target, with a multiplier between 1.05 and something
worse that one pilot settles. If it lands high, the dial is `linked_from` — dropping backlinks halves
the database and costs the demo its best query, which is a decision to take with the measurement in
hand rather than now.

**Topology**, at the 9 GB vshard cap: 128 vshards over 50 hosts is ~2 GB per vshard and 2–3 vshards
per host, which is the shape `src/client/fanout.test.ts` already measured at 61–81 host requests for
a ~500-object read. `HLEKK_VSHARDS` sets it, and the count is fixed when the directory first opens,
so it is chosen before the load and not after.

## Why this dataset

Briefly, since the demo doc has already committed to it.

- **It lands on the size target by choosing components**, not by subsetting. Pages, links, categories
  and revisions are four dials with known row counts, so the database can be built to a number on
  purpose. Every rejected candidate needed a reachability job or a time window to cut it down, which
  makes the demo's size an artifact of a judgement nobody can check.
- **Mirroring is the intended use.** CC BY-SA 4.0 and GFDL, dumps posted monthly for exactly this.
  Attribution is a requirement, and the demo has to identify itself as a mirror of a dated dump.
- **A visitor can falsify the answer.** They type `Albert Einstein` and already know what should come
  back.
- **Rejected: Stack Exchange**, which scored highest on shape — a question with its answers is a
  colocation group exactly — and is rejected on terms. The dumps moved behind authentication in 2024,
  re-uploads are discouraged, community mirrors are the only route and some dumps carry deliberate
  watermark rows. A public hosted copy is what those measures exist to prevent.
- **Rejected: GH Archive**, which scored highest on recognizability. No total size is published
  anywhere, so the demo's headline would rest on a guess; and it gives state only by reconstruction
  from events, so there is no exact oracle.

## Loading it locally, which needs no loader at all

There is **no import, export, backup or snapshot tool for a deployed Durable Object's SQLite
database**. Cloudflare's storage-options page says the quiet part: *"With SQLite in Durable Objects,
you may also need to build some of your own database tooling that comes out-of-the-box with D1."*
Point-in-time recovery is not an import — it restores an object's *own* history to a bookmark,
configured from inside the object, and *"is not supported in local development."*

**Locally the files are plain SQLite, and that is a load path.** Verified: after `npm run app`, each
host is a database at `.wrangler/app-state/v3/do/hlekk-app-HlekkHostDO/<hex>.sqlite` holding
`objects`, `assocs`, `assoc_counts`, `outbox`, `vshards` and `index_entries` exactly as *Host schema*
specifies, with `__miniflare_do_name` naming the host — `demo/h-6` — and ids readable as big-endian
`vshard << 47 | seq`. Proven on a row hlekk never wrote: an `objects` row inserted with Python's
`sqlite3` into `demo/h-6` at `(vshard 90, seq 5)`, `next_seq` bumped to keep the sequence invariant,
then read back through the Worker's own graph query — routed to vshard 90, host 6, answered in **1
request and 0 rounds**.

This does not replace the chunked snapshot, which is what a deployed load needs and is owed anyway.
What it buys is the pilot: the whole import can be built offline at any size, `databaseSize` read off
it, and every query and oracle exercised, before the chunked-ingest work is finished. It also makes
`invariants.ts` load-bearing rather than reassuring — a load that bypasses the write path has
bypassed every check in it.

**Batching limits, for whichever path.** Two of them bite: **100 bound parameters per query**, which
fits only ~20 `assocs` rows in a parameterized insert, and a **100 KB statement**, which fits ~2,000
once blob ids are inlined as `x'…'` hex literals instead of bound. `exec` takes several statements
separated by semicolons but refuses `BEGIN` and `SAVEPOINT`, so the transaction comes from
`transactionSync`. Undocumented: whether the 100 KB applies per statement or to a whole
multi-statement string. Alarms suit a self-feeding ingest — 15-minute wall time, 30 s of CPU to 5
minutes via `limits.cpu_ms`, self-rescheduling, at-least-once with six retries — and **an R2 binding
inside a Durable Object works, ranged reads included**, which was undocumented and is now measured.
See the open item below.

One trap found while measuring it, and it is this repo's own rather than the platform's: **an
`undefined` argument to `call` arrives as `null`.** The wire is JSON, and `JSON.stringify` keeps an
array's length while turning its `undefined` entries into `null`, so a handler's optional parameter
sees `null`, its default does not apply, and a `!== undefined` guard inside it is wrong. It turned an
unranged probe into a 500 while the same call with a real offset worked.

## Later: the dataset that needs paged storage

Recorded because it was measured, not because it is scheduled. Once
[`paged-storage.md`](paged-storage.md) lands, the dataset is the **Software Heritage graph** — many
TiB with no derivation. Measured from the `2025-10-08` export's own artifacts in the public
`s3://softwareheritage` bucket (`us-east-1`, AWS Open Data, CC BY-4.0, author information anonymized
at source):

- **53,529,848,761 nodes** — 26.60 B contents, 20.59 B directories, 5.46 B revisions, 403 M origins,
  364 M snapshots, 115 M releases.
- **1,003,518,287,197 edges**, 97% of them directory entries: 711.5 B `dir→cnt`, 254.9 B `dir→dir`.
- **Max in-degree 787,976,403** on one node, almost certainly the empty blob or empty tree. Max
  out-degree 1,308,724. Average degree 17.7.
- **29.48 TiB of ORC across 1,664 part objects**, summed from the bucket's listing, matching the
  published 30 TiB. `directory_entry` alone is 24.8 TiB.

In hlekk's row format that is ~75 TiB forward and ~140 TiB with the `cnt→dir` inverse — within the
16-bit field's ~590 TB ceiling at the 9 GB cap, but far past what hosts owning their storage can
hold. Two findings worth keeping, both design gaps rather than loading problems:

- **A Merkle DAG has polymorphic edges and the catalog cannot express them.** `dir→{cnt,dir,rev}` is
  one ordered list over a union of target types. An edge type declares one `to`, and the id carries
  no type tag — *Layout* rejected one — so the type cannot be recovered from the id either.
- **Directory entries sort by name and `assocs` sorts by `time`.** A `time` of 0 gives a file browser
  an arbitrary listing order. The honest fix is the deferred "more sort fields" work.

## Open

- [x] The storage multiplier: **at or below 1x**, measured at 0.85x and 54.1 bytes/edge on a
      deployed pilot. `linked_from` stays. See *The storage multiplier, which was the open question*.
- [ ] Per-index normalization, so a case-sensitive title index and a case-insensitive email index can
      coexist. `titleKey` is the stopgap and says so.
- [ ] Extending `invariants.ts` to check the four unpaired edge types agree as if they were pairs,
      which is the only thing that would catch a half-loaded direction.
- [x] Whether an R2 binding works inside a Durable Object: **yes, and ranged reads land exactly.**
      Measured against a 1 MiB object of 16,384 stamped 64-byte records, read from three different
      host DOs on a real deployment: a full read returned all 1,048,576 bytes; `offset 640` returned
      record 10, `offset 524288` record 8,192, and `offset 1048512` record 16,383. So a host can pull
      its own slice in chunks with the offset held as a cursor, which is what a bulk import needs —
      each host pulling a pre-partitioned payload instead of a Worker pushing `createUnique` through
      the one directory object that bounds pass A at ~590 pages/s. `r2probe` on the host DO is kept
      for whoever asks next.
- [ ] Whether the 100 KB SQL statement limit is per statement or per `exec` string.
- [ ] Which affinity functions the demo compares, given the import takes it as a parameter. Note
      that 48% of simplewiki pages have no category, so `category` is half a fallback to `namespace`.
      And now a harder constraint than a comparison: **raw first-category affinity is not usable at
      scale at all**, because one key took 68.2% of a 10,000-page subset's edges and
      `Category:Living people` would take ~1M pages on enwiki. A bounded key — a membership cap
      spilling to the title hash, or a category composed with a hash bucket — is the thing to compare
      `hash` against. See *The affinity key that ate the cluster*.
- [x] How many index vshards the real load needs: **64 for this pilot, and the count was the wrong
      question.** Four did funnel every title insert through four Durable Objects and did provoke
      `Durable Object is overloaded`, but 64 bought only 1.4x — because `createUnique` opens by
      asking the *directory* DO which index vshard a title belongs to, and there is one of those per
      database. ~590 pages/s is that one object's ceiling, not the index's. See *Which makes pass A
      the bottleneck* in [`wikimedia-demo.md`](wikimedia-demo.md) for the table and the fix.
- [x] `records()` is a generator, with `writeRecords` spilling to a file only on request. A page's
      edges split into continuation records at 50,000 so a high-degree page does not materialize its
      whole list; folding them back reproduces the unsplit records exactly, and streaming 22.3 M
      edges held 65 MB. What remains is for the loader to call it instead of reading the file.
- [ ] enwiki's red-link share, which sets the real edge count. simplewiki's is 24.5% of links and
      0.6% of category targets; a complete wiki should be lower on both.
