# hlekk

A graph database you can run yourself, and a protocol that lets two of them be read in one query.

An object has a type and a JSON payload. Edges between objects are stored once per direction, ordered
newest first, and counted. A query is a tree of hops from objects you already hold. Nothing about
where the data sits appears in the API: the engine spreads a database over as many hosts as it needs
and moves vshards between them while reads continue.

What makes it more than one more graph store is that an edge may point **into another database**:

```ts
// In the notes database. The target is a reference, not an id.
await notes.assocAdd(noteAbout, note, "https://wiki.example/db#281474976710691");

// And one query brings the page back from the wiki.
const [row] = await Note.gen(note).related("about", noteAbout).run(notes);
row.about[0].title; // "Country"
```

The two databases are run by different people, on different machines, under different policies. The
query crosses the boundary over HTTP, and the wiki decides what the notes database may see.

Try the [incident-to-release experiment](examples/incident-release/README.md). Give an agent one incident reference, let it follow the link to a maintainer’s Postgres release record, then repeat with the maintainer offline.

## Where things are

| | |
| --- | --- |
| [`spec/protocol.md`](spec/protocol.md) | The normative specification. What an implementation must do to be one |
| [`spec/schemas/`](spec/schemas/) | JSON Schemas for every body, normative |
| [`spec/fixture/`](spec/fixture/) | A catalog, graph and policy table to be tested against |
| [`docs/design.md`](docs/design.md) | The engine: why it is built this way, and what was rejected |
| [`docs/protocol.md`](docs/protocol.md) | The protocol's rationale, and what cannot be revised |
| [`docs/global-ids.md`](docs/global-ids.md) | How a reference into another database is stored and named |
| [`PLAN.md`](PLAN.md) | What is done and what is not |

The documents are the point. Every decision that was hard is written down with the reading or the
argument that settled it, and the ones still open are listed as open.

## Running one

For local and hosted walkthroughs, see the [Cloudflare Durable Objects, Rivet, and celld deployment examples](examples/README.md).

```bash
npm install
node src/adapters/node/serve.ts --dir ./my-database --port 8080 --path /db
```

That is a whole database: a directory of SQLite files, one process, and the protocol on a port. No
account anywhere. The two platform seams the Cloudflare adapter fills — a Durable Object's SQLite and
a published shard map — become files, and everything above them is the same code.

```bash
curl http://127.0.0.1:8080/db            # the descriptor: versions, keys, limits
curl http://127.0.0.1:8080/db/vocabulary # the types and edges it exposes
```

A second one of these, on another machine, with an edge drawn at its URI, is a federation.

It also runs on Cloudflare Workers and Durable Objects — `src/adapters/cloudflare/` and the
`wrangler.*.jsonc` configs — which is where the Wikimedia demo in [`docs/wikimedia-demo.md`](docs/wikimedia-demo.md)
lives.

## Checking an implementation

```bash
npm test                      # the suite
npm run test:formats          # and again on the older storage format
npm run conformance:fixture   # the conformance suite, against the published fixture
npm run conformance -- <uri>  # or against any database serving the protocol
```

`scripts/conformance.mjs` imports nothing from `src/`. A suite that shared code with the
implementation under test would be checking that the implementation agrees with itself.

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
