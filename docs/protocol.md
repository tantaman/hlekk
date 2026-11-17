# The cross-database protocol

Nov 7, 2026 · @Matt Wonlaw

What one database exposes to another, and what has to be decided before anyone builds against it.
[`global-ids.md`](global-ids.md) owns how a reference into another database is stored and named; this
owns what crosses the wire when one is followed.

**The serving half is built; the asking half is not.** `src/query/request.ts` holds the
bounded-request guard, lifted out of the wiki demo because a query box open to the internet and a
database open to other databases are the same exposure. `src/query/serve.ts` answers a read: check,
compile, gather, then apply the policy. Neither needed a storage change, because a database answering
a foreign read is only answering questions about its own objects with its own ids — the alias column
in [`global-ids.md`](global-ids.md) is what the *asking* half needs, and that waits. Identity is not
built either, and is its own piece of work for the reason the *Identity* section gives.

**Reads only.** A cross-database write is a much larger question — it crosses a trust boundary in the
direction that changes someone else's data, and nothing in the inverse-edge or cascade machinery can
follow it — and it is deferred rather than designed here. Adding writes later is additive, so this is
not one of the decisions below that gets stuck.

Unlike the other documents here, this one is **almost entirely unmeasured**. It is a set of choices.
The few figures are marked, and the choices that cannot be revised once someone has built against
them are collected at the end, because those are the only ones that need to be right now.

## The shape of the thing

Anyone runs their own hlekk. They decide whether to expose it at all. A database they expose answers
at a URI, and that URI authorizes what it is asked. **Who may participate is open; what any
participant allows is entirely its own.**

So the protocol fixes a *vocabulary* and almost no *policy*. One implementation may check the calling
identity and nothing else; another may check every object; another may refuse anything but three named
shapes. None of that is the protocol's business. What is its business is that a caller can tell the
difference between the answers it gets back — which turns out to constrain more than it sounds like,
and is most of this document.

## The boundary is not the internal transport

The protocol a Worker speaks to a host today is method dispatch: `{method, args}` over `fetch`, in
`src/adapters/cloudflare/rpc.ts`, carrying maps keyed by vshard and the epoch the caller routed with.
It cannot be exposed and it cannot be extended into this. Exposing it would publish the shard map,
hand a stranger the host indices, and make them a participant in the move protocol — a `moved` reply
is a routing correction, and a foreign database has no business holding routes.

The cross-database protocol is therefore a **second, narrower surface**: database-to-database rather
than coordinator-to-host. Object-granular, no placement, no epochs, no vshards. A foreign caller
addresses objects and edges; where they live is not theirs to know, and telling them would also be
telling them when it changes.

## A request is bounded and priced before it runs

This is the one property I would call non-negotiable, and the reason is arithmetic rather than taste.

A chain of traversals materializes the product of its limits, so an answer is exponential in depth
while storage reads stay flat. **Measured** by the wiki demo's probe, recorded in
`src/query/request.ts`: depth 10 at limit 3 is 177,145 answer nodes, depth 12 reached 1,594,321 nodes
and 16.5 seconds — while storage reads stayed flat at 58 objects and 32 requests across depths 10, 12
and 14. A budget on reads, requests or rounds never fires. Nothing about the I/O reveals it.

So a request whose cost is discoverable only by running it hands an unauthenticated stranger a work
amplifier. `check(request, vocabulary, limits, roots)` computes the bound from the request's text,
before any I/O, by multiplying the limits down each root-to-leaf path and summing what every node
materializes.

**The entry is part of the price, and this is easy to get wrong.** The tree is gathered once per root,
so its cost is linear in how many objects the request enters from — which means `maxIds` and `maxNodes`
are not two independent bounds that each hold on their own. Pricing the tree for one root and then
serving `maxIds` of them understates the request by a factor of `maxIds`: a two-level request at
limit 100 prices at 10,101 nodes, comfortably inside a 20,000 budget, and materializes 1,010,100 from
the 100 ids the same request may name. That is the amplifier this whole section exists to remove,
reappearing behind a guard that reported it was satisfied. So the entry is validated *first* and its
width is passed into the price, and the quoted `cost` describes the request that will actually run
rather than a single-root version of it.

Three consequences for the protocol:

- **A `Plan` can never cross.** Principle 3 is that the query rides and the hosts resolve, but that is
  a protocol between parts of one database. A plan is a frame list with indices into itself: a caller
  can name a frame that does not exist, or name an ancestor and build a cycle. A request is a *tree* —
  a hop holds its children — so neither is representable. That is why the boundary takes this shape
  and not the internal one.
- **The vocabulary is a projection, not the catalog.** `check` is parameterized over which edges may
  be traversed and what fields their target types declare, supplied by the implementation. What a
  database exposes is narrower than what it holds, and choosing that is policy. `src/catalog/projection.ts`
  already names exactly this selection for code generation; a served projection is the same idea
  pointed outward, and building one from it is the obvious next step.
- **The price is quotable.** `check` is separate from running, so a caller can be told what a request
  would cost before sending it, and a refusal can say which part was too expensive. A budget that only
  ever appears as a rejection is not a budget a caller can plan against.

## Policy is free; the refusal vocabulary is not

Three things the protocol has to pin down even while leaving enforcement entirely to the
implementation. Each is a decision rather than a default, and each has a consequence that is easy to
miss.

### Is "forbidden" distinguishable from "absent"?

Distinguishable leaks existence: a caller learns that an object it may not read is there.
Indistinguishable means a permission revocation is byte-identical to a delete. That second one is not
merely a privacy preference, because the read path already drops edges to missing objects at read time
— so under an indistinguishable answer, "an edge you may not follow" silently becomes "an edge to
something deleted", and a maintained count still counts it either way.

I think indistinguishable is right, and it has to be *chosen* rather than arrived at, because the
whole read path's behaviour follows from it.

**Chosen also means transitive, which does not fall out of enforcing it object by object.** An answer
is a graph, not a list. If a request reaches an object only by hopping *through* a forbidden one, then
dropping the forbidden object and the lists that name it leaves that descendant sitting in the answer:
it satisfies the policy on its own merits, and its own list is keyed by its own id rather than by the
hidden one, so neither check touches it. But had the forbidden object genuinely been absent, the
engine would never have gathered the descendant at all — so its presence is both the tell this
decision was meant to remove *and* a disclosure of data the hidden path was the only route to. The
faithful question is therefore not "may the caller see this object?" but "would this object still have
been reached?", and the enforcement is a re-walk of the answer from the roots that refuses to step
through anything hidden. Transitive is not contagious: an object some other permitted path also
reaches survives, because an absent parent would not have hidden it either.

### A count is a separately authorized operation, and some edges have none

`assoc_counts` is maintained with the edge write, so a count is a single row read and free. That makes
it the thing most likely to ride along on a read that was authorized for something else. "This object
has 4,312 inbound edges from a database you cannot read" is a disclosure, and an implementation that
authorizes objects will not notice it is answering about edges.

A related correctness rule fell out of building this: a **field relationship has no count**. It
follows an id in a payload and stores nothing, so there is no maintained counter to read, and a count
naming one is refused before any I/O like any other name that does not resolve. It is still
traversable, which is the distinction — the `Vocabulary` reports it as an edge that may be followed
but not counted.

### A response states its own cacheability

Enforcement granularity decides what a caller may reuse, and only the responder knows its granularity.
Per-identity policy caches per (caller, object). Per-object field rules cache fragilely. Per-request
policy caches not at all. Without the response saying which, a caller must either re-ask for
everything or risk serving an answer the policy has since withdrawn — and the difference between those
two is the difference between federation being usable and being one round trip per object forever.

## Identity

**A database authenticates a database, and that is sufficient rather than a compromise.** The reason
is that nothing forwards. A foreign database does not continue a traversal on anyone's behalf, so the
topology is not one database relaying to the next: the coordinator is the hub. It asks B directly, and
if B's answer carries a reference into C it asks C directly as well. B never speaks to C, and never
speaks for A. So every database authenticates exactly the one party addressing it, there is no
delegation chain to verify, and the many hops of a federated read are many *graph* edges rather than
many trust hops.

That is worth stating because the alternative is the thing that sinks federated identity schemes: a
caller passing along a claim about a third party's user, to a database that cannot check it, several
times over. It is not avoided here by being careful. It is unrepresentable, because no database ever
acts for another.

