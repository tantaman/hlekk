# Forward plan

Nov 17, 2026 · @Matt Wonlaw

From one database to a graph of them. Today a hlekk database can answer another database's read, as
a library function that nothing mounts on a route. This plan takes it to two independently run
databases joined by an edge and read in one query, and then to what makes that a standard someone
else can implement: an identity scheme, a normative protocol, a conformance suite, and a reference
implementation that runs without Cloudflare.

[`docs/design.md`](docs/design.md) owns the engine. [`docs/global-ids.md`](docs/global-ids.md) owns
how a reference into another database is stored and named, and [`docs/protocol.md`](docs/protocol.md)
owns what crosses the wire when one is followed. This is the plan, and it holds only what is not yet
done. The Wikimedia plan it replaces is closed and kept at
[`docs/wikimedia-plan.md`](docs/wikimedia-plan.md), because other documents cite its figures.

Figures marked **measured** were read off a real artifact and say how. Four are new here, three in
step 3 and one in step 5, and `node scripts/edge-order.mjs` prints them. Everything else in this
document is a plan, not a reading, and the designs in steps 4 and 6 are the least certain part of it:
they are written to be proven or broken by the oracle each step names.

## Where this stands

Built, on `main`, with typecheck clean and **357 of 357 tests passing** (run Nov 17):

- The engine: all six steps of design.md's build plan, the Cloudflare adapter in
  `src/adapters/cloudflare/`, and `LocalCluster` in `src/client/local.ts`, a second complete
  implementation of the platform seams that runs a whole database in one process.
- The serving half of the protocol, as a library. `src/query/request.ts` prices a bounded request
  before any I/O, and `src/query/serve.ts` answers one and applies a policy to the answer.
- The shape of a stored cross-database reference, as DDL that nothing applies:
  `src/host/schema.foreign.ts`.
- The decisions, in global-ids.md and protocol.md.

Not built:

- A string form for a reference into another database. Ids are bare decimals everywhere.
- A wire format or an HTTP route. `serve` returns the engine's own result, type integers included.
- The alias column, the registry, or a write path that accepts a foreign target. An alias is the
  small number a database gives each other database it references, so that an edge stores a number
  and not a URI; the registry is the table that maps one to the other.
- The asking half. Nothing follows an edge out of a database.
- Identity: no keys, signatures or pins.
- A normative spec, a conformance suite, a license or a README.
- More than one database per deployment. `databaseOf(env)` reads the name from configuration.

Two gates are lifted. global-ids.md held the alias column until the enwiki placement was decided, and
`schema.foreign.ts` held it for a bulk-import oracle that needed the old primary key. Wikipedia is
loaded as far as it is going to be, and the bulk import is no longer planned. Both passages are now
stale, and step 3 rewrites them when it applies the DDL.

## The target

Three milestones, each a thing that can be shown.

- **A, after step 4.** A new, small database holds an edge to a page in the deployed wiki database,
  and `Note.gen(id).related("about", noteAbout)` returns the page. Two deployments, one query, and
  no change to the query builder's API. The wiki stays on the storage it was loaded with; only the
  new database needs the format that can hold such an edge.
- **B, after step 6.** The same read is authenticated, continues inside the wiki database
  (`note → page → the pages it links to`), and can pass through a second database into a third.
- **C, after step 8.** Someone outside this repository runs a database from a published package,
  passes the conformance suite, and links to ours. An agent can create a database and link it.

## Decisions to confirm

protocol.md lists what cannot be revised once someone builds against it, and those stand: forbidden
is indistinguishable from absent, a count is separately authorized, a response states its own
cacheability, a request is a tree and never a plan, nothing is pushed down, and reads only.

Building this adds seven more of the same kind. Each has a recommendation, and each becomes permanent
at the step named, so that is the latest point to disagree.

