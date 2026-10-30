# Paged storage over object storage

Oct 30, 2026 · @Matt Wonlaw

A detailed exploration behind one bullet of [`design.md`](design.md)'s *Later* section. Nothing
here is committed. It exists because the bullet described the destination as greenfield and it is
not: most of it is built, in Rust, and ran in production on a 100 GB base.

Numbers quoted as measured come from the `rindle` repository — either its own harnesses or its
deployed `r2db` demo — and are cited to the ledger that holds them. They are evidence about the
storage engine, not about hlekk.

## The destination

Back a host's trees with rindle's paged copy-on-write B+tree, whose pages live in R2, with the
Durable Object holding a durable write overlay and a hot page cache rather than the whole dataset.
This is a larger idea than the R2 tiering under *Deferred*, which only moves the cold tails of long
edge lists.

What it changes for hlekk, in order of how much it matters:

- **The vshard byte cap lifts.** A move becomes a lease handoff — fence, flush dirty pages,
  compare-and-set the manifest, grant the lease at epoch + 1 — so the write pause scales with dirty
  bytes rather than total bytes. The cap at ~1 GB exists only to bound a stop-the-world copy.
- **Read placement becomes unbounded.** Immutable pages plus a manifest version give snapshot reads
  from any compute in any region, with no replication protocol and no follower lag. Regional
  followers stop needing the `changes` log.
- **Write ownership does not change.** Object storage shares storage, not writers. Exactly one
  lease holder per vshard still serializes mutations, so the directory, epochs, `moved` replies and
  fencing all survive unchanged.
- **The correctness primitive moves.** Principle 5 becomes one lease-fenced manifest CAS instead of
  one local `transactionSync()`. A fenced but still live old owner holding dirty pages could
  otherwise flush them after the handoff and corrupt a tree the new owner is also writing; today
  such a zombie can only damage its own local copy, which is about to be dropped.

## What already exists

Enough that the work is integration rather than invention.

- **`rindle-paged-store`** is the paged tree with no engine in its dependency cone — pages, keys,
  the tree, commits, the redo log, schema and the write transaction. It was split out of
  `rindle-paged` for exactly this reason: a host that wants rows on pages and not incremental view
  maintenance can now ask for that and nothing more.
- **`rindle-paged-object`** (design 464) is pages in an object store: a part-addressed base plus
  delta layers, a durable write overlay in front, a warm page cache with an admission policy, GC
  with publication fences, and the publish/fold/sweep plane.
- **Both compile for `wasm32-unknown-unknown`**, as does the leaf above them, each under its own CI
  lane (`wasm-paged`, `wasm-paged-object`). Verified 2026-10-30.
- **The precedent ran.** `r2db` was this shape with a *JavaScript* page tier instead of a Rust one:
  a Durable Object with the wasm engine inside it and pages in R2, serving a deployed demo whose
  published base measured **100 GB across 23,993 part objects**. It was retired 2026-10-23
  (`follow-ups/r2db-tombstone.md`) because its hardest part got rebuilt one layer down and in Rust.
  So "not bounded by database size" is a thing that happened, not a hope.
- **The fault-and-retry contract is alive and tested.** `rindle-paged`'s `MissIo` is a `PageIo` that
  refuses a non-resident page, plus a `rounds()` driver, kept deliberately when r2db went "because
  the contract outlived it". The `fuzz-paged-rings` lane drives it in nine concentric rings against
  a SQLite recompute oracle.

## What is missing: the faulting arm

`rindle-paged-object`'s read **blocks** on the ranged GET. That is a decision, not an oversight
(464 §3.5): a native host can hold hundreds of GETs in flight, so blocking-plus-prefetch gets the
batching without paying re-execution. A Durable Object cannot block on R2.

So hlekk needs a faulting arm of the same leaf. Three findings about where it goes:

- **The fault belongs at the `ObjectStore` seam, below the page leaf.** That seam is already fully
  synchronous (`get`, `get_range`, `get_ranges`, and a batched multi-object form). Put the fault
  there and base resolution (pointer → layer → part), the overlay, the warm tier, GC and the
  publication plane all work unchanged.
