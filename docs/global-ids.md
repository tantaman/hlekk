# References across databases

Nov 7, 2026 · @Matt Wonlaw

An exploration behind one sentence of [`design.md`](design.md)'s *IDs and sharding*: "Separate
databases number their vshards independently, so an ID means nothing without its database." This
document asks what it would take for an ID to mean something without its database, and answers that
the ID is the cheap part. [`protocol.md`](protocol.md) owns what crosses the wire when a reference is
followed; this owns how one is stored and named.

**Nothing here is built.** It records the shape to build if this is ever wanted, the readings that
chose that shape over two others, and — at more length — the four things the shape does not solve.
The ID question is settled in about a page. The rest is the work.

Figures marked **measured** were read off a real artifact and say how; `scripts/id-width.mjs`
produces every one of them. Figures marked *arithmetic* are derived from those and say what they
assume.

## What it is for

A service where any developer or agent creates databases freely — thousands of them, most of which
stay private and small. Some graduate to usefulness, and when a cluster of them needs to refer to
each other, an edge is drawn from one into another without first merging them. A private graph per
tenant, and one global graph made of the edges between them.

The appeal is that it costs nothing until it is used. Principle 8 says small stays small, and a
database that never links out should pay nothing for the ones that do. That is the constraint every
reading below is judged against, and it is what rules out the obvious design.

## The obvious design, and what it costs

Make every ID globally unique: 128 bits, with the database in the high half.

There is exactly one backward-compatible way to do it. `ids.ts` explains why — the vshard field is
anchored at bit `SEQ_BITS`, so anything inserted below it re-reads every existing ID as a different
vshard, and edges make re-minting impossible. So the database field goes **above** the existing 64
bits, which keeps the current ID as the low half:

```
[ db: 64 ] [ vshard: 16 ] [ seq: 47 ]
```

Everything the layout relies on survives this. `vshardOf` masks the low half. Big-endian bytes sort
as `(db, vshard, seq)`, so a vshard's rows are still one contiguous key range within their database
and `vshardRange` is still a `BETWEEN`. No ID is re-minted: an existing ID is the same number with a
zero prefix. The reserved sign bit even stops being load-bearing, since nothing is coerced through a
double at 128 bits.

What does not survive is mixing widths in one column. SQLite compares blobs by memcmp over the
shorter length and then takes shorter as less, so an 8-byte key sorts below every 16-byte key
whatever its value. Every stored key has to be rewritten. That is a byte rewrite rather than a
re-mint, and `install()` is already `INSERT OR REPLACE` row at a time behind a fence, so a width
migration is a special case of a move — but it is every row of every table.

