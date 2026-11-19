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

**Since built, for moves** (`Host.chunk`, `Host.install`, and the cursor the mover records). A chunk
whose `next` is set lands staged and unserved on a host that does not hold the vshard; the one whose
`next` is null writes the `vshards` row with its `next_seq`. Into a vshard the host already owns at
the chunk's epoch, which is what a laid-out database is, each chunk lands as an ordinary idempotent
write. So the primitive this section asks for exists. The loaders in `scripts/` do not use it yet.

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

**Built, and two of the three holes are now unrepresentable rather than guarded.** `examples/wiki/wiki-query.ts`
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

## A cheaper path to the demo beat

The sequence above conflates two goals that need different work: making the demo **big**, and making
it **land**. Only the first needs enwiki and the chunked snapshot. *The demo beat worth building for*
is the affinity knob, and the knob is about **requests per query, not bytes** — so it is fully
visible at a size the existing primitives can load.

**Full simplewiki is that size, and it is already the pilot this doc asks for.** Step 4 says *prove
at ~3 GB, then scale*; `wikimedia-import.md` reports the whole of simplewiki as 950,421 pages and
42,817,596 edges, which at the pilot's measured 54.1 bytes/edge is **~2.3 GB**. The "~3 GB pilot" and
the entire dataset are the same artifact — no subset, and so no subset's distorted edge share to
explain away.

### Edges are no longer the cost

`Host.assocAddMany` writes many edges in one transaction. `assocAdd` is one mutation and *every
mutation commits in one transaction*, so a thousand edges were a thousand durable commits; the
~6,300 edges/s ceiling was measuring the commit, not SQLite. Measured on one host over real SQLite,
20,000 edges in chunks of 1,000:

