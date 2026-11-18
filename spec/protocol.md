# The hlekk cross-database read protocol, version 1

This is the normative specification. It says what an implementation must do to be one.

[`../docs/protocol.md`](../docs/protocol.md) is the rationale: why the protocol has this shape, what
was considered and rejected, and which decisions cannot be revised once anyone has built against
them. Where the two appear to disagree, this document is what an implementation is held to and that
one is what it is for.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD
NOT**, **RECOMMENDED**, **MAY** and **OPTIONAL** are to be interpreted as described in
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174),
when and only when they appear in capitals.

The shape of every body is given by a JSON Schema in [`schemas/`](schemas/), and those schemas are
normative. [`fixture/`](fixture/) is a published catalog, graph and policy table an implementation
loads in order to be tested; `scripts/conformance.mjs` in this repository checks an implementation
against both.

## 1. What this protocol is

One database answers another database's **read**. That is all of it.

- **Reads only.** There is no operation that writes, and there will not be one in version 1. The
  cross-database graph is outbound links. A **hint** (§11) asks a database to look at one of the
  caller's own edges; it writes nothing, and whatever that database then records is an outbound link
  of its own, made from what it read.
- **Object-granular.** A caller addresses objects and edges. Where they live — which host, which
  shard, which region — is not the caller's to know, and telling it would also be telling it when
  that changes.
- **No forwarding.** A database **MUST NOT** fetch from a third database on a caller's behalf
  (§7.4). The caller is the hub: it asks B, and if B's answer carries a reference into C it asks C
  itself.

## 2. Identifiers

### 2.1 The database URI

A database is identified by an absolute URI. That URI is its identity: two databases with different
URIs are different databases, and a database that comes to answer at a URI another database used to
answer at is, to everyone holding a reference into it, a different database (§8.4).

A **canonical** database URI:

- **MUST** have scheme `https`, in lowercase. An implementation **MAY** accept `http` when the host
  is a loopback host, for development, and **MUST NOT** accept it otherwise.
- **MUST** have a host, lowercase, with internationalized names as A-labels, and **MUST NOT** have a
  trailing dot.
- **MUST NOT** carry userinfo.
- **MUST NOT** state a port when it is the scheme's default. It **MAY** state any other port.
- **MUST** have a path with no empty, `.` or `..` segment, and no trailing slash. The path **MAY** be
  empty.
- **MUST** spell percent-escapes in uppercase, and **MUST NOT** escape an unreserved character
  (RFC 3986 §6.2.2.2).
- **MUST NOT** carry a query or a fragment.
- **SHOULD** be at most 512 characters. An implementation **MUST** state its own limit if it is
  shorter, and **MUST** refuse a URI over its limit rather than truncating one.

An implementation **MUST** refuse a URI that is not canonical, and **MUST NOT** repair one. Where a
canonical spelling of the same resource exists, the refusal **SHOULD** name it.

> Why refuse rather than repair: a URI is a key in the registry that maps it to a local alias, so two
> spellings of one database become two aliases and nothing notices. Draining that in one direction
> only — a caller is told what to send and sends it — is the whole of the fix.

### 2.2 The reference

A **reference** is either a local id or a canonical database URI, `#`, and that database's own local
id:

```
281474976710691
https://db.example/wiki#281474976710691
```

A local id **MUST** be an unsigned 64-bit integer below 2^63, written as a bare decimal with no
leading zeros.

A canonical database URI carries no fragment (§2.1), so the first `#` in a reference is
unambiguously the separator. An implementation **MUST** split there, and **MUST NOT** treat a
percent-escaped `#` inside the path as a separator.

**In an answer** (§5.4): every id is relative to the database that answered, and every reference into
any other database is absolute. A caller **MUST** read a bare id in an answer — including one inside
an object's payload — as an object in the database that answered it, and **MUST NOT** resolve it
against itself.

## 3. Transport

Every route is served under the database URI.

| Route | Method | Request | Response |
| --- | --- | --- | --- |
| `{db}` | `GET` | — | [descriptor](schemas/descriptor.json) |
| `{db}/vocabulary` | `GET` | — | [vocabulary](schemas/vocabulary.json) |
| `{db}/read` | `POST` | [read request](schemas/read-request.json) | [read response](schemas/read-response.json) |
| `{db}/price` | `POST` | [read request](schemas/read-request.json) | [price response](schemas/price-response.json) |
| `{db}/hint` | `POST` | [hint](schemas/hint-request.json) | [hint response](schemas/hint-response.json), with `202` |

