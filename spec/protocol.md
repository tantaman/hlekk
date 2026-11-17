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
  cross-database graph is outbound links.
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

### 4.2 The vocabulary

`GET {db}/vocabulary` returns the [vocabulary](schemas/vocabulary.json): every type this database
exposes, with its fields, and every edge a request may traverse.

What a database **exposes** **MAY** be narrower than what it holds. A type it does not expose is a
type a request cannot name and an answer cannot contain.

A type name is not an agreement about shape. A caller **SHOULD** compare the vocabulary's fields with
its own declaration of the same names, and **SHOULD** decline a type it cannot read through — for
example one for which it declares a required field the responder does not expose. A caller **MUST
NOT** guess at a field an answer does not carry.

## 5. Reading

### 5.1 A request is a tree

A read request is a **tree**: a hop holds its children. An implementation **MUST NOT** accept a
request that names a frame by index, and **MUST NOT** accept one that can express a cycle.

A responder **MUST** refuse a request carrying a member this specification does not define, at the
request, at a hop, at a filter or at a count. Ignoring one would leave a caller unable to tell
whether what it sent took effect.

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

A responder **MUST NOT** sign a response. TLS and the key pin carry it, which means a proxy in the
path is trusted as the origin is; this is a stated choice rather than an omission.

### 7.3 Keys, pinning and rotation

- A database **SHOULD** publish exactly one current key. A key's `id` **MUST** be the base64url
  SHA-256 of the key itself, so an id is a fact about a key and not a claim.
- A caller **MUST** record the key a database proved on first contact (a **pin**), and on later
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
  A caller **MUST NOT** clear a repudiation automatically.
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
| `401` | A signature was presented and could not be verified |
| `403` | The caller is verified and this database will not serve it, or its pin is repudiated here |
| `404` | Not one of this database's routes |
| `405` | Not a method this route takes |
| `413` | The body is over the stated cap |
| `500` | This database failed |

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