| Backing | Per-edge | Batched | |
| --- | --- | --- | --- |
| In memory (`LocalCluster`'s) | 62,599/s | 135,010/s | 2.2x |
| File-backed, `COMMIT` reaching the filesystem | 791/s | 95,080/s | 120x |
| Through `/ingest/edges` on workerd DO SQLite, one host | **525/s** | **4,425/s** | **8.4x** |

The in-memory row is why `ingest:local` will barely move: it never pays for durability, so it was
never measuring this. The third row is the one to plan against — it is the whole path, through the
endpoint, onto Durable Object storage — and the reason to trust it is its per-edge figure: **525/s**,
against the **~570/s per host** the deployed pilot measured. workerd's per-edge rate and a deployed
host's are the same number, so the batched rate beside it is a fair proxy for a deployed host, and
both of its runs were checked by reading the maintained count back at 4,000 of 4,000 rather than by
trusting the endpoint's own report.

What this does *not* claim is a deployed number. Removing commits exposes whatever is behind them —
RPC round trips, request CPU, payload size — and only a deployed run says where that sits; workerd
has no network between the Worker and its hosts. Carried across at 8x, the pilot's 6,300/s aggregate
suggests simplewiki's 42,817,596 edges in **roughly 15–30 minutes** rather than 1.9 hours, which is
the figure to check rather than to quote.

**Checked: 21.1 minutes, at 33,832 edge writes/s aggregate over 43 deployed hosts** — inside the
predicted window, so the projection was sound. Two things the projection could not have said. The
rate is not flat: it opens at **90,132/s** against empty hosts and settles toward **~27,500/s** as
the tables grow, so an aggregate is an average over a decaying curve and the decay past 63 MB/host is
still unmeasured. And the gain over the per-edge path is **5.4x deployed**, not workerd's 8.4x —
removing the commits exposed the network, exactly as this paragraph warned. A second run over rows
that already existed held 33,832/s, so the upsert path costs about what the insert path does.
`/ingest/edges` takes the batched path by default and falls back to the per-edge write when a batch
throws, because a batch is one unit and so can only say *that* it failed, while a resumable load
needs to know *which* edge did.

### Which makes pass A the bottleneck — though not for the reason given here first

With edges off the critical path, pass A is the dominant term. This section used to say that a
`createUnique` funnels through the database's **four** index vshards, that `indexVshards` is fixed
when the directory first opens, and that the irreversible decision was therefore to open more of
them. The middle clause is true. **The conclusion is wrong, and measuring it was cheap.**

A database was init'd with **64** index vshards and pass A run against it on real Cloudflare:

| Index vshards | Pages in flight | Pass A |
| --- | --- | --- |
| 4 | 96 | ~280/s |
| 64 | 96 | 390/s |
| 64 | 384 | **590/s** |
| 64 | 768 (batch 600) | 552/s |

Sixteen times the index vshards bought **1.4x**, and concurrency past ~384 bought nothing at all. At
590 pages/s each of the 64 index vshards is taking 2 × 590 / 64 ≈ **18 commits/s**, against the
**525–570/s** a single host sustained for per-edge writes in the table above — a 30x headroom — and
each of the 43 hosts is taking 590 / 43 ≈ **14 creates/s**. Nothing in the index is near saturation.

What is saturated is **one object**, and it is not an index vshard. `createUnique` is four sequential
hops, not three:

```
indexVshardFor(key)  ->  the DIRECTORY DO   <- one per database, single-threaded
indexReserve         ->  an index vshard
create               ->  the page's host
indexConfirm         ->  an index vshard
```

`Hlekk.createUnique` opens with `await this.#transport.indexVshardFor(key)`, and
`cloudflareTransport` serves that by calling the **directory** Durable Object — of which there is
exactly one per database. Every page in pass A queues behind it whatever the index vshard count is,
and ~590/s is that one object's ceiling. It is also why local workerd shows *no* scaling across 4,
16, 32 and 64 index vshards (741 / 685 / 689 / 704 pages/s, all at 96 in flight): an invariant
bottleneck is invariant there too, which is why workerd could not have settled this question and the
deployed run had to.

**So opening more index vshards is not the fix, and the one-way decision at `init` matters far less
than this doc claimed.** The fix is that `indexVshardFor` should not be a network call at all. It is
`set[indexHash(key) % set.length]` (`directory/directory.ts`) — a pure function of the key and the
index vshard list. The list lives in the directory's own meta and is **not** published in the shard
map (`directory/map.ts` carries no index entries), which is the only reason a client has to ask for
it. Publishing it removes the hop and the serialization point together, and is worth about 4x on
pass A by the table above.

It is not free, which is why it has not simply been done here: a client holding a stale list after
the set grows would hash a title into a different index vshard than its neighbours do, and
uniqueness is the one thing that index exists to guarantee. It needs the shard map's versioning, not
a cache — the same epoch machinery, applied to a second published fact.

Batching the index path the way the edge path is batched remains the other half: `createUnique` is
reserve → create → confirm across two hosts, a three-phase protocol rather than one transaction, and
more work than `assocAddMany` was.

64 index vshards were chosen for the pilot regardless. They cost ~2.9 MB of empty schema, they come
*additionally* out of the grown batch rather than out of `HLEKK_VSHARDS`, they did remove real
queueing (280 → 390 at equal concurrency), and they are the shape that pays off the day the
directory hop goes away.

### What it costs and what it cannot show

Two loads — `category` and the `hash` control — are the comparison. The second needs **no re-import
at all**: `affinityOf` is called when a record is *read*, not when the wiki was imported, so
`records({ affinity: "hash" })` over the same intermediates is the control. The 58-second
`--passes 0b,5` re-merge is only needed to materialize `records.jsonl`, which a streaming loader
does not use. ~4.6 GB of storage, under $1/month.

**The comparison costs a second deployment, not a second variable, and this is forced.** A Durable
Object's env comes from the deployment that defines its namespace, never from whoever called it. A
Worker can address the object named `other/h-3` perfectly well — but that object then resolves *its*
peers and *its* KV chunk key from *its own* `HLEKK_DATABASE`. So a Worker holding two database names
does not get two databases: it gets one set of hosts that the second database's directory adopts
vshards on, and one set of map chunks that the second database publishes over the first's. That was
tried, and workerd reported it as `indexLookup: host does not hold index vshard 155`, with two
"databases" sharing all 43 hosts and each having overwritten the other.

So `wrangler.wiki-hash.jsonc` is a second deployment with its own `migrations`, and therefore its own
host and directory namespaces. `hlekk-wiki` binds it as a service and forwards `?placement=b` to it,
which keeps the comparison same-origin for the browser and off the public internet. The control has
no such binding, so a forward cannot loop.

**The honest limit: 2.3 GB fits inside one Durable Object**, well under the 9 GB vshard cap. So this
pilot cannot carry *a size no single host could hold* — that claim still needs enwiki, and so still
needs the chunked snapshot. What it can carry is the better claim this doc already identified: here
is the knob that decides whether a graph read is one round trip or fifty, on 950,421 real pages, with
the same query and the same data on either side of it. The GB count is not the headline; the request
count is.

## What the placement comparison answered

The demo exists to show that placement following the access pattern beats placement ignoring it. Both
sides were loaded — 950,421 pages and 42,817,596 edges each, same code, same 43 hosts, same 192
active vshards — and the answer for the key the demo was built around is **no, barely**.

| Placement | Hosts touched by one page's links and categories, of 43 |
| --- | --- |
| `category` — the page's first category | **27.0** |
| `hash` — the title, the no-locality control | **34.2** |
| ratio | **1.27x** |

Fourteen `ns:0` pages with 57–73 outlinks, the entire link and category set returned on both sides
and the target lists verified identical. Every one of the fourteen favoured clustering, 1.07x–1.67x,
so the effect is real. It is just small, and "one round trip or fifty" is not what it says.

**Why, measured rather than argued.** 469,546 of 950,421 pages — **49.4%** — have no category at all
and fall back to a title hash, so half the corpus is placed at random by construction. The decisive
part is the other half: a page's ~65 link targets carry **32–50 distinct first categories**. `1068`
has 73 targets across 50 keys; the best case found, `Number_theory`, is 66 across 32. There is almost
nothing to colocate, because **a page's categories describe the page and its links point away from
it** — which is not a flaw in simplewiki but what an encyclopedia is.

The control behaves exactly as a control should, which is the check that makes the rest trustworthy:
34.2 against a uniform expectation of `43 × (1 − (42/43)^65) = 33.6`.

**A method error worth recording, because the first answer was wrong.** A read with a `limit`
returns the targets with the smallest ids, and `init` assigns vshards to hosts in contiguous blocks
(`Math.floor(i / per)`), so a limited sample lands in a narrow band of hosts *whatever* the
placement. The first run reported 1.39x and had clustering losing on several pages — an artifact of
sampling, not a result. Only a page whose entire target set fits under the limit compares anything.
The UI's placement tab had the same bias at `limit=25`, was later raised to 100, and has
since been removed from the demo — the comparison is a finding recorded here, not a control
a visitor needs to re-run.

**The knob's larger effect was on writes, in the opposite direction.** Pass B ran at 33,832 edges/s
clustered against 164,021 spread — **4.8x** — because first-category affinity put **20.9%** of all
edges on one host (541 MB against 22 MB on the lightest, where even is 2.3%), and the loader keeps
one batch in flight per host, so the whole load waits on the straggler. Measured, placement cost 4.8x
of write throughput to buy 1.27x of read fan-out.

### So the key is derived from the graph instead

`scripts/partition-wiki.mjs`. The edge list is a recorded copy of the traversals the demo performs,
so the key stops being guessed from metadata and is computed from the traversals: partition the graph
so that few edges cross a host, then name the part. The partitioner's objective — edges cut — **is**
the number the A/B measures, which is the reason to derive the key rather than hunt for a cleverer
field.

Capacity-constrained asynchronous label propagation, seeded breadth-first, 42.8 million edges in
about 8 seconds. Four choices in it are load-bearing:

- **Partition at host granularity, then split within the host.** A read's cost is hosts, so the host
  boundary is the one the cut must avoid. Partitioning into 192 vshards and grouping those onto 43
  hosts was tried and is worse — the first level spends its effort on boundaries the second
  dissolves — and measured 11.2 hosts against 9.1 for partitioning into 43 directly. The split below
  it only has to balance; a vshard is still the unit of movement, so it is not pointless, it is just
  not what the question is about.
- **Balance by degree, not by page count.** Edges are the bytes: 42.8M of them against 950k pages.
- **Balance as a hard constraint.** Unconstrained label propagation collapses to one label per
  connected component — a perfect cut score for a useless partition. The category placement is the
  same failure from the other end.
- **A nonce in each part's key.** `Allocator.place` does `active[fnv(key) % active.length]`, so the
  key alone decides the vshard and two parts whose keys collide share one. Collisions merge
  neighbourhoods the partitioner worked to separate, for reasons having nothing to do with the graph.
  A few hundred hashes per part buys exact placement through the ordinary affinity seam, with no
  change to the engine: it chooses a string, and the engine does what it always does with one.

Predicted on 3,013 `ns:0` pages with 50–150 total edges, forward targets only:

| Placement | Hosts touched, of 43 | vs `hash` | Heaviest host's edge share (even is 2.3%) |
| --- | --- | --- | --- |
| `category` | 20.8 | 1.33x | 20.9% |
| `hash` | 27.7 | 1.00x | 3.4% |
| `graph` | **8.6** | **3.20x** | **2.8%** |

The graph key is also the best *balanced* of the three — 1.20x the mean edge load against the
control's 1.46x — which matters because a placement that won on balance rather than on locality would
be answering a different question. Cut is 32.1% of edges and a page's neighbourhood spans 5.2 of 43
parts.

**Two validations before any of this was deployed**, because an offline model that predicts 3.2x is
worth nothing on its own:

- The model of `place` reproduces the live `hash` database's object count on **182 of 192 vshards
  exactly**, total error 10 pages in 950,421.
- Loaded against local workerd, **3,000 of 3,000 objects landed on the vshard the partition chose** —
  which also confirms `init` is deterministic, since the local database's active set had to match the
  production map the partition was computed against. All three deployments have byte-identical shard
  maps.

What this does not yet include is the live load and the live measurement of the third placement; the
3.20x above is a prediction from the real graph and the real cluster map, not a reading off a
deployment.

**What the whole exercise says about the demo's thesis.** Placement is worth a multiple here, but the
multiple comes from a key derived from the access pattern, not from a field that happens to sit on
the object. A metadata key is a *guess* that the thing a page is filed under is the thing it is read
with; on an encyclopedia that guess is wrong, and the demo can only show it is wrong by measuring it.
The honest headline is 3.2x with a graph-derived key and 1.27x with a category — and the reason the
second number is small is more interesting than the first number being large.

## Sequence

1. ~~Plumb `N`, prove the query plane at 50 hosts with trivial data.~~ Done, d763a4f.
2. ~~Prove the whole path on a real deployment at low scale.~~ Done. Not in the original list, and it
   belonged there: `npm run ingest:deployed` against `wrangler.wiki.jsonc` runs this demo's schema,
   record shape, title entry point and page card over 43 real host Durable Objects, real KV and real
   RPC, 9/9. It found two bugs that every local test passed and two constraints that change steps 2
   and 3, which is the entire argument for doing it before them rather than after. See
   [`wikimedia-import.md`](wikimedia-import.md#the-same-ingest-deployed-which-also-works).
3. **Chunked ingest.** The real primitive, and independent of the dump's schema. Also the move fix.
   The ordinary write path is measured at ~6,300 edge writes/s deployed, which is **~154 hours (6.4
   days)** for enwiki's 3.5 billion edges — not the ~6,400 hours an earlier draft gave, which had the
   unit slipped from days to hours. It is one durable commit per edge, so it is the wrong primitive
   rather than a slow one; but at 6.4 days it is a *painful* primitive rather than an impossible one,
   so what makes this load-bearing is repeatability — the affinity comparison means loading twice —
   not impossibility. **It is also not what stands between this branch and a demo that lands:** see
   *A cheaper path to the demo beat*.
4. **The loader.** Built, as `scripts/load-wiki.ts`:

   ```bash
   node scripts/load-wiki.ts --base "$BASE"                      # the whole wiki, category affinity
   node scripts/load-wiki.ts --base "$ALT" --affinity hash        # the control, into the other deployment
   node scripts/load-wiki.ts --base "$BASE" --pass A --pages 10000   # probe a setting
   ```

   It streams `records()` and never materializes it; the only thing it holds for the run is the
   `page_id -> hlekk id` map, which pass B cannot avoid because an edge names its target by page id
   and only pass A knows what id that page got. Two passes, because ids must exist before an edge
   can reference one. Batches per `(host, vshard)` in key order with **one batch in flight per
   host**, since a vshard is one contiguous key range and a Durable Object is single-threaded.
   Continuation records are folded, so a page whose edge list exceeded the importer's cap is one
   page and not several.

   **Resumable, which it needs to be:** pass A appends every `key -> id` it mints to a checkpoint
   (which is also where pass B reads its map), and pass B checkpoints a watermark — a page key below
   which every edge is acknowledged, held back by anything still buffered or in flight, so a resume
   can only redo work and never skip it. Proven by killing a run mid-pass-A: 5,550 ids were
   checkpointed against 6,600 objects actually written, and pass A's idempotency absorbed the gap
   (`1,800 already present`) for 6/6 checks and exactly 20,000 objects.

   `ingest-deployed.ts` is kept and is *not* this: `selectSubset` scans at most 200,000 keys, drops
   every edge pointing outside the subset, and holds it all in memory. Right for a subset, wrong for
   a wiki — but it still proves a deployment at low scale in minutes.

   **An interrupted load can strand objects, and nothing can find them afterwards.** The completed
   load reported 950,423 objects for 950,421 pages, and the two are accounted for exactly.
   `createUnique` is reserve → create → confirm across two hosts; if the process dies between the
   create and the confirm, the client's own recovery (delete the object, release the reservation)
   dies with it. The reservation lapses after `RESERVATION_TTL_MS` and frees the title, but the
   object stays — with no index entry pointing at it, in a system whose only entry point is that
   index. The first load crashed having written 297,749 objects against 297,743 checkpointed ids;
   on resume, 4 of those 6 resolved through the index as *already present* and were reused, and the
   other 2 had never been confirmed, so pass A minted fresh objects for their titles and left the
   originals unreachable. So `objects == pages` is not an invariant across a crash, there is no
   garbage collection for the difference, and `/admin/wipe` is the only thing that can reclaim it —
   by erasing the whole database. The check is left to fail rather than widened, because the
   discrepancy is real.

   Three hazards it had to be taught, two of which this doc did not know to ask for:
   - **Batch per host in key order.** Shuffled inserts fell to ~23 writes/s per host as the tables
     grew and the platform eventually refused outright.
   - **Use a bounded affinity key.** Raw first-category put 68.2% of a subset's edges on one host.
   - **Retry pass A for longer than a reservation lives.** `createUnique` reserves the title, creates,
     then confirms. If a batch's response is lost after the reservations are taken, the retry meets
     its own predecessor's reservations — and an unconfirmed reservation is the one state
     `lookupUnique` cannot resolve, so the Worker rethrows `ValueTaken: already taken by a
     reservation in flight`. Nothing clears it but the reservation lapsing. A 12.4 s retry window
     against `RESERVATION_TTL_MS` of 30 s killed a load **290,400 pages in**, on a title that
     appears exactly once in the dump: the collision was the loader meeting itself. The window is
     now derived from the constant and checked at startup.
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
- [x] Which affinity functions the demo compares: **`category`, `graph` and `hash`**, the last being
      the no-locality control. `category` against `hash` was the original pair, chosen as the two
      ends of the axis — one buys whatever locality the link graph has, the other provably none — and
      because the mode is applied when a record is read, so a second load needs no re-import. It was
      loaded, measured at **1.27x**, and that answer is why there is a third: `graph`, whose key is
      computed from the edge list by `scripts/partition-wiki.mjs` rather than read off the page.
      Predicted 3.20x. See "What the placement comparison answered".
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
