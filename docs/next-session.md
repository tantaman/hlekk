# Next session: loading simplewiki, and making the demo land

Oct 31, 2026

Written to be picked up cold, like its neighbours. It records what is on the branch, what the
remaining work is, and — the part worth reading first — **which of it is not built yet despite
looking as though it is**.

Prerequisite: this session needs Cloudflare credentials, which the one that wrote this did not have.
See *Before anything else*.

Companion docs: [`wikimedia-demo.md`](wikimedia-demo.md) owns the demo and the topology,
[`wikimedia-import.md`](wikimedia-import.md) owns the dumps and the record stream. This one owns only
the handoff and defers to those on anything they state.

## What is on the branch

`claude/batched-edge-writes`, PR #7, two commits on top of `main`. 283 tests, typecheck clean,
`npm run smoke` 14/14.

- **The enwiki projection was wrong and is corrected.** ~154 hours (6.4 days), not ~6,400. Both docs
  say so, and the argument for the chunked snapshot is now repeatability rather than impossibility.
- **`Host.assocAddMany`** — N edges in one transaction instead of one durable commit each. Measured
  8.4x end to end through `/ingest/edges` on workerd DO SQLite (525 → 4,425 edges/s), and 120x over a
  plain file where `COMMIT` reaches the disk. `/ingest/edges` takes the batched path by default and
  replays a failed batch edge at a time, because a batch can only report *that* it failed.
- **The cluster grid** — every host drawn, the ones that served the read lit, stated in Rindle
  Cloud's own vocabulary.
- **Lowercase titles resolve.** `titleKey` is case-sensitive; the first letter is now capitalized as
  MediaWiki does.

## Before anything else

The previous session had no Cloudflare auth (`wrangler whoami` → not authenticated), which is why
nothing below has been run against a real deployment.

Set in the environment's settings — the cloud environment menu in the session title bar, then Edit —
and a new session picks them up:

- `CLOUDFLARE_API_TOKEN` — needs **deploy and Durable Object write** scope, not read-only.
- `CLOUDFLARE_ACCOUNT_ID`

Verify with `npx wrangler whoami` before trusting anything else.

## The thing that is not built

**`npm run ingest:deployed` cannot load the full wiki, and it is easy to assume it can.** It is a
pilot harness. `selectSubset` in `scripts/wiki-subset.ts`:

1. scans at most `window` distinct keys — **capped at 200,000** — and then breaks, so `--pages
   950421` still loads at most 200,000;
2. **drops every edge whose target is outside the subset**, which is right for a subset and wrong for
   a full load;
3. holds the whole subset in memory as a `Map`, which 950,421 records carrying 42,817,596 edges will
   not tolerate.

So [`wikimedia-demo.md`](wikimedia-demo.md)'s step 4, *the loader*, is still genuinely unbuilt. The
~23 minute figure in *A cheaper path to the demo beat* is the arithmetic for a loader that streams;
it is not a claim that one exists. **Writing it is the first real task.**

What it must do, most of which is already measured rather than guessed:

- **Stream `records()`**, never materialize. It is an async generator over the merged intermediates
  and is already the seam the demo doc specifies.
- **Two passes.** Ids must exist before edges can reference them. Pass A mints ids via
  `createUnique` on `(ns, title)`; pass B writes edges. The alternative buffers 1.78 billion
  unresolved references.
- **Batch per `(host, vshard)` in key order.** A shuffled insert collapsed to ~23 writes/s per host
  and the platform eventually refused outright; grouped in key order it reached ~6,300/s, and now
  more with `assocAddMany`. `anchorOf` routes a batch by its first edge, and `Client.assocAddMany`
  groups by `vshardOf(id1)` for you.
- **Fold continuation records.** A page whose edge list exceeded the importer's cap arrives as
  several records repeating the same key with `more: true`. Treating a repeat as a second page both
  loses edges and double-counts the page.
- **Be resumable.** Hours of ingest means it will be restarted. An edge write is an idempotent upsert
  whose count moves only for a new edge, and `createUnique` resolves an already-taken title to the id
  holding it, so coarse retry is safe by construction — but the loader must checkpoint *where it
  was*, which nothing does today.

Reuse `scripts/ingest-deployed.ts`'s batching, retry and reporting; replace its `selectSubset` call
with the stream. Do not delete it — it is the thing that proves a deployment at low scale in minutes.

## The decision that cannot be undone

`indexVshards` is fixed when the directory first opens. `createUnique` writes through the index
vshard its title hashes to, so with four of them every page in pass A funnels through four Durable
Objects, and a Durable Object is single-threaded. That is the measured ~280 pages/s, and at 950,421
pages it is ~57 minutes — **the dominant term now that edges are batched**.

The previous session assumed this scales linearly with the index vshard count and said so. *It is an
assumption, not a measurement.* It is worth ~58 hours on enwiki, and it is cheap to check:

> Init two throwaway databases on workerd — `HLEKK_DATABASE` is the only reset switch there is, so a
> new name is a new set of empty objects — one with `indexVshards=4` and one with `indexVshards=32`,
> and time 10,000 `createUnique`s into each. No Cloudflare account needed; workerd shows it.