| Decision | Recommendation | Permanent at |
| --- | --- | --- |
| How a reference is spelled | `<database URI>#<decimal id>`, for example `https://db.example/wiki#281474976710691`. One `#` in a URI makes the split unambiguous, and the database's identity is exactly the prefix | Step 1, the first payload that stores one |
| When two database URIs are the same | A canonical form, and a URI not already in it is refused rather than repaired. Rules in step 1 | Step 1 |
| The HTTP binding | `GET` on the database URI returns a descriptor: a small JSON document giving the protocol versions, keys and limits. `POST {db}/read`, `POST {db}/price`, `GET {db}/vocabulary` | Step 2, the first outside caller |
| What names cross the wire | Type names, never the catalog's integers. Ids in an answer are relative to the database answering, and a reference into any other database is absolute | Step 2 |
| What an unfollowed reference looks like in an answer | The reference appears in its list and has no entry in `objects`. A database answering a read never follows one | Step 4, when a served database first holds one |
| The identity scheme | One Ed25519 key per database, published in the descriptor, pinned on first contact, rotated by signing the new key with the old. Requests signed with a restricted profile of HTTP Message Signatures (RFC 9421) | Step 5 |
| The license | Apache-2.0, for the patent grant a standard's reference implementation wants. MIT is the alternative | Step 7, and free to settle today |

## Order

| Step | Delivers | Needs |
| --- | --- | --- |
| 1. A reference has one spelling | `Ref`, parsed and canonicalized in one place | Nothing |
| 2. The protocol over HTTP | The wiki database answers reads on the internet | Nothing |
| 3. Storing a foreign edge | Storage format 2, the registry, the write path | 1 |
| 4. The first cross-database read | Milestone A | 1, 2, 3 |
| 5. Identity | Signed requests, pins, rotation | 2 |
| 6. Inside another database, and beyond it | Milestone B | 4, and 5 for anything not public |
| 7. The release | Spec, conformance suite, Node adapter, package | 5, 6 |
| 8. Hosting and the agent surface | Milestone C | 7 |

Steps 1, 2 and 3 do not depend on each other's code beyond `Ref`, and step 5 can run beside 3 and 4.

## 1. A reference has one spelling

Field relationships store ids inside JSON payloads, so whichever spelling ships first is in payloads
permanently. global-ids.md names this as the one piece that is expensive to defer. It changes no
stored byte.

**Build**

- `src/query/ref.ts`. `Ref` is a string that is either a local `Id` or a database URI, `#`, and an
  `Id`. `parseRef(ref)` returns `{ db: string | null, id }`, `formatRef(db, id)` writes one, and
  `canonicalDb(uri)` returns the URI or throws naming the canonical spelling.
- `src/host/ids.ts` does not change. `parseId` and `toKey` keep refusing anything that is not a bare
  decimal, so a qualified reference that reaches a key conversion throws instead of being truncated.
  global-ids.md says to have `parseId` round-trip a qualified id. A separate `parseRef` is the same
  decision with the 8-byte guard left strict, which that document also asks for.
- The canonical database URI: scheme `https`, lowercase (`http` only for a loopback host, for
  development). Host lowercase, international names as A-labels, no trailing dot. No userinfo. No
  port when it is the scheme's default. A path with no empty, `.` or `..` segment and no trailing
  slash, percent-escapes in uppercase and only where required. No query and no fragment. A length
  cap, value to set.
- Where a qualified reference is accepted: an edge's target, and a payload field the catalog declares
  as an id. Where it is refused: an edge's source, `with`, the target of an update or delete, and a
  global index entry. Step 3 enforces these; this step only records them.

**Proven by** a round-trip property over generated URIs and ids; a table of non-canonical spellings,
each refused with the canonical one named; `toKey` throwing on every qualified form.

**Done when** `Ref` is exported and the suite's count has gone up with nothing else changed.

## 2. The protocol over HTTP

The serving half needs no storage change, so the first database on the internet that answers the
protocol can be one that is already loaded: the wiki, under the `PUBLIC` policy, with no identity.

