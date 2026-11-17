# Forward plan

Nov 17, 2026 · @Matt Wonlaw

From one database to a graph of them. The first seven steps of this plan are built: a reference has
one spelling, the protocol is on HTTP, a foreign edge is stored, a read follows one and keeps going
inside the database it reaches, requests are signed and keys are pinned, and there is a normative
spec with a conformance suite and a package. What is left is step 8, which is product on top of the
standard.

[`docs/design.md`](docs/design.md) owns the engine. [`docs/global-ids.md`](docs/global-ids.md) owns
how a reference into another database is stored and named, and
[`docs/protocol.md`](docs/protocol.md) owns the protocol's rationale.
[`spec/protocol.md`](spec/protocol.md) is now the normative specification — what an implementation
other than this one is held to — and [`spec/schemas/`](spec/schemas/) is normative with it. The
Wikimedia plan this document replaced is closed and kept at
[`docs/wikimedia-plan.md`](docs/wikimedia-plan.md), because other documents cite its figures.

Figures marked **measured** were read off a real artifact and say how.

## Where this stands

Built, with typecheck clean and **585 of 585 tests passing under both storage formats**
(`npm run test:formats`), **42 of 42** conformance checks against the published fixture
(`npm run conformance:fixture`) and **30 of 30** without one (`npm run conformance:node`):

- **Step 1.** `src/query/ref.ts`. A reference is a local id or `<database URI>#<id>`, with one
  canonical spelling for the URI, refused rather than repaired.
- **Step 2.** `src/protocol/http.ts`, `wire.ts`, `surface.ts`. One handler from a WHATWG `Request` to
  a `Response` with no platform in it, type names and never catalog integers on the wire, the exposed
  surface as a projection, and `Hop.after` so a served list can be paged. Mounted on the wiki Worker
  at `/db`.
- **Step 3.** Two storage formats, the alias column in the key, the registry in the directory, the
  write path taking a `Ref`, and the comparator and cursor codec that moved with the key. No in-place
  upgrade; a vshard move is the migration.
- **Step 4.** Milestone A. A read follows an edge into another database: the alias becomes a URI at
  one seam, routing learned a client per foreign database, and `serve` lists a reference rather than
  following it.
- **Step 5.** One Ed25519 key per database, published in the descriptor, pinned on first contact,
  rotated by signing the new key with the old. Requests signed under a restricted profile of
  RFC 9421.
- **Step 6.** Milestone B. Lists and counts that live elsewhere, a page continued by the responder's
  own token, a frame's subtree sent as hops so a traversal inside one database is one request, onward
  to a third database, per-query budgets, caching as the response permits, and type agreement on
  fields.
- **Step 7.** `spec/protocol.md`, `spec/schemas/`, `spec/fixture/`, the Node adapter as a whole
  database over files with a `serve` command, the package's exports map and build, README, LICENSE
  (Apache-2.0), CONTRIBUTING and CI.

Not built: step 8, below.

### What the oracles found

Worth recording, because it is the argument for having built them rather than only the unit tests.

- The **federation oracle** — a query across many databases equals the same query over one database
  holding both graphs, after mapping ids — found that a payload id field in a foreign object is
  relative to the *responder*, so resolving it locally returned whichever object happened to share
  the number. That is the alias-in-the-key failure one level down, inside the JSON.
- It also found the **atype collision** that proves why integers never cross the wire:
  `notes.note_about` and `wiki.page_links` are both 1 in their own catalogs, so a query that
  traverses another database's edge can only name it if the asking catalog declares it too.
- Holding this implementation to **its own schemas** found a malformed id in `ids` reaching a key
  conversion and coming back as a 500, and an unknown request member being accepted silently.
- The **fixture's signature check** found that a database with no verifier ignored a presented
  signature: the caller had made a claim nobody checked and could not tell.

## Decisions now permanent

These were the seven this document asked to confirm. Each is settled and in the normative spec; a
change to one is a change someone has built against.

| Decision | Settled as |
| --- | --- |
| How a reference is spelled | `<database URI>#<decimal id>`. One `#` in a canonical URI makes the split unambiguous |
| When two database URIs are the same | A canonical form, in `spec/protocol.md` §2.1. A URI not in it is refused and the canonical spelling named |
| The HTTP binding | `GET {db}`, `POST {db}/read`, `POST {db}/price`, `GET {db}/vocabulary` |
| What names cross the wire | Type names. Ids relative to the database answering; a reference into any other absolute, payload fields included |
| What an unfollowed reference looks like | In its list, with no entry in `objects`, no list or count below it, and never dropped by a filter |
| The identity scheme | Ed25519 per database, published, pinned, rotated by signature. A restricted profile of RFC 9421 |
| The license | Apache-2.0 |

Two more were settled while building, and belong in this table for the same reason:

| Decision | Settled as |
| --- | --- |
| An unknown member of a request | Refused. A caller that cannot tell whether its field took effect is the thing `at` exists to prevent, so a new optional member is a new wire version |
| A signature a responder cannot verify | Refused, including by a responder that verifies none and says so in its descriptor. A caller reads the descriptor and does not sign to a keyless database |

## 8. Hosting and the agent surface

Milestone C. The least specified step, and deliberately last: it is product on top of the standard,
and the standard is now done.

- **Many databases in one deployment.** The database's name comes from the request path instead of
  `HLEKK_DATABASE`. Host and directory names are already scoped by database, so the namespaces can
  hold many. What has to change is that a Durable Object learns its database from the call that first
  reaches it and records it, where today it reads its own configuration.
