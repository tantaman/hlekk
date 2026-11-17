import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonical } from "../catalog/catalog.ts";
import type { Lock } from "../catalog/catalog.ts";
import { LocalCluster } from "../client/local.ts";
import type { Id, Json } from "../query/types.ts";
import { deterministic, seeded } from "../runtime/runtime.ts";
import { Query } from "../schema/query.ts";
import { generateGraph, generateQuery, replay } from "./generate.ts";
import type { Script } from "./generate.ts";
import { federate, replaySplit, splitOf } from "./federation.ts";
import { generateSchema } from "./schemas.ts";
import type { Shape } from "./shape.ts";
import { assertSound } from "./invariants.ts";

// The federation oracle: the differential oracle one level up.
//
// The differential oracle says a query across many hosts equals the same query on one host. This says
// a query across many DATABASES equals the same query on one database holding both graphs, after
// mapping ids. Nothing about that is true by construction. The split side crosses a database
// boundary, which means an HTTP request, a wire format, a type-name agreement, a policy, a second
// catalog's integers, and a coordinator that resolves an alias to a URI and routes on it — while the
// control side crosses none of that and reads one engine's own tables.
//
// **The split respects what may not cross.** `splitOf` unions objects joined by `with`, by an edge
// type that cannot be foreign, and by a payload id field, and flips a coin per component. So the
// crossing edges are exactly the ones the catalog permits to cross, which is the point: the oracle
// tests the design's own rules rather than a relaxation of them.
//
// **Times are distinct here.** Storage format 2 orders an edge list `(time, db, id2)`, so at a tie a
// list holding foreign rows puts them ahead of local ones while the same list in one database orders
// purely by id. That is stated in `host/schema.ts` and measured in `scripts/edge-order.mjs`; it means
// a limit cutting a list mid-tie keeps different rows on the two layouts, and no normalization undoes
// that. See `GraphOptions.times`.

const A = "https://a.example/db";
const B = "https://b.example/db";
const C = "https://c.example/db";

/** The lock, with every edge type that CAN be foreign marked as one, and which atypes those are.
 *
 *  Marking them in the single-database control too, so both sides run the same catalog: the flag
 *  changes nothing locally — it only forbids an inverse and a cascade, which these types already
 *  lack — and a comparison between two different catalogs would be comparing the wrong thing. */
function crossable(shape: Shape): { lock: Lock; crossing: Set<number>; fields: boolean } {
  const crossing = new Set<number>();
  const edges: Lock["edges"] = {};
  let fields = true;
  for (const [name, e] of Object.entries(shape.lock.edges)) {
    // A field relationship stores nothing, so it has no atype and nothing to intern — a payload
    // reference carries the URI itself. Marking it foreign is what lets a payload id point out of
    // this database, which is the second of the two places `query/ref.ts` allows a qualified one.
    const may = e.inverse === undefined && e.onDelete !== "cascade";
    edges[name] = may ? { ...e, foreign: true } : e;
    if (may && e.atype !== undefined) crossing.add(e.atype);
    if (!may && e.field !== undefined) fields = false;
  }
  const lock: Lock = { ...shape.lock, edges };
  delete lock.sum; // the flag changed the contents, and the sum is a conflict detector over them
  return { lock, crossing, fields };
}

interface Built {
  control: LocalCluster;
  f: Awaited<ReturnType<typeof federate>>;
  /** position -> control id, and position -> the split's reference for the same object. */
  map: { control: Id[]; split: string[]; local: Id[]; where: string[] };
  root: number;
  rootType: string;
  query: (id: string, depth: number) => Query<never, unknown>;
  crossings: number;
  split: string[];
}