`{db}/hint` is **OPTIONAL** (§11). Every other route is **REQUIRED**.

- Every request and response body **MUST** be JSON, with `Content-Type: application/json`.
- A responder **MUST** answer `405` with an `Allow` header for a method a route does not take, and
  `404` for a path that is not one of its routes.
- A responder **MUST NOT** redirect. A caller **MUST NOT** follow a redirect: a database that moved
  is a different database.
- A responder **MUST** state a maximum request body size in its descriptor, **MUST** answer `413` for
  a body over it, and **MUST** decide that before parsing the body.
- A responder **MUST** serve its descriptor without requiring authentication. Verifying it would
  need the key it carries.

## 4. The descriptor and the vocabulary

### 4.1 The descriptor

`GET {db}` returns the [descriptor](schemas/descriptor.json). A caller reads it before it sends
anything.

- `database` **MUST** be the canonical URI this database answers at. A caller **SHOULD** check it
  against the URI it meant to reach, and **SHOULD** refuse an answer from a database that names a
  different one.
- `wire` **MUST** list every wire version this database speaks. A caller **MUST NOT** send a request
  it cannot read the answer to.
- `limits` **MUST** state every limit in the schema. A caller **SHOULD** clamp its requests to them
  rather than being refused.
- `keys` **MUST** be present. An empty list means this database authenticates nobody (§7.1), which a
  caller **MUST** be able to tell from a database that does and did not say so.
- `routes` **MUST** state `read`, `price` and `vocabulary`, each as the route §3 gives it. It
  **MUST** state `hint` where this database takes hints and **MUST NOT** state it where it does not
  (§11.1), so that a caller can tell the two apart without sending anything.

### 4.2 The vocabulary

`GET {db}/vocabulary` returns the [vocabulary](schemas/vocabulary.json): every type this database
exposes, with its fields, and every edge a request may traverse.

What a database **exposes** **MAY** be narrower than what it holds. A type it does not expose is a
type a request cannot name and an answer cannot contain.

A type name is not an agreement about shape. A caller **SHOULD** compare the vocabulary's fields with
its own declaration of the same names, and **SHOULD** decline a type it cannot read through — for
example one for which it declares a required field the responder does not expose. A caller **MUST
NOT** guess at a field an answer does not carry.

### 4.3 Discovery

The vocabulary is enough to read a database nobody described, from one id.

Every edge states the type it starts at and the type it lands on, so the edges a caller may hang
under an object are the ones whose `from` is that object's type — and the object's type is in the
answer (§5.4). `counted` says whether a count may be asked for; `foreign`, where a responder states
it, says the hop may leave this database. A responder **MUST** state `from`, `to` and `counted` for
every edge it exposes, and **SHOULD** state `foreign`.

A responder **MUST** refuse a hop whose edge does not start at the type its parent hop lands on
(§5.1), so a caller that builds its tree this way is told when it is wrong instead of being handed an
empty list it cannot interpret.

There is **no entry point but ids** (§5.3). A responder **MUST NOT** offer a way to enumerate the
objects of a type: it would be an unbounded scan, and it would disclose the shape of a graph a policy
may be hiding. Discovery therefore starts from a reference the caller already holds, and goes
anywhere from there.

## 5. Reading

### 5.1 A request is a tree

A read request is a **tree**: a hop holds its children. An implementation **MUST NOT** accept a
request that names a frame by index, and **MUST NOT** accept one that can express a cycle.

A responder **MUST** refuse a request carrying a member this specification does not define, at the
request, at a hop, at a filter or at a count. Ignoring one would leave a caller unable to tell
whether what it sent took effect.

A responder **MUST** refuse a hop whose edge does not start at the type its parent hop lands on. Such
a hop can only ever return nothing, and a caller cannot tell that nothing from a true empty list — so
answering it is answering a question the caller did not ask.

A hop directly under the request's `ids` **cannot** be checked this way and **MUST NOT** be refused
on these grounds: the entry is ids, an id does not carry its type, and `ids` may hold objects of more
than one type. A responder **MUST NOT** read storage in order to find out, because a request is
priced and refused before any I/O (§5.2).

### 5.1.1 The names a caller chooses

A hop's result appears under its `as`, or under its edge's name where it gives none. A count's
appears under its `as`, or under the edge name it was written as.

