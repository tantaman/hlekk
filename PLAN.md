# Forward plan

Nov 17, 2026 · @Matt Wonlaw

From one database to a graph of them. The first seven steps of this plan are built: a reference has
one spelling, the protocol is on HTTP, a foreign edge is stored, a read follows one and keeps going
inside the database it reaches, requests are signed and keys are pinned, and there is a normative
spec with a conformance suite and a package.

Step 8 was hosting and an agent surface. Two decisions taken after step 7 — **one deployment is one
database**, and **reads are public by default** — remove most of it, and §8 below records what it was
and why it is not that. What is left is deploying what exists, which needs an account rather than a
decision.

[`docs/design.md`](docs/design.md) owns the engine. [`docs/global-ids.md`](docs/global-ids.md) owns
how a reference into another database is stored and named, and
[`docs/protocol.md`](docs/protocol.md) owns the protocol's rationale.
[`spec/protocol.md`](spec/protocol.md) is now the normative specification — what an implementation
other than this one is held to — and [`spec/schemas/`](spec/schemas/) is normative with it. The
Wikimedia plan this document replaced is closed and kept at
[`docs/wikimedia-plan.md`](docs/wikimedia-plan.md), because other documents cite its figures.

Figures marked **measured** were read off a real artifact and say how.

## Where this stands

Built, with typecheck clean and **702 of 702 tests passing under both storage formats**
(`npm run test:formats`), **48 of 48** conformance checks against the published fixture
(`npm run conformance:fixture`) and **35 of 35** without one (`npm run conformance:node`):

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

- **After step 7.** `src/reader/`. A reader: a query across databases from a process that has none,
  which is what "the protocol is the agent surface" needed to be usable from code as well as from
  `curl`. It is the two drivers and the asking half of step 4, unchanged, with the one thing a
  database of your own supplies them — a catalog — built per database from that database's own
  `/vocabulary`. A lock is optional: with one, a module generated from it runs against the reader
  as it would against a database. Without one a read is the wire's own request, as data, or the
  same request written by chaining (`src/reader/query.ts`), which compiles to that data and can say
  nothing it cannot. `hlekk/reader` runs wherever `fetch` does, and `hlekk/adapters/node` wraps it
  with the address guard.

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
- Writing the **discovery** test — a caller walking a database from one id with only the vocabulary to
  go on — found three ways a caller's own names could be lost, each producing an answer it could not
  tell from a true one. A count and a hop over one edge default to the same name, so the list came
  back empty beside a count saying it was not; two hops under one name both ran and one was discarded;
  and a hop named `id` did not shadow a field but collapsed the structure of the whole answer, since
  the normalized form keys everything by `row.id`. The wiki demo's authored-query box had the first
  of those too.
- Building the **reader** — the first caller with no catalog of its own — found that the engine's
  client could not read through three databases that share none. A frame's subtree is named through
  the ASKING catalog, so a hop the asker can name and the responder does not expose rode along, and
  the responder refused all of it, correctly: `entry → about → release → supersedes` was refused by
  the ops database, which has no `packages.supersedes` to be asked about. Every federation in the
  suite had given the first foreign database the later edges too, which is why nothing saw it.
  Below the first hop the client now sends only what the responder's vocabulary exposes, and asks
  for that vocabulary only when a request nests; a hop directly under the ids is still the
  responder's to refuse, which is what keeps a wrong query loud.

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
| A hop that does not start where its parent lands | Refused, naming what is available from there. It could only ever return nothing, and nothing is an answer a caller cannot tell from a true empty list |
| Two of a caller's own names landing on one | Refused, and so is a name a row already carries. Letting the later one win is what makes a wrong answer look like a right one |
| How many databases a deployment serves | **One.** A Durable Object's env comes from the deployment that defines its namespace, so a Worker holding two names gets one set of hosts and not two databases — measured on workerd. Density traded for separate namespaces, separate limits and a blast radius of one |
| Whether a mounted database is readable | **Public by default**, because the protocol exists so a database can be read by another and one that answers nothing is not participating. Safe because mounting the handler is the act of exposure, which is only true while no layer mounts one automatically |

## 8. What is left, after two decisions

Step 8 was "hosting and the agent surface", and it was four bullets. Two decisions taken after step 7
remove three of them, so what it was is recorded here along with why it is not that any more.