async function fuzzCase(seed: number, databases: readonly string[] = [A, B]): Promise<Built | null> {
  const r = seeded(seed);
  // No inverse pairs and no cascades, so every stored edge type MAY cross. Both are what the
  // catalog refuses `foreign` on, and a schema of mostly paired types is one whose edges mostly
  // cannot cross — which would collapse the split into one database and prove nothing. Inverses and
  // cascades are the differential oracle's ground; crossing is this one's.
  const shape = generateSchema(seeded(seed ^ 0x1f21), {
    types: 3 + r.int(2),
    edges: 5 + r.int(4),
    namespaces: 2,
    pairs: 0,
    onDelete: ["detach"],
  });
  const { lock, crossing, fields } = crossable(shape);
  if (crossing.size === 0 || !fields) return null;

  const script: Script = generateGraph(r, shape, {
    objects: 14 + r.int(8),
    vshards: 3 + r.int(3),
    edges: 18 + r.int(10),
    updates: 3 + r.int(4),
    removes: 1 + r.int(3),
    deletes: 1 + r.int(2),
    times: "distinct",
  });

  // The control: one database holding both graphs.
  // Format 2 on both sides: the control runs the same catalog, foreign flags included, and a
  // format 1 database cannot apply one.
  const control = new LocalCluster({ batch: 64, runtime: deterministic(seed), database: "control", format: 2 });
  control.directory.applyLock(lock);
  control.scatter(3);
  control.spreadCatalog();
  await control.publish();
  const laid = await replay(control.client(), shape, script, () => control.deliverAll());

  // The split: the same script across two databases.
  const split = splitOf(script, crossing, seeded(seed ^ 0x7c3a), databases, { payloadRefsCross: true });
  const f = await federate({
    members: databases.map((uri, i) => ({
      uri,
      lock,
      database: `db${i}`,
      batch: 64,
      runtime: deterministic(seed ^ i),
    })),
  });
  const again = await replaySplit(f, shape, script, split, async () => {
    for (const m of f.members.values()) await m.cluster.deliverAll();
  });
  assert.deepEqual(again.outcomes, laid.outcomes, `seed ${seed}: an operation was refused on one layout and not the other`);

  // How many edges actually crossed. A split that put everything in one database proves nothing.
  let crossings = 0;
  for (const m of f.members.values()) {
    for (const [, host] of m.cluster.hosts) {
      crossings += host.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM assocs WHERE db <> 0")[0]!.n;
    }
  }

  // A root whose type has somewhere to go, so the query is more than a point read.
  const candidates = laid.types.map((t, i) => ({ t, i })).filter(({ t }) => shape.outgoing[t].length > 0);
  if (candidates.length === 0) return null;
  const pick = r.pick(candidates);

  const query = (id: string, depth: number) =>
    generateQuery(seeded(seed ^ 0x9e37), shape, pick.t, shape.types[pick.t].gen(id) as unknown as Query<never, unknown>, {
      depth,
      width: 2,
    });

  return {
    control,
    f,
    map: { control: laid.ids, split: again.refs, local: again.local, where: again.where },
    root: pick.i,
    rootType: pick.t,
    query,
    crossings,
    split,
  };
}

/**
 * An answer with every id replaced by the script position that made it.
 *
 * The two layouts mint their own ids — each database's sequence is its own — so the answers cannot be
 * compared as they are. This is the "after mapping ids" the oracle's contract names. Longest first,
 * because a reference contains a bare id as its suffix and replacing the short one first would leave
 * the prefix behind.
 */
function anonymize(answer: Json, spellings: readonly { id: string; at: number }[]): string {
  const byLength = [...spellings].sort((a, b) => b.id.length - a.id.length);
  let text = canonical(answer);
  // Quoted, because an id is always a string in an answer and a bare one can be a very small
  // decimal: vshard 0 mints ids like "13", and replacing those unquoted rewrote version numbers and
  // numeric payload fields that happened to match. Longest first, because a reference ends with the
  // bare id it qualifies.
  for (const { id, at } of byLength) text = text.split(`"${id}"`).join(`"@${at}"`);
  // The generator's dangling placeholder: an id field whose type had no instance to point at when
  // the payload was made holds "0", which no replay ever fills in. Both layouts spell that
  // correctly and differently — a bare id in one database, and a reference into whichever database
  // holds the object in the split, because a bare payload id IS responder-relative. Position
  // mapping has already run, so a real id of 0 is gone by here.
  text = text.split('"0"').join('"@nowhere"');
  for (const uri of [A, B, C]) text = text.split(`"${uri}#0"`).join('"@nowhere"');
  // A cursor is storage coordinates and not part of what the answer MEANS: it carries the target's
  // alias and its id in its own database, so the same page of the same list has a different cursor
  // once the list holds a foreign row. Whether there IS one is kept, because that says whether the
  // list can be continued. What a cursor over a list in another database should be to an
  // application is open in PLAN.md, and this is where that openness shows.
  return text.replace(/"cursor":"(?:v\d+|t2):[^"]*"/g, '"cursor":"<cursor>"');
}

/**
 * Every spelling an answer read from `home` could carry for each position.
 *
 * A bare id is only unambiguous within one database — two databases mint from their own sequences
 * and the same number exists in both — so the bare spelling is listed only for the database the
 * query was asked of, and everything else by its reference. That asymmetry is not the test's
 * convenience: it is what an answer actually carries, and the reason the foreign client has to make
 * a responder-relative payload id absolute before it reaches the cache.
 */
const spellingsOf = (map: Built["map"], home?: string): { id: string; at: number }[] =>
  home === undefined
    ? map.control.map((id, at) => ({ id, at }))
    : map.local.map((id, at) => ({ id: map.where[at] === home ? id : map.split[at]!, at }));

const run = async (db: { query: Function }, q: Query<never, unknown>) => (await q.run(db as never)) as unknown as Json;