Index vshards are **grown additionally** (`allocator.grow().slice(0, n)` in `src/do/directory.ts`),
not carved out of `HLEKK_VSHARDS`, so raising the count does not cost data vshards. Measure, then
choose, then init once.

## Sequence

```bash
# 0. auth
npx wrangler whoami

# 1. measure pass-A scaling on workerd, choose indexVshards      (no account needed)

# 2. write the streaming loader                                   (the real work)

# 3. import simplewiki — downloads its own dumps (~0.18 GB), ~3 GB of intermediates
node scripts/import-enwiki.mjs --wiki simplewiki --date 20261001 --affinity category

# 4. deploy, lay out, load
npm run wiki:deploy
curl "$BASE/admin/init?hosts=50&indexVshards=<measured>"
node scripts/load-simplewiki.ts --base "$BASE"     # the loader from step 2

# 5. the control: same edges, different placement, ~58 seconds of importer time
node scripts/import-enwiki.mjs --wiki simplewiki --date 20261001 --affinity hash --passes 0b,5
#    then load into a second database — change HLEKK_DATABASE and init again

# 6. the A/B surface
```

`20261001` is the newest dated dump as of writing; dated directories are removed after a few months,
so check <https://dumps.wikimedia.org/simplewiki/> if it 404s. The importer builds its own URLs from
`--wiki` and `--date`, so do not pre-download.

## Numbers to check the run against

If a measurement disagrees with these by a lot, something is wrong — these were read off artifacts,
not estimated.

| | |
| --- | --- |
| simplewiki pages | 950,421 |
| simplewiki edges | 42,817,596 (`links × 2 + categories × 2`) |
| Import, dumps already local | 139 s |
| Re-merge for the affinity control (`--passes 0b,5`) | 58 s |
| Storage | 54.1 bytes/edge → **~2.3 GB** |
| Pass A, 4 index vshards | ~280 pages/s |
| Pass B, per-edge, deployed aggregate | ~6,300 edges/s |
| Pass B, batched, workerd one host | 4,425 edges/s (8.4x) |
| Page 1 of the record stream | `April`, ns 0, 414 outlinks, 156 backlinks, 2 categories |

**The first deployed run settles an open question for free:** whether the 8.4x survives a real
network. workerd has none between the Worker and its hosts, so pass B's deployed rate is the figure
to capture and write back into `wikimedia-import.md`.

## Hazards already paid for — do not rediscover these

- **`HLEKK_DATABASE` is the only reset switch.** There is no truncate for a deployed Durable Object's
  SQLite. A new name is a new set of empty objects, and an empty baseline is what the storage figure
  has to be read against.
- **Classic KV allows one write per second per key.** A bug that republished the shard map on every
  object create 429'd a deployed load and passed every local test, because local workerd rate-limits
  nothing. Fixed, but the asymmetry is the lesson.
- **Raw first-category affinity is unusable.** It put 68.2% of a 10,000-page subset's edges on one
  host — 2,875 pages share `Category:France_geography_stubs` — and no placement could have spread it.
  A category is an unbounded key. The importer's `category` mode already falls back to a title hash
  for the 48% of pages with no category; what it does for the pathological *present* keys is worth
  checking before trusting a 950k run.
- **Pass A must run at its own, much lower concurrency** than pass B, or the index vshards queue
  hundreds deep and the platform refuses with `Durable Object is overloaded`.
- **An empty host DO weighs 45,056 bytes deployed** against 40,960 on workerd.
- **Epochs stay 0.** Moves, rebalancing, the placement controller and the outbox are all out of scope
  and all already built if the demo later wants them. `HLEKK_SHED_BYTES` is deliberately absent from
  `wrangler.wiki.jsonc`; leave it absent.

## What the demo still needs to land

Of the four things the previous session named, two are done — lowercase titles resolve, and the
cluster is drawn rather than listed. The two that remain both need a load, which is why they are
here:

1. **Scale you can feel.** The demo currently runs 2,000 pages, which one Durable Object would hold
   with a thousandfold margin. 950,421 pages is a real encyclopedia to browse, with real hub pages
   and real degree distribution.
2. **The affinity A/B, which is the actual beat.** Same query, same data, two placements: one spread
   with no locality, one clustered. The cluster grid is already built and is where this renders — two
   grids side by side, one lit wide and one lit narrow, with the request counts under them. That is a
   better claim than "300 GB works": *here is the knob that decides whether a graph read is one round
   trip or fifty, and here it is mattering.*

**State the limit honestly when you get there.** 2.3 GB fits inside one Durable Object, well under
the 9 GB vshard cap, so this pilot cannot carry *a size no single host could hold*. That still needs
enwiki, and so still needs the chunked snapshot. The GB count is not the headline; the request count
is.

## Out of scope

The chunked snapshot and enwiki. They are the right next thing after this and are the subject of
`wikimedia-demo.md` step 3 — but enwiki's import alone needs ~250 GB of working disk for
intermediates and sort scratch, which a session container does not have. Do simplewiki first and let
it settle the deployed throughput question.