Within one level of a request, every such name **MUST** be distinct, counting hops and counts
together, and a responder **MUST** refuse a request where two collide. A responder **MUST** also
refuse a name of `id`, or one beginning with `$`: a row carries `id`, `$version` and `$edge` beside
its payload, and `id` in particular is what the normalized form keys every object, list and count by.

> Why this is a refusal and not a precedence rule: a count and a hop over one edge default to the
> same name, and naming them that way is the first thing a caller working from the vocabulary does.
> Letting the later one win returns an empty list beside a count saying it is not empty — which is
> the shape that makes a wrong answer look like a right one.

### 5.2 A request is priced before it runs

A responder **MUST** be able to compute a request's cost from its text, before any storage is read,
and **MUST** refuse a request whose cost exceeds what it will spend.

`{db}/price` **MUST** return the same cost that `{db}/read` reports for the same request, and **MUST
NOT** read any storage to produce it.

> Why: a chain of hops materializes the product of its limits, so the answer is exponential in depth
> while storage reads stay flat. A budget on reads, requests or rounds never fires, and nothing about
> the I/O reveals it.

### 5.3 The entry is ids

A request enters from `ids`, which **MUST** be bare local ids of the database answering, and **MUST**
hold at least one. A responder **MUST** refuse a member of `ids` that is not an id, and **MUST NOT**
let one reach its storage.

The width of the entry is part of the price: a responder **MUST** price a request for the number of
ids it enters from, not for one.

### 5.4 The answer

A read response is the normalized form: every object once with its version, and the structure
separately. See [`schemas/read-response.json`](schemas/read-response.json).

- Every key of `objects` **MUST** be a bare local id of the database answering. A responder **MUST
  NOT** place an object for any other database there, and a caller **MUST** refuse an answer that
  does.
- An object's `type` **MUST** be a type name. A responder **MUST NOT** send a catalog integer: those
  are allocated per database and mean nothing to a caller.
- An object's `data` **MUST** carry only fields the responder exposes for that type.
- A member of a list **MAY** be a reference into another database (§6).
- A caller **MUST NOT** keep anything from an answer that it did not ask for.

### 5.5 Paging

A list in an answer carries `cursor` and `more`. A caller continues it by sending the `cursor` back
as a hop's `after`.

A cursor is **opaque to the caller**. A caller **MUST NOT** construct one, **MUST NOT** parse one,
and **MUST NOT** continue a list from anything but a cursor that database gave it.

> Why: a responder drops rows its policy hides, so the last row the caller can see is not where the
> list resumes. The rows in between are exactly the ones that were removed.

### 5.6 Cacheability

Every read response **MUST** state its own cacheability. A caller **MUST NOT** keep an answer whose
`reuse` is `never`, **MAY** keep one marked `caller` for its own use for the stated seconds, and
**MAY** keep one marked `public` for any caller for the stated seconds.

A responder **MAY** also set `Cache-Control`. Where it does, the header **MUST** agree with the body;
the body is normative.

## 6. References a responder does not follow

A database answering a read **MUST NOT** follow a reference out of itself.

Where a read reaches one, the responder **MUST** include the reference in the list that reached it
and **MUST NOT** place an object for it in `objects`. It **MUST NOT** attach a list or a count below
it: it holds neither, and an empty one would read as "that database has nothing" rather than "ask
it".

A filter **MUST NOT** drop a reference. The responder cannot judge an object it does not hold, so the
reference passes through undecided and the caller, which can follow it, judges.

A caller that wants what is behind a reference **MUST** ask that database itself.

## 7. Identity

### 7.1 The anonymous caller

A request carrying none of the signature headers in §7.2 is the **anonymous caller**. That is not an
error: a responder's policy decides what an anonymous caller gets, and a database serving public data
authenticates nobody.

A request carrying some but not all of them **MUST** be refused. Otherwise removing a header is a
downgrade, and a caller that cannot sign would get a different answer by deleting one than by forging
one.

A responder that verifies no signatures **MUST** publish no key (§4.1) and **MUST** refuse a request
that presents one, rather than reading it as anonymous. A caller that presented a credential has to
learn that nobody checked it. A caller **SHOULD NOT** sign a request to a database whose descriptor
publishes no key.

### 7.2 Signing a request

A signed request carries four headers:

```
Hlekk-Caller: https://notes.example/db
Content-Digest: sha-256=:<base64>:
Signature-Input: hlekk=("@method" "@target-uri" "content-digest" "hlekk-caller");created=<n>;keyid="<id>";alg="ed25519"
Signature: hlekk=:<base64>:
```