- **The wanted set must be expressed as object keys and byte ranges, not page ids**, because that is
  what the host has to hand to `bucket.get(key, { range })`. Base resolution happens inside Rust, so
  a fault raised above it cannot name what to fetch. This is the argument for the seam above.
- **`StoreError` has no variant for it.** It is `PreconditionFailed | Io(String)`, so a miss cannot
  travel as a kind, and `io::Error::other(format!(…))` on the way out of the leaf would flatten one
  anyway. A typed variant is the honest fix — `PreconditionFailed` is already precedent for "a
  signal, not a fault".

## Rounds or async

**Rounds.** The choice was examined with everything on the table, including making the store async
from the page leaf upward.

First separate the fault from the retry, because only one can live in the store. The fault can:
record the page, refuse. The retry cannot — the unwind is a transaction abort plus a re-run of the
whole closure from the beginning, driven by something above the store. In a Durable Object that
driver is JavaScript; in rindle's CI it is `MissIo::rounds`.

The cost shapes are opposite (464 §3.5):

| | leaf blocks | fault → host drives rounds |
| --- | --- | --- |
| point read, branches resident | 1 RTT | 1 RTT + one re-run |
| wide read | *k* RTTs, serialized unless the leaf prefetches | ~depth rounds, each batching every miss |
| CPU | nothing re-executed | `O(rounds × query work)`, per round |

Three reasons rounds win here, in order of weight.

**The await lands in the wrong place.** `Host.#write` is `storage.transactionSync(f)` —
synchronous, so nothing interleaves. A Durable Object's input gate does **not** protect an await
that touches neither an event nor durable storage, and an R2 GET is exactly that; 464 cites it as
the reason the base's `writePointer` has to fence twice. An async store therefore puts an
interleaving point *inside* a mutation, and principle 5 needs concurrency control it does not need
today. Concretely: `create` reads `next_seq` and bumps it, and that is safe only because nothing
can run between the read and the write. Fault-and-retry puts the await between attempts, outside
the transaction, which is where a single-threaded actor wants it — the thread still yields between
rounds, so requests still overlap.

**It buys the small term.** Async removes re-execution, not depth; a dependent chain is a dependent
chain. And re-execution is the term r2db could subtract from a wall-clock budget *without changing
a single ceiling value*. Its per-call ceiling was refusing ~24 of ~69 real calls, **every one on
`ms` and none on `r2Gets`**; the fix was to make `ms` thread time by subtracting the wall time spent
inside `fetchRound`, "because a call parked on a fetch is not holding the thread the ceiling exists
to protect" (`follow-ups/r2db-cold-wake.md` §3). The refusals stopped and no ceiling moved.

**It forks the store.** The native consumers want sync-and-blocking. Async means two colours or
converting everyone.

The argument that does **not** apply to hlekk, and was wrongly cited at first: rindle's own
objections to an async store are mostly about its *engine* — `Graph::fetch` is infallible, the arena
operator graph relies on a shared `&Graph` borrow for reentrant fetch-during-push, and cursor
cleanup is RAII with no async `Drop`. hlekk does not use the engine. The async tail it would have to
colour is tree → cursor → txn, which is materially shorter.

**What would reopen it:** an interactive transaction, a client holding one open across round trips.
That is where restartability genuinely binds. v1 has no such API, so it is not a reason to choose
differently now.

## The planner's cost model inverts

The current model: hops inside a host are in-process reads costing microseconds, hops across hosts
are network round trips, so the win is to batch per host and ship the query to the data.

With pages in object storage the cheap axis stops being cheap — an in-host hop may be a cold page.
But the sharper half is that the two axes have **different shapes**. A cross-host fan-out is N
requests in parallel: one round whatever N is. A tree descent is *dependent* — page k+1 cannot be
named until page k arrives. So the axis the design treated as free became not merely expensive but
**serial**, while the axis it was built to avoid was always parallel.

**Batching per host is still the win, not a liability.** 50 object reads in one host request make
their 50 descents interleave, so the cost is `depth` rounds of width 50 rather than `50 × depth`
serial round trips. A Worker is capped at 6 simultaneous connections while response headers are
outstanding, so the real figure is `depth × ceil(width / 6) × RTT` — a tax on how much batching
saves, not a reason to batch less. **The number to measure is GETs per round**, which is what the
cap applies to; rounds alone will look fine while a wide round pays nine serial RTTs.