- **A database that costs nothing until its first write.** `global-ids.md` needs this for "create as
  many as you like", and a URI is already mintable before the database behind it exists. Today
  `Directory.open` assigns a first batch of 64 vshards and a host, so an empty database is ~2 KB and
  two Durable Objects rather than nothing.
- **Who may write.** Principle 10 keeps the engine's caller trusted, so this is a layer above it: an
  owner credential per database, set at creation, required for writes and for reads outside the
  protocol. `src/worker/guard.ts` is the shape of it for operator routes; this is the same idea per
  database rather than per deployment.
- **The agent surface.** The read protocol is already usable by an agent as plain HTTP, and
  `/vocabulary` describes each database. Creation, schema changes, writes and links need tools. An
  MCP server over the hosting layer is the proposal, and its shape was deliberately left until step 7
  was done. It is now, so this is the decision to make next — and it is a product decision rather
  than one this plan can settle: what an agent may create, under whose credential, and what it is
  billed.

## Deliberately not in this plan

- **Cross-database writes, inverses and cascades.** Reads only, as `docs/protocol.md` decides. The
  global graph is outbound links.
- **Backlinks.** A subscription protocol with its own threat model.
- **A global directory of databases.** A URI is the name and DNS arbitrates it. Discovery is not
  identity and can come later without touching anything here.
- **Subject claims**, where a caller speaks for one of its own users. `docs/protocol.md` shows it is
  safe to add and that it is additive.
- **More Wikipedia on Durable Objects, and the bulk import.** Closed in
  [`docs/wikimedia-plan.md`](docs/wikimedia-plan.md).
- **Paged storage**, and everything under `design.md`'s *Deferred*.

## Left out of steps 1–7, with the reason

Each of these was in a step's build or proof list and is not done. They are here rather than in the
steps above, so that nothing reads as finished that is not.

- **Every deployment.** Nothing in this repository has been deployed by this work: not the wiki
  Worker with the protocol mounted at `/db`, not the `wrangler.notes.jsonc` step 4 called for, and so
  not the latency of a foreign hop measured beside a local one. All of it needs an account. The two
  gates stand: redeploy all four wiki Workers before any database URI is handed out, and review every
  route on every deployed Worker before an announcement — starting with `/counts`, which is public
  and takes as many ids as a URL holds, and `src/worker/app.ts`, which has no gate at all and must
  not be deployed as it stands.
- **workerd.** `npm run smoke` needs a port and an account, so Ed25519 through WebCrypto is confirmed
  on Node 22 against RFC 8032's own vectors and not on the Workers runtime. Nothing in
  `src/protocol/identity.ts` uses a Node builtin.
- **Foreign fetches in `testkit/sim.ts`'s schedule**, dropped and reordered. A foreign read is routed
  by URI and not by vshard, so what it would newly interleave with is the coordinator's route cache,
  which that simulation already hammers — but it is not covered, and the faults it would add are
  covered only in `src/protocol/federation.test.ts`, which does not interleave them with moves.
- **Publishing the package.** Everything that makes it publishable is in place; `"private": true`
  stays, because publishing is a decision with a name attached and one word to undo.
- **Filters sent with a foreign hop.** Step 6 sends a frame's subtree without them, because the cache
  keys a list by object and edge type and a filtered list merged into it would answer another frame
  wrongly. Sending them means keying foreign lists by frame.
- **A `where` over an edge type whose `from` does not match the parent.** `check` validates every
  name against the vocabulary but not that a hop starts where its parent lands, so a nonsensical
  traversal is answered as an empty list rather than refused. It costs nothing — the list is genuinely
  empty — but a refusal would be better.

## Open

- [x] Whether a failed foreign hop fails the query by default. **It does**, and a caller opts into an
      answer that omits what could not be reached and says which databases and how many references.
      A repudiated database is not omitted away: it was reached and answered.
- [ ] Whether a policy may hide that an edge into another database exists. `Policy` decides objects
      and counts, and a reference this database does not own is neither. Today it cannot: an
      unfollowed reference is in its list whatever the policy says.
- [ ] Whether type names need a namespace URI per domain. Two databases that both say `wiki.page`
      agree by convention, and `/vocabulary` now lets a reader check the *shape* behind the name —
      which is the half that was actually dangerous. Reserving the field is additive; requiring it is
      not.
- [ ] Where `unreachable` lives. The registry's DDL lists it as a state and nothing writes it: a
      timeout is held in the asking isolate, and writing it from every isolate that sees one would
      load the directory.
- [ ] What a cursor over a list in another database is to an application. Step 6 wraps the
      responder's token, so the question is now narrow: whether an application may hold one across a
      responder's own rotation of them, and whose clock `time` is.
- [ ] Whether `create` needs an idempotency key. Carried from `design.md`, and sharper once step 8
      puts agents behind HTTP retries.
- [ ] Objects stranded by an interrupted `createUnique`. A process that dies between the create and
      the confirm leaves an object no index entry points at, and nothing collects it
      ([`docs/wikimedia-demo.md`](docs/wikimedia-demo.md)). A defect in the engine, and step 8 puts it
      behind HTTP.
- [ ] The chunked snapshot. Carried from `design.md`, and the only route from storage format 1 to
      format 2.
- [ ] How long a retired key's grace window is. `pruneKeys` takes one and nothing chooses it; a
      caller pinned on a pruned key is repudiated on next contact, which is the cost of the window
      being finite.
- [ ] Whether a responder should refuse a repeated signature. A read applies nothing, so replay
      inside the skew window is harmless to correctness and not to cost.