This is a **restricted profile** of [RFC 9421](https://www.rfc-editor.org/rfc/rfc9421). An
implementation:

- **MUST** cover exactly the four components above, in that order, and **MUST** refuse a
  `Signature-Input` that covers any other set, in any other order, or under any other label.
- **MUST** use `ed25519` and **MUST** refuse any other `alg`.
- **MUST** compute `Content-Digest` as RFC 9530 specifies, over the request body's **bytes**.
- **MUST** build the signature base as RFC 9421 §2.5 specifies over those components, and **MUST**
  verify against the bytes received rather than against a re-serialization of a parse.
- **MUST** refuse a `created` outside an accepted window around its own clock, and **SHOULD** accept
  no more than 300 seconds of skew either way.
- **MUST** refuse a `Hlekk-Caller` that is not a canonical database URI (§2.1).

> Why the restriction: RFC 9421 lets a signer choose what it covers, and a verifier that accepts the
> signer's choice accepts a signature over nothing much. Every component a verifier lets a signer
> drop is one an attacker may drop, and every algorithm it accepts is one an attacker may choose.

A responder **MUST NOT** sign a response in version 1. TLS authenticates the responding origin.
A proxy that terminates TLS is trusted to serve the response.

### 7.3 Keys, pinning and rotation

A descriptor pin detects changes in the keys an origin advertises. An operator with control
of that origin can copy the old public descriptor. Only the caller proves possession of its
private key, through a signed request.

- A database **SHOULD** publish exactly one current key. A key's `id` **MUST** be the base64url
  SHA-256 of the key itself.
- A caller **MUST** record the current key a database publishes on first contact (a **pin**), and on later
  contact **MUST** accept the database only if it publishes the pinned key or a key reachable from it
  through rotation signatures. The pin then advances to the key reached.
- A rotated key **MUST** carry `signedBy`: the id of the key it replaces, and that key's signature
  over the new one. The message signed **MUST** be
  `"hlekk-key-rotation" LF alg LF key`, which is domain-separated from the signature base in §7.2 so
  that neither signature can be presented as the other.
- A retired key **SHOULD** stay published through a grace window, so that a caller which has not
  looked recently can still walk forward from its pin.
- Where a database publishes no key reachable from the pin, a caller **MUST** treat the pin as
  **repudiated**: every read through that reference **MUST** fail by name, and **MUST NOT** resolve.
  A caller **MUST NOT** clear a repudiation automatically. Discovery errors are retryable and leave the pin intact.
- A responder **MAY** record a caller's key. It **SHOULD** record a caller only where its policy
  distinguishes that caller; anyone else is verified and forgotten.

### 7.4 No database acts for another

A database **MUST NOT** make a request to a third database on a caller's behalf, under its own
identity or any other. Combined with §6, this means the many hops of a federated read are many graph
edges and not many trust hops: there is no delegation chain, and no claim about a third party's user
to pass along.

## 8. Refusals

A refusal body is [`schemas/refusal.json`](schemas/refusal.json).

| Status | When |
| --- | --- |
| `400` | The request is wrong: a name the vocabulary does not have, a cost over budget, a member this specification does not define, a body that is not JSON, a signature presented to a database that verifies none |
| `401` | A signature was presented and could not be verified, or a route that requires one (§11.2) was sent none |
| `403` | The caller is verified and this database will not serve it, or its pin is repudiated here |
| `404` | Not one of this database's routes |
| `405` | Not a method this route takes |
| `413` | The body is over the stated cap |
| `429` | The request was acceptable and this caller has sent more than this database will take from it now |
| `500` | This database failed |
| `503` | The request was acceptable and this database is not taking requests now, from anyone |

A `429` or `503` **MUST** carry `Retry-After`, as a whole number of seconds and not as a date. A
caller **SHOULD NOT** repeat the request before then. Every other status in this table is about the
request, and repeating it unchanged gets the same answer; these two are about the moment.

> Why two: a `429` is a reason for this caller to slow down and a `503` is not a reason for it to
> think it did anything. A responder with only `400` to reach for teaches its callers to retry at
> once, because a `400` cannot say "later".

A `400`, `401`, `403` or `413` **SHOULD** carry `at`: a path into the submitted request, so a caller
can correct the part that was wrong instead of retrying blind.

A `500` **MUST NOT** say anything about the failure beyond that there was one. A stranger learns that
this database broke, not how.

**Forbidden is indistinguishable from absent.** A responder **MUST NOT** let a caller tell an object
its policy hides from one that does not exist, and this **MUST** hold transitively: an object
reachable only through a hidden one **MUST NOT** appear in an answer either, because had the hidden
one genuinely been absent the engine would never have gathered what is under it.

**A count is separately authorized.** A responder **MAY** serve an object and refuse its count. Where
it refuses one, the count **MUST** be absent rather than zero.

## 9. Versioning

- Every response body carries `v`, the wire version. Version 1 is this document.
- A responder **MUST** list in `wire` every version it speaks, and **MUST** answer in the version it
  received, or refuse.
- A new **required** member of any body, a change to the meaning of an existing one, and a change to
  §7.2's covered components or algorithm each require a new wire version.
- A new **optional** member of a body does not require a new version, but a responder **MUST** refuse
  a request member it does not know (§5.1), so a caller **MUST NOT** send one to a responder that has
  not advertised the version that defines it.

## 10. Security considerations

- **A URI is an instruction to make a request.** A reference is written by whoever writes the edge, so
  a caller resolving one is being told to connect somewhere. An implementation on a platform that can
  reach a private network **MUST** refuse a database URI resolving to a non-public address, and
  **SHOULD** check every address the name resolves to rather than the first. This does not close the
  gap between the check and the connection, which only a resolving HTTP client can.
- **A caller must bound what a hop costs it.** A caller **SHOULD** apply a deadline, a cap on
  response bytes, a limit on requests and a limit on how many databases one read may reach. One
  tenant's query latency is otherwise another tenant's to decide.
- **A responder must bound what a request costs it** (§5.2). Nothing about the I/O reveals the cost
  of a deep request, so a responder that budgets reads rather than answer nodes has no budget.
- **A responder's answer is untrusted input.** A caller **MUST** validate it against §5.4 rather than
  trusting its shape, **MUST** refuse an object key that is not the responder's own, and **MUST NOT**
  keep what it did not ask for.
- **A local id is not a secret.** Ids are sequential and therefore guessable. Entropy in an
  identifier is not an access control, and this protocol does not pretend otherwise: §8's policy is.
- **Replay inside the skew window is possible and harmless to correctness.** A read applies nothing.
  It is not harmless to cost, so a responder **MAY** refuse a repeated signature.
- **The descriptor is unauthenticated** (§3). Its trustworthiness on first contact is TLS and the
  domain's; afterwards it is the pin's (§7.3).
- **A hint is an instruction to make a request too** (§11). It is bounded by being signed — the
  request it causes goes to the database that asked for it, and to no database a third party chose —
  and by being looked at off the request path, under a quota per caller. A responder **SHOULD** ask
  its own policy whether it would record anything before it reads anybody.
- **A recorded edge is true, not endorsed.** An edge a database drew says something about what that
  database thinks; an edge it recorded from a hint says only that a stranger's database linked to
  it, and anyone can run a database. A reader following one is following a link a stranger chose,
  into a database a stranger runs, and everything above about a responder's answer applies to what
  it finds there.

## 11. Hints

A cross-database edge lives in the database that drew it, so the database it points at does not know
it exists. A **hint** is how it may be told:

> My object `source` may have an edge `edge` to your object `target`. A read of me will say.

It is the one request in this protocol that is not a read, and it is not a write. Nothing in it is
recorded. What a database does about one is read (§5), and what it records, if anything, is what
that read showed.

Taking hints is **OPTIONAL**. This section binds a database that takes them and a caller that sends
them.

### 11.1 The route

A database that takes hints **MUST** state `routes.hint` in its descriptor (§4.1), and its value
**MUST** be `{db}/hint`. One that does not take them **MUST NOT** state it and **MUST** answer `404`
there, as for any path that is not one of its routes. A caller **MUST NOT** send a hint to a database
whose descriptor does not state the route.

A database that verifies no signatures (§7.1) **MUST NOT** take hints.

### 11.2 The request

`POST {db}/hint` carries a [hint](schemas/hint-request.json):

```json
{ "source": "281474976710691", "edge": "notes.note_about", "target": "562949953421317" }
```

- `source` **MUST** be a bare local id (§2.2) of the **calling** database.
- `edge` **MUST** be the name of an edge type in the calling database's vocabulary: the edge a read
  of `source` hops to reach the reference.
- `target` **MUST** be a bare local id of the **answering** database.

A hint says *look*, not *this exists*. A caller sends the same hint when it draws the edge and when
it withdraws it, and the read is what tells them apart.

- A hint **MUST** be signed as §7.2 specifies. A responder **MUST** refuse one that carries no
  signature, with `401`, and **MUST NOT** read it as the anonymous caller.
- A responder **MUST** refuse a hint signed as itself.
- A responder **MUST** refuse a hint carrying a member this specification does not define, for the
  reason §5.1 gives.

> Why `source` is a bare id and not a reference: a database may speak only about its own objects, and
> a hint is an instruction to go and read whoever it names. Were `source` a reference, any database
> could aim the answering one at a third of its choosing, and the rule that it must not would be a
> check somebody has to remember. As a bare id of the caller, it cannot be said.
>
> Why a signature is required here and nowhere else: the anonymous caller is a caller for a read
> because a read is answered and that is the end of it. A hint is answered and then *acted on* — by a
> request to the caller's database — so "who is the caller" is not a question about policy but about
> where that request goes.

### 11.3 The answer

A responder that takes the hint **MUST** answer `202` with a
[hint response](schemas/hint-response.json).

`202` means *received*. It does not mean the target exists, that the responder will look, or that it
would record anything if it did.

- The answer **MUST NOT** depend on whether `target` exists, on whether the caller may see it, or on
  what the responder's policy would do with the hint. It is decided from the request alone: its
  size, its signature and its shape. A hint that answered differently for an object a read would
  hide is the way around §8.
- A responder **MUST NOT** read the calling database before it answers, beyond what verifying the
  signature requires (§7.2). The claim is looked at afterwards.
- A responder **MAY** drop a hint it accepted, at any time and without saying so. A caller **MUST
  NOT** take `202` to mean an edge was recorded.
- A responder **MAY** answer `429` or `503` (§8), and where it does it **MUST** decide that without
  regard to `target`.

### 11.4 What a responder does with one

- A responder **MUST NOT** record anything on the strength of a hint. What it records it **MUST**
  have read from the calling database: a read (§5) entering from `source`, hopping `edge`, whose
  answer lists the reference `{db}#{target}` — this database's own URI and that id.
- That read **MUST** go to the database that signed the hint, and to no other.
- Where the read succeeds and lists the reference, the responder **MAY** record that the edge
  exists. Where it succeeds and does not — including where `source` is not in the answer at all,
  which §8 makes the same thing — the responder **MUST NOT** record it, and **SHOULD** stop serving
  an edge it recorded from an earlier hint for the same `source`, `edge` and `target`.
- Where the read does **not** succeed — the caller cannot be reached, it refuses, its pin is
  repudiated (§7.3), or its list is longer than the responder will page through (§5.5) — the
  responder **MUST NOT** record anything and **SHOULD NOT** remove anything. A failure is not an
  answer.
- What a responder records, it serves as it serves any reference it holds (§6): in a list, under an
  edge its vocabulary states with `foreign` true (§4.3), as the reference `{caller}#{source}`, with
  no object behind it. A caller reads it with §5 as it stands. **No answer says whether an edge was
  drawn or recorded**; a responder **SHOULD** therefore record under edge types of its own, distinct
  from the ones it draws itself, so that its vocabulary says which is which.
- A responder that will serve a recorded edge to callers other than itself **SHOULD** make the
  checking read as the anonymous caller (§7.1). It then serves only what anyone could have read from
  the calling database themselves. One that reads as itself may be shown an edge the public is not,
  and nothing in this protocol stops it passing that on.

**Sending a hint is consent to record the edge.** §5.6 lets a caller keep an answer for the seconds
its responder states, and a recorded edge is kept for longer than that. A database that sends a hint
permits the answering database to keep the one fact the hint is about — that an edge from `source`
to `target` exists — until a later read says otherwise, whatever the checking read's `reuse` says.
It permits nothing else: every other part of that read's answer is kept or not as §5.6 says.

### 11.5 Sending one

- A caller **MUST NOT** send a hint except about an edge it holds, or held: a hint tells the
  answering database that the edge exists, which is the caller's to disclose and nobody else's.
- A caller **MAY** give up on a hint at any point, and is never required to retry one. A responder
  that did not hear of an edge does not record it, and nothing that was true has become false.
- A caller **SHOULD** send the hint again when it withdraws the edge.

> Why a hint may be lost and an edge may not: an edge is written in one database by its own client,
> and either was or was not. Telling another database about it is a second act, toward a server that
> may be down for a week, and making the first wait on the second is how one database's outage
> becomes another's.