**Before anything is advertised.** `/admin/*` and `/ingest/*` on the wiki Worker are closed in code
behind a bearer token, `HLEKK_ADMIN_TOKEN`, and refuse everything while it is unset
(`src/worker/guard.ts`). That closes nothing that is already deployed. `hlekk-wiki`,
`hlekk-wiki-hash`, `hlekk-wiki-graph` and `hlekk-enwiki` each serve the routes as they were until
redeployed, so redeploying all four comes before any database URI is handed out. Two things are
left as they were, on purpose. `/counts` is public and takes as many ids as a URL holds, each one a
read. And `src/worker/app.ts`, the small issue-tracker demo, has no gate at all: it is a local
harness, and it must not be deployed as it stands.

**Build**

- `src/protocol/wire.ts`. Encodes `Served` for the wire and decodes it for step 4. An object's
  `otype` becomes its type name from the catalog. Ids stay relative to this database. A version field
  rides on every body.
- `Hop.after` in `request.ts`: a continuation token, validated by `check` and compiled to
  `Frame.after` by `planOf`. Without it a served list cannot be paged, and step 6 depends on it.
- A vocabulary built from a projection. `vocabularyOf` takes a list of edge names today.
  `src/catalog/projection.ts` already resolves a named selection with a hash and narrowed fields, so
  the exposed surface becomes a projection, and the encoder sends only the fields it projects. That
  is static field narrowing; a policy that varies fields per caller stays open.
- `src/protocol/http.ts`. One function from a WHATWG `Request` to a `Response`, with no Cloudflare
  import, so the Worker and a Node server mount the same code. Routes as in the table above. A
  `Refused` is a 400 carrying its `at`. A body over the size cap is a 413, checked before parsing.
  A fault inside the engine is a 500 that says nothing about it.
- Mounted in `wiki-app.ts` under a path prefix, which makes the database URI `https://<host>/<prefix>`.
  `Hlekk` already satisfies `ReadSource`.
- `src/adapters/node/http.ts`: the same handler over `node:http` and a `LocalCluster`. Step 4's tests
  need two databases talking over real HTTP, and this is the start of step 7's Node adapter.
- `scripts/conformance.mjs <database URI>`: black-box checks that need no fixture. The descriptor
  parses; a priced request costs what the read then reports; an over-budget request, an unknown edge,
  too many ids and a count on a field relationship are each refused with an `at`.

**The gate.** This redeploys a Worker onto loaded databases. Deploy to a scratch database first and
run the `ingest:deployed` read checks against it, then the wiki. If step 3 has landed, also confirm
that a host opened on the old storage format issues no DDL.

**Proven by** handler tests that pass `Request` objects with no network; an encode-then-decode test
that returns the original result; the wiki demo's query tests passing unchanged; the conformance
script against local workerd and then the deployment.

**Done when** a `POST` to the deployed wiki's `/read` with one page id and one hop returns pages, a
cost and a cacheability.

## 3. Storing a foreign edge

**Measured**, by `scripts/edge-order.mjs` reading SQLite's query plans. These three readings shape
the step:

- On the new key `(id1, atype, db, id2)`, a page ordered `(time, db, id2)` is served by
  `assocs_range` directly, at the head and after a cursor.
- On the new key, today's order `(time, id2)` needs a temporary b-tree for its last term. So a host on
  the new key cannot keep today's page query, and the tie-break changes: at one `time`, five edges
  read back as `2:8 2:3 1:7 0:9 0:4` (alias, then id), foreign before local.
- Adding the column to today's table with `ALTER TABLE` works, but the new order then sorts the whole
  list in a temporary b-tree. So an existing host cannot be given the new statements cheaply.

Together: two storage formats, each with its own statements, and no in-place upgrade.

**Build**

- **The format is a recorded fact.** Format 1 is today's `assocs`; format 2 has `db` in the key. The
  directory holds the database's format in `meta`, where absent means 1, and every database created
  from now on is 2. A host detects its own format from the shape of `assocs` and refuses to open when
  that disagrees with what the directory says. A new, empty host is told the format when it is first
  adopted. This is what turns "the fleet diverges in silence" into a refusal with a reason.
