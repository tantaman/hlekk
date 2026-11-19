# hlekk

A graph database you can run yourself, and a protocol that lets two of them be read in one query.

Hlekk is Old Norse for a chain link. An object has a type and a JSON payload. Edges between objects
are stored once per direction, ordered newest first, and counted. A query is a tree of hops from
objects you already hold. Nothing about where the data sits appears in the API: the engine spreads a
database over as many hosts as it needs and moves vshards between them while reads continue.

What makes it more than one more graph store is that an edge may point **into another database**:

```ts
// In the notes database. The target is a reference, not an id.
await notes.assocAdd(noteAbout.atype, note, "https://wiki.example/db#281474976710691");

// And one query brings the page back from the wiki.
const [row] = await Note.gen(note).related("about", noteAbout).run(notes);
row.about[0].title; // "Country"
```

The two databases are run by different people, on different machines, under different policies. The
query crosses the boundary over HTTP, and the wiki decides what the notes database may see.

Enough of these, each linking into the others, is a structured internet. A database is a site, an
object is a page with a type and declared fields, an edge is a link with a name, and a reference
(`<database URI>#<id>`) is the address of one object. Whoever holds a reference can read the object,
learn its type, see which edges leave it, and follow them into databases nobody told them about.
Nothing is scraped and nothing is inferred, because every database states its own vocabulary.

## Status

Version 0.1.0. Wire version 1 of the protocol has a [normative specification](spec/protocol.md) and
a conformance suite, and this repository is the reference implementation. It is not on npm yet, so
work from a checkout. It needs Node.js 22.18 or later and has no runtime dependencies; the examples
are written against Node.js 24. [`PLAN.md`](PLAN.md) lists what is built, what is not, and what is
still open.

## If you are an agent

