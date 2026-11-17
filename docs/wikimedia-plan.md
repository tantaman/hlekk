# The Wikimedia plan (closed)

Oct 31, 2026 · @Matt Wonlaw

**Closed Nov 17, 2026, and kept for its figures.** This was `PLAN.md` until
[`../PLAN.md`](../PLAN.md) replaced it. Wikipedia is loaded as far as it is going to be on Durable
Objects. Step 1 below finished after this was written: the third placement was deployed and read at
**3.24x** the control (commit `55b7769`), against the 3.20x predicted here. The namespace filter in
step 2 was built (`8c8c505`) and the enwiki import was prepared and sized at 20 hosts (`1054b8d`).
The bulk import in step 2 was not built and is no longer planned, so nothing below is a commitment.
The open item on the 4 missing objects was answered in `9d6c5f6`: seven pairs of titles folded onto
one index key, plus objects orphaned by interrupted creates, not a lost confirm.
Other documents cite the measurements here, which is why the text is left as it was written.

Where the Wikimedia demo goes from here, and why in this order. [`wikimedia-demo.md`](wikimedia-demo.md)
owns the demo and what has been measured on it; [`wikimedia-import.md`](wikimedia-import.md)
owns the dumps and the record stream. This is the plan, and it holds only what is not yet done.

Figures marked **measured** were read off a real artifact — a deployment, a dump, or a loaded
database — and say how. Figures marked *arithmetic* are derived from those, and say what they assume.

The one sentence that reorganises everything below: **a bulk import does not make the load faster, it
deletes pass A.** Pass A costs 33.6 hours at enwiki scale *only* because ids are minted server-side,
and that same fact is the only reason the import needs two passes at all. Assign ids offline and both
go away together.

## Where this stands

Done and committed:

- Both simplewiki placements loaded and measured. **Measured:** the clustered key buys **1.27x** —
  27.0 hosts of 43 against the title hash's 34.2, on fourteen pages whose entire link and category
  set was returned on both sides with the target lists verified identical. Every page favoured
  clustering, so the effect is real and small.
- Why it is small. **Measured:** 469,546 of 950,421 pages (**49.4%**) have no category at all and
  fall back to a title hash, and for the half that do, a page's ~65 link targets carry **32–50
  distinct** first categories. A category says what a page is filed under; its links point away from
  it.
