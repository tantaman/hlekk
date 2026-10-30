# The demo dataset

Oct 30, 2026 · @Matt Wonlaw

What to load into hlekk to show it working at a size nobody can wave away, and what the demo has to
assert for the showing to mean anything. This targets the **v1 engine as built** — host-owned DO
SQLite, no paged storage — so every limit in [`design.md`](design.md)'s *Platform limits* is live:
10 GB per host, a ~1 GB vshard cap, and the write path as the only way in.

Figures marked **measured** were read today from the dataset's own published artifacts; the method is
named each time. Figures marked *estimated* are arithmetic over those, and say what they assume.

## The recommendation

**The English Wikipedia link, category and revision graph, from the official monthly dumps.**

Two builds, because the host count and the dataset size are not independent:

| Build | Contents | Size | Hosts at 5 GB each | vshards |
| --- | --- | --- | --- | --- |
| **A** | Pages, the full link graph both directions, the category graph both directions, counts, title index | ~231 GiB | **~50** | 512 |
| **B** | A, plus all 1.378 billion revisions as objects and as an ordered edge list per page | ~485 GiB | **~100** | 1,024 |

Build A is the ~50-host demo. Build B is the ~500 GiB demo. They are not the same demo, and the
reason is the one hard limit in the design:

> **500 GiB cannot fit on 50 host DOs.** The SQLite-backed DO cap is 10 GB, so 50 hosts hold 466 GiB
> with *zero* headroom — and a vshard move needs free space on the destination, so a cluster packed
> to the cap has nowhere to shed to and the placement controller has nothing it can legally do. At
> the design's own 5 GB-per-host assumption (half the limit), 500 GiB is ~100 hosts and 231 GiB is
> ~50. Pick the host count or pick the size; the product of the two is fixed at about 5 GB.

Build A is the better first demo and B is the better second one. A is half the load time, it shows
the whole architecture, and the thing B adds — a billion-row ordered edge list per page — is the one
component that is pure bulk rather than new behaviour.

### Why this dataset

Four things had to be true at once, and this is the only candidate that got all four.

- **It lands on the size target by choosing components, not by subsetting.** Pages, links,
  categories and revisions are four independent dials with known row counts, so the database can be
  built to 231 GiB or 485 GiB on purpose. Every other candidate needed either a reachability
  computation to cut it down or a time window chosen to cut it down, and in both cases the demo's
  size becomes an artifact of a judgement call nobody can check.
- **It is published for reuse, and mirroring is the intended use.** CC BY-SA 4.0 and GFDL, dumps
  posted monthly by Wikimedia for exactly this. This is what disqualified the two datasets that
  otherwise scored higher on recognizability — see *What was rejected*. A public, queryable demo is
  redistribution, and it has to rest on terms that permit it rather than on terms nobody enforces.
- **A visitor can check the answer.** They type `Albert Einstein`, and they already know what should
  come back. A demo whose answers cannot be falsified by the person looking at it is a screenshot.
- **It maps onto the schema already in the repo.** `src/worker/schema.ts` has an object with an
  ordered child list, a maintained inverse pair and a cascade. A page with its revisions is that,
  at 10^9. The demo extends the existing catalog rather than replacing it, which is also what makes
  the differential oracle in `src/testkit` reusable against it.

## The dataset, measured

From the `enwiki` dump of 2026-10-01 and the live site statistics, read today.

**Totals** — measured, from `action=query&meta=siteinfo&siprop=statistics` on en.wikipedia.org:

| | Count |
| --- | --- |
| Pages, all namespaces | 66,505,524 |
| Articles (ns 0, non-redirect) | 7,257,179 |
| Revisions (total edits) | 1,378,088,750 |
| Registered users | 55,226,076 |

`site_stats` in the SQL dump disagrees with all of these by an order of magnitude — it reports 137 M
edits and 724,955 articles. It is MediaWiki's legacy sharded counter and it has drifted; the dump
carries seven near-identical rows of it. **Do not size anything from `site_stats`.** The API figures
above are the ones to use.

**Row counts per table** — measured by streaming a 300 MiB compressed prefix of each dump, counting
`),\n(` row separators, and scaling by total compressed size. The method validates against the one
table whose true count is known independently: it predicts 64.27 M `page` rows against the API's
66.51 M, so it runs about 3.4% low.

