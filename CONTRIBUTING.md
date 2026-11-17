# Contributing

## The short version

```bash
npm install
npm run typecheck
npm run test:formats          # the suite, on both storage formats
npm run conformance:fixture   # the conformance suite against the published fixture
```

All three have to pass. `npm test` alone runs one storage format; both have to pass, because a
database created before the format changed still has to answer everything a new one does.

## What a change to this repository looks like

**Write down why.** The documents under [`docs/`](docs/) are the point of this repository as much as
the code is. A change that settles something records the reading or the argument that settled it, and
an alternative that was considered and rejected is recorded as considered and rejected rather than
left out. Where a figure appears, say how it was measured; the scripts under
[`scripts/`](scripts/) that print the figures are checked in for that reason.

**A comment says why, not what.** The code says what. A comment that restates the line above it is
noise; a comment that says which failure the line prevents is the reason anyone can change it later.

**Every claim is executable.** A proposal that nothing applies rots: `src/host/schema.foreign.ts` was
DDL nothing issued, with tests to keep it valid, and it still went stale in two places before it
shipped. Prefer a test to a paragraph.

**Keep a refusal loud.** The engine's recurring choice is to fail with a reason rather than to answer
something nearly right. A qualified reference reaching a key conversion throws; a host opened at the
wrong storage format refuses; a URI that is not canonical is refused rather than repaired; a database
that answers with the wrong key is repudiated. If a change makes one of those quieter, it needs an
argument.

## Changing the protocol

[`spec/protocol.md`](spec/protocol.md) is what an implementation other than this one is held to, so
changing it is not the same kind of change as the rest.

1. **Check whether it can be changed at all.** [`docs/protocol.md`](docs/protocol.md) has a section
   called *What cannot be revised later*, and [`PLAN.md`](PLAN.md) has a table of decisions that
   became permanent at a named step. Those are not difficult to change; they are impossible to
   change once anyone has built against them. A proposal to revise one has to say who is relying on
   the current behaviour and what happens to them.
2. **Say which kind of change it is.** Adding an optional member of a response body is additive.
   Adding a required one, changing what an existing one means, or touching the covered components or
   algorithm in §7.2 is a new wire version — see §9.
3. **Change the schema and the spec together.** [`spec/schemas/`](spec/schemas/) is normative, and
   `src/protocol/schemas.test.ts` holds this implementation to it. A schema change with no
   corresponding spec paragraph, or the reverse, will fail that test or be caught in review.
4. **Grow the conformance suite.** A property worth specifying is a property an implementation other
   than this one can be checked for. If the change makes a new property observable from outside, add
   the check to `scripts/conformance.mjs`; if it needs data to be observable, add it to
   [`spec/fixture/`](spec/fixture/) and say in that README what a loader must do with it.
5. **Keep the suite independent.** `scripts/conformance.mjs` and `scripts/lib/` import nothing from
   `src/`. A suite that shared code with the implementation under test would be checking that the
   implementation agrees with itself.

## Changing storage

There are two storage formats and there is no in-place upgrade between them — see the header of
[`src/host/schema.ts`](src/host/schema.ts) for the readings that decided that. A third format would
need the same treatment: its own statements, a recorded fact in the directory, a host that refuses to
open when the two disagree, and the whole suite passing under it.

`scripts/edge-order.mjs` and `scripts/id-width.mjs` print the figures those decisions rest on, from
SQLite's own query plans and page counts. Re-run them rather than quoting them.

## Tests

The suite is `node --test` over `src/**/*.test.ts`. Four kinds of test carry most of the weight, and
a change to the engine usually belongs in one of them rather than in a new file:

- **The differential oracle** (`src/testkit/oracle.test.ts`): a query across many hosts equals the
  same query on one. Random schemas, random graphs, random queries, from a seed.
- **The federation oracle** (`src/testkit/federation-oracle.test.ts`): a query across many
  *databases* equals the same query on one database holding both graphs, after mapping ids. It found
  two real bugs while being written, which is the argument for it.
- **The invariants** (`src/testkit/invariants.ts`): what must be true of a whole cluster whatever was
  done to it. Run after anything that writes.
- **The simulation** (`src/testkit/sim.test.ts`): one seeded schedule, everything at once, because
  the bugs that matter live between the phases a staged test imposes.

A failing seed is a reproduction: the seed is the whole of the input.

## Deploying

Nothing in this repository deploys itself, and the operator routes on the demo Workers are closed
behind `HLEKK_ADMIN_TOKEN` and refuse everything while it is unset. `src/worker/app.ts` has no gate
at all: it is a local harness and must not be deployed as it stands.

Before any database URI is handed out to someone who will draw an edge at it, read
[`PLAN.md`](PLAN.md)'s gate for the step that deploys it. A URI is an identity, and handing one out
is the one thing that cannot be taken back.
