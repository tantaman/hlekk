# Onto the paged store, over R2

Oct 30, 2026 · @Matt Wonlaw

> **Status: proposed.** This is the plan [`paged-storage.md`](paged-storage.md) explored and
> [`design.md`](design.md)'s *Later* section parked. It supersedes neither: the exploration holds the
> cost model, the measured numbers and the arithmetic, and is cited rather than restated here. What
> this doc adds is the decisions — six of them — and the order to take them in.

## What this decides

1. **Host storage becomes `rindle-paged-store`**, a copy-on-write B+tree, with pages in R2 behind
   `rindle-paged-object`'s `PageIo`, a durable write overlay and warm page tier in the DO's own
   SQLite, and the branch spine in RAM.
2. **Go all the way to R2 now**, rather than landing pages-in-SQLite as a step. Not because the step
   was wrong — because residency makes it a *tier* of the destination instead of a detour. §2.
3. **IDs become `i64`**, not 8-byte big-endian blobs. The layout already fits: the id space is
   exactly `[0, i64::MAX]`. §5.
4. **`int64` joins the catalog's scalars**, and id-typed fields become integer cells. §6.
5. **One paged store per vshard**, created on the vshard's first write. §4.
6. **The byte cap is retired.** A vshard closes to new roots on load and on sequence exhaustion;
   residency becomes a *host* budget the placement controller manages. §9.

Three things deliberately do not change, and they are the reason this is tractable: write ownership
(one lease holder per vshard), principle 5 (one mutation, one local transaction — §7), and the
coordinator protocol (§8).

## 1. What we are standing on

Not greenfield. Taken from the `rindle` repo, verified 2026-10-30:

| What | Where | State |
| --- | --- | --- |
| The paged tree — pages, keys, commits, redo log, schema, write txn | `rindle-paged-store`, design 438 | Shipped; no engine in its cone |
| Pages in an object store — part-addressed base, delta layers, overlay, warm tier, GC, publish/fold/sweep | `rindle-paged-object`, design 464 | Shipped; **no production consumer yet** |
| Exact `i64` cells, end to end, exact comparator | `rindle-value`'s `ValueType::Int`, design 226 A–D | Shipped |
| The fault-and-retry contract, nine rings against a recompute oracle | `rindle-paged-store`'s `miss.rs`, lane `fuzz-paged-rings` | Shipped |
| Both halves compile for `wasm32-unknown-unknown` | lanes `wasm-paged`, `wasm-paged-object` | Shipped |

And it ran. `r2db` was this shape with a *JavaScript* page tier, serving a deployed demo on a
published base of **100 GB across 23,993 part objects**. It was retired 2026-10-23 because its
hardest part got rebuilt one layer down and in Rust (`follow-ups/r2db-tombstone.md`). Its
`cdylib` — the paged store behind a `PageIo` whose tiers lived in JS, plus the `#[wasm_bindgen]`
surface a Worker drives, 6 files — is readable at **`f347f85`** on branch
`claude/brave-babbage-td1koc`. (The ledger names `08c186f`; that SHA does not resolve on the branch
it cites, and `f347f85` is the commit before the removal. Worth a ledger fix.)

So hlekk would be `rindle-paged-object`'s first production consumer, which that ledger calls "the
next thing worth fixing".

## 2. Why all the way, and not pages-in-SQLite first

The intermediate step was: keep the data resident, put the tree's pages in `ctx.storage.sql`, skip
R2 and therefore skip the faulting arm. It is a real step and its reasoning was sound. It is also
**already inside the destination**, which is why it is not worth landing separately.

`rindle-paged-object`'s warm tier is a `WarmCache` over a slot file — a `PageIo`-shaped device that
persists admitted pages and survives hibernation. In a Durable Object that device is
`ctx.storage.sql`. So "the tree's pages live in the DO's own SQLite" is not an alternative
architecture; it is the warm tier of this one, doing its job.

And `WarmOptions` already carries the knob:

```rust
pub struct WarmOptions {
    pub page_size: u64,
    pub budget_bytes: u64,
    /// Branch pages at or above this level are pinned. PIN_MIN_LEVEL is 464 §3.4's.
    pub pin_min_level: u8,       // u8::MAX pins nothing; lower pins more
}
```