| Table | Dump (gz) | gz bytes/row | Rows (estimated) |
| --- | --- | --- | --- |
| `pagelinks` | 6,835 MiB | 4.02 | **~1.78 billion** |
| `templatelinks` | 4,415 MiB | 2.70 | ~1.71 billion |
| `categorylinks` | 2,432 MiB | 10.52 | **~242 million** |
| `page` | 2,320 MiB | 37.85 | ~64.3 million (true: 66.5 M) |
| `linktarget` | 1,376 MiB | 11.71 | ~123 million |
| `redirect` | 179 MiB | 12.07 | 15,551,165 (exact — whole file read) |

`templatelinks` is excluded from both builds. It is the same shape as `pagelinks`, costs another
~194 GB in both directions, and shows the demo nothing `pagelinks` does not.

**One schema detail that changes the mapping.** `pagelinks` no longer stores a target title or page
id; it stores `(pl_from, pl_from_namespace, pl_target_id)` into `linktarget`, whose rows are
`(lt_id, lt_namespace, lt_title)` — *titles*, which need not be pages. So a link's target resolves
through `linktarget` and may resolve to nothing: a red link. A navigable demo keeps only links whose
target resolves to a real page, which also trims the edge count by whatever share of enwiki's links
are red. That share is unmeasured here and the loader should report it.

## Mapping onto hlekk

`schema/wiki.json`, in the catalog's serialized form:

```json
{
  "objects": {
    "wiki.page":     { "fields": { "ns": "number", "title": "string", "redirect": "boolean",
                                   "len": "number", "extract": "string" } },
    "wiki.revision": { "fields": { "ts": "number", "comment": "string", "len": "number",
                                   "minor": "boolean", "userId": { "id": "wiki.user" } } },
    "wiki.user":     { "fields": { "name": "string" } }
  },
  "edges": {
    "wiki.page_revisions":  { "from": "wiki.page", "to": "wiki.revision", "onDelete": "cascade" },
    "wiki.revision_author": { "from": "wiki.revision", "to": "wiki.user", "field": "userId" },

    "wiki.page_categories": { "from": "wiki.page", "to": "wiki.page",
                              "inverse": "wiki.category_pages" },
    "wiki.category_pages":  { "from": "wiki.page", "to": "wiki.page",
                              "inverse": "wiki.page_categories", "maintained": true },

    "wiki.page_links":      { "from": "wiki.page", "to": "wiki.page" },
    "wiki.linked_from":     { "from": "wiki.page", "to": "wiki.page" }
  }
}
```

Three decisions in that file are the interesting ones.

**The sort key.** `assocs` orders by `time`, and each edge type needs a meaning for it.
`page_revisions` gets the revision timestamp, so a page's history reads newest-first for free and
the `(time, id2)` cursor is exactly a history cursor. `page_categories` gets `cl_timestamp`, which
`categorylinks` carries, so "recently added to this category" is a real query. `page_links` has no
natural time: the dump does not record where in the article a link appeared, so the ordinal is not
available and `time` is 0 with the primary key's `id2` breaking the tie. That is stable and
arbitrary. **It is also what rules out the link-order demos** — the "first link in every article
leads to Philosophy" walk needs link position, which lives only in the wikitext dump (24 GiB bz2),
not in `pagelinks`. Either parse wikitext for article-namespace link order, or use breadth-first
search over backlinks for the depth showcase instead. The second is cheaper and shows the same thing.

**Only the small edge type is paired.** `page_categories` / `category_pages` is a genuine maintained
pair, so the outbox delivers 242 M inverse writes across hosts and build-plan step 4 is exercised at
a scale it has never seen. `page_links` and `linked_from` are **two independent edge types**, both
loaded directly from sorted passes over `pagelinks`. Pairing them would put 1.78 billion inverse
writes through the outbox, which is the single largest risk in the load and buys nothing here,
because a dump is a static snapshot that cannot drift. The cost is honest and worth writing down: a
*live* Wikipedia mirror would need the pairing, and the demo therefore does not prove that the outbox
survives the link graph — only that it survives the category graph. The invariant checker in
`src/testkit/invariants.ts` should be extended to verify the two unpaired types agree as if they were
a pair, since nothing in the engine is enforcing it.

**Colocation is set at load, and it is what makes the demo fast.** A page, its revisions, its
outgoing links and its category memberships are all created `with: pageId`, so they share the page's
vshard. Then a page's history and its outlink list are one host and one hop. What necessarily
crosses hosts is the *targets*: the page objects an outlink points at live in their own vshards, so
rendering a page's links with their titles is the two-hop case the design is built around, and
`linked_from` for a popular page is a long list on one host whose members are scattered over all of
them. Both are the interesting cases, and both come out of the data rather than being arranged.

