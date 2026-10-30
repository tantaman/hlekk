# Wikimedia read-only demo

Oct 30, 2026 · @Matt Wonlaw

A follow-up written to be picked up cold, so that this branch and the Wikimedia import branch can be
brought together without replaying the conversation that produced it. It records what the demo is,
what already carries it, what was measured, and what the loader still owes.

The target: **a ~300 GB database spread across ~50 host DOs, laid out in advance, queried read-only.**
No moves, no rebalancing, no growth. A proof that the query plane assembles graph answers across tens
of Durable Objects at a size no single one could hold.

Branch: `claude/focused-pascal-cli6hi`. Relevant commits are cited inline.

## Two decisions this rests on

- **Entry is by unique lookup, then traverse.** Reads start from an id the caller holds or from
  `lookupUnique(idx, value)`. There is no scan and no non-unique index — the catalog carries a
  `unique` flag but only the unique path is built, and non-unique index maintenance is still
  deferred ([`design.md`](design.md#what-a-deployment-still-owes)). For Wikimedia this is a good
  fit rather than a compromise: a page title is unique per namespace, so *title → id → traverse the
  link graph* is the natural shape and needs nothing new.
- **The data is a real Wikimedia import**, prepared on its own branch, not a synthetic generator.
  That fixes the loader's input seam as the thing to agree on first; see *What the loader owes*.
  [`wikimedia-import.md`](wikimedia-import.md) is that side: which dumps, their measured row counts,
  the catalog they map onto, and the record stream `scripts/import-enwiki.mjs` emits. It answers five
  of the open questions below with measurements — redirects are **15,551,165**, not ~10M, and should
  be pages; `MAX_PAYLOAD` does not bind because no wikitext is stored — and raises two live bugs on
  this side: `normalize` lowercases index keys, so a `${ns}:${title}` key still collides `Ash` with
  `ASH`, and `categorylinks` has dropped `cl_to` for a `linktarget` reference.

## What already carries the demo

**The query plane is substantially built and its correctness is well covered.** The operators are all
there — `ObjectsById`, `EdgeHop`, `FieldHop`, `Where` (and/or/not/cmp plus `exists` subqueries),
`Take`, `Probe`, `Join`, `CountRel` — with cursors, paging and two drivers proven to agree.

The load-bearing evidence is the differential oracle: *a query over a database spread across hosts
equals the same query against one host holding every vshard*, fuzzed over random graphs, random
queries and random schemas. That is precisely the property the demo rests on, and it is already
pinned. **Correctness of the query plane is not the risk here.**

**Laying a topology out in advance already works.** `/admin/init` spreads a database's vshards across
a given number of hosts with index vshards reserved, all at epoch 0, and `LocalCluster.scatter`
does the same in process. A pre-laid-out read-only database stays at epoch 0 throughout, which keeps
the subtlest machinery in the system out of the demo path entirely.

## What was measured

A fan-out test at **128 vshards over 50 hosts** (`src/client/fanout.test.ts`, d763a4f), shaped like a
link graph rather than a colocation group: a page's links point at arbitrary pages, so affinity buys
nothing.

| Topology | Query | Cost |
| --- | --- | --- |
| 128 vshards / 50 hosts | 2 levels, limit 25 → ~500 objects | **61–81 host requests** |
| 256 vshards / 50 hosts | the same | 61 host requests |

**98% of edges leave their host.** Cross-host assembly is the ordinary case in this shape, not the
exception the issue-tracker fixtures exercise.

The number that matters is that requests are bounded by **hosts × rounds, not by objects** — ~500
objects for ~70 requests, at roughly 1.5 requests per host. That is what batching per host is for. At
three rounds of 50 parallel calls it implies a sub-100 ms page view, so latency is not the thing to
worry about; it is the loader.

Two things that test needed fixing first:

- **`HLEKK_VSHARDS` now sets a database's initial vshard count** (d763a4f). The library already took
  the parameter but the DO path did not pass it, so every database got `INITIAL_VSHARDS = 64`. At the
  9 GB vshard cap that is a 576 GB ceiling and awkward over 50 hosts; 128 vshards puts 2–3 on each
  host at ~2.3 GB apiece. The count is read once, when the directory first opens, and changing it
  later moves nothing. This also settles, in practice, the open question of whether `N` is a
  creation-time parameter.
- **The per-round task grouping was quadratic** (d763a4f). It rebuilt a host's batch array per task,
  so one host's batch cost k²/2 copies to assemble — invisible at tens of tasks, real at thousands.

## What the loader owes

Nothing of this exists yet. It is the whole remaining critical path.

**The bootstrap primitive is the chunked snapshot, which is also the move fix.** `install(Snapshot,
epoch)` is already *"put this data in this vshard on this host"*. What it is not is chunked: it
materializes a whole vshard as one JS object, crosses one RPC and replays row at a time inside a
single transaction, against a 128 MB isolate and 30 s of CPU per request (300 s configured). The size
that survives is measured in hundreds of megabytes. So deferring moves does **not** defer this work —
the loader needs the same chunking the move path needs, and doing it for the loader gets the move fix
with it. The shape of the fix is recorded on `Host.snapshot` and in
[`design.md`](design.md#vshards): a vshard is one contiguous key range in `objects`, `assocs` and
`assoc_counts`, so a cursor paginates it; `install` is already `INSERT OR REPLACE`, so a chunk is
idempotent; and the `vshards` row flip is already the last step, so a half-installed vshard is
invisible.

Four constraints the loader has to respect:

- **The loader mints ids, not the allocator.** Edges reference their targets, so ids have to exist
  before edges can be written without a round trip per edge. The loader groups source records by
  affinity key → vshard, allocates each vshard's sequence itself, and hands each host its
  `next_seq`, which `Snapshot.nextSeq` already carries. Practically this is a two-pass load — assign
  ids, then resolve edges — unless unresolved references are buffered in one pass.
- **The loader materializes what the write path would maintain.** Both halves of every paired edge,
  and `assoc_counts` for both directions. A bulk load cannot route backlinks through the outbox; at
  this volume that is millions of queued ops.
- **Index entries are written by hand** into index vshards — title → id, for the lookup the demo
  enters by.
- **Hosts must `adopt` their vshards, and be given the catalog lock.** Reads check ownership, not
  just writes (`host.ts`, `store.serves(...)` in `exec`), so a host that holds rows for a vshard it
  has not adopted serves nothing. `ensure` is where a host gets its lock.

### What the import branch needs to emit

Per record: an **affinity key**, a **type**, a **field map**, and **outbound edges expressed in the
source's own identifiers**. `records()` in `scripts/import-enwiki.mjs` is an async generator of
exactly that, so the loader can consume it in process and partition by `(host, vshard)` as it reads
rather than reading a ~164 GB intermediate file. One wrinkle to know: a page whose edge list exceeds
50,000 arrives as **continuation records** — same key and fields repeated, `more: true` on all but
the last — so a high-degree page does not materialize its whole list in the importer. Edges are
additive and an object write is idempotent, so the only thing the loader must not do is treat a
repeated key as a second page. See
[`wikimedia-import.md`](wikimedia-import.md#what-the-import-emits) for the shape and the passes that
produce it, including that both directions of both relations are materialized rather than declared
as inverses, exactly because the outbox is out of scope here. The loader owns everything downstream of that — vshard choice, id
minting, reference resolution, batching per `(host, vshard)`, both halves of each edge, counts, index
entries. Keeping the parse step behind that seam is what lets the ingest path be proven at 3 GB
before 300 GB is committed to it.

## Wikimedia-specific hazards

1. **`MAX_PAYLOAD` is 2 MB**, the platform's row-size limit, and so the cap on an object payload.
   Most articles are far under it; some lists are not. This needs a decision before the load rather
   than during it — truncate, drop the text and keep metadata plus the link graph, or split across
   rows. Worth measuring the dump's maximum first.
2. **Title keys need their namespace.** Uniqueness is per `(ns, title)`, so the index key should be a
   normalized `${ns}:${title}` or Talk pages collide with articles.
3. **Redirects** — roughly 10M on enwiki. Whether they are pages or a field on a page changes the
   object count substantially.
4. **High-degree pages.** A page with a million backlinks is ~1M rows at ~66 bytes, so ~66 MB on one
   vshard: fine against a 9 GB cap, and the maintained count means a degree read is not a scan. The
   cost is a hot vshard and a slow stretch of the load, not a correctness problem. Overflow storage
   keyed by `(id1, atype)` stays deferred.

**One known hazard this demo happens to avoid.** `with` does not consult the vshard cap, which is the
one path that can still carry a vshard past it and is live now that the cap sits just under the DO
limit ([`design.md`](design.md#open-questions)). A Wikimedia load has no natural parent to colocate
under and places by affinity instead, so it never takes that path.

## The demo beat worth building for

The 98% cross-host figure is a liability stated one way and the most interesting part of the demo
stated another. **Affinity is a knob.** Hash the title and placement spreads perfectly with no
locality at all. Key affinity on something that clusters — category, link neighbourhood, first letter
— and related pages land together on a host, and the same query over the same data costs a handful of
requests instead of ~70.

That is a better claim than "300 GB works": it is "here is the knob that decides whether a graph read
is one round trip or fifty, and here it is mattering." It argues for a **configurable affinity
function in the loader**, so the database can be loaded twice and compared, rather than the knob being
discovered after 300 GB is in place.

## The query editor is a different risk surface

A fixed page view and a box a stranger types a query into are not the same exposure, and the engine
is ready for the first but not the second. Measured against a 60-page graph on 8 hosts, with plans
submitted directly rather than built through the typed builder.

**What is already safe.** A limit of 10,000 over a 400-row list is clamped by the list: 8 requests,
121 nodes. A filter matching nothing returns one node and reads its list once. A negative limit
yields nothing. A predicate on a field that does not exist matches nothing rather than throwing. And
`MAX_ROUNDS` catches a query that will not converge. `MIN_RATE`, `MAX_AHEAD` and `MAX_PAGE` do their
job per step.

**What is not.** Three holes, all reachable from a plan a user can type:

| Plan | Reads | Answer | Outcome |
| --- | --- | --- | --- |
| chain depth 10, limit 3 | 32 reqs, 58 objects | 177,145 nodes | 0.9 s |
| chain depth 12, limit 3 | 32 reqs, 58 objects | 1,594,321 nodes | **16.5 s** |
| chain depth 14, limit 3 | 32 reqs, 58 objects | — | **OOM** |
| `f1 → f2 → f1` through edge frames | — | — | **never returns, OOM** |
| child naming a frame that does not exist | — | — | raw `TypeError` |

1. **The answer is exponential in depth, and no budget sees it.** A chain of `related` levels
   materializes the product of its limits — 3^depth — so depth 14 at limit 3 exhausts the heap. The
   decisive detail is the columns that *don't* move: **storage reads stay flat at 58 objects and 32
   requests across all three rows.** The coordinator re-walks the same 60 pages along every path. So
   a budget on reads, requests, rounds or objects would never fire, and those are the budgets one
   reaches for first. **The guard has to count materialized answer nodes.**
2. **Frame cycles do not terminate.** A cycle through two edge frames recurses until the heap is
   gone. A cycle through an `ids` frame *is* self-limiting, because `ObjectsById` yields nothing
   without explicit ids — which is exactly why a casual test of "what if a frame points at itself"
   comes back clean and proves nothing.
3. **A dangling child frame index** is an unvalidated read of `plan.frames[i]`.

**And one that is bounded here but not at Wikimedia scale.** A selective filter walks its whole edge
list — 60 rows and 8 requests in the probe, but the entire list on a page with a million backlinks.
[`design.md`](design.md#filtered-limits-across-hosts) already names this: *"A scan cap per query,
returning a cursor, is not built yet."* High-degree pages make it live rather than theoretical.

**The cheap guard is static.** Multiply the limits along each root-to-leaf path through the frame
graph; reject the plan if the product exceeds a budget. That catches the explosion before any I/O,
costs nothing, and falls out of the same walk that has to check the graph is a DAG and that every
child index exists. A runtime cap on materialized nodes is still worth having behind it, because a
filter makes the static product loose, and the scan cap is its own piece of work.

None of this blocks the Wikipedia UI, whose queries are fixed and written by us. It all blocks the
editor.

**Built, and two of the three holes are now unrepresentable rather than guarded.** `src/worker/wiki-query.ts`
takes a *nested description* of a query instead of a `Plan`, which settles the open question below in
the direction that removes the holes. A hop holds its children, so there is no frame index for an
author to get wrong (hole 3), and no way to name an ancestor and make a cycle (hole 2) — and
`Query.compile()` reserves a frame before emitting its children, so every child index is strictly
greater than its parent's, which is a proof rather than a sample. The tests assert that property of
the compiled plan instead of asserting that a cycle was caught.

Hole 1 is the one that needs the arithmetic, and it is the static guard this doc specified: multiply
the limits down each root-to-leaf path, sum what every node materializes, refuse past a budget. The
numbers are stated in one place and served to the client, so the editor prices a query as it is typed
and shows the same figure the server would refuse it with. The demo doc's own case — depth 4 at limit
100 — is refused as *101,010,101 answer nodes* before any I/O. 20 tests cover it.

**The editor is a text editor, not a form.** It is the overlay pattern: one tokenizer paints a `pre`
sitting behind a transparent-text `textarea`, so the glyphs an author types are the glyphs that get
coloured, and a pure `completionContext(text, caret)` drives the popup. The grammar is **hlekk's own
builder chain**, so what an author writes is what this repo's own code says:

```
page(0, "Country")
  .countAs("backlinkCount", linked_from)
  .related("links", page_links, q => q
    .limit(25)
    .where("len", ">", 20000)
    .related("via", linked_from, q => q.limit(3)))
```

Text does not widen the surface, and that is the only reason it is allowed. `parseQuery` is a
parser, not an `eval` — the text arrives at a Worker, and evaluating a stranger's text there would
hand them the isolate — and it produces the same nested description the form produced, which is then
checked by the same guard. So the holes stay closed by construction and the budget stays the budget.
Errors carry a character offset, so the editor puts the caret on the mistake instead of describing
it. 39 tests cover the language, including that a well-formed but ruinous query still gets refused.

Every name the popup offers is read from `/schema` at runtime, so it cannot offer a relation the
catalog lacks. What it completes is not tested, though, and that is worth knowing: the editor ships
as one inline string with no build step, so there is no module for a test to import. The grammar is
tested on the server; the caret-context logic is not.

**What is still true and unfixed:** a selective filter walks its whole edge list, so `where` on a
high-degree page reads the whole list — `len > 20000` over `Country` took 1,393 ms and 12 host
requests on the pilot. `maxLimit` is not a bound on that, and *A scan cap per query, returning a
cursor* is still not built.

## Not needed for this

Moves, the placement controller, rebalancing, outbox delivery, epoch transitions, the `changes` log,
paged storage. Epochs stay 0. Explicitly out of scope, and all of it already built and tested if the
demo later wants it.

## Sequence

1. ~~Plumb `N`, prove the query plane at 50 hosts with trivial data.~~ Done, d763a4f.
2. ~~Prove the whole path on a real deployment at low scale.~~ Done. Not in the original list, and it
   belonged there: `npm run ingest:deployed` against `wrangler.wiki.jsonc` runs this demo's schema,
   record shape, title entry point and page card over 43 real host Durable Objects, real KV and real
   RPC, 9/9. It found two bugs that every local test passed and two constraints that change steps 2
   and 3, which is the entire argument for doing it before them rather than after. See
   [`wikimedia-import.md`](wikimedia-import.md#the-same-ingest-deployed-which-also-works).
3. **Chunked ingest.** The real primitive, and independent of the dump's schema. Also the move fix.
   **Now load-bearing rather than preferable:** the ordinary write path is measured at ~6,300 edge
   writes/s deployed, which is ~6,400 hours for enwiki's 3.5 billion edges. It is one durable commit
   per edge, so it is the wrong primitive rather than a slow one.
4. **The loader**, against the import branch's emitted shape. Prove at ~3 GB, then scale. Two things
   it must do that this doc did not know to ask for: **batch per host in key order** (shuffled
   inserts fell to ~23 writes/s per host as the tables grew and the platform eventually refused the
   writes outright), and **use a bounded affinity key** (raw first-category put 68.2% of a subset's
   edges on one host, and no placement could have spread it).
5. ~~The demo query surface~~ — title lookup, then a page view with links, backlinks and counts.
   Done, served at `/` from the Worker, plus paging through every relation and a query editor.

## Costs to know before step 3

- **~$60/month** of Durable Objects storage for 300 GB, at $0.20/GB-month.
- **Hours of sustained ingest**, even parallelized across 50 DOs. Resumability matters more than
  throughput: a load that cannot be restarted from where it stopped will be run many times.
- Worth dialing the loader in at 3 GB before paying either.

## Open

- [x] What `MAX_PAYLOAD` forces for oversized articles: nothing, because the import stores a ~300
      character lead extract rather than wikitext. It binds only if article text is wanted, and
      `page.page_len` gives the maximum without parsing anything.
- [x] Redirects as pages, 15,551,165 of them (counted, not estimated). A redirect has its own title,
      its own `page` row and its own outbound link, and `pagelinks` resolves through `linktarget` to
      *titles* — so demoting one to a field breaks link resolution for every link pointing at it.
- [ ] Which affinity functions the demo compares. The import takes it as a parameter already
      (`--affinity category|namespace|initial|hash`, `hash` being the no-locality control), so
      loading twice is a decision rather than a rebuild.
- [x] Two passes over the dump, not one with buffered references: ids must exist before edges can
      reference them, and the alternative buffers 1.78 billion unresolved references. Both dumps
      sort cheaply on their join keys.
- [ ] Whether the demo needs any read the unique-index entry point cannot reach — which would mean
      the deferred non-unique global index, and is the one thing here that is real added scope.
- [x] The query editor's limits policy, as a first set of numbers in `wiki-query.ts`: depth 4, limit
      100 per hop, 16 frames, **20,000 materialized answer nodes**, 4 filters and 4 counts per hop.
      Served to the client so an author sees the budget being spent. Still a judgement rather than a
      derivation.
- [x] Whether the editor accepts a `Plan` directly or only a builder-produced query: **only a
      builder-produced query**, which is what makes the cycle and the dangling frame index
      unrepresentable instead of guarded.