- The key is now derived from the link graph instead — `scripts/partition-wiki.mjs`. **Measured:**
  32.1% of edges cut, a page's neighbourhood spanning 5.2 of 43 parts, 42.8M edges in about 8
  seconds. *Arithmetic*, from the real graph and the real cluster map: **8.6 hosts of 43, 3.20x the
  control**, with the best edge balance of the three placements (1.20x the mean against the
  control's 1.46x).
- Three abandoned databases reclaimed. **Measured:** 142,868,480 bytes, 43/43 hosts each.
- R2 from inside a Durable Object, including ranged reads. **Measured** on hosts 0, 17 and 42 — this
  was the open question the whole bulk path rests on.

Not done: the third placement is not deployed, so **3.20x is a prediction**. That is step 1.

## 1. Finish the three-way reading

Cheap, and it is what tells us whether enwiki is worth building around the graph key. ~50 minutes of
load.

`wrangler.wiki-graph.jsonc` is committed and needs `wrangler deploy` — a new Worker, so it needs
authorising once.

Then, in order:

1. `GET /admin/init?hosts=50&indexVshards=64`. The same call as the other two. **Measured:**
   `per = ceil(128/50) = 3` yields 43 hosts, and `init` is deterministic — the two loaded
   deployments have byte-identical shard maps.
2. **The gate.** Load 3,000 pages and check that every object sits on the vshard the partition chose.
   `/admin/where` cannot answer this on an empty database — `holding` is empty until rows exist — so
   a probe load is the only way to see it. **Measured** locally: 3,000 of 3,000. If the deployed map
   differs from the one the partition was computed against, every part is on the wrong host; the
   partition is regenerated from the real map before anything else. Cheap to catch here, expensive
   to discover at the end.
3. The full load, resuming from the probe rather than `--fresh`, since the loader skips pages already
   present.
4. Storage, from `/admin/size` less the **measured** 1,937,408-byte empty baseline. This tests the
   prediction *independently of any read*, so it is the half to trust first: the heaviest host should
   be near 1.20x the mean, against the category side's **measured** 541 MB.
5. Pass B's own throughput, which is a consequence rather than a separate test. **Measured:** 33,832
   edges/s clustered against 164,021 spread, a 4.8x gap caused entirely by 20.9% of all edges landing
   on one host while the loader keeps one batch in flight per host. If the graph side lands near the
   hash side, the write penalty is gone *while* the read locality is gained, which is a stronger
   claim than the read number alone because it removes the trade-off the first result implied.
6. The live three-way read: only pages whose entire link and category set fits under the limit, with
   target lists verified identical across all three origins, widened from 14 pages to 40–60.

A method error to keep not repeating: a read with a `limit` returns the smallest-id targets, and
`init` assigns vshards to hosts in contiguous blocks, so a limited sample lands in a narrow band of
hosts *whatever* the placement. The first measurement was an artifact of this and reported 1.39x with
clustering losing on several pages. The UI's placement tab had the same bias and has since been
removed from the demo, so the measurement lives in the doc rather than in a pane a visitor re-runs.

## 2. Bulk import, proven against an oracle

### What changes

`Snapshot` already has the shape — `{vshard, epoch, nextSeq, objects, assocs, counts, outbox, index}`
— and `install()` already does `INSERT OR REPLACE` inside `sql.txn`. So the work is smaller than it
sounds:

1. **The importer emits ids.** The one genuinely new piece. An id is `(vshard << 47) | seq`; the
   vshard already comes from the affinity key offline, so adding `seq` per vshard makes every id
   known before any network call. Then edges resolve to ids offline, the two passes become one, and
   the index entries are computed offline too — uniqueness is a sort, and simplewiki had **measured**
   0 duplicate `(ns, title)` pairs.
2. **`adopt` stops dropping its third argument.** `Host.adopt(vshard, epoch, nextSeq)` already seeds
   the sequence counter; the DO's RPC wrapper passes two. Without this a host that later mints an id
   collides with a bulk-loaded one — silent corruption, so it goes first.
3. **`install()` chunked, with a cursor.** One transaction today. The offset into R2 is held in the
   host's own storage and driven by its alarm. **Measured limits:** 100 bound parameters, a 100 KB
   statement (~2,000 rows with `x'…'` hex ids), `exec` refuses `BEGIN`/`SAVEPOINT`, and an alarm gets
   15 minutes of wall clock against 30s of CPU (5 min via `limits.cpu_ms`). Resumability is not
   optional at this size.
4. **A route to start the pull**, with each host fetching its own slices.
5. **Fixed-width binary staging, not SQL text.** See the budget below.
6. **A namespace filter in the importer**, which has none. **Measured:** ns 0+14 is only 52% of
   simplewiki's pages, and ns 3 (User talk) alone is 31%. The cheapest large win available, and a
   link-graph demo does not want talk pages.

A free side effect worth naming: this removes `indexReserve`/`indexConfirm` from the load path, and
both loaded databases carry a defect that lives there — **measured** 2 stranded objects on the cat
side (950,423 objects for 950,421 ids) and 4 missing on the hash side (950,417). Bulk install does
not have that path.

### How it is proven

On simplewiki, against something better than a smoke test. `wiki-simple-cat` and `wiki-simple-hash`
are both fully loaded *through the mutation path*, so a bulk-loaded fourth database using the same
affinity key as one of them should be **comparable row for row** — same ids, same objects, same
assocs, same counts, same index entries. If bulk install is correct the two databases agree exactly.
Six invariants passing is not that.

Same reason the import doc gives for running simplewiki first: same schema, about 1% of the size,
finishes in minutes, and every pass either works there or is broken everywhere.

## 3. enwiki, once

No second copy, so there is no control to measure against and the placement choice is a production
decision rather than an experiment.

### What does not scale yet

**The partitioner does not currently run at enwiki scale.** It builds the CSR in memory: *arithmetic*,
3.5B rows at 4 bytes is ~14 GB of adjacency, against **measured** 171 MB for simplewiki.

The fix is cheap because `edges.tsv` is already sorted by `from`, so streaming it yields exactly the
node-by-node neighbour lists label propagation needs. A `--stream` mode holds only `label[]` —
*arithmetic*, ~140 MB for enwiki — and re-reads the edge file once per round: ten sequential passes
over tens of GB, so minutes. This is on the critical path, not a nice-to-have, because placement
cannot be changed later (below).

### The time budget

*Arithmetic* throughout, from simplewiki's **measured** 61.5 bytes/row and the ns 0+14 share:

| | Today | With bulk |
| --- | --- | --- |
| Pass A | 33.6 h, bounded by one directory DO | gone — ids assigned offline |
| Pass B | 32.1 h | one offline pass, then a parallel install |
| Total | **2.7 days** | hours, dominated by generation and upload |

With the namespace filter: ~35M pages and ~2.6B edges, ~163 GB in the database.

Two cautions. **The R2 upload is probably the real wall clock**: 163 GB of SQL-ready rows is hours on
a home uplink, where fixed-width binary — two packed 8-byte ids per edge — is ~31 GB, and it also
makes a ranged read pure offset arithmetic, which is the shape the r2probe already validated with its
64-byte stamped records. And **the install estimate is the least certain figure in this document**; it
is bounded by R2 egress into a DO and per-alarm CPU, neither measured at volume.

Disk: **measured** 806 GB free against ~540 GB of enwiki intermediates. Tight but workable.

### Decisions that must be made before `init`

All three are irreversible, and the last one is the one that bites.

- **`HLEKK_VSHARDS`.** Read once, when the directory first opens; changing it afterwards moves
  nothing. 128 gave 192 active vshards on simplewiki. enwiki wants more.
- **Host count.** *Arithmetic:* 163 GB over 43 hosts is 3.8 GB each — inside the **measured** 10 GB
  per-DO limit, but with less headroom than is comfortable, and more hosts also means more install
  parallelism. Note `active()` drops a vshard above half the 9 GB cap.
- **The affinity key.** Placement is decided at create time, so changing it means reloading
  everything. This is why step 1 comes before step 3: otherwise enwiki's permanent placement is
  chosen on a prediction rather than a reading.

## Deliberately not in this plan

- **Moves, rebalancing and epoch transitions.** Out of scope per the demo doc; every vshard stays at
  epoch 0 and `HLEKK_SHED_BYTES` stays unset, which keeps the subtlest machinery in the system off
  the demo path.
- **The directory hop as a general fix.** Publishing the index vshard list in `src/directory/map.ts`
  would let clients compute `set[indexHash(key) % set.length]` locally and lift pass A's **measured**
  ~590 pages/s ceiling by roughly 4x. Bulk import routes around the need, and a stale list breaks
  uniqueness, so it needs the map's versioning. Worth doing, not worth doing first.

## Open

- [ ] The live reading of the third placement. Everything in step 1.
- [ ] The 4 missing objects on the hash side. The hypothesis is a lost `indexConfirm` response, after
      which the worker's recovery deletes the object while the confirmed index entry survives, so the
      retry resolves to a deleted id — a title that looks up fine and reads as nothing. **Unverified.**
      The graph load gives a third sample for free.
- [ ] Whether pass B's throughput decays past the **measured** 63 MB/host, which is the one gate
      nothing has tested and which a 163 GB database walks straight into.
- [ ] Whether the demo needs any read the unique-index entry point cannot reach, which would mean the
      deferred non-unique global index. Carried over from the demo doc; still the only item here that
      is real added scope.