- **Statements by format.** Format 1 keeps today's SQL byte for byte, which is what keeps the loaded
  wiki databases untouched. Format 2 changes `PAGE_HEAD` and `PAGE_AFTER` in `host/store.ts`, and
  `#putEdge`, `#dropEdge`, `#hasEdge`, `#erase`, `snapshot` and `install` in `host/host.ts`.
  `FOREIGN_ASSOCS_DDL` moves into `host/schema.ts` as format 2's table and the stale header goes.
- **One comparator, in three places.** `Edge` and `Cursor` in `query/types.ts` gain `db`, and
  `edgeOrder` compares `(time, db, id2)`. The cursor codec in `schema/query.ts` becomes `v2` and
  carries the alias; a `v1` cursor decodes as alias 0, so cursors already handed out stay valid. The
  SQL, `edgeOrder` and the codec have to agree or a tie-broken cursor lands in the wrong place, which
  is the failure `cmpId`'s comment already warns about.
- **The catalog.** `EdgeDecl.foreign`, on stored edges and field relationships alike. Compiling
  refuses `foreign` with `inverse` and `foreign` with `onDelete: "cascade"`, as global-ids.md
  specifies. `applyLock` refuses a lock holding any foreign edge type on a format 1 database.
- **The registry.** `FOREIGN_DBS_DDL` is appended to the directory's DDL, which is safe on existing
  directories because it only adds a table. `intern(uri)` canonicalizes, inserts once, and returns
  the alias, taken from a counter in `meta` and never from `MAX(alias) + 1`. The directory also
  records the database's own URI, and interning that is refused. `Transport` gains `intern` and
  `aliases`, in `LocalCluster` and the Cloudflare adapter both.
- **The write path.** `assocAdd`, `assocAddMany` and `assocRemove` take a `Ref` as the target. The
  client parses it, collapses a reference to its own database into a local id, checks the edge type
  is foreign, interns the URI, and sends the alias. The binding never changes, so an isolate caches
  it for life. The host refuses a non-zero alias on a format 1 host or a non-foreign edge type. For
  payloads, `create` and `update` check every field the catalog declares as an id.
- **The audit.** `vshardOf` must never see a foreign target. The sites that take an edge's target
  are `opTarget` and the cascade branch of `#erase`, and the catalog rules above keep foreign targets
  out of both. Put the assumption in code: one helper that throws on a non-zero alias, called at
  each. Outside the engine, both demo Workers decode a vshard from every id in an answer to report
  which hosts served it, and need to skip a qualified one.
- **Until step 4, a read that meets a foreign edge throws.** Dropping it would read as a dangling
  reference, and loading it by number would return a local object that happens to share the id.

**Proven by**

- The whole existing suite, run once per format. With no foreign edge written, format 2 has to pass
  everything format 1 passes: the differential oracle, the reference model, the invariants and the
  simulation.
- New tests against a real `Host`: a foreign edge written, paged, removed and counted; a page whose
  cursor falls inside a tie between a local and a foreign edge; the same local id in two databases
  held as two edges; every refusal above; a host that will not open on the wrong format; a format 1
  database file whose schema is byte-identical after being opened by the new code.
- New invariants in `testkit/invariants.ts` for format 2: every non-zero alias in `assocs` is in the
  registry, none sits under an edge type that is not foreign, a count still equals its list, and no
  outbox row names a foreign id.
- `scripts/id-width.mjs` re-run against the real statements, to confirm the 1.019x it measured for
  this shape before the shape was real.

**Not in this step:** moving an existing database to format 2. A format 1 snapshot installs into a
format 2 host with every alias 0, so a vshard move is the migration, as global-ids.md says. It waits
on the chunked snapshot design.md already owes.

## 4. The first cross-database read

Milestone A. The asking half, for the narrowest useful case: follow an edge into another database and
bring back the objects it points at.

**Build**