## Residency, and the one decision that cannot be deferred

Depth is the floor only when **cold**, and that is where the cheap win is. From rindle's residency
work (`follow-ups/paged-internal-node-residency.md` §7): keep levels 2-and-up in RAM, which costs
single-digit MiB and *makes a descent one local read*, with level 1 in the object's own storage.
Then a point read is **one** GET for the leaf rather than one per level.

Measured on the deployed 100 GB demo across two consecutive wakes, as the warm set converged to
1,099 of the base's 1,120 branch pages: cold query **7.34 s → 1.90 s**, `r2Gets` **53 → 16**
(`follow-ups/r2db-cold-wake.md` §4). Before that work the same demo was paying ~1.9 s of store time
on every visit, because nothing had ever populated the warm set and every wake re-descended the
tree from R2.

So the engineering that pays is the branch-page working set per host — warm the spine at wake,
record and prefetch hot leaves, persist the warm set in the object's own storage — and not the
choice of mechanism in §4.

**Page size is a v1 decision, not a later one.** A store keeps the page size it was created with and
changing it needs a rebuild. Against motivating example 5, a tenant growing from 1 MB to 500 GB:

| page size | consequence |
| --- | --- |
| 4 KiB | at 500 GiB, level 1 **alone** has spent 59% of the DO's 10 GB tier; overruns it entirely at ~795 GiB |
| **16 KiB** | level 1 of a **3.1 TiB** store fits the tier; a 1 TiB store spends 32% and still caches 0.6% of its leaves; a point read is one 16 KiB GET |
| 64 KiB | backs 12 TiB, but 192 KiB written per single-row commit — right only if read-mostly and scan-heavy |

**16 KiB**, and explicitly not the 4 KiB default. Two choices cost about as much as a page-size
step: integer or short keys (a 26-byte sequential text key costs 60% more resident memory — hlekk's
u64 BLOB ids already get this right), and scan resistance in the local tier, since writes there cost
roughly 3× the GETs that fetched the page.

## What the vshard cap actually bounds

The cap is ~1 GB and `design.md` is explicit that *"the cap is the largest unit that can be
relocated in a tolerable pause, not the largest unit that fits."* So it is set by move time and by
nothing else, and the open question says the value is a guess "until step 1's throughput
measurement". It is a placeholder for a measurement rather than a result, which is worth saying
plainly before reasoning from it.

Under lease handoff the pause scales with dirty bytes, so that reason goes away. Three bounds take
its place, and only the first is about the vshard:

- **Write rate, not bytes.** A vshard is one lease holder is one DO's single thread, against a 1,000
  requests/sec soft limit. So a vshard is bounded by the write rate its owner can serve. That is a
  load-dependent bound rather than a constant, and it means the trigger for opening more vshards
  should be load rather than gigabytes.
- **Write concurrency sets the vshard COUNT.** This is the cap's second job and it survives intact.
  `design.md` already names it: *"Opening a single vshard would funnel every create in the database
  onto one vshard on one host, against the 1,000 requests/sec ceiling."* N vshards spread across
  hosts is N parallel writers, so the count is a concurrency parameter. Bigger vshards are fine;
  *fewer* vshards costs write throughput.
- **Branch-page residency bounds the HOST, not the vshard** — see the next section.

So "roughly one vshard per gigabyte of live data" stops being the rule, in both directions: the
count is load-bound, and the per-vshard overhead below makes one-per-gigabyte actively expensive.

## What a host can hold

This is the number paged storage changes most. A host stops holding the data and holds the write
overlay, the tree's level-1 branch pages and a leaf cache.

At 16 KiB pages, ~69% steady-state fill, with integer-like keys (which hlekk's big-endian u64 blobs
are — the favourable case; a 26-byte text key costs 60% more resident memory):

| | share of store | per 1 TB of base | where it lives |
| --- | --- | --- | --- |
| all internal levels | ~0.30% | ~3 GB | — |
| levels 2 and up | ~0.0009% | **~9 MB** | RAM |
| level 1 | ~0.299% | **~3 GB** | the DO's own 10 GB tier |