**Measured**, on the host's own DDL and the wiki demo's shape — 12,000 objects at 65 out-edges,
scattered targets, ids sequential within simplewiki's 192 active vshards, read as `page_count *
page_size`, the figure `databaseSize` reports:

| where the reference lives | total bytes | bytes/edge-row | vs today | enwiki |
| --- | --- | --- | --- | --- |
| today | 51,245,056 | 64.5 | 1.000x | 170 GB |
| alias in the key | 52,224,000 | 65.8 | 1.019x | 174 GB |
| a second table | 51,253,248 | 64.5 | 1.000x | 170 GB |
| 128-bit ids | 79,421,440 | 100.5 | **1.550x** | 264 GB |

The enwiki column is *arithmetic*, from these per-row figures and [`../PLAN.md`](../PLAN.md)'s 35M
pages and 2.6B edges after the namespace filter. The control's **measured** 64.5 bytes/edge-row sits
next to PLAN.md's **measured** 61.5 on the loaded simplewiki databases, which is what makes the
comparison worth trusting; the small gap is the synthetic graph's degree being uniform where the real
one's is not.

The delta is **+36 bytes per edge row**, not +16, because `assocs_range` carries the primary key as
its suffix and so gains both IDs a second time.

Three consequences, in the order they matter:

1. **Every database pays it, including the ones that never link out.** 1.55x on the exact workload
   the system is for. Against principle 8 this is the whole argument.
2. **A copy stops being a copy.** design.md names cheap copies as a benefit of per-database ID
   spaces: "restoring a backup or branching staging off production is a byte copy." Globally unique
   IDs stored inline end that — a fork either rewrites every ID or claims the original's.
3. **The ceiling moves the wrong way.** *Arithmetic:* 1.55x on the same data is 34 hosts where
   enwiki needs 22, and the per-database ceiling falls from ~590 TB to ~380 TB for the same 16
   vshard bits.

Against that, one real gain, which is principle 7: an ID used against the wrong database would fail
instead of resolving to whatever object holds that number there. That is the cost design.md records
for separate ID spaces, and the wide form is the only option here that removes it. It is not enough.

## The fact that makes a cheap form possible

**Only `id2` can ever be foreign.** An edge lives on `id1`'s vshard; `anchorOf` routes `assocAdd`
and `assocRemove` by `id1`; `objects.id` is minted locally by the host that owns the vshard;
`assoc_counts` is keyed by `id1`; `index_entries.id` points at a local object; and `vshardRange` —
the thing a move depends on — only ever ranges over `id1` and `objects.id`.

So the entire question is confined to one column of one table. Nothing else in the schema can hold a
reference to another database, which is why the reference does not need to be in the ID at all.

## The form: an interned alias inside the key

```sql
CREATE TABLE assocs (
  id1   BLOB    NOT NULL,
  atype INTEGER NOT NULL,
  db    INTEGER NOT NULL DEFAULT 0,   -- 0 is this database; otherwise an interned alias
  id2   BLOB    NOT NULL,
  time  INTEGER NOT NULL,
  data  TEXT,
  PRIMARY KEY (id1, atype, db, id2)
) WITHOUT ROWID
```

`(db, id2)` **is** the 128-bit global ID. A foreign `id2` is the remote database's own local ID,
which is 8 bytes by construction, so the pair is a varint plus 8 bytes instead of 16. The alias
column is the database prefix, interned — which means the choice between "extra bits in the ID" and
"an extra field on the edge" was never a choice between two designs. It is the same design, stored
where it costs a byte instead of eight.

Two details follow:

- **`INTEGER`, not a fixed width.** SQLite's record format spends a header byte on the serial type
  and no payload byte at all on integer 0, so a local edge pays the header and nothing else, and
  there is no ceiling on how many foreign databases one database may reference. **Measured** on a
  column added to an otherwise identical table: **0.31 bytes/row** realized over 200,000 rows,
  against a nominal 2 (one header byte in the row, one in the index record) — page packing absorbs
  the rest. The same column on `assocs` realizes **1.3 bytes/edge-row**, because those records pack
  differently. Both are measured; 1.019x is the figure that matters.
- **`fromKey`'s 8-byte guard stays strict.** Nothing about a stored ID changes, so principle 7's loud
  failure on a missed conversion keeps working. This is worth more than the bytes: the real hazard in
  the wide form was auditing every call site that assumes a width, and turning a loud failure into a
  soft one.

### Nothing else in the host schema changes

`assocs_range` is unchanged as a declaration, but its records carry the primary key as their suffix
and so widen with it — about half the 1.019x above, and no second index to add. The other five tables
are untouched, each for a reason worth stating, because a bigger diff than this would be grounds to
distrust the design:

| Table | Why it does not change |
| --- | --- |
| `objects` | `id` is minted locally from `vshards.next_seq` by the host that owns the vshard, so it can never be foreign. Only edges point out |
| `assoc_counts` | Keyed `(id1, atype)`, counting a local object's outbound edges of a type. A foreign target is still one, so the count is already right |
| `index_entries` | `id` points at a local object, and uniqueness is enforced on one host of *this* database. It cannot point out, and should not |
| `outbox` | The catalog refuses an `inverse` on a foreign-capable edge type, so a foreign edge never generates a row. Every op's ids stay local |
| `vshards` | Ownership and sequence allocation are per database throughout |

`db` sits before `id2` in the key rather than after. Both orders are **measured** identically, and
this one groups a local object's edges by target database, so "every edge from X into database 7" is a
range scan rather than a filter. It also reads in the order the global ID composes.

### Why in the key and not in `data`

`data` is the edge's own JSON payload, and the write path is `INSERT OR REPLACE` on
`(id1, atype, id2)`. An edge to local ID 5 in database X and an edge to local ID 5 in database Y
would therefore have the same key, and the second would silently replace the first — no error, no
count change, the first target simply gone. That is the class of thing BLOB keys and principle 7
exist to make unrepresentable, so the discriminator has to be in the key. It also could not be
ranged or indexed there, and a JSON field costs far more than a varint.

### Why one table and not two

The readings do not decide this: 1.019x against 1.000x, where the second table's entire cost is
8,192 bytes of empty b-tree pages. *Arithmetic:* +4 GB on a 170 GB enwiki, against a 34-host
deployment. Cost is not the argument.

What decides it is whether one edge type can hold both local and foreign targets. It has to, and
that is the whole premise: `issues.issue_owner → core.user` starts fully local, and one day some
users live in a shared identity database and some do not. The edge type should not change, and an
application should not have to declare two of everything.

Once one edge type holds both, a second table loses. `related()` reads `assocs_range (id1, atype,
time)` newest-first under a limit, with a cursor of `(time, id2)`. Two tables means interleaving two
time-ordered streams in the hot read path and minting a cursor valid across both, with a comparator
version to carry. The column leaves the index and the read exactly as they are; some rows simply come
back with `db > 0`.

A second table only wins where an edge type is statically all-local or all-foreign, and forcing that
pushes the merge up into every application's code. Recorded as considered, not planned.

## The registry

An alias means nothing on its own. It resolves through a table that has to be database-wide, because
any host can hold an edge into the same foreign database and an alias must mean one thing everywhere.
That puts it in the directory DO, distributed the way the catalog is, with a version carried on
requests. It is the one new table.

```sql
CREATE TABLE IF NOT EXISTS foreign_dbs (
  alias  INTEGER PRIMARY KEY CHECK (alias > 0), -- 0 means local and is never allocated
  uri    TEXT    NOT NULL,                      -- the identifier; an alias is local shorthand for it
  pinned BLOB,                                  -- what it proved about itself; NULL until first contact
  state  TEXT    NOT NULL,                      -- 'live' | 'unreachable' | 'repudiated' | 'tombstoned'
  added  INTEGER NOT NULL,
  seen   INTEGER                                -- when the pin was last confirmed
)

