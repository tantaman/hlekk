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

Three reasons it should be a generator the loader pulls from rather than a file, in decreasing order
of how much they settle:

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

What makes this less trivial than "just stream it": the loader needs records grouped by
`(host, vshard)`, not by `page_id`, so it cannot consume a stream and write directly. But at 128
vshards that is 128 open buffers in one pass, not a sort. **And the seam does not move** — the
contract is the record shape, not a file, so this is a choice on the import side rather than a
renegotiation of it.

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
minutes via `limits.cpu_ms`, self-rescheduling, at-least-once with six retries — but **an R2 binding
inside a Durable Object is undocumented**, where KV from a DO has its own example, so verify that
before resting a plan on it.

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

- [ ] The storage multiplier, from a pilot's `databaseSize`. It decides whether `linked_from` stays.
- [ ] Per-index normalization, so a case-sensitive title index and a case-insensitive email index can
      coexist. `titleKey` is the stopgap and says so.
- [ ] Extending `invariants.ts` to check the four unpaired edge types agree as if they were pairs,
      which is the only thing that would catch a half-loaded direction.
- [ ] Whether an R2 binding works inside a Durable Object. Documented for KV, undocumented for R2.
- [ ] Whether the 100 KB SQL statement limit is per statement or per `exec` string.
- [ ] Which affinity functions the demo compares, given the import takes it as a parameter. Note
      that 48% of simplewiki pages have no category, so `category` is half a fallback to `namespace`.
- [x] `records.jsonl` should be a generator, not a file: ~164 GB at enwiki scale, a duplicate of a
      checkpoint `edges.tsv` already provides, and discarded by the second affinity load anyway. The
      loader partitions by `(host, vshard)` in one pass over 128 buffers. Not yet implemented — the
      script still writes the file.
- [ ] enwiki's red-link share, which sets the real edge count. simplewiki's is 24.5% of links and
      0.6% of category targets; a complete wiki should be lower on both.