The caller is therefore named by its URI, and what remains is binding that claim to a key.

- **A URI resolves to a key at a well-known path under it.** TLS already proves domain control, so
  this is exactly as strong as the domain and needs no new infrastructure or coordinated PKI.
- **Pinned on first use, checked on later contact.** This is the `pinned` column in
  [`global-ids.md`](global-ids.md)'s registry. A changed key requires a signed rotation.
  The TLS origin authenticates the response. A replacement operator can republish an old descriptor.
- **The registry is symmetric.** A pins B's key when A interns B; B pins A's when A first calls. The
  same columns serve both directions — only the alias is outbound-only, because only stored edges
  need it. There is one table, not two.
- **Per request, HTTP Message Signatures over the discovered key.** Deployable behind CDNs and
  proxies where mTLS is not, which matters when the premise is that anyone can host.
- **Key rotation is the part that gets skipped**, and pinning without it is a foot-gun: sign the new
  key with the old, or accept both through a grace window. This is also the argument against putting
  the key *in* the URI, self-certifying though that would be — identity has to survive rotation, or
  rotation is impossible.

### Per-user policy, without a user registry

A responder decides at the granularity it can see, which by default is "the database calling me". That
is the granularity any service-account API has, and it is principle 10 one level out: authorization
between databases belongs to the databases, authorization inside one belongs to the application behind
it. A database serving 10,000 users enforces among them itself; its peers cannot and should not.

That is not a ceiling, and raising it does not require anyone to hold anyone else's user list. A
caller may make a claim about *its own* subject — `sub: https://foo.example/users/42` — and the
responder decides whether it accepts that caller's claims about that caller's namespace. That is a
per-database policy, not a per-user one: nobody has to know who user 42 is.

**The rule that keeps this from becoming the untenable case: a database may assert only about subjects
in its own namespace**, checked against the authenticated caller. A claim about
`https://baz.example/users/9` arriving from `foo.example` is refused, because foo is not authoritative
for baz. That one check is the whole difference between speaking about yourself, which is sound at any
scale, and relaying a claim you cannot verify, which is not sound even once.

It is optional and additive, so a responder that does not care ignores it — and it needs no change to
the code. `Policy` is a per-request argument in `ServeOptions`, so an implementation authenticates
first and builds the policy for that caller and subject; `Policy.object` closes over whoever is
asking.

### What authentication does not buy

**It does not stop a reader from re-serving what it read.** A database that reads B's objects and also
answers third parties can pass them on, and nothing in the protocol prevents it — the same position as
any API client holding a service credential. `Cacheability` tells a caller what it may reuse, but that
is advisory and not enforcement. So the honest statement is that a database controls **who it answers,
not what happens next**: if data must not leave the caller, it must not be sent. Signatures are
frequently mistaken for providing this, and they do not.

**It does not make an id a secret.** Local ids are sequential and therefore guessable, and that was
always fine under principle 10. It stops being fine across a boundary, and the answer is the
authorization check, not entropy in the identifier. An unguessable id is not an access control and
should not be mistaken for one.

## What a foreign hop costs the query

**There is no pushdown.** A foreign database will not accept a plan, so it cannot continue a traversal
on the caller's behalf. Each level of foreign traversal is a separate request, separately authorized.

This was decided on cost — a plan is unbounded work chosen by someone else — and it carries the
stronger half of the identity argument for free. A database continuing a traversal on a caller's behalf
would have to either act as itself, making it a confused deputy fetching a third party's data for
someone else, or relay claims to a database that cannot verify them. One decision, two independent
reasons, and the second would have forced it on its own.

So `related()` across a boundary is depth-1 per round trip, and a federated query's latency is linear
in its foreign depth — where a local query's latency is the longest chain of *dependent* reads, with
everything independent batched into one round. That is a semantics change, not only a slower one.

What makes it fit at all is that the query layer already models a store that cannot answer:
`missOwner`, and a stream that ends `short` because it stopped at data its store does not hold. A
foreign hop is one more store that answers `UNKNOWN` and resolves in a later round. What is new is
that the round crosses the internet, so it needs a deadline and a budget of its own, and one
database's query latency becomes partly another's problem.

## The graph is directed and one-sided

This is worth stating plainly because it defines what "the global object graph" actually is.