Level 1 is the whole cost and does not fit RAM. Reserve half the 10 GB tier for it and a host backs
**~1.6 TB of base** — about 300× the 5 GB per DO that `design.md`'s growth table assumes. On that
table, 1 TB needs about one host rather than ~200, and 100 TB about 60 rather than ~20,000.

**Always holding the internal nodes is the right target**, and it is what makes a point read one R2
GET rather than one per level. Three caveats on "always":

- **RAM is lost on hibernation; the DO's own storage is not.** So the spine has to be *persisted*
  and re-pinned at wake from local storage, not merely cached. That is what makes a second wake
  cheap: r2db measured a cold query at 7.34 s then 1.90 s, and `r2Gets` 53 then 16, as its warm set
  converged on 1,099 of the base's 1,120 branch pages.
- **A move starts the new owner cold**, so hand the warm set over with the lease. It is a list of
  page ids, it costs almost nothing, and without it a move's cost migrates from a long pause to a
  long warm-up rather than going away.
- **The failure mode is uncalled mechanism, not missing mechanism.** r2db had all of this and its
  own open path called none of it, so every wake re-descended from R2 for months and roughly a
  quarter of first visits failed. What fixed it was a boot report with a per-phase breakdown,
  "because a single wake duration cannot say which of four fixes to apply".

## One paged store per vshard

Lease handoff only works if the unit of lease is the unit of move. If a host runs one paged store
spanning many vshards, moving a vshard means extracting a key range — a copy, not a handoff, and the
stop-the-world protocol is back.

So each vshard needs its own base and manifest in R2, and that carries a fixed per-vshard cost: a
meta page, a catalog, a manifest, a publication cycle and a GC pass, paid whether the vshard is busy
or not. At 64 vshards it is noise. At one-per-gigabyte a 100 TB database is 100,000 independent
paged stores on ~60 hosts, which is **~1,600 manifests per host** to publish and sweep.

This is an argument for fewer, larger vshards that is independent of the id-layout reasoning below,
and probably the stronger of the two. It also sets the floor under "fewer": the write-concurrency
bound above, since vshards are what parallelism is bought with.

## The id layout

Changed ahead of the storage decision, because every id ever minted encodes it and no id exists yet.
**1 reserved / 16 vshard / 47 sequence**, from 24/40. `design.md`'s *Layout* has the full reasoning;
the parts that belong here:

- **The old 16 PB ceiling was a product of the cap**, not of the field. 2^24 × 1 GB is 16 PB. What
  sets the width instead is that a logical database is what one customer spins up and the service
  scales by adding databases, so the field bounds one customer: ~65 TB at the current cap, which is
  where managed Postgres draws its line, and ~6.5 PB once a vshard is not bounded by a copy.
- **The rest went to the sequence, which is the half paged storage drives.** The byte cap is what
  used to retire a vshard early; removing it means vshards live longer and spend more ids. And
  `SEQ_BITS` can never be changed afterwards — widening it moves the vshard field and re-decodes
  every id — so it is sized generously while the vshard field is sized for what is needed.
- **The burn rate is not the request limit.** Earlier splits were sized against 1,000/sec as though
  it were writes; it is *requests*, and one transaction can create many objects in a colocation
  group. At 100,000 creates/sec — an ordinary tenant import behind `with: parentId` — 2^40 lasts
  ~4 months and 2^47 ~45 years.
- **Nothing was spent on a new field.** A type tag was rejected: it makes type immutable per object,
  pins type ids across catalog edits that teams make independently, and `design.md`'s indexing
  measurement uses "an id names a vshard but not a type" as a reason the shared object table is
  right. A fixed sub-slab field was rejected because it would come out of the sequence, the field
  under real pressure. Slabs stay dynamic.
- **The one reserved bit is the sign bit.** Every id stays below 2^63, the threshold where SQLite
  coerces an integer to REAL and two distinct ids can compare equal. Blob keys are the defence;
  this makes the collision unrepresentable. The cost is that the vshard field is fixed at 16 bits,
  with sharding above hlekk as the hatch — the same answer a Postgres instance's ceiling has.
- **One unforeseen benefit.** At 24 bits a fully fragmented shard map was 16.7M entries and 200 MB,
  which a 25 MiB KV value could not hold at all. At 16 bits the same worst case is ~786 KB, so the
  reader-side ceiling is simply gone and chunking is left doing incremental republication only.

