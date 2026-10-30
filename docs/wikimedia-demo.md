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
source's own identifiers**. This is what `scripts/import-enwiki.mjs` writes, as JSONL — see
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

## Not needed for this

Moves, the placement controller, rebalancing, outbox delivery, epoch transitions, the `changes` log,
paged storage. Epochs stay 0. Explicitly out of scope, and all of it already built and tested if the
demo later wants it.

## Sequence

1. ~~Plumb `N`, prove the query plane at 50 hosts with trivial data.~~ Done, d763a4f.
2. **Chunked ingest.** The real primitive, and independent of the dump's schema. Also the move fix.
3. **The loader**, against the import branch's emitted shape. Prove at ~3 GB, then scale.
4. **The demo query surface** — title lookup, then a page view with links, backlinks and counts.

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
- [ ] The query editor's limits policy: maximum depth, maximum limit per frame, and the budget a
      path's product of limits may not exceed. The mechanism is cheap; the numbers are a judgement
      about what a stranger may spend.
- [ ] Whether the editor accepts a `Plan` directly or only a builder-produced query. Accepting plans
      is what puts the validator on the critical path.