An edge lives on `id1`'s vshard. A cross-database edge from A to B therefore lives **entirely in A**,
and B does not know it exists. The catalog rule in `global-ids.md` makes this explicit by refusing an
`inverse` on a foreign-capable edge type: delivery routes through the host's own client, scoped to one
database, and retries forever, so writing the other half would mean a host in A holding credentials to
write into B.

The global graph is therefore a web of **outbound** links, like the actual web, and not a symmetric
graph. There is no way to ask B who links to it. If backlinks are ever wanted they are a separate
subscription protocol — B advertises an inbox, A notifies it, B decides whether to store anything —
and that is a different document with a different threat model.

## Type agreement, not type naming

Naming is solved: the catalog already treats a type's name as canonical and its lock integer as a
local encoding, so a cross-database edge carries `issues.issue_comment` and a URI-scoped domain makes
that name globally meaningful with no registry.

What is not solved is agreement. A globally unique type name says nothing about whether the reader
knows that type's shape, and two databases will be on different catalog versions with different field
sets. So the protocol needs a reader to be able to **decline a type it does not understand**, and a
response to carry enough about a type for that decision to be made. The alternative is a reader that
silently mis-reads a payload whose fields moved, which is the failure principle 7 exists to prevent.

## What cannot be revised later

Everything above is a decision. Only these are decisions that someone building against the protocol
would make permanent, and so only these need to be right before it is published.

| Decision | Why it is stuck |
| --- | --- |
| Forbidden distinguishable from absent | Every caller's read path is written around the answer it gets |
| Whether a count is separately authorized | Making it separate later breaks callers that relied on it riding along |
| Cacheability stated in the response | A caller that cached on a guess is already serving stale answers |
| The identity scheme and the rotation story | Changing how a key is discovered or rotated invalidates every pin in existence |
| That the request is a tree and not a plan | Accepting a plan later is easy; refusing one after people send them is not |

Everything else — the limits, the vocabulary, the enforcement model, the alias column, the registry's
columns — is an implementation's own and can move.

## Open

- [x] What a foreign read returns: whole objects, in the normalized form `QueryResult`, which
      design.md already built for "a response leaving the Worker, where a shared object would
      otherwise be duplicated once per path". Ids-only was the alternative and is easier to authorize,
      but it removes most of the point of `related()` over a foreign edge. Field-level policy is
      therefore owed: `Policy.object` is whole-object today.
- [x] The entry is ids, and only ids, bounded by `maxIds` (100). A reference into another database
      *is* an id, so nothing needs more to follow one. Entry by a unique index — "the user with this
      email" — is a separate decision with a larger authorization question behind it, and adding it
      later is additive. `maxIds` is a bound on the entry and **not** a second bound beside
      `maxNodes`: the two multiply, so the entry's width is an input to the price rather than a
      separate cap. See *A request is bounded and priced before it runs*.
- [ ] Building a `Vocabulary` from a projection rather than from the catalog. `vocabularyOf(catalog,
      exposed)` takes a set of edge names, which is enough to serve a boundary but puts the selection
      in a deployment's hands as a list. A projection is the same selection with a name, a hash and a
      plan-time check that it still resolves.
- [ ] The deadline and budget on a foreign round, and what a partial answer looks like in a result
      that today distinguishes only `done` from `short`.
- [ ] Whether a foreign edge's `time` is the source's clock, and what a cursor means across two
      databases that do not share one. A cursor is `(time, id2)` and carries a comparator version;
      neither half is obviously meaningful across a boundary.
- [ ] URI canonicalization, carried over from `global-ids.md`, which the protocol needs settled before
      a pin or an alias means anything.
- [ ] Whether a reference is allowed at all without a mutual handshake, or whether an inbound edge is
      itself a disclosure the target consents to.
- [ ] Whether a request may carry a subject claim at all, and in what form. The own-namespace rule
      above makes one safe to accept, but nothing says a responder must offer per-subject policy, and
      a protocol that defines the field invites callers to send it to databases that ignore it. The
      field is additive either way, so this is a question about when rather than whether.
- [ ] Field-level policy. `Policy.object` decides a whole object, so a database that will serve two
      of an object's five fields cannot say so, and `fields` narrowing in a projection is the shape
      that would express it.