describe("the federation oracle, fuzzed", () => {
  // Depth 1: one hop, which is the whole of what step 4 builds — follow an edge into another
  // database and bring back the objects it points at. A query that then keeps going inside that
  // database is Milestone B, and the test below pins that it is refused by name rather than answered
  // short.
  it("answers a query at depth across two databases as one database holding both graphs would", async () => {
    let checked = 0;
    let crossed = 0;
    let answered = 0;
    let both = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const built = await fuzzCase(seed);
      if (!built) continue;
      const { control, f, map, root, rootType, query, crossings } = built;

      const expected = anonymize(await run(control.client(), query(map.control[root]!, 3)), spellingsOf(map));
      const home = f.member(map.where[root]!);
      // The split's ids are its own, and an object in the other database is named by a reference, so
      // both spellings map to the same position: either is what an answer could carry.
      const got = anonymize(await run(home.db, query(map.local[root]!, 3)), spellingsOf(map, map.where[root]!));

      assert.equal(
        got,
        expected,
        `seed ${seed}: a query from ${rootType} at position ${root} answered differently once the graph was split` +
          ` across two databases (${crossings} crossing edges)`,
      );

      for (const m of f.members.values()) assertSound(m.cluster, { quiesced: true });
      crossed = Math.max(crossed, crossings);
      if (crossings > 0) both++;
      if (expected !== "[]" && expected !== "[null]") answered++;
      checked++;
    }
    assert.ok(checked >= 18, `expected most seeds to produce a case, got ${checked}`);
    assert.ok(crossed >= 3, `edges have to actually cross the boundary, saw at most ${crossed}`);
    assert.ok(both >= checked / 2, `most cases should cross, got ${both} of ${checked}`);
    assert.ok(answered > checked / 2, `most answers should hold rows, got ${answered} of ${checked}`);
  });

  // Three, so a read can leave A for B and leave B for C — and the coordinator asks C itself rather
  // than B asking on its behalf. Cycles come free: the generated graph is not acyclic, and a split
  // by component puts edges back and forth across every pair.
  it("answers the same across three databases, cycles included", async () => {
    let checked = 0;
    let spread = 0;
    for (let seed = 301; seed <= 318; seed++) {
      const built = await fuzzCase(seed, [A, B, C]);
      if (!built) continue;
      const { control, f, map, root, query, crossings } = built;
      const expected = anonymize(await run(control.client(), query(map.control[root]!, 3)), spellingsOf(map));
      const got = anonymize(await run(f.member(map.where[root]!).db, query(map.local[root]!, 3)), spellingsOf(map, map.where[root]!));
      assert.equal(got, expected, `seed ${seed}: a query over three databases disagreed (${crossings} crossing edges)`);
      spread = Math.max(spread, new Set(map.where).size);
      checked++;
    }
    assert.ok(checked >= 12, `expected most seeds to produce a case, got ${checked}`);
    assert.ok(spread === 3, `the graph has to actually land in three databases, saw ${spread}`);
  });

  it("gives the same answer under both drivers when the query crosses a boundary", async () => {
    let crossed = 0;
    for (let seed = 101; seed <= 115; seed++) {
      const built = await fuzzCase(seed);
      if (!built) continue;
      const { f, map, root, query, crossings } = built;
      const home = f.member(map.where[root]!);
      const ids = spellingsOf(map, map.where[root]!);
      const plan = () => query(map.local[root]!, 3);
      assert.equal(
        anonymize((await plan().run(home.db, { driver: "rounds" })) as unknown as Json, ids),
        anonymize((await plan().run(home.db, { driver: "async" })) as unknown as Json, ids),
        `seed ${seed}: the two drivers disagreed across a database boundary`,
      );
      crossed = Math.max(crossed, crossings);
    }
    assert.ok(crossed >= 3, `edges have to cross, saw at most ${crossed}`);
  });

  // What **the query riding inside one database** buys: the coordinator sends a frame's subtree as
  // hops, so the responder's own engine does the traversal below the objects it was asked for. A
  // traversal of depth n inside one database therefore costs one request rather than n.
  it("asks a database once per dependent level and not once per hop", async () => {
    let deepest = 0;
    for (let seed = 401; seed <= 430; seed++) {
      const built = await fuzzCase(seed);
      if (!built) continue;
      const { f, map, root, query, crossings } = built;
      if (crossings === 0) continue;
      const home = f.member(map.where[root]!);
      const away = [...f.members.values()].find((m) => m.uri !== home.uri)!;
      away.served.read = 0;
      await run(home.db, query(map.local[root]!, 3));
      // One request would be the floor: the first level that needs the other database. Each further
      // level that DEPENDS on what came back is another, because the coordinator cannot ask for what
      // it does not yet know the ids of. What it must not be is one per hop per object.
      if (away.served.read > 0) {
        assert.ok(
          away.served.read <= 4,
          `seed ${seed}: ${away.served.read} requests to one database for a depth-3 query, which is per-hop and not per-level`,
        );
        deepest = Math.max(deepest, away.served.read);
      }
    }
    assert.ok(deepest > 0, "some query has to have reached the other database at all");
  });
});