- **A host emits a foreign target and never loads it.** `EdgeHop` and `runTask` send a row with a
  non-zero alias back as a miss carrying the alias. `SqlStore.object` answers `UNKNOWN`, without
  recording a refusal, for a qualified reference that a field relationship read out of a payload.
  Today it would throw inside `parseId`.
- **The client makes references absolute at one seam.** In `Hlekk.#exec`, straight after
  `transport.exec`, every edge row and every miss carrying an alias gets its URI from the isolate's
  alias cache. Past that line the coordinator sees only `Ref`s, and the alias stays on the edge for
  ordering alone.
- **Routing.** `#router` returns a host's client for a local reference and a foreign client for a
  qualified one. Both drivers batch by client identity already, so a foreign database gets one
  request per batching window however many targets it holds.
- **`src/protocol/client.ts`**, a `HostClient` for a database reached over HTTP. Object misses become
  `POST {db}/read` with ids in batches of the responder's advertised maximum. Every id asked for is
  answered into the cache: the object, or `null` when the answer lacks it. A type name this catalog
  does not declare is declined, as `null` with a recorded reason, which is protocol.md's "decline a
  type it does not understand". A miss for a list or a count that lives in the other database throws
  by name; step 6 builds it.
- **A database answering a read never follows a foreign edge**, or it becomes the deputy protocol.md
  rules out. `serve` asks the engine to stop there. The reference is listed and nothing is loaded,
  which needs a third store answer beside an object, `null` and `UNKNOWN`, and touches `EdgeHop`,
  `Where`, `Join` and `normalize`. A filter cannot judge an object it does not hold, so it passes the
  reference through undecided and the caller judges. This is the largest engine change in the plan.
- **Failure is stated, never inferred.** A timeout, a refusal or a malformed answer is a named error
  and fails the query by default. A caller may opt into an answer that omits what could not be
  reached, and that answer says which databases and how many references. An empty list is never the
  report of a failure.
- **The responder is a stranger.** HTTPS only. No redirects, since a database that moved is a
  different database. A deadline and a cap on response bytes. Object keys in an answer must be bare
  ids, which is what stops a responder supplying objects for any database but itself. Nothing is kept
  that was not asked for. On Node, refuse a URI that resolves to a private address.

**Proven by**

- **A federation oracle**, the differential oracle one level up: a query over two databases joined by
  foreign edges equals the same query over one database holding both graphs, after mapping ids.
  `testkit/generate.ts` already produces the schema, the graph and the queries. The new part splits
  the objects across two `LocalCluster`s by a seeded coin, stores each crossing edge as a foreign
  one, and joins the two with a `fetch` that calls the HTTP handler in process. The generator keeps
  crossing edge types free of inverses and cascades, since the catalog refuses those.
- The wrong-database test: A holds object 5 and an edge to B's 5, and B has no 5. A's 5 must not be
  in the answer.
- Request counts per query, with the counting transport the suite already uses.
- Faults from `testkit/unreliable.ts` on the foreign fetch, for both failure modes.
- Two real processes on the Node handler, over real HTTP.
- A deployment: a new `wrangler.notes.jsonc` on format 2, which is a new Worker and needs
  authorizing once. Its catalog declares `notes.note`, a foreign `notes.note_about` edge to
  `wiki.page`, and `wiki.page` with the fields it reads. Record the latency of the foreign hop beside
  a local one, as a measurement.

## 5. Identity

Nothing before this step needs it, because the wiki is public. Everything after it does, and
protocol.md puts the scheme among the things that cannot change once pins exist.

**Build**

- **Keys.** One Ed25519 pair per database, generated when the database is created. On Cloudflare the
  private half lives in the directory's storage and a coordinator isolate reads it once; on Node it
  is a file. **Measured**: WebCrypto signs and verifies Ed25519 on Node 22 with no dependency, which
  keeps the package at zero runtime dependencies. Confirm the same in workerd through `npm run smoke`
  before relying on it.