**One deployment is one database.** Not a limitation worked around but the arrangement, and it was
always the conclusion rather than the starting assumption: a Durable Object's env comes from the
deployment that defines its namespace and never from whoever called it, so a Worker holding two
database names does not get two databases — it gets one set of hosts that the second database's
directory adopts vshards on and one set of map chunks the second publishes over the first's. That was
tried, and workerd reported it as `indexLookup: host does not hold index vshard 155` with two
"databases" sharing all 43 hosts (`examples/wiki/wiki-app.ts`).

What is given up is density, and what is kept is the stronger thing: separate Durable Object
namespaces, separate KV, separate account limits, and a blast radius of exactly one database. The
database prefix on DO names and KV keys stays, because it costs nothing and lets a second deployment
share the namespaces rather than needing its own.

**Reads are public by default.** The protocol exists so that one database can be read by another, and
a database that answers nothing is not participating in it — so readable is the state that makes the
thing work, and a responder narrows from there with a `Policy` per request and a projection over what
it exposes at all. What makes that safe is that mounting the handler is the act of exposure: a
database that exists and is not mounted is reachable by nobody.

The hazard is recorded in `src/query/serve.ts` beside the default rather than guarded against:
anything that mounts the handler for a database *automatically* inverts the argument, because then
nobody chose to expose it. That would be a hosting layer, and there is not going to be one — which is
the same decision as the first, read from the other end. If that ever changes, the default is the
first thing that has to.

### What those two decisions removed

- ~~**Many databases in one deployment.**~~ Out. It has no subject: one deployment is one database.
  The mechanism it needed — a Durable Object learning its database from the first call that reaches it
  rather than from its own configuration — is not built and is not wanted.
- ~~**A database that costs nothing until its first write.**~~ Out. `global-ids.md` wanted it for
  "create as many as you like", and creating one is now a deployment, so the ~2 KB floor of a
  directory and 64 vshard rows is not a figure anybody multiplies by a trillion. The reasoning in
  that document stands as the reasoning for a service nobody is running.
- ~~**The agent surface, as an MCP server.**~~ Out as a proposal; what it was for is already there.
  The read protocol is plain HTTP an agent can call, and it is a better agent interface than a wrapper
  would be because it was designed for an untrusted caller rather than for a model: `GET {db}` states
  the limits, `GET {db}/vocabulary` states the types and their fields, `/price` says what a read costs
  before it is spent, and a refusal carries `at` so a wrong request corrects itself. The one thing an
  MCP server would have bought is credential custody on a WRITE surface — and with one deployment per
  database there is no public write surface to hold a credential for.

### What is actually left

**Writes stay the owner's.** Principle 10 keeps the engine's caller a trusted server, and with one
deployment per database that is the application's own client behind whatever the application already
has. The demo Workers' operator routes are closed behind `HLEKK_ADMIN_TOKEN` and refuse everything
while it is unset. So the third bullet — an owner credential per database — is a deployment concern
that is already met at the deployment level, and there is nothing per-database to add.

**The deployments.** Everything under *Left out of steps 1–7* below, which is the real remaining work
and needs an account rather than a decision.

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
- **A hop off the root cannot be checked against its parent's type.** A hop under another hop is now
  refused when it does not start where that one lands (§5.1), but the entry is ids, an id does not
  carry its type, and `ids` may hold objects of several types — so there is nothing sound to check a
  root hop against, and pricing happens before any I/O that could find out. Closing it means a caller
  optionally stating the root's type, which is a new request member and so a new wire version.

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
- [x] The chunked snapshot. A move copies a vshard a chunk at a time and resumes from a recorded
      cursor, so it is bounded by the vshard cap rather than by one request. It is also the route
      from storage format 1 to format 2 — a format 1 vshard's chunks install into a format 2 host
      with every alias 0, which `src/host/copy.test.ts` pins — though no deployed database has been
      migrated that way yet.
- [ ] How long a retired key's grace window is. `pruneKeys` takes one and nothing chooses it; a
      caller pinned on a pruned key is repudiated on next contact, which is the cost of the window
      being finite.
- [ ] Whether a responder should refuse a repeated signature. A read applies nothing, so replay
      inside the skew window is harmless to correctness and not to cost.
