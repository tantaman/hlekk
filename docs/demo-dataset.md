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
`categorylinks` carries, so "recently added to this category" is a real query.

A note on that table, found by reading the bytes rather than the documentation: **`categorylinks`
no longer stores `cl_to`.** As of the 2026 dumps its seven columns are `(cl_from, cl_sortkey,
cl_timestamp, cl_sortkey_prefix, cl_type, cl_collation_id, cl_target_id)` — a category is named by
a `linktarget` id now, exactly as a link target is, and `cl_sortkey` is a binary collation key, not
a readable title. This is good news for the loader, since category edges resolve through the same
`linktarget` map the link edges use and there is one fewer join; it does make the category pass
depend on the link-target pass, which it did not before. `page_links` has no
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

**Build A never uses `with:`, and that is worth being exact about.** An earlier draft of this
section said pages, links and categories are created `with: pageId`. They are not, because there is
nothing to colocate: `wiki.page` is the only object type in Build A, and an edge already lives on
its `id1`'s vshard with no option in the matter. So a page's outlink list and its category list are
one host and one hop for free, by the storage layout rather than by a placement decision.

**The only placement lever is therefore the affinity key a page is created under**, and the loader
sets it to the page's first category. Pages sharing one land together and stay together as the
database spreads, so browsing within a topic stays on a few hosts while browsing across topics fans
out — which is the contrast demo query 6 exists to show. With no affinity at all, placement is
random within the active set, every traversal is a full fan-out, and the demo has one case instead
of two.

What necessarily crosses hosts is the *targets*: the page objects an outlink points at live in
their own vshards, so rendering a page's links with their titles is the two-hop case the design is
built around, and `linked_from` for a popular page is a long list on one host whose members are
scattered over all of them. Both come out of the data rather than being arranged.

**`with:` only starts to matter in Build B**, where a revision is an object that wants to be in its
page's vshard. That is also where the undecided colocation group limit starts to bind.

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

Two things have to be built before the load can run, and both were found by writing the loader
against the code rather than against the design doc.

### `db.txn` is specified but not built, and the load needs it

`Mutation` in `src/client/transport.ts` is `create | update | delete | assocAdd | assocRemove |
apply | indexReserve | indexConfirm | indexRelease`. There is no batch kind, and no `txn` on the
client — `db.txn(anchorId, …)` appears in *Mutations* and *Transactions* in `design.md` and in the
build plan's assumptions, but nothing implements it. So today every edge is its own round trip.

What that costs Build A:

| | Requests | At the 1,000/sec per-DO ceiling, 50 hosts |
| --- | --- | --- |
| One mutation per row | ~4.0 billion | ~22 hours |
| Batched per anchor | **~380 million** | **~2.1 hours** |

The batched figure is 66.5 M pages × 3 for reserve–create–confirm, plus roughly one transaction per
page for each of the three edge passes. Both columns are floors: they count requests against the
request ceiling, and the thing that will actually bind is DO SQLite write throughput, which is
unmeasured. The ratio is the point.

**This only binds on the deployed path.** Build A can be loaded locally by writing the SQLite files
directly, where there are no requests to count — see *Bulk loading* below. So `txn` is a
prerequisite for deploying the demo, not for building it, which is a good reason to build it
second.

**An edge always lives on its `id1`'s vshard, so a group of edge writes sharing an `id1` touches
exactly one vshard** and satisfies *Transactions*' rule that every id share the anchor's. One
page's whole outlink list is therefore one legal transaction, which is exactly the grouping the
sorted passes produce. This is the smallest useful version of `txn` and it is all the load needs.

### The title index collides on case

`client.normalize` is `value.trim().toLowerCase()`, applied to every index key. MediaWiki titles are
case-sensitive after the first character, so `Ash` and `ASH` — both real enwiki pages — normalize to
one key, and the second page to be loaded is refused with `ValueTaken` and silently dropped.

The stopgap is in `src/worker/wiki.ts`: `titleKey` escapes every uppercase letter to `%` plus its
lowercase hex code, which makes the key lowercase-stable, so normalization is a no-op on it and
nothing collides. Verified on `Ash`/`ASH`.

**The honest fix is for normalization to be a property of the index rather than one global
function.** `design.md`'s *Global lookups and uniqueness* says values are normalized "once, in one
place" and is right that it must be one place per index; it is currently one place per database.
An index over emails and an index over case-sensitive titles cannot share a rule.

A third thing worth setting before the load: **index vshards.** `npm run app` opens 2. At ~66.5 M
title entries and ~60 bytes each, the index is ~4 GB, so 2 vshards exceeds the ~1 GB cap outright.
Open 16, both for the bytes and because the index is written on every page create and the vshard
count is what gives that write parallelism.

### Bulk loading, and what the platform actually allows