This README is written to be executed, and the steps are in the order you need them:
[run a database](#1-run-one), [give it your own types](#2-give-it-your-own-types),
[read it](#3-read-it), [link it to someone else's](#4-link-it-to-someone-elses),
[host it](#5-host-it) and [check it](#6-check-it). The rules the commands do not show:

- **Entry is by reference.** No route lists the objects of a type and there is no search. Keep every
  id you mint, or key it with a unique index, and start every read from a reference you hold.
- **Ids are decimal strings, and they belong to whoever answered.** A bare id in an answer, including
  one inside a payload, is an object in the database that answered. Never resolve it against your own.
- **You are the hub.** A database never follows a reference out of itself. When a list holds
  `<database URI>#<id>`, split at the first `#` and ask that database yourself. The
  [reader](#from-a-program) does exactly that for you, within a budget.
- **Ask the database what it is before you ask it anything else.** `GET {db}` states its limits and
  `GET {db}/vocabulary` states its types, their fields and where each edge starts and lands. Build
  requests from those and not from what you expect to be there.
- **A refusal is a correction.** `error` says what was wrong and `at` says where in your request.
  Fix that part instead of retrying.
- **Empty is not unreachable.** A `200` with no object means absent or hidden, and the two are
  indistinguishable on purpose. A failed connection means you could not ask. Report them differently.
- **A cursor is opaque.** Send a list's `cursor` back as the hop's `after`. Never build or parse one.
- **A short page is not the end.** A filtered list reads at most its share of the database's
  `maxScan` (the price's `scan`) and stops there, so it can come back short of its limit, or empty,
  with `more: true`. Continue it with `after` rather than reading it as the end.
- **A URI is permanent.** A database's URI is its identity, recorded the first time its storage is
  opened and refused if it ever changes. Choose the name before you hand out a reference.
- **Anything mounted is public.** Reads need no credential by default and no protocol route writes.
  Put nothing in a served database that you would not publish, and keep its data directory and
  operator token to yourself.
- **An object is its publisher's claim.** Cite the reference each statement came from, and keep what
  a database said apart from what you inferred from it.

## 1. Run one

```bash
git clone https://github.com/tantaman/hlekk.git
cd hlekk
npm ci
node src/adapters/node/serve.ts --dir .local/first --port 8080 --path /db
```

That is a whole database: a directory of SQLite files, one process, and the protocol on a port. No
account anywhere. From a second terminal:

```bash
curl http://127.0.0.1:8080/db
curl http://127.0.0.1:8080/db/vocabulary
```

The first is the descriptor: wire versions, limits, the database's public key and its routes. The
second is the vocabulary, which is empty, because this database has no types yet. Stop it with
Ctrl-C before the next step, which uses the same port.

## 2. Give it your own types

Writes are not part of the protocol. They go through your own client, in the one process that owns
the directory, so a database with a shape is a short script. Save this as `notes.mjs` in the root of
the checkout:

```js
// A whole database: a schema, two notes, an edge between them, and the protocol on a port.
import { open } from "./src/adapters/node/database.ts";
import { listen } from "./src/adapters/node/http.ts";
import { plan } from "./src/catalog/catalog.ts";
import { formatRef } from "./src/query/ref.ts";

// The schema, by domain. Every name is `<domain>.<name>`, and `plan` assigns the integers.
const lock = plan({
  notes: {
    objects: { "notes.note": { fields: { title: "string", body: "string" } } },
    edges: {
      "notes.cites": { from: "notes.note", to: "notes.note" },
      // `foreign` lets a target live in another database.
      "notes.about": { from: "notes.note", to: "ops.incident", foreign: true },
    },
  },
  // A type this database points at and does not hold: the name, and no fields.
  ops: { objects: { "ops.incident": { fields: {} } } },
});

const store = await open({ dir: ".local/notes", lock });
const server = await listen(store.binding, { path: "/db", port: 8080 });

// A unique index is how a script finds its own objects again, since nothing lists a type.
// The index number is yours to choose. Keys compare without regard to case.
const BY_SLUG = 1;
if (!store.cluster.directory.indexVshards().length) {
  store.cluster.openIndexVshards(1);
  await store.cluster.publish();
}
const Note = store.catalog.objectNamed("notes.note").otype;
const note = async (slug, title, body) =>
  (await store.db.lookupUnique(BY_SLUG, slug)) ??
  (await store.db.createUnique(BY_SLUG, slug, Note, { title, body }));

const first = await note("first", "Duplicate deliveries", "Seen after the Relay 3.7.2 rollout.");
const second = await note("second", "Follow-up", "Checking the acknowledgement deadline.");
await store.db.assocAdd(store.catalog.edgeNamed("notes.cites").atype, second, first);

// The target of a foreign edge is a reference: <database URI>#<id>.
const about = process.argv[2];
if (about) await store.db.assocAdd(store.catalog.edgeNamed("notes.about").atype, first, about);

console.log(`Database:  ${server.database}`);
console.log(`Reference: ${formatRef(server.database, second)}`);
```

```bash
node notes.mjs
```

It prints the database URI and a reference to the second note, and keeps serving. Run it again and
the ids are the same: the lookup finds the notes, and an edge that already exists is not added twice.

- **Fields** are `"string"`, `"number"`, `"boolean"`, `"json"`, `{ enum: [...] }`, `{ id: "<type>" }`
  for an id held in the payload, or `{ optional: <spec> }`.
- **Edges** are stored, ordered by time and counted. `unique: true` makes one to-one, and
  `inverse` with `maintained: true` on the derived half keeps a pair in step.
- **Changing the schema** is `plan(domains, previousLock)`, which keeps every integer already assigned
  and raises the version. `open` applies a lock only when its version is ahead of what the directory
  holds, so keep the lock in a file beside your domain definitions and plan from it.
- **One process per directory.** The process that serves is the process that writes.

[`examples/incident-release/incidents.mjs`](examples/incident-release/incidents.mjs) is the same
pattern in thirty lines, and [`releases.mjs`](examples/incident-release/releases.mjs) shows the other
way to publish: the protocol in front of a Postgres view you already have, with no hlekk storage.

## 3. Read it

This is the whole interface a stranger gets, and it is the one to use on any database you are handed
a reference into. Split the reference at its first `#`:

```bash
REF='PASTE_THE_REFERENCE_THAT_notes.mjs_PRINTED'
DB=${REF%%#*}
ID=${REF#*#}
```

| Route | Method | What it tells you |
| --- | --- | --- |
| `{db}` | `GET` | The descriptor: wire versions, limits, keys, routes |
| `{db}/vocabulary` | `GET` | Every type with its fields, and every edge with where it starts and lands |
| `{db}/read` | `POST` | Objects by id, and the edges under them, as a tree of hops |
| `{db}/price` | `POST` | What that same request would cost, without reading any storage |

```bash
curl -fsS "$DB/vocabulary"
```

```json
{"v":1,"catalog":1,
 "types":{"notes.note":{"fields":{"title":{"type":"string","optional":false},"body":{"type":"string","optional":false}}},
          "ops.incident":{"fields":{}}},
 "edges":{"notes.cites":{"from":"notes.note","to":"notes.note","counted":true,"foreign":false},
          "notes.about":{"from":"notes.note","to":"ops.incident","counted":true,"foreign":true}}}
```

A read enters from ids and names the edges to follow. A hop may hold its own `hops`, and takes `as`,
`limit`, `after`, `where` and `counts`:

```bash
curl -fsS --json "{\"ids\":[\"$ID\"],\"counts\":[{\"as\":\"cited\",\"edge\":\"notes.cites\"}],\"hops\":[{\"edge\":\"notes.cites\"}]}" "$DB/read"
```

```json
{"v":1,
 "roots":["9710886696517632"],
 "objects":{
   "9710886696517632":{"type":"notes.note","version":1,"data":{"title":"Follow-up","body":"Checking the acknowledgement deadline."}},
   "9429411719806976":{"type":"notes.note","version":1,"data":{"title":"Duplicate deliveries","body":"Seen after the Relay 3.7.2 rollout."}}},
 "lists":{"1:9710886696517632":{"ids":["9429411719806976"],"cursor":"v2:1795010130453:0:9429411719806976","more":false,"edges":[{"time":1795010130453,"data":null}]}},
 "counts":{"0:9710886696517632":{"cited":1}},
 "shape":{"0":{"notes.cites":1},"1":{}},
 "cost":{"frames":2,"nodes":26},
 "cache":{"reuse":"public","seconds":60}}
```

The answer is normalized. `objects` holds every object once, with its type name and version. `lists`
holds the structure, keyed `<frame>:<parent id>`, and `shape` says which of your names leads to which
frame. `cache` says whether you may keep the answer and for how long. Send the same body to
`$DB/price` to learn the cost before you spend it.

When a request is wrong, the refusal says where. A count and a hop over one edge take the same name
unless one of them says `as`, which is why the count above does:

```json
{"error":"counts[0]: \"notes.cites\" is already the \"notes.cites\" hop, and one answer cannot be both","at":"counts[0]"}
```

[`spec/protocol.md`](spec/protocol.md) is the full contract, and [`spec/schemas/`](spec/schemas/)
has a JSON Schema for every body.

### From a program

The same reads without building requests by hand. A reader is a client with no database behind it:
it meets each database by its descriptor and vocabulary, sends each one the part of a request it can
answer, and follows references into whichever database they name. Save this as `read.mjs` beside
`notes.mjs`:

```js
// Reads other people's databases from a program that runs none.
import { connect } from "./src/adapters/node/reader.ts";

const ref = process.argv[2];
// `allowLoopback` because these databases are on this machine. Without it a reader refuses any
// address that is not public, which is what you want when the references come from strangers.
const db = await connect(ref.slice(0, ref.indexOf("#")), { allowLoopback: true });
console.log("from a note you may follow:", db.edgesFrom("notes.note").join(", "));

const read = db.reader
  .from(ref)
  .countAs("cited", "notes.cites")
  .related("cites", "notes.cites", (cites) => cites.related("about", "notes.about"));

const [note] = await read.run();
const [cited] = note.cites.items;
console.log(`${note.$type} "${note.title}" cites ${note.cited}: "${cited.title}"`);
for (const about of cited.about.items) console.log(`  about ${about.$type} ${about.id}\n  ${JSON.stringify(about.ticket)}`);
console.log("as data:", JSON.stringify(read.request()));
```

```bash
node read.mjs "$REF"
```

```
from a note you may follow: notes.cites, notes.about
notes.note "Follow-up" cites 1: "Duplicate deliveries"
as data: {"counts":[{"as":"cited","edge":"notes.cites"}],"hops":[{"edge":"notes.cites","as":"cites","hops":[{"edge":"notes.about","as":"about"}]}]}
```

- **A read is data.** `read.request()` is the body `POST {db}/read` takes, without its `ids`: the
  same hops, counts, filters and limits, under the same rules, and a mistake in one is refused with
  its place in the request. `db.reader.read(ref, request)` runs one directly, so a read can be
  stored, sent, or written by something else. The chained form writes that request and can say
  nothing it cannot. The one member that does not travel is `after`: a cursor goes back to whoever
  returned the page, so a reader's continues a read on a reader and a database's continues one on
  that database, and each refuses the other's.
- **A row is the object's fields beside `id`, `$type` and `$version`.** `id` is always a full
  reference. A hop comes back as a page: `{ items, cursor, more }`.
- **Nothing is declared.** Each database is read by its own vocabulary, so one request may name edges
  from several. A caller that does have a lock passes it, and queries built with `hlekk/schema` then
  run against the reader as they would against a database: `Type.gen(ref).related(...).run(reader)`.
- **A read is bounded.** A deadline, a number of requests and a number of databases, per read. A
  database that cannot be reached fails the read by name, or is left out and reported with
  `{ omit: { databases: {}, references: [] } }`.

The reader itself is [`src/reader/`](src/reader/reader.ts) and runs wherever `fetch` does. The entry
point above is the Node one, which adds the check that keeps a reference from leading into a
private network.

## 4. Link it to someone else's

Start a second database, run by somebody else as far as yours is concerned. The incident example's
downstream publisher is one more Node process and needs nothing else:

```bash
cd examples/incident-release
npm ci
npm run incidents -- 'http://127.0.0.1:8461/releases#742'
```

It prints an incident reference. Back in the root of the checkout, stop `notes.mjs` and start it
again with that reference, which draws the `notes.about` edge at it:

```bash
node notes.mjs 'PASTE_THE_INCIDENT_REFERENCE'
```

Now read two hops from the second note:

```bash
curl -fsS --json "{\"ids\":[\"$ID\"],\"hops\":[{\"edge\":\"notes.cites\",\"hops\":[{\"edge\":\"notes.about\"}]}]}" "$DB/read"
```

The first note's `notes.about` list holds `http://127.0.0.1:8460/incidents#…` and `objects` has no
entry for it. Your database stored the link and does not speak for what is behind it. Ask the
database that does:

```bash
INCIDENT='PASTE_THE_INCIDENT_REFERENCE'
curl -fsS --json "{\"ids\":[\"${INCIDENT#*#}\"],\"hops\":[{\"edge\":\"ops.deployed_release\"}]}" "${INCIDENT%%#*}/read"
```

That answer carries the incident and one more reference, into a release maintainer's database.

Or let the reader be the hub. The request in `read.mjs` has not changed, and it now crosses into the
second database:

```bash
node read.mjs "$REF"
```

```
from a note you may follow: notes.cites, notes.about
notes.note "Follow-up" cites 1: "Duplicate deliveries"
  about ops.incident http://127.0.0.1:8460/incidents#…
  "INC-217"
as data: …
```

The release maintainer's database is a third publisher, serving a Postgres view. The
[incident-to-release experiment](examples/incident-release/README.md) starts it, hands a fresh agent
nothing but the incident reference, and then takes the maintainer offline to see what the agent can
still support.

A reference can be written before the database behind it exists, and a link is allowed to dangle. The
engine's own client can also follow a foreign edge inside one query, as the snippet at the top does;
[`src/adapters/node/federation.test.ts`](src/adapters/node/federation.test.ts) is that, over real
sockets.

## 5. Host it

| Where | What it takes | Walkthrough |
| --- | --- | --- |
| Any machine with Node.js | A directory, a port, and TLS in front | Below |
| Cloudflare Workers and Durable Objects | A Cloudflare account and Wrangler | [`examples/README.md`](examples/README.md#cloudflare-durable-objects) |
| Rivet | A Rivet Cloud cluster, the OpenOrange CLI and Docker | [`examples/README.md`](examples/README.md#rivet) |
| celld | A celld node and an S3 bucket | [`examples/README.md`](examples/README.md#celld) |

**On your own machine.** A public database URI must be `https`, so terminate TLS in a reverse proxy
or tunnel and forward the database's path to the port. The listener binds loopback unless told
otherwise. Give the database its public name the first time its directory is opened, with
`uri: "https://notes.example/db"` in `open(...)`, or on the command line:

```bash
node src/adapters/node/serve.ts --dir /var/lib/hlekk/notes --port 8080 --path /db --uri https://notes.example/db
```

The descriptor then names `https://notes.example/db`, and so does every reference you hand out. A
directory first opened on loopback keeps its loopback URI and refuses any other, so a local
experiment is not promoted to a public database: start a fresh directory under the real name. That
directory also holds the database's private signing key. Back it up and keep it private.

**On an actor platform.** The three platform examples deploy the same
[wiki Worker](examples/wiki/wiki-app.ts) as it stands: SQLite-backed hosts, a directory object, the
shard map in KV, operator routes behind a token, and the protocol mounted at `/db`. Each walkthrough
runs locally first and then deploys. A Worker for your own types is modelled on that file and on
[`examples/wiki/wiki.ts`](examples/wiki/wiki.ts), which declares its schema.

Before a URI goes to anyone who will draw an edge at it, read the deployment notes in
[`CONTRIBUTING.md`](CONTRIBUTING.md#deploying). Handing one out is the step that cannot be taken back.

## 6. Check it

```bash
npm run conformance -- http://127.0.0.1:8080/db
```

That is the conformance suite against any database serving the protocol, yours or anyone's.
`scripts/conformance.mjs` imports nothing from `src/`. A suite that shared code with the
implementation under test would be checking that the implementation agrees with itself.

```bash
npm test                      # the suite
npm run test:formats          # and again on the older storage format
npm run conformance:fixture   # the conformance suite, against the published fixture
```

## Where things are

| | |
| --- | --- |
| [`spec/protocol.md`](spec/protocol.md) | The normative specification. What an implementation must do to be one |
| [`spec/schemas/`](spec/schemas/) | JSON Schemas for every body, normative |
| [`spec/fixture/`](spec/fixture/) | A catalog, graph and policy table to be tested against |
| [`examples/`](examples/README.md) | The deployments, and the [incident-to-release experiment](examples/incident-release/README.md) |
| [`docs/design.md`](docs/design.md) | The engine: why it is built this way, and what was rejected |
| [`docs/protocol.md`](docs/protocol.md) | The protocol's rationale, and what cannot be revised |
| [`docs/global-ids.md`](docs/global-ids.md) | How a reference into another database is stored and named |
| [`docs/wikimedia-demo.md`](docs/wikimedia-demo.md) | The Wikimedia demo on Cloudflare Durable Objects: what it is and what was measured |
| [`src/reader/`](src/reader/reader.ts) | The standalone client: reads across databases from a process that runs none |
| [`src/adapters/`](src/adapters/) | The two adapters: Node.js over files, and Cloudflare Workers with Durable Objects |
| [`PLAN.md`](PLAN.md) | What is done and what is not |

The documents are the point. Every decision that was hard is written down with the reading or the
argument that settled it, and the ones still open are listed as open.

To use the engine from another project, build the checkout and install it by path. The package
exports `hlekk`, `hlekk/schema`, `hlekk/catalog`, `hlekk/protocol`, `hlekk/reader`,
`hlekk/adapters/node`, `hlekk/adapters/cloudflare` and `hlekk/testkit`.

```bash
npm run build                                  # in the checkout
npm install /path/to/hlekk                     # in your project
```

## What it does not do

- **Cross-database writes, inverses and cascades.** Reads only, and that is a decision rather than a
  gap: delivery routes through a host's own client, which is scoped to one database and never gives
  up, so writing the other half of a cross-database edge would mean holding credentials to write into
  someone else's database inside a path with no give-up. A target database that wants a backlink
  subscribes; it does not get written into.
- **Backlinks across databases.** A subscription protocol with its own threat model.
- **A global directory of databases.** A URI is the name and DNS arbitrates it. Discovery is not
  identity.
- **Many databases in one deployment.** One deployment serves one database, by decision rather than
  by accident — a Durable Object's env comes from the deployment that defines its namespace, so a
  Worker holding two names gets one set of hosts and not two databases. What that gives up is
  density; what it keeps is separate namespaces, separate limits, and a blast radius of exactly one.
- **A permission model above the engine.** Principle 10 keeps the engine's caller trusted, which
  holds inside one database owned by one application — which is the arrangement above — and would be
  false the moment arbitrary agents created databases and linked between them. `docs/global-ids.md`
  says so plainly; it is the principle the design would actually break, and the answer here is not to
  break it.

## Two defaults worth knowing

- **A mounted database is publicly readable.** The protocol exists so a database can be read by
  another, and one that answers nothing is not participating in it, so that is where a responder
  starts and it narrows from there — a `Policy` per request, and a projection over what it exposes at
  all. What makes it safe is that **mounting the handler is the act of exposure**: a database that
  exists and is not mounted is reachable by nobody. `src/query/serve.ts` records the one thing that
  would invert that argument.
- **Writes are nobody's but yours.** There is no write operation in the protocol and there is not
  going to be one. Writing is your own client, inside your own deployment, behind whatever you
  already have.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md), which is mostly about how a protocol change is proposed —
because once someone has built against this, some of it cannot be revised at all.

## Licence

[Apache-2.0](LICENSE), for the patent grant a standard's reference implementation wants.