CREATE UNIQUE INDEX IF NOT EXISTS foreign_dbs_uri ON foreign_dbs (uri)
```

**The URI is the identifier.** This is what makes the graph open: a URI is mintable before the
database behind it exists, so an edge can be drawn at a name nobody has deployed yet and empty
databases cost nothing; creating a database needs no registry round trip; and anyone who serves the
protocol at a URI can be referenced without asking an authority for a number. An earlier draft of
this document put a separately allocated identity beside the URI and keyed the registry on that. It
was wrong in a way worth recording, because it is the obvious first instinct: a URI can be
reassigned, so an alias bound to one can come to mean a different database. But an allocated
identifier buys that guarantee by reintroducing a central allocator, and the allocator is the thing
every system in this space has died of. Openness is the feature being bought.

**A pin is what keeps substitution loud.** The reassignment hazard is real and the answer is not a
second name — it is to record what the database proved about itself when it was interned, and to
check that on later contact. Trust on first use, SSH's model rather than a naming authority. A
mismatch moves the row to `repudiated` and reads through that alias fail, instead of quietly
returning a stranger's objects under an edge that meant someone else. That is principle 7 with no
authority in the picture, and it is why `pinned` is in the table rather than a second identifier.

**An alias is never repointed.** The alias-to-URI binding is permanent: `state` tombstones rather
than deletes, and the next alias comes from a counter in `meta` rather than `MAX(alias) + 1`, which
is only accidentally correct while nothing is ever purged — and apply already contemplates purging
tombstoned catalog names. Same hazard as reusing a catalog integer, same answer.

**Canonicalization becomes load-bearing.** Once the URI is the identifier, two spellings of one
database are two aliases and the unique index does not notice: scheme, host case, default port,
trailing slash, percent-encoding, fragments. This is the price of the choice, it is a known swamp,
and it is listed under *Open* rather than waved at.

**The host needs no copy of it.** A host stores the alias and never resolves it; the coordinator
does, when it takes the foreign hop. Which raises the obvious objection: what stops a stale client
writing an alias that does not exist? The never-repoint rule. A stale client can only name an alias
already allocated, and an allocated alias always means the same URI, so the worst case is an
edge into a database that is gone — a dangling reference, which the read path already drops at read
time. No host-side validation, no round trip, nothing added to the host's DDL. The rule earns its
keep twice.

**A URI resolves to an HTTPS endpoint, not a DO stub.** One deployment cannot bind another account's
Durable Object namespace, so a foreign hop is a Worker-to-Worker fetch. That is a different latency
class and a different set of failure modes — timeout, refused, database gone — than any local read,
which is why the planner has to know a hop can be foreign even though `db` per row is only known at
read time. The catalog gives it that statically.

## What the catalog must refuse

The planner's static signal is one optional flag on `EdgeDecl`, beside `inverse`, `maintained`,
`onDelete` and `unique`:

```json
"issues.issue_owner": { "from": "issues.issue", "to": "core.user", "unique": true, "foreign": true }
```

`foreign: true` says targets *may* be in another database, not that they are, which is what lets one
edge type hold both. Two refusals hang off it. Both belong beside the existing rule that exactly one
side of a pair is `maintained`, and both are better as plan-time errors than as discoveries in the
outbox.

- **An `inverse` on an edge type that permits foreign targets.** Delivery routes through the host's
  own client, which is scoped to one database, and retries forever. Writing the other half would mean
  a host in one database holding credentials to write into another — a trust boundary crossed inside
  a path with no give-up. If the target database wants a backlink it subscribes; it does not get
  written into. So a cross-database edge is one-directional.
- **`onDelete: cascade` on one.** A cascade across the boundary is a remote write. Foreign references
  have to be allowed to dangle, which the existing read path already tolerates: edges to missing
  objects are dropped at read time, and a maintained count still counts them.

`assoc_counts` needs no change. It counts a local object's outbound edges of a type, and that is as
true of a foreign edge as a local one.

## What a foreign hop costs the query

It batches per database rather than per host, and it cannot share a round with local reads.

This fits the driver better than it sounds. `runAsync` already lets each branch move on when its own
data lands, and `missOwner` and `short` streams already model a stream that stopped at data its store
does not hold. A foreign hop is one more store that answers `UNKNOWN` and resolves in a later round.
What is new is that the round crosses the internet, so it needs a deadline and a budget, and one
tenant's query latency becomes partly another tenant's problem.

## What none of this solves

The ID was the cheap part. These four are the work, and the third is the one that contradicts a
stated principle.

**Routing has no global level.** `chunkKey(database, index)` and `hostStub(env, host)` both derive
from `HLEKK_DATABASE`, a Worker config value. A client physically cannot route an ID from another
database: one directory binding, one KV prefix, one host namespace. An alias and a URI give the
*name*; nothing maps that name to a directory, a host namespace, a region or an account. That is a
global directory above the per-database one, and it is where the service lives — who owns a database,
whether it is alive, whether it may be linked to.

**The catalog is a namespace too**, though less of one than it first appears. `atype` and `otype`
integers are allocated per database by the lock, so `atype` 7 in one database means nothing in
another, and an edge that resolves while being uninterpretable is worse than one that fails. What
shrinks the problem is that the catalog already treats the *name* as canonical and the integer as a
local encoding: `issues.issue_comment` is the entry, and the lock's integer is merely how this
database writes it down. So a cross-database edge carries the name, and once domains are URIs that
name is globally meaningful with no registry to build — the alias-to-URI relation and the
atype-to-name relation are the same pattern, and the second is already implemented. What remains is
not naming but agreement: a globally unique type name says nothing about whether the reader knows
that type's shape, so a reader has to be able to decline a type it does not understand. That is a
protocol question, not an ID one.

**Authorization.** Principle 10 says the caller is a trusted server and authorization belongs to the
application. That holds inside one database owned by one application. It is false the moment
arbitrary agents create databases and link between them, because there are now two applications with
different interests: may A reference B, may A read B's objects or only hold the ID, does B learn that
A links to it. Local IDs are sequential and so guessable, which is fine under principle 10 and not
fine across a boundary. That permission system has to live in the infrastructure, and **this is the
principle the idea actually breaks.** Entropy in an identifier is not a substitute for it.

**"Trillions of databases" is not an ID question.** 40 bits covers a trillion. What does not is
already open in design.md: classic KV caps namespaces at 1,000, the map's one-namespace-keyed-by-
database arrangement works because "a hosted multi-tenant deployment would not" have few databases,
and KV Instant's envelope is 1 MB *per namespace* over at most 10,000 keys. Alongside it sits idle
cost: a database today is a directory DO plus `N` vshard rows, about 2 KB, so *arithmetic*, 10^12 of
them is ~2 PB of empty databases and 2 × 10^12 Durable Objects. Create-as-many-as-you-like requires
an empty database to cost zero — nothing existing until the first write, and an ID mintable before
the database exists, which argues for deriving a database's identity from `(owner, name)` rather than
allocating it.

## The presentation form is a URI, not a width

The alias is a storage form, local to one database and never leaving it. When a reference is written
down — in a log, an export, an edge drawn by hand — what it carries is the target database's URI and
the target's own local ID. There is no packed global integer, and that absence is the point: a fixed
width has to be handed out by someone.

The arithmetic is worth keeping, because it is the argument for why a fixed width is the wrong
instinct rather than merely an unnecessary one. *Arithmetic*, from the birthday bound `p ≈ n²/2N`: at
10^12 databases a 64-bit random or hash-derived database ID collides with certainty, `p ≈ 2.7 × 10^4`,
and holding `p < 10^-9` at that count needs `N > n²/2p = 5 × 10^32`, about **109 bits** of database ID
alone — 173 bits with the local half. So a packed form at a credible scale is either wider than 128
bits or centrally allocated, and there is no third option. A URI is neither: it is as long as it needs
to be, and DNS already arbitrates who may mint one.

What a fixed form would have bought is a cheap equality test and a cheap sort. The interned alias buys
both of those locally, which is where they are actually needed, without the identifier being
fixed-width anywhere. Recorded as considered, not planned.

One consequence worth stating plainly: `ids.ts` does not change. A local ID keeps its layout exactly,
because qualification happens outside the integer rather than inside it. The whole of the earlier
*wider ID* reading was the cost of the alternative.

Guessability is addressed by none of this and should not be. Local IDs are already sequential, so an
ID has never been a secret; the permission system above is what carries that.

## What to do now

One thing, and it is not the storage.

**Fix the string form.** design.md's field relationships store IDs *inside JSON payloads* —
`"authorId": { "id": "core.user" }` — and an edge with `field` follows one. If every payload ID is a
bare decimal, those references are local-only permanently, and qualifying them later means rewriting
payloads, which the move and snapshot path does not cover and no fence makes safe. So: decide now
that an `Id` is a string that may be qualified by a database's URI, have `parseId` round-trip one,
and have everything that compares IDs compare the qualified form. Not one stored byte changes. This
is the only piece here where deferring is expensive.

Nothing needs reserving in `ids.ts` beside it. Qualification lives outside the integer, so a local
ID's layout is untouched by all of this.

**Not now:** the alias column, the registry, the global directory, the permission model. There is
also a scheduling reason, not only a scope one. PLAN.md step 3 is an irreversible enwiki placement
decision resting on step 1's three-way reading, and a wider row changes every figure that decision is
made against — 61.5 bytes/row, 163 GB, the host count, `HLEKK_VSHARDS`. Take the step 1 measurement
on today's IDs, make the enwiki call, then decide this. The other order means choosing a permanent
placement against numbers already invalidated.

## Open

- [ ] Whether an alias is allocated in `catalog.lock.json` at plan time or by compare-and-set in the
      directory at runtime. URI identity pushes hard toward runtime, since drawing an edge at a name
      nobody has deployed against is the point of it — which makes the registry the first
      schema-shaped state outside the lock, and gives up the git-conflict property that catches two
      branches allocating one integer twice.
- [ ] URI canonicalization. Scheme, host case, default port, trailing slash, percent-encoding,
      fragments: two spellings of one database become two aliases and the unique index does not
      notice. Load-bearing the moment the URI is the identifier, and the known cost of that choice.
- [ ] What a database proves about itself, and when. A pin detects substitution only if there is
      something to pin and something to check it against on later contact — a key it signs with, at
      a minimum. The policy on a mismatch is a decision rather than a default: refuse the alias
      outright, or surface it and let the application choose.
- [ ] What a foreign read returns. Whole objects against a projection the target database publishes,
      or IDs only, leaving the caller to fetch. The second is far easier to authorize and the first is
      what makes `related()` over a foreign edge useful.
- [ ] The deadline and budget on a foreign round, and what a partial answer looks like in a result
      that today distinguishes only `done` from `short`.
- [ ] Whether a foreign edge's `time` is the source's clock, and what a cursor means across two
      databases that do not share one.
- [ ] Whether cross-database references are allowed at all without a mutual handshake, or whether an
      inbound edge is itself a disclosure the target must consent to.