There is **no import, export, backup or snapshot tool for a deployed Durable Object's SQLite
database** — not in Wrangler, not in the API. Cloudflare's own storage-options page says the quiet
part: *"With SQLite in Durable Objects, you may also need to build some of your own database tooling
that comes out-of-the-box with D1."* D1 has `import`/`export`; Durable Objects have neither, and the
reason is architectural rather than a gap in the tooling — a Durable Object's storage is private to
the object, so its own JavaScript is the only writer there has ever been.

Point-in-time recovery exists and is not an import. `getCurrentBookmark`,
`getBookmarkForTime` and `onNextSessionRestoreBookmark` restore **that object's own** storage to a
bookmark within 30 days, configured from inside the object and completed with `ctx.abort()`. The
docs do not describe restoring from a file or into a different object, and PITR *"is not supported
in local development because a durable log of data changes is not stored locally."*

**Locally, though, the files are right there, and this is the load path for Build A.** Verified
today against this repo: after `npm run app`, each host is a plain SQLite database at
`.wrangler/app-state/v3/do/hlekk-app-HlekkHostDO/<hex>.sqlite`, holding `objects`, `assocs`,
`assoc_counts`, `outbox`, `vshards` and `index_entries` exactly as *Host schema* specifies, plus
`assocs_range`, and a `__miniflare_do_name` table whose row is the DO's name — `demo/h-6` — which is
what maps a file to a host. Ids are 8-byte big-endian blobs of `vshard << 47 | seq`, readable
straight out of the file.

So the whole of Build A can be built offline with ordinary SQLite tooling and never touch the write
path. Proven end to end on a row that hlekk never wrote: an `objects` row inserted with Python's
`sqlite3` into `demo/h-6`'s file at `(vshard 90, seq 5)`, with `vshards.next_seq` bumped to keep the
invariant that a vshard's sequence is past every id it holds, then read back through the Worker's
normal graph query — routed to vshard 90, host 6, answered in **1 request and 0 rounds**:

```
{ "title": "written straight into the sqlite file", "status": "open",
  "id": "12666373951979525", "$version": 1, "comments": [], "commentCount": 0 }
```

That turns the load from a request-rate problem into a disk-bound one: hours at worst, and no
1,000/sec ceiling anywhere in it. It also makes `src/testkit/invariants.ts` load-bearing rather than
merely reassuring — a loader that bypasses the write path has bypassed every check in it, so the
invariant pass over the finished cluster is the only thing standing between a hand-built database
and a subtly wrong one. Run it before believing any query.

**What this does not do is deploy.** A deployed demo needs the rows to arrive through running code,
and the way to make that cheap is to stop sending one request per row and **let each host feed
itself**: the loader shards its sorted output by destination vshard, uploads one file per host, and
each host ingests its own in an alarm loop. Alarms suit it — a 15-minute wall-time limit, 30 seconds
of CPU by default and up to 5 minutes via `limits.cpu_ms`, self-rescheduling by design, and
at-least-once with six retries at exponential backoff from 2 seconds. Two things stand in the way,
and only one is work:

- **Ids have to be assigned before the host mints them**, since the loader must know which vshard a
  row belongs to in order to shard by it. The fix is a reservation: a host advances
  `vshards.next_seq` by *n* and hands back the base, after which the loader computes
  `id = (vshard << 47) | (base + i)` offline. Same trick the paged-storage demo would get free from
  Software Heritage's published node order, and it keeps the sequence invariant intact.
- **R2 from inside a Durable Object is undocumented.** Reading KV from a DO has its own documented
  example (`this.env.YOUR_KV_NAMESPACE.get(...)`); R2 has nothing comparable on the DO pages, so
  that it works the same way is an inference, not a fact. Verify it with a one-binding spike before
  any plan rests on it.

**The in-DO batching recipe, whichever path.** The limits are specific and two of them bite:

| Limit | Value | Consequence |
| --- | --- | --- |
| Bound parameters per query | **100** | A parameterized multi-row insert fits ~20 `assocs` rows. Far too few. |
| SQL statement length | **100 KB** | With literals inlined instead of bound — `x'002d000000000005'` for a blob id — a row costs ~50 bytes, so ~2,000 rows per statement. |
| Row / BLOB / string size | 2 MB | Never approached by Build A. |
| Columns per table | 100 | Fine; relevant only to the generated-column indexing idea. |
| CPU per invocation | 30 s, to 5 min via `limits.cpu_ms` | Sets how much one alarm can ingest. |
| Storage per object | 10 GB, then `SQLITE_FULL` on write | Reads and `DELETE` still work when full, which is the only reason a packed host is recoverable. |

So the shape is: inline literals rather than bindings, ~2,000 rows per `exec`, many `exec` calls
inside one `transactionSync()` so the batch costs one commit. `exec` does accept several statements
separated by semicolons, but it refuses `BEGIN` and `SAVEPOINT`, so the transaction has to come from
`transactionSync`. One thing the docs do not say: whether the 100 KB limit applies per statement or
to the whole multi-statement string. Assume per call until measured.