## What it costs

Per-row costs assume `WITHOUT ROWID` tables keyed as in *Host schema*: an 8-byte BLOB id costs 9
bytes with its header, a SQLite record header is ~6 bytes, and an `assocs` row with no edge data
costs ~29 bytes plus a ~28-byte `assocs_range` index entry, so **~57 bytes per edge**. Object rows
carry their JSON payload. These are arithmetic, not measurements — DO SQLite's page overhead,
free-space fragmentation and the real cost of its storage layer are exactly what build-plan step 1
has never measured, so treat the totals as ±30% and the ratios as sound.

| Component | Rows | Each | Total |
| --- | --- | --- | --- |
| `wiki.page` objects | 66.5 M | ~90 B | 6 GB |
| `page_links` | 1.78 B | ~57 B | 101 GB |
| `linked_from` | 1.78 B | ~57 B | 101 GB |
| `page_categories` | 242 M | ~60 B | 15 GB |
| `category_pages` | 242 M | ~57 B | 14 GB |
| `assoc_counts` | ~300 M | ~25 B | 7.5 GB |
| Title index entries | 66.5 M | ~60 B | 4 GB |
| **Build A** | | | **~248 GB = 231 GiB** |
| `wiki.revision` objects | 1.378 B | ~140 B | 193 GB |
| `page_revisions` | 1.378 B | ~57 B | 79 GB |
| **Build B** | | | **~520 GB = 485 GiB** |

**Layout.** Build A: 512 vshards on ~50 hosts, ~0.48 GB per vshard against the ~1 GB cap, ~10
vshards per host. Build B: 1,024 vshards on ~100 hosts, ~0.51 GB per vshard, ~10 per host. Both
match the growth table in *Growing the vshard count* — which predicts ~1,000 vshards and ~200 hosts
at 1 TB — so this demo is a direct test of that table rather than a new claim.

Create the database with `N` set to its final vshard count, not to 64. *Initial sharding* says a
database known in advance to be large can be created with 256 or 1,024, and this one is: vshards
cannot be split, so the count chosen at creation is the count forever, and the ids minted during the
load encode it. Build A should be created at 512 even though it starts empty, and Build B at 1,024.
If both builds are wanted from one load, create at 1,024 and let A occupy it sparsely.

The shard map is a non-issue at this scale: 1,024 vshards fully fragmented is ~12 KB against the
~786 KB that *Shard map size* computes for the 16-bit worst case, so one chunk holds everything and
`SPAN_BITS` does not matter here.

## Loading it

**The write path is the only way in.** Without paged storage there is no base to bulk-build and no
manifest to publish, so every one of the ~5.2 billion rows in Build B goes through
`transactionSync()` on an owning host. That single fact shapes the whole load:

- **Batch by page, colocated.** One transaction writes a page, its revisions, its outlinks and its
  categories, all `with: pageId`. For a median page that is a handful of rows; for a heavily-edited
  one it is thousands. Driving the load page-by-page in page-id order means the input is already
  grouped the way the transactions want.
- **The colocation group limit binds here and its value is still undecided.** *Design limits* leaves
  it as "a documented limit, value to be set". A page with 100,000 revisions is a colocation group
  with 100,000 members, and the loader is the first thing that will find out what the limit is. This
  is the demo's first contribution back to the design.
- **`linked_from` needs a second pass in target order.** The same 1.78 billion links, sorted by
  target instead of source, so each target page's backlink list is written contiguously into its own
  vshard. Sorting 1.78 billion 12-byte tuples is an ordinary external sort, done outside hlekk.
- **Throughput is the unknown, and the load is the measurement.** Build-plan step 1 owes a per-DO
  throughput number and `npm run app` "writes tens of objects, not thousands". Whether 5.2 billion
  rows across ~100 hosts takes four hours or four days is not currently knowable from anything in
  the repo. **This is the demo's main technical return**: it retires step 1's open item, and the
  vshard density and move thresholds that are currently guesses become measured.
- **Watch the allocator, do not drive it.** The database is created with its full vshard count, so
  the load should never need the active set to grow — but *Growing the vshard count* opens the next
  `N` when the active set empties, and a load that trips that has told you something about the byte
  cap. Log it rather than preventing it.