`pin_min_level` defaults to `PIN_MIN_LEVEL = 2` — levels 2-and-up, the branch spine, which is
464 §3.4's policy and what makes a point read one GET instead of one per level.
**`pin_min_level(0)` pins everything, leaves included.** With a `budget_bytes` that covers the
store, every read is local and synchronous, no fault ever fires, and the round loop never runs a
second round.

That is the small-database mode, and it is an option value rather than a code path. Which settles
the sequencing question: landing pages-in-SQLite first would be building, as a milestone, a
configuration of the thing it was a step toward.

## 3. Residency is a spectrum, and small is one end of it

Three tiers, split by whether they can answer **now**:

| Tier | Holds | Synchronous | Survives hibernation |
| --- | --- | --- | --- |
| RAM | the branch spine, plus hot leaves | yes | no |
| `ctx.storage.sql` | the write overlay, plus the warm slot file | yes | **yes** |
| R2 | the immutable base, as part objects | **no** | yes |

The two numbers that matter, at 16 KiB pages, ~69% fill, integer keys — from
`follow-ups/paged-internal-node-residency.md` §7 and
[`paged-storage.md`](paged-storage.md#what-a-host-can-hold):

- **levels 2 and up: ~0.0009% of base, ~9 MB per TB.** Fits RAM at any size we care about.
- **level 1: ~0.299% of base, ~3 GB per TB.** Does not fit RAM; fits the DO's own tier.

So the policy is a function of one quantity — what the vshards on this host sum to against the
host's resident budget — and it has three regimes:

| Regime | Condition | `pin_min_level` | Behaviour |
| --- | --- | --- | --- |
| **Resident** | the whole base fits the budget | `0` | every read local; R2 is write-only (durability, moves, followers) |
| **Spine-resident** | level 1 fits the budget | `2` (default) | a point read is one GET for the leaf |
| **Degraded** | level 1 does not fit | `2`, budget-bound | a descent may fault at more than one level |

**This makes full residency a placement-controller objective, not a configuration flag**, and it
inverts the controller's job in a useful way. Today it sheds on byte and request pressure. Now it
also sheds to keep hosts under their resident budget — and when it cannot, the host *degrades*
rather than failing. Principle 8 ("small stays small") stops being a property of how little a small
database stores and becomes a property the controller holds for as long as it can.

Reserve half the 10 GB tier and the regime boundaries fall at roughly **5 GB of base per host** for
Resident and **~1.6 TB** for Spine-resident. The second figure is ~300× the 5 GB per DO
`design.md`'s growth table assumes: 1 TB needs about one host rather than ~200.

**What this does not do is make a cold wake free.** RAM is lost on hibernation; the slot file is
not. r2db measured a cold query at **7.34 s then 1.90 s**, and `r2Gets` at **53 then 16**, across
two consecutive wakes as its warm set converged on 1,099 of the base's 1,120 branch pages
(`follow-ups/r2db-cold-wake.md` §4). Before that work the same demo paid ~1.9 s of store time on
*every* visit, because nothing had ever populated the warm set. The lesson in that ledger is not
about mechanism — r2db had all of it — it is that **its open path called none of it** for months,
and what fixed it was a boot report with a per-phase breakdown, "because a single wake duration
cannot say which of four fixes to apply". We should ship that report with the first host, not after
the first incident.

## 4. One paged store per vshard, created lazily

Lease handoff only works if the unit of lease is the unit of move
([`paged-storage.md`](paged-storage.md#one-paged-store-per-vshard)). A store spanning many vshards
makes moving one an extraction of a key range — a copy, and the stop-the-world protocol is back. So
each vshard gets its own base, manifest and store.

That carries a fixed per-vshard cost: a meta page, a catalog, a manifest, a publication cycle and a
GC pass. **Taken naively it breaks principle 8.** A new database is 64 vshards, and 64 stores ×
~4 pages × 16 KiB is ~4 MB of pages, 64 R2 manifests and 64 publication cycles — for a database
`design.md` promises costs "about 2 KB".

So: **a vshard's store is created on its first write.** A two-row database has one or two stores;
the other 62 vshards exist in the `vshards` table and in the directory, as they do today, and cost
what they cost today. An untouched store publishes nothing, so its publication and GC passes are
no-ops. The per-vshard cost becomes proportional to vshards that hold data, which is the right
shape.

One consequence to accept: the allocator hashes a root's affinity key across the active set, so a
database with 64 roots of distinct tenants will have materialized all 64 stores. That is the
intended behaviour — it is the same pre-sharding argument `design.md` makes under *Initial
sharding*, and the cost at 64 is noise. The shape this rules out is "one vshard per gigabyte": at
100 TB that would be ~100,000 stores on ~60 hosts, ~1,600 manifests per host to publish and sweep.
§9 retires the rule that produced that number.

## 5. IDs become `i64`

**`OwnedValue` has no blob cell.** The variants are `Absent | Null | Bool | Int(i64) | Float(f64) |
Str | Json`, in both the owned and borrowed forms. So a key is an `Int` or a `Str`, and `Int` is
obviously right — the paged store's residency arithmetic is written for integer-like keys, and a
26-byte sequential text key costs 60% more resident memory.

**The layout already fits, exactly.** Measured, not asserted:

| vshard | id range | note |
| --- | --- | --- |
| 0 | `[0, 140737488355327]` | |
| 63 | `[8866461766385664, 9007199254740991]` | the top is `2^53 − 1` = `Number.MAX_SAFE_INTEGER`, to the digit |
| 64 | `[9007199254740992, …]` | the first id above the JS-safe bound |
| 65535 | `[…, 9223372036854775807]` | the top is `i64::MAX`, to the digit |

So the 16/47/1 layout makes the id space precisely `[0, i64::MAX]`. **The reserved sign bit is what
buys that**, and it is now load-bearing for a second, independent reason: `Int` is *signed*, so an
id at or above 2^63 would store as a negative number and sort below every other id — destroying the
contiguous key range that makes a vshard one range, which the paged tree needs at least as much as
SQLite did. The bit was reserved against SQLite's REAL coercion; keep it for this.

**What changes:** `toKey` / `fromKey` retire. `vshardRange` returns a `[bigint, bigint]` pair and a
vshard is `id BETWEEN v<<47 AND ((v+1)<<47)-1` over an integer key — same contiguity, same 8 bytes.
`parseId`, `makeId` and `vshardOf` are unchanged.

**What does not change: ids stay decimal strings in the API and in JSON.** `JSON.stringify` refuses
BigInt, and that is not negotiable at an HTTP boundary. This is already the rule and already a
lesson the build plan records ("a vshard is a bigint in memory and has to be a decimal string on
the wire").

**This is free exactly once, and now is the window.** No id has been minted. The layout commit
already took one one-way door (`SEQ_BITS` can never move); this takes the other half of it while
there is nothing to re-mint. After the first production write it is not a change, it is a migration
edges make impossible.

### 5.1 The fail-loudly property has to move

`design.md`'s fourth reason for blob keys was that **a missed conversion yields an `ArrayBuffer`,
which fails loudly, instead of a silently rounded number.** Dropping blobs drops that, and the
replacement is not automatic. Three parts:

- **Inside Rust and across wasm**, an id is an `i64` and exact. `wasm-bindgen` carries `i64` as a
  JS `BigInt`; pin that with a test rather than trusting it, because it is sensitive to build
  configuration and a regression would be silent.
- **At hlekk's own HTTP boundary**, marshal `Int` cells out as decimal strings. We own this
  boundary — we do not cross rindle's, so rindle's own guards are not watching (§5.2).
- **Do not reinvent `marshal.rs:134-141`.** Design 226 §8 names the bug: `js_to_owned_value` routes
  a value through `JSON::stringify`, which *throws* on a BigInt, and an `Err(_) => OwnedValue::Null`
  arm **swallows it into `NULL`**. A BigInt written from JS silently became nothing. That is the
  exact shape a fresh JS→cell converter writes by accident, and it is principle 7 inverted.
- **Borrow the backstop.** `rindle_value::js_safe` is `pub mod`, no feature flag, and
  `rindle-value` is already a normal dependency of `rindle-paged-store`. `i64_in_js_safe_range` and
  `unsafe_int_in_cells` come free. Wire them in so that if we ever emit a bare `number` for an
  `Int` cell, it refuses rather than rounds.

### 5.2 Vshard 64 is a landmine, and our tests will not find it

`rindle-value/src/js_safe.rs`: an `OwnedValue::Int` crosses every *rindle* JS boundary as an f64,
and above `2^53` the walk refuses the frame with a typed error. Design 226 Stage E — the bigint
value plane — has not started, and §8's gate stands: a query whose base-table footprint includes an
`int64` column is refused at `build_pipeline` time.

**Neither applies to us.** `rindle-paged-store` lists `cone-excludes = ["rindle", "rindle-planner",
"rindle-index-advice", "rindle-sqlite"]` and takes `rindle` as a **dev-dependency only**, so
`build_pipeline` is not reachable — Rust enforces it. And the mandatory `strict_i64` walk is on
rindle's own napi and wasm boundaries, not ours. Design 226 says the parallel case outright: *"`int64`
in a Rindle SQL (222) table is unaffected by the gate at every stage — that path has no browser IVM
leg."* Neither does hlekk. **We are not waiting on Stage E.**

Being outside the guard is what makes this dangerous. From the table in §5: vshards 0–63 occupy
exactly `[0, 2^53)`. Every test, fixture and smoke run inside the founding active set works
perfectly with a naive bare-number marshal. **The first id that does not is the first id in vshard
64** — which is a growth event, in production, long after the code was written, and the same instant
`design.md` already identifies as when an app written against single-vshard guarantees finds out.

So: the string encoding and the `js_safe` assertion go in with the first commit of the wasm surface,
plus a fixture that mints an id in a high vshard and round-trips it. Cheap, and the only way this
class of bug is catchable before it ships.

## 6. `int64` joins the catalog

`Scalar` is `"string" | "number" | "boolean" | "json"` today, and field values go through
`JSON.stringify` / `JSON.parse`. So hlekk has **no exact integer type at all**, and a user who
stores a snowflake id or a large counter in a `number` loses precision today —
`JSON.parse('{"n":9007199254740993}')` is already wrong. This is the bigint win that is actually
about user data rather than about ids.

- **Call it `int64`, not `bigint`.** `bigint` is JS's *unbounded* carrier; the type is 64 bits.
  Naming it after the carrier gives a type that truncates or fails differently per backend.
- **Signed i64**, matching `OwnedValue::Int`, so it reaches the store with no conversion.
- **Range-validated on write**, the way `parseId` validates an id. Principle 7.
- **Decimal string on the wire, `bigint` in the app.** The client has the catalog through codegen,
  so a generated projection knows which fields are `int64` and reconstitutes them. No replacer, no
  reviver guessing.
- **`{ id: … }` fields become `Int` cells too**, which makes them indexable — direct input for the
  deferred index service.

**This can land before any Rust exists**, carried as a decimal string in the existing JSON payload.
It is exact immediately and *ordered* only once the store is a tree (a decimal string in JSON cannot
be range-queried without zero padding). That is a good reason to land it first and let the paged
work prove itself against a type already in the catalog.

## 7. Principle 5 survives, because a commit never touches R2

This is the structural fact the whole design rests on, and it is easy to lose.

A commit writes its changed pages, plus catalog, free-list and meta, **into the overlay** — and the
overlay is `ctx.storage.sql`. R2 holds the *published* base; publication is a later, alarm-driven
fold. So the commit path is entirely local and entirely synchronous, and
`storage.transactionSync(f)` still wraps the ownership check, the data write, the counts and the
outbox row into one transaction that commits together.

Two consequences worth stating plainly:

- **`transactionSync` subsumes the store's commit protocol.** The write-pages-then-meta-with-fsync
  dance exists because a raw file has no atomic multi-write. Inside `transactionSync` the whole
  commit is atomic for free, so `Durability::Rebuildable` (pages and meta per commit, no `fsync`)
  gives Durable semantics at Rebuildable's cost. The manifest CAS and the publication fence — the
  parts TLA+ found bugs in twice — are *publication* concerns, never commit concerns.
- **`Commits::Logged` is the lever on flush cost.** A copy-on-write tree rewrites the root path on
  every leaf write: at depth 3 and 16 KiB that is ~6 pages, ~96 KB, per commit. Under `Logged`
  (design 462 D1) a commit appends row changes to the redo log and pages are written once per
  flush. Pick the cadence against measured write rate, and note the log needs its own `LogStore`
  over the same device.

### 7.1 What lives in the tree, and what stays in SQLite

| Today's table | Where it goes | Why |
| --- | --- | --- |
| `objects`, `assocs`, `assoc_counts` | the tree | the data; `assocs`' `(id1, atype, time)` index becomes a declared secondary index |
| `index_entries` | the tree | it moves with the vshard, so it belongs in what the handoff ships |
| `outbox` | the tree | same reason; draining it is a tree write and `ORDER BY (vshard, seq)` is a range read |
| `vshards` | **stays in SQLite** | it is the fence, and it is read *before* the store opens |

`vshards` staying put is not incidental. **It is what keeps `create` idempotent across rounds.** The
id comes from `next_seq` in the `vshards` row, so a fault aborts the transaction, the `UPDATE` rolls
back, and the retry reads the same value and mints the same id. A UUID or an in-memory counter would
hand out a different id per round. If `next_seq` ever moves into the tree, that property needs
re-deriving, not assuming. (Note this splits the existing open question in two: a *round* retry is
safe by construction; a *client* retry after a lost reply is not, and only the second needs an
idempotency key.)

On index payloads: design 468 D2 defaults a declared secondary index to `Payload::KeyOnly`, but
464/468 D3 explicitly defaults the **object-storage** home to `Payload::Row`, because a primary
probe there can require a network GET. Take `Row` for `assocs`' ordered index — `related()` reads
edge rows, and a covering index is what keeps a page of edges one descent instead of a descent plus
*n* probes.

## 8. The faulting arm

The one genuinely missing piece. `rindle-paged-object`'s read **blocks** on the ranged GET, which is
a decision rather than an oversight (464 §3.5): a native host holds hundreds of GETs in flight, so
blocking-plus-prefetch gets the batching without paying re-execution. A Durable Object cannot block.

**The fault goes at the `ObjectStore` seam, below the page leaf.** That seam is already synchronous
and already shaped for this:

```rust
fn get(&self, key: &str) -> Result<Option<Object>, StoreError>;
fn get_range(&self, key: &str, range: Range<u64>) -> Result<Option<Vec<u8>>, StoreError>;
fn get_ranges(&self, key: &str, ranges: &[Range<u64>]) -> Result<Option<Vec<Vec<u8>>>, StoreError>;
// …plus the batched multi-object form, and `head`
```

`(key, Range<u64>)` is exactly what `bucket.get(key, { range })` takes. That is the argument for
this seam and not a higher one: base resolution (pointer → layer → part) happens inside Rust, so a
fault raised *above* it cannot name what to fetch. Put it here and the overlay, the warm tier, GC
and the publication plane all work unchanged.

**Rounds, not async.** The choice was examined with an async store on the table and
[`paged-storage.md`](paged-storage.md#rounds-or-async) has the full argument. The decisive reason is
that the await lands in the wrong place: a DO's input gate does not protect an await touching
neither an event nor durable storage, and an R2 GET is exactly that — so an async store puts an
interleaving point *inside* a mutation, and principle 5 needs concurrency control it does not need
today. Fault-and-retry puts the await between attempts, outside the transaction, which is where a
single-threaded actor wants it. The thread still yields between rounds, so requests still overlap.

What would reopen it: an interactive transaction held open across round trips. v1 has no such API.

### 8.1 Three things to get right

**`StoreError` needs a typed variant, and the want list needs discipline.** It is
`PreconditionFailed | Io(String)` today, so a miss cannot travel as a kind, and
`io::Error::other(format!(…))` on the way out would flatten one anyway. `PreconditionFailed` is
precedent for "a signal, not a fault" — add a `NotResident` beside it.

Then the **want list accumulates across a round and is drained by the host**, following
`miss.rs`'s `MissIo` and rindle-do's `WANTED`. Two rules, both learned the hard way:

- **Record every range a read is missing, not the first.** A spanning read over an overflow run is
  one call; stopping at the first miss makes one round fetch one page of the run, so a deep chain
  needs a round per page and the cap bounds *data* rather than dependency depth.
- **A real failure must leave nothing on the list.** The list is the classifier — the loop decides
  "miss, fetch, retry" from it being non-empty — so every early return truncates back to the
  high-water mark it entered with. Without that, recording range N and then failing for real on
  N+1 of the same run makes a genuine I/O failure indistinguishable from a miss: it gets retried to
  the round cap and reported as "nothing is wrong with the store", for the one case where something
  is. rindle-do fixed this *here* rather than in the loop, deliberately, because `PagedStore::open`
  legitimately wraps a boot-time miss into "not a paged store (no valid meta page)" — so a
  predicate over error *text* classifies a store open as a real failure and the object never boots.

**A page miss must not travel as `UNKNOWN`.** The two signals want opposite responses. `Refusal`
carries no target, so `UNKNOWN` sends the coordinator back to the directory — "ask someone else". A
miss means "ask me again, I will have it". Conflated, every cold page costs a directory round trip
and looks like a move. **The page loop lives inside the host's turn, invisible to the coordinator**,
which is what makes the two round loops nest and the coordinator protocol genuinely unchanged.

**`Host.#write`'s rethrow is load-bearing and currently accidental.** It recognizes five typed
refusals and rethrows everything else, and that rethrow is what lets a miss escape to the round
driver. A catch-all added there later turns a miss into a refusal and the loop silently stops
converging — a failure that appears only in a Worker. Make it explicit, with a comment that says
why, and a test that drives a miss through it.

### 8.2 What to measure

**GETs per round**, not rounds. A Worker is capped at 6 simultaneous connections while response
headers are outstanding, so the real cost is `depth × ceil(width / 6) × RTT`. Rounds alone will look
fine while a wide round pays nine serial RTTs. Also the 10,000-subrequest limit, which width is the
exposure to.

And a per-phase **boot report** from the first host, per §3.

## 9. The vshard cap, retired

`design.md` sets the cap at ~1 GB and says plainly that *"the cap is the largest unit that can be
relocated in a tolerable pause, not the largest unit that fits"* — and that the number is a
placeholder for build plan step 1's measurement rather than a result.

Under lease handoff the pause scales with dirty bytes, so the reason goes away. **The byte cap is
retired.** Three bounds take its place, and only the first is about the vshard:

- **Write rate.** A vshard is one lease holder is one DO's single thread, against a 1,000
  requests/sec soft limit. Load-dependent, not a constant.
- **Write concurrency sets the vshard *count*.** N vshards across hosts is N parallel writers, so
  the count is a concurrency parameter. Bigger vshards are fine; *fewer* vshards costs write
  throughput.
- **Residency bounds the host, not the vshard.** §3.

Two knock-ons:

- **The load trigger stops being optional.** With no byte cap, byte-triggered active-set growth
  never fires, so `N` becomes every tenant's permanent write-concurrency ceiling unless growth is
  driven by load. [`paged-storage.md`](paged-storage.md#what-the-vshard-cap-actually-bounds) says
  the trigger *should* be load; retiring the cap is what makes it mandatory.
- **The id layout is already paid up for this.** Vshards living longer spend more ids, which is
  exactly the reason the sequence went to 47 bits. 47 bits is ~45 years at 100,000 creates/sec
  sustained into one vshard. And 2^16 vshards unbounded by a copy is ~6.5 PB per database, against
  ~65 TB at the old cap — the 16-bit field gets *more* comfortable, not less.

**It does not become the 10 GB tier, and should not be given a large constant instead.** Three
reasons, the second of which is arithmetic rather than judgment: a cap at the tier size means one
vshard per full host, leaving the placement controller nothing to shed but the host itself; the tier
holds freelist slack, index copies, the redo log and the COW shadow of in-flight commits *as well
as* live rows, so 10 GB of data does not fit a 10 GB tier; and a vshard with no headroom refuses
`with: parentId` children, which is the one capacity limit developers see, with no split as an out.
Under this design the host no longer holds the data, so the right answer is not a bigger number —
it is that the vshard stops having a byte bound and the *host* gets a resident budget.

## 10. The move becomes a lease handoff

The fence, the epoch and the directory's state machine survive. The copy and the catch-up do not.

1. The directory marks the vshard `moving` and names the target.
2. The old owner finishes in-flight writes and publishes its dirty pages.
3. **Fence.** Its `vshards` row goes to `fenced`; every write route answers `moved`.
4. **Manifest CAS at epoch + 1.** The new owner takes the lease. This is the atomic point.
5. The new owner opens the store at the published manifest, replays the delta, adopts the `vshards`
   row at epoch + 1.
6. The directory publishes epoch + 1. The old owner drops its local pages.

**The CAS is what makes the zombie unrepresentable**, and this is the one place the correctness
primitive genuinely moves. Today a fenced-but-live old owner can only damage its own local copy,
which is about to be dropped. Over shared storage it could flush dirty pages *after* the handoff
into a tree the new owner is also writing. A fenced owner's CAS fails, so it cannot.

**Hand the warm set over with the lease.** A move starts the new owner cold, and without this a
move's cost migrates from a long pause to a long warm-up rather than going away. It is a list of
page ids and costs almost nothing.

And note what arrives early and free: a tree version *is* a snapshot, so copying version V while the
old owner keeps writing and then shipping only pages dirtied since V is the design's deferred
"snapshot-and-tail move" — with **no `changes` log**, because the tree already holds the snapshot.

## 11. What this costs

- **No throughput baseline.** Build plan step 1's measurement is still owed, and it is what sets
  vshard density and cost. Every cost here is a regression against a number we do not have.
  **Measure the current host first** — this is the one item that should not slip.
- **Re-execution per round.** Bounded because the API is restricted: point reads, ordered range
  reads with limits, maintained counters. Nothing re-runs a join. r2db's own fix was to stop
  charging fetch wall-time to a per-call CPU ceiling, "because a call parked on a fetch is not
  holding the thread the ceiling exists to protect" (`follow-ups/r2db-cold-wake.md` §3) — the
  refusals stopped and no ceiling moved.
- **Page size is immutable per store. 16 KiB**, not the 4 KiB default: at 500 GiB, 4 KiB pages spend
  59% of the DO's tier on level 1 alone and overrun it entirely at ~795 GiB, while 16 KiB backs a
  3.1 TiB store and makes a point read one 16 KiB GET. 64 KiB backs 12 TiB but writes 192 KiB per
  single-row commit. This is a v1 decision; getting it wrong is a rebuild.
- **Publication cannot ride the round loop.** A PUT is a side effect and the loop's closure must be
  restartable. Publication is alarm-driven and outside a read transaction, so it is a separate
  protocol — prepare bytes, host PUTs, host confirms. `PreparedPublication` is the shape to read
  first. It is also the one surface no request-driven test can reach, which r2db's e2e asserted
  deliberately.
- **A Rust toolchain and a wasm artifact in a zero-dependency TypeScript repo.** rindle's own
  CLAUDE.md warns at length about exactly this: the wasm is a gitignored build product, and renamed
  `#[wasm_bindgen]` exports fail silently in JS, not in the Rust lanes.
- **Cross-repo coupling.** `rindle-paged-store` and `rindle-paged-object` are closed crates in a
  private monorepo (`copy.bara.sky` mirrors only the engine, `rindle-sqlite` plus four deps,
  `packages/**` and the plugin). Decide deliberately whether the wasm is built in that repo and
  published, vendored here, or whether hlekk moves in.
- **Billing.** A COW commit writes ~6 pages of 16 KiB where today's writes a handful of small rows.
  Check it against DO SQLite's rows-written accounting and R2's class-A operation pricing before
  committing to a cadence. r2db metered this; we have no meter.

## 12. Order

Each step is independently valuable and independently revertible.

1. **Throughput measurement on the current host.** Build plan step 1's owed item. Nothing below is
   interpretable without it.
2. **`int64` in the catalog** (§6). Pure TypeScript, no Rust, all four oracles watching.
3. **A `Store`-shaped seam on the write path.** The read path already has one — `Store` is the
   interface and `SqlStore` an implementation — but `Host`'s mutations are ~50 SQL strings over six
   tables with nothing between them and storage. So the read path is a substitution and the write
   path is a rewrite. This step is the rewrite, still over SQLite, with behaviour unchanged.
   [`paged-storage.md`](paged-storage.md#integration-seams) notes it is useful on its own.
4. **IDs to `i64`** (§5), including the string marshalling, the `js_safe` backstop and the
   high-vshard fixture. Still over SQLite, as INTEGER columns — which is legal now only because
   every id is below 2^63.
5. **`PagedStore` behind both seams, fully resident** (`pin_min_level(0)`, warm slot file in
   `ctx.storage.sql`, no R2). Wasm enters the tree here. Re-measure against step 1.
6. **The faulting arm** (§8): `StoreError::NotResident`, the want list, the nested round loops, the
   `#write` rethrow made explicit. Drive it with a miss-injecting `ObjectStore` before any R2
   exists — `miss.rs` is the pattern and the nine-ring ladder the precedent.
7. **R2 under it**: `ObjectPageIo`, the part-addressed base, publication on the alarm, GC. The boot
   report ships here.
8. **Lease handoff** (§10), replacing the stop-the-world copy. Under the existing chaos harness,
   which already kills hosts mid-move.
9. **Retire the byte cap** (§9) and give the placement controller a resident budget and a load
   trigger.

Steps 2–4 are pure TypeScript and land against the current engine. Step 5 is where the cost and the
toolchain arrive, and it is the natural place to stop and reconsider.

## 13. What `design.md` will need changed

Recorded rather than done, so the two docs do not drift silently:

- *Why BLOB storage* — the whole section becomes historical. All four reasons are retired or moved:
  two already were, the third (contiguous range) holds for an integer key, and the fourth's
  fail-loudly property moves to §5.1's three mechanisms.
- *Layout* — the reserved bit gains its second reason (§5).
- *vshards* and *Growing the vshard count* — the byte cap and "roughly one vshard per gigabyte" go
  (§9); the host column of the growth table changes by ~300× (§3).
- *Host schema* — four of six tables move into the tree (§7.1).
- *Principles* — 5 gains a sentence on why it survives (§7); 8 becomes a controller objective (§3).
- *Build plan* step 3 — the move's copy and catch-up are replaced (§10).
- *Later → Paged storage* — becomes a pointer here.

## 14. Considered and dropped

- **Pages in DO SQLite as a separate milestone.** Subsumed; it is this design's warm tier at
  `pin_min_level(0)` (§2).
- **An async store from the page leaf up.** The await lands inside a mutation, it buys the small
  term, and it forks the store for every native consumer (§8).
- **Reimplementing the page tiers and publication plane in JavaScript**, as `packages/r2d2` did in
  26,392 lines. That is what the r2db arc retired, and the lesson in its ledger is precisely "two
  implementations of one storage format in two languages".
- **Squeezing ids under 2^53 to make them JS-safe numbers.** Checked and dropped in
  [`paged-storage.md`](paged-storage.md#the-id-layout); it costs the vshard field and buys nothing,
  since the API boundary packs and unpacks either way.
- **`(vshard, seq)` as two integer columns.** Recorded in `design.md` as considered; it widens every
  edge row and the index that serves `related()`, and `Int` keys make its one advantage moot.
- **Waiting on design 226 Stage E.** Not a dependency (§5.2).
- **Raising the byte cap to the 10 GB tier.** §9.

## Open

- [ ] Whether `StoreError::NotResident` carries the wanted set or marks a side-channel drain. §8.1
      argues for the kind *and* the accumulating list; the shape of the API is undecided.
- [ ] Prefetch batching against the 6-connection cap and the 10,000-subrequest limit. Width is the
      exposure; depth is the native tuning lever.
- [ ] Whether `index_entries`' TTL sweep wants its own index in the tree, or a range scan per vshard
      is fine. It runs on an alarm, so a scan probably is.
- [ ] The resident budget's actual value, and whether it is per host or per vshard-set. §3 assumes
      half the tier; nothing has measured what the overlay needs under write load.
- [ ] Whether a fully resident store should publish to R2 at all before it has to — a small database
      could treat R2 as backup-only and skip the publication cycle entirely.
- [ ] Per-DO request limits and single-threaded execution are untouched, so one object's write rate
      stays bounded by one DO. Unchanged from [`paged-storage.md`](paged-storage.md#open), and still
      the floor under §9's first bound.