### The passes

`scripts/load-enwiki.mjs`. Each is a stream over one published dump; nothing is held except two
flat id maps.

| Pass | Reads | Writes | Why |
| --- | --- | --- | --- |
| 0 | `page.sql.gz` | `pages.tsv` | Every page's id, namespace, title, redirect flag, length |
| 0b | `categorylinks.sql.gz` | `affinity.tsv` | Each page's first category, as its placement key |
| 1 | `pages.tsv` | pages, `ids.bin` | `createUnique` per page; `page_id → hlekk id` |
| 2 | `linktarget.sql.gz` | `lt.bin` | `lt_id → hlekk id` by `(ns, title)`; 0 means a red link |
| 3 | `pagelinks.sql.gz` | `wiki.page_links` | Grouped by source page |
| 4 | `pagelinks.sql.gz` | `wiki.linked_from` | The same rows, grouped by target page |
| 5 | `categorylinks.sql.gz` | `wiki.page_categories` | Grouped by source; the inverse rides the outbox |

- **The id maps are flat arrays, not hashes.** `page_id` and `lt_id` are dense and bounded — enwiki's
  run to roughly 10^8 — so an 8-bytes-per-slot Buffer indexed by the key is ~800 MB off-heap with
  O(1) reads, and every pass that uses one is already sorted by that key, so the access pattern is
  sequential. 0 doubles as "red link".
- **Sorting is GNU `sort`.** Every key is an integer in a fixed column. Reimplementing an external
  sort in JS would be strictly worse.
- **Run it on `simplewiki` first.** Same schema, about 1% of the size, finishes in minutes. Every
  pass either works there or is broken everywhere.
- **The row parser is a scanner, not a `split`.** A dump is `INSERT INTO \`t\` VALUES\n(…),\n(…);`
  with one row per line, but a quoted field can contain a newline, a comma or an escaped quote, so
  neither character can be split on. Verified against 200,000 real `page` rows and against unit
  cases for each of those escapes plus a row cut by a chunk boundary.
- **Every pass asserts its table's column count.** This is not defensive padding: `categorylinks`
  dropping `cl_to` made the loader read a binary collation sortkey as a category title, which wrote
  millions of garbage affinity keys and resolved no category edges at all — and every field still
  parsed, so nothing failed. Principle 7 says a changed schema should stop the load.
- **One assumption is left for the first run to settle.** `cl_target_id` is read as a `linktarget`
  id, by analogy with `pl_target_id` and because `cl_to` is gone. The column shape says so; an id
  was not resolved end to end to confirm it. So passes 2 and 5 refuse to continue when more than
  90% of their rows fail to resolve — a sparse wiki has red links, a wrong key column has almost
  nothing else, and the `simplewiki` run separates the two in minutes.

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

- [x] Build A first. It is the ~50-host demo, it is the faster load, and the thing B adds is the
      one component that is pure bulk rather than new behaviour. `src/worker/wiki.ts` is its schema
      and `scripts/load-enwiki.mjs` its loader. Build B remains an addition, not a change: a new
      object type and a new edge type are both catalog-only under *What a change costs*.
- [ ] `db.txn(anchorId, ops)` as a `Mutation` kind, needed to *deploy* the demo rather than to
      build it: the local load writes the SQLite files directly and counts no requests at all. The
      grouping the loader already produces — one anchor's whole edge list — is one vshard, so the
      smallest version is enough.
- [ ] Whether an R2 binding works from inside a Durable Object. Documented for KV, undocumented for
      R2, and the self-feeding deployed load rests on it. One binding and a spike settles it.
- [ ] Whether the 100 KB SQL statement limit applies per statement or to a whole multi-statement
      `exec` string. It sets the rows-per-call figure and the docs do not say.
- [ ] Per-index normalization, so a case-sensitive title index and a case-insensitive email index
      can coexist. `titleKey` in `src/worker/wiki.ts` is the stopgap and says so.
- [ ] The two `/ingest` routes the loader posts to, and whether they belong in the demo worker or
      behind an admin-only binding.
- [ ] Per-DO write throughput, which decides whether the load is hours or days. Unmeasured, and
      measuring it is build-plan step 1. The request-count floors above are not it.
- [ ] Index vshard count. 16 is the proposal, against the 2 that `npm run app` opens and a ~4 GB
      title index.
- [ ] The colocation group limit. It does not bind in Build A, which creates no colocated objects;
      it binds in Build B, where the most-edited pages are colocation groups of 10^5 revisions.
- [ ] The backlink degree distribution, and whether the top vshard needs placement by affinity.
- [ ] The share of enwiki links that are red, which sets the real edge count.
- [ ] Whether the demo's unpaired `page_links` / `linked_from` should become a real maintained pair
      once a live EventStreams tail is wanted, and what 1.78 B outbox deliveries would cost.
- [ ] Where the demo runs, and what a public endpoint over 50–100 host DOs costs to keep warm.