**The exact-count oracle.** A dump is a consistent snapshot, so every maintained counter has a known
right answer: re-derive each page's outlink, backlink, category-member and revision counts from the
source tables and compare against `assoc_counts`. This is a differential oracle over the real load
at 10^9, and it is the one check that can catch a count drifting — the reference model in
`src/testkit/model.ts` can only do it at toy scale. It should run as a pass over the finished
database and be part of the demo's own assertions.

## The demo itself

Seven queries, each chosen because it proves a specific claim. The existing `scripts/app.mjs`
already asserts about where rows landed rather than that requests succeeded; this is that, scaled.

| # | Query | What it proves |
| --- | --- | --- |
| 1 | Resolve a title to a page | The global unique index: hash-sharded by normalized `(ns, title)`, answered on one host. Build-plan step 6 at 66.5 M entries. |
| 2 | A page card: the page, 50 outlinks with their titles, its categories, its backlink and revision counts | The two-hop claim. One request to the page's host, then one batched request per host holding a link target. Counts come from counters. |
| 3 | "What links here" for a popular page, paginated | An ordered range read over a 10^5–10^6 member edge list on one host, with a `(time, id2)` cursor, and a count that was never a `COUNT(*)`. |
| 4 | Members of a large category, newest first | The same, over the one genuinely paired edge type — so every row in the answer arrived through the outbox from another host. |
| 5 | A page's revision history, 50 at a time | Colocation. One host, one hop, no fan-out, because the load put the revisions in the page's vshard. |
| 6 | Breadth-first search from one page to another over links | Dependent depth: the cost the architecture cannot remove. Each level is one parallel round across many hosts, so the round count is the path length and the request count is the frontier. |
| 7 | Pages linking to X that are also in category Y | Filtered limits across hosts, and the read-ahead window that refills a limit when a filter rejects rows — the hardest path in the query engine. |

**What the page has to show, beside the answer.** Hosts touched, host requests, rounds, and the
vshards involved. `app.mjs` already reports `read.hosts`, `read.requests` and `read.rounds`; the demo
should put those on screen for every query, because they are the claim. A query that answers in 40 ms
is unremarkable; a query that answers in 40 ms *from 23 host DOs in 2 rounds* is the architecture.

**And the move.** A live map of 512 or 1,024 vshards across their hosts, a button that moves one, and
the same query re-run returning a byte-identical answer with a different host list. That is principle
4 and build-plan step 3, visible to someone who has not read the design. `app.mjs` asserts exactly
this today at 12 issues; the demo is the same assertion at 10^9 rows.

## Hazards

- **The 10 GB host cap is the binding constraint, and packing near it breaks moves.** Stated above;
  it is the reason the two builds have different host counts. Target 5 GB per host and let the
  placement controller keep it there.
- **A single hot vshard.** Backlink lists are heavy-tailed, so the vshard holding the most-linked
  pages carries far more edges than the mean. *vshards* calls this growth from inside and defers
  overflow storage keyed by `(id1, atype)` until needed; a 10^6-member backlink list is ~57 MB,
  which is fine, but it is one vshard's worth of concentration the allocator cannot relieve by
  moving, because a vshard is never split. Measure the distribution before loading and, if the top
  vshard is an outlier, place the worst offenders by affinity rather than by hash.
- **Red links.** `pagelinks` targets are titles via `linktarget`, not pages. Resolve and drop the
  unresolvable, and report the share dropped.
- **No article text in either budget.** A ~300-character lead extract for the 7.26 M articles costs
  ~2.2 GB and makes the demo readable; full wikitext is another 100 GB+ and a few of the largest
  articles would approach the 2 MB row cap. Store the extract, link out for the rest.
- **Attribution is a requirement, not a courtesy.** CC BY-SA 4.0 and GFDL oblige the demo to
  attribute and to identify itself as a mirror of a dated dump, not as Wikipedia.
- **The dump is monthly, so the demo is a snapshot.** Good for the oracle, and it means the write
  path is exercised by the load and by synthetic writes only. If a live write workload is wanted, the
  Wikimedia EventStreams feed is the obvious tail — and that is when `page_links` would have to
  become a real maintained pair.

## What was rejected, and why

- **Stack Exchange** scored highest on shape — a question with its answers and comments is hlekk's
  colocation group exactly, and the whole corpus lands near 500 GiB with no subsetting. It is
  rejected on terms: Stack Exchange moved the dumps behind authentication in 2024 and discourages
  re-uploads, community mirrors are the only route, and some dumps carry deliberate watermark rows.
  A public hosted copy is the thing those measures exist to prevent. Reconsider only with
  permission in writing.