- **The descriptor** lists the current keys. A rotated key carries the previous key's signature over
  it, and the previous key stays listed through a grace window.
- **Pins.** `foreign_dbs.pinned` holds a hash of the key first seen. On later contact the descriptor
  is accepted if it lists the pinned key or a key reachable from it through rotation signatures, and
  the pin then advances. Otherwise the row becomes `repudiated` and every read through that alias
  fails by name. Only an operator un-repudiates.
- **Signing.** Requests carry the caller's database URI in a header and a signature over the method,
  the target URI, a digest of the body, that header and a creation time. The responder canonicalizes
  the URI, fetches the caller's descriptor with step 4's defences, verifies, and builds the `Policy`
  for that caller. `serve` does not change, since `Policy` is already per request.
- **Unsigned requests are the anonymous caller**, and the policy decides what that caller gets.
- **Strangers do not grow the registry.** A responder records a caller only when its policy
  distinguishes that caller. Anyone else is verified and forgotten.
- **Responses are not signed.** TLS and the descriptor pin carry it. Stated as a choice, because a
  proxy in the path is then trusted as the origin is.

**Proven by** fixed test vectors; a request altered in its body, target, caller or time, each
refused; a rotation chain accepted and a broken one repudiated while local reads carry on; the
reassignment case, where a database is torn down and another is brought up at the same URI with a new
key, and the edge into it fails rather than resolving; the federation oracle under a policy that
admits only A, with a third database getting an answer identical to one over an empty database.

## 6. Inside another database, and beyond it

Milestone B. After step 4 a query can land in another database. This step lets it keep going.

**Build**

- **Lists and counts that live elsewhere.** A `Miss` is a read the coordinator could not answer from
  what it has gathered, and step 4 handled one kind, an object. The foreign client turns the other
  two into requests: a page of an edge list is a one-hop request with `after`, and a count is a
  request with `counts`. Type names come from the asking catalog, so both sides have to declare the edge
  under one name.
- **A page's continuation is the responder's token.** A responder drops rows the caller may not see,
  so the last visible row is not where the list resumes. `EdgePage` gains an optional `next`,
  `EdgeHop` uses it when present, and the `Cache` joins a foreign list's runs by token.
- **The query rides inside one database.** When the coordinator asks for objects at one level of the
  query, a frame, it sends that frame's subtree as hops, so the responder's own engine batches the work within it and a
  traversal of depth n inside one database costs one request. Filters are not sent: the cache keys a
  list by object and edge type, so a filtered list merged into it would answer another frame wrongly.
  Sending them means keying foreign lists by frame, and that is a later optimization.
- **Onward.** A responder's answer lists references it did not follow, and the coordinator asks those
  databases itself. No database asks another on a caller's behalf. A reference that comes back into
  the asking database is local again.
- **Budgets.** A deadline, a request count and a database count per query. Limits are clamped to what
  the responder's descriptor advertises before sending. A responder's refusal surfaces with its `at`.
- **Caching as the response permits.** An isolate cache keyed by database and canonical request,
  honouring `public` and `caller` for the seconds stated, and nothing for `never`.
- **Type agreement, one step further.** The vocabulary states each exposed type's fields. The
  coordinator compares them with its own declaration once per database and type, and declines the
  type on a mismatch it cannot read through.

**Proven by** the federation oracle at arbitrary depth over three databases, cycles included; request
counts showing one request per database per dependent level; foreign fetches added to the schedule
in `testkit/sim.ts`, dropped and reordered; on the deployment, `note → page → page_links`.

## 7. The release

What turns the repository into a standard and a reference implementation of it.

- **A normative spec**, `spec/protocol.md`, with requirement keywords: the database URI and its
  canonical form, the reference form, the descriptor, the vocabulary, read and price, the refusal
  vocabulary, identity, versioning, and security considerations. protocol.md stays as the rationale.
