# The conformance fixture

A small catalog, graph and policy table. An implementation under test loads these **by its own
means** — there is no protocol for writing, and there is not going to be one
([`../protocol.md`](../protocol.md): the cross-database graph is reads only) — and then serves the
result. `scripts/conformance.mjs` checks what a black box can show about it.

## What to load

- [`catalog.json`](catalog.json) is a hlekk lock. An implementation that is not this one needs the
  three object types and three edge types it declares, under exactly those names: names are what
  cross the wire, and the integers in the file are this engine's own encoding of them.
- [`graph.json`](graph.json) lists objects by name, then the edges between them. Load them in the
  order given; the `time` on each edge is the sort key its list is read by, and the suite relies on
  the order that produces.
- `graph.json`'s `foreignEdges` hold a reference into a database nobody runs. A URI is mintable
  before the database behind it exists, so this is a legal edge and a read of it must list the
  reference and have no object for it.
- `graph.json`'s `policy` is what the implementation must enforce. Three rules, each the smallest
  that makes one protocol property observable from outside; each carries its own `why`.

## What to report

Ids are minted by the implementation, so the suite cannot know them. Write a **manifest**: a JSON
object mapping each name in `graph.json` to the id that implementation gave it, plus the database
URI it is serving at.

```json
{
  "database": "https://example.test/db",
  "ids": { "root": "281474976710656", "visible-a": "281474976710657" }
}
```

Then:

```bash
node scripts/conformance.mjs <database URI> --fixture <path to the manifest>
```

Without `--fixture` the suite runs the checks that need no data at all — a cost is arithmetic over
the request's text, and a refusal happens before any I/O — which is what makes those runnable against
a live database without being told what is in it.

## Loading it into this implementation

```bash
npm run conformance:fixture
```

which opens a database in a temporary directory, loads the fixture, serves it on a free port, writes
the manifest and runs the suite against it.