- **GH Archive** scored highest on recognizability, and an event stream is the ideal write workload
  — a 14-year replay would exercise the allocator, the outbox and the placement controller in their
  natural order. Rejected on two counts: no total size is published anywhere (the often-quoted
  ~17 TB figure is three years old and unsourced), so the demo's size would rest on a guess; and the
  events are public activity by named people, where Wikipedia's are too but Software Heritage's are
  anonymized. It also gives state only by reconstruction from events, so there is no exact oracle.
- **Common Crawl's web graph** is bigger and simpler and has no object payloads worth reading, so it
  would showcase edges and nothing else.
- **Software Heritage** is the right dataset for the *second* demo, once paged storage lands. See
  below.

## Later: the paged-storage demo

Recorded because it was measured today and because it is the natural next showing, not because it is
scheduled. Once [`paged-storage.md`](paged-storage.md) lands, the dataset is the **Software Heritage
graph**, and it is many TiB without any derivation.

Measured from the `2025-10-08` export's own published artifacts in the public `s3://softwareheritage`
bucket (`us-east-1`, AWS Open Data; CC BY-4.0 for the graph dataset, plus the Ethical Charter and
bulk-access terms, and author/committer information is anonymized at source):

- **53,529,848,761 nodes** — 26.60 B contents, 20.59 B directories, 5.46 B revisions, 403 M origins,
  364 M snapshots, 115 M releases (`graph.nodes.stats.txt`).
- **1,003,518,287,197 edges**, of which 97% are directory entries: 711.5 B `dir→cnt` and 254.9 B
  `dir→dir` (`graph.edges.stats.txt`).
- **Max in-degree 787,976,403** on a single node, almost certainly the empty blob or empty tree
  (`graph.stats`). Max out-degree 1,308,724. Average degree 17.7.
- **29.48 TiB of ORC across 1,664 part objects** in 13 tables, summed from the bucket's own listing —
  which matches the published 30 TiB. `directory_entry` alone is 24.8 TiB, 86% of the export.

Why it is the second demo and not the first: in hlekk's row format those edges come to ~75 TiB
forward and ~140 TiB with the `cnt→dir` inverse, which is past the 16-bit vshard field's ~65 TB
ceiling under the current cap and reachable only once a vshard is not bounded by a copy. It is the
dataset that *requires* paged storage rather than merely benefiting from it.

Two findings worth keeping, because both are design gaps rather than loading problems:

- **A Merkle DAG has polymorphic edges and the catalog cannot express them.** `dir→{cnt,dir,rev}` and
  `snp→{cnt,dir,rev,rel}` are single ordered lists over a union of target types. v1's catalog
  declares one `to` per edge type, and the id deliberately carries no type tag — *Layout* rejected
  one — so the type cannot be recovered from the id either. Either the catalog grows a union target,
  or the target type rides in the edge's `data` and `related()` loses its typing and `onDelete` its
  meaning.
- **Directory entries sort by name, and `assocs` sorts by `time`.** A `time` of 0 gives arbitrary
  order for a directory listing, which is the one thing a file browser cannot have. Packing the
  first 8 bytes of the entry name into `time` as a big-endian integer gives correct order for names
  that differ in their first 8 bytes and arbitrary order among those that do not. The honest fix is
  the deferred "more sort fields" work under *Edge fields only on `related`*.

One piece of good news for whoever builds it: the export publishes its own locality-optimizing node
permutation (`graph.pthash.order`, and the BV graph it produces compresses to 1.945 bits per link).
Taking contiguous blocks of that order as vshards inherits that locality for free and makes the id
assignment a pure function of the export — so a subset loads at its final ids and later stages are
pure inserts.

## Open

- [ ] Build A or Build B first. A is the ~50-host demo and the faster load; B is the ~500 GiB
      headline. They differ only by the revision component.
- [ ] Per-DO write throughput, which decides whether the load is hours or days. Unmeasured, and
      measuring it is build-plan step 1.
- [ ] The colocation group limit, which the most-edited pages will hit during the load.
- [ ] The backlink degree distribution, and whether the top vshard needs placement by affinity.
- [ ] The share of enwiki links that are red, which sets the real edge count.
- [ ] Whether the demo's unpaired `page_links` / `linked_from` should become a real maintained pair
      once a live EventStreams tail is wanted, and what 1.78 B outbox deliveries would cost.
- [ ] Where the demo runs, and what a public endpoint over 50–100 host DOs costs to keep warm.