- **JSON Schemas** for every body, used by the conformance suite and by the handler's own tests.
- **The conformance suite**, grown from step 2's script. It needs a fixture, so an implementation
  under test loads a small published catalog, graph and policy table by its own means. The suite then
  checks what a black box can show: forbidden indistinguishable from absent, transitively; counts
  authorized separately; paging; cacheability; signature verification with the suite as caller;
  references left unfollowed.
- **The Node adapter**, `src/adapters/node/`: file-backed SQLite per host, one process, and a command
  that serves a database from a directory. This is "spin up your own" with no account anywhere, and
  the proof that the protocol is implementable off the platform it was designed on. design.md's
  precondition holds, since one Node process serves one writer at a time.
- **The package.** An exports map for the client, the protocol, and each adapter; a build that emits
  JavaScript and declarations, since the repository runs TypeScript directly today; `"private"`
  removed.
- **README, LICENSE, a contribution guide** that says how a protocol change is proposed, and CI for
  typecheck, tests and the conformance suite against the Node adapter.
- **A review of every route on every deployed Worker** before the announcement, starting from the
  two left open in step 2.

## 8. Hosting and the agent surface

Milestone C. The least specified step, and deliberately last: it is product on top of the standard.

- **Many databases in one deployment.** The database's name comes from the request path instead of
  `HLEKK_DATABASE`. Host and directory names are already scoped by database, so the namespaces can
  hold many. What has to change is that a Durable Object learns its database from the call that
  first reaches it and records it, where today it reads its own configuration.
- **A database that costs nothing until its first write.** global-ids.md needs this for "create as
  many as you like", and a URI is already mintable before the database behind it exists.
- **Who may write.** Principle 10 keeps the engine's caller trusted, so this is a layer above it: an
  owner credential per database, set at creation, required for writes and for reads outside the
  protocol.
- **The agent surface.** The read protocol is already usable by an agent as plain HTTP, and the
  vocabulary endpoint describes each database. Creation, schema changes, writes and links need tools.
  An MCP server over the hosting layer is the proposal. Its shape is a product decision to make when
  step 7 is done, not before.

## Deliberately not in this plan

- **Cross-database writes, inverses and cascades.** Reads only, as protocol.md decides. The global
  graph is outbound links.
- **Backlinks.** A subscription protocol with its own threat model.
- **A global directory of databases.** A URI is the name and DNS arbitrates it. Discovery is not
  identity and can come later without touching anything here.
- **Subject claims**, where a caller speaks for one of its own users. protocol.md shows it is safe to
  add and it is additive.
- **More Wikipedia on Durable Objects, and the bulk import.** Closed in
  [`docs/wikimedia-plan.md`](docs/wikimedia-plan.md).
- **Paged storage**, and everything under design.md's *Deferred*.

## Open

- [ ] Whether a failed foreign hop fails the query by default, as step 4 proposes, or omits and
      reports. Reversible either way, so not in the table above.
- [ ] Whether a policy may hide that an edge into another database exists. `Policy` decides objects
      and counts today, and a reference this database does not own is neither.
- [ ] Whether type names need a namespace URI per domain. Two databases that both say `wiki.page`
      agree by convention only. Reserving the field in the vocabulary is additive; requiring it is
      not.
- [ ] Where `unreachable` lives. The registry's DDL lists it as a state, but writing it from every
      isolate that sees a timeout loads the directory. Step 4 keeps it in memory.
- [ ] What a cursor over a list in another database is to an application. Step 6 wraps the
      responder's token; protocol.md's question about whose clock `time` is stays open.
- [ ] Whether `create` needs an idempotency key. Carried from design.md, and sharper once step 8 puts
      agents behind HTTP retries.
- [ ] Objects stranded by an interrupted `createUnique`. A process that dies between the create and
      the confirm leaves an object no index entry points at, and nothing collects it
      ([`docs/wikimedia-demo.md`](docs/wikimedia-demo.md)). The bulk import was going to route around
      this. With that gone it is a defect in the engine again, and step 8 puts it behind HTTP.
- [ ] The chunked snapshot. Carried from design.md, and now also the only route from format 1 to
      format 2.