And one idea checked and dropped: squeezing under 2^53 to make ids JS-safe numbers. Two of
`design.md`'s four reasons for blob keys are about precision, but the other two bind independently —
big-endian bytes sorting in unsigned numeric order is what makes one vshard a contiguous key range,
which the paged tree needs at least as much as SQLite did, and a missed conversion failing loudly as
an `ArrayBuffer` is principle 7. Blob keys stay either way, so there is nothing to buy.

## What hlekk already has right

The host is already written as the restartable synchronous closure a round loop requires, on both
sides, for reasons that had nothing to do with pages.

- **Reads.** `SqlStore`: *"Reads are synchronous, as DO SQLite's are, so every promise it returns is
  already settled: a batch runs in one turn of the event loop, as one snapshot, with no cursor open
  across an await."* That is the closure shape `rounds()` wants.
- **Writes.** `Host.#write` wraps `storage.transactionSync(f)`. Synchronous, transactional, rolled
  back on throw.
- **`create` is idempotent across rounds by construction.** The id comes from `next_seq` *in the
  `vshards` row*, so a fault aborts the transaction, the `UPDATE` rolls back, and the retry reads the
  same value and produces the same id. A UUID or an in-memory counter would hand out a different id
  per round. Note this splits the open question in two: a *round* retry is safe, a *client* retry
  after a lost reply is not, and only the second needs an idempotency key.
- **Outbox delivery is already outside the transaction.** `Deliverer.drain()` is async and driven
  off committed rows, so a retry cannot double-send.
- **Per-round CPU is small**, because the API is restricted: point reads, ordered range reads with
  limits, and maintained counters. Nothing re-executes a join.

## Three hazards

- **A page miss must not travel as `UNKNOWN`.** The two signals want opposite responses. `Refusal`
  carries no target, so `UNKNOWN` sends the coordinator back to the directory to re-resolve — "ask
  someone else". A page miss means "ask me again, I will have it". Conflated, every cold page costs
  a directory round trip and looks like a move. **The page loop belongs inside the host's turn,
  invisible to the coordinator** — which is also what makes the two round loops nest and the
  coordinator protocol genuinely unchanged.
- **`#write`'s rethrow is load-bearing and accidental.** It recognizes five typed refusals and
  rethrows everything else, and that rethrow is what lets a miss escape to the round driver. A
  catch-all added there later turns a miss into a refusal and the loop silently stops converging —
  a failure that only appears in a Worker.
- **The round cap must bound dependency depth, not data.** A spanning read has to record *every*
  page it is missing, not the first; otherwise one round fetches one page of a run and a deep chain
  needs a round per page. `MissIo` does this deliberately and says so.

## Integration seams

Asymmetric, and worth knowing before estimating:

- **Reads have a seam.** `Store` is the interface and `SqlStore` is one implementation, so a
  paged-backed `Store` drops in. This is what *"`Store` is row-shaped over an opaque backing"* was
  protecting, and it was the right call.
- **Writes do not.** `Host`'s mutations are SQL strings against `objects` / `assocs` /
  `assoc_counts` / `outbox` with no interface between them and the store. So the read path is a
  substitution and the write path is a rewrite. Giving the write path a `Store`-shaped seam is
  useful on its own and could land independently of any paged work.

## Open

- [ ] The faulting arm's shape in rindle: a typed `StoreError` variant, and whether the wanted set
      is drained per call or accumulated across a round.
- [ ] Prefetch batching against the Worker's 6-connection cap and 10,000-subrequest limit. Width is
      the exposure here, where depth is the native tuning lever.
- [ ] Publication cannot ride the round loop: a PUT is a side effect and the loop's closure must be
      restartable. Publication is alarm-driven and outside a read transaction, so this is a separate
      protocol (prepare bytes, host PUTs, host confirms) rather than a blocker. `PreparedPublication`
      in `rindle-paged-object` is the shape to read first.
- [ ] Flush cost: a copy-on-write tree rewrites the root path on every leaf write and each flush is
      a billed operation, so page size is a cost decision as much as a latency one.
- [ ] Per-DO request limits and single-threaded execution are untouched, so one object's write rate
      stays bounded by one DO.
