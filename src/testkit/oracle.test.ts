import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonical } from "../catalog/catalog.ts";
import { LocalCluster } from "../client/local.ts";
import { vshardOf } from "../host/ids.ts";
import type { Id, Json } from "../query/types.ts";
import { deterministic, seeded } from "../runtime/runtime.ts";
import type { Random } from "../runtime/runtime.ts";
import { Query } from "../schema/query.ts";
import { generateGraph, generateQuery, replay } from "./generate.ts";
import type { Script } from "./generate.ts";
import { FIXED } from "./schema.ts";
import { generateSchema } from "./schemas.ts";
import type { Shape } from "./shape.ts";

/** The oracle's contract, from the design: a query across many hosts must equal the same query
 *  against one host that holds every vshard.
 *
 *  `hosts` is how many the database starts spread over, which decides where the script's own writes
 *  go. A database on one host writes every inverse edge inline and routes nothing, so a workload laid
 *  down there and only afterwards moved apart has never crossed a host while writing. */
async function cluster(seed: number, shape: Shape, hosts = 1): Promise<LocalCluster> {
  const c = new LocalCluster({ batch: 64, runtime: deterministic(seed) });
  c.directory.applyLock(shape.lock);
  if (hosts > 1) c.scatter(hosts);
  c.spreadCatalog();
  await c.publish();
  return c;
}

/** Spreads a script's vshards further by moving them, which is how a real database gets there. The
 *  ids do not change, so the answers must not either. */
async function spread(c: LocalCluster, script: Script, r: Random, hosts: number): Promise<number> {
  for (const vshard of script.vshards) {
    const v = BigInt(vshard);
    const from = c.directory.resolve(v)!.host;
    let to = r.int(hosts);
    if (to === from) to = (from + 1) % hosts; // so every listed vshard actually moves
    c.mover.begin(v, to);
    await c.mover.run(v);
  }
  c.spreadCatalog();
  await c.publish();
  await c.deliverAll();
  // How many hosts the script's own vshards ended up on. A one-host answer would prove nothing.
  return new Set(script.vshards.map((v) => c.directory.resolve(BigInt(v))!.host)).size;
}

interface Case {
  script: Script;
  shape: Shape;
  root: Id;
  rootType: string;
  query: () => Query<never, unknown>;
  /** Hosts that accepted one of the script's creates. */
  wrote: number;
  /** Inverse edges that travelled through the outbox rather than being written inline. */
  carried: number;
}

interface Built {
  one: LocalCluster;
  many: LocalCluster;
  hosts: number;
  c: Case;
}

/** Builds one case: a graph laid down twice, once on a single host and once over several, and a query
 *  over a root the graph actually made. */
async function fuzzCase(seed: number, shape: Shape = FIXED): Promise<Built | null> {
  const r = seeded(seed);
  const script = generateGraph(r, shape, {
    objects: 20 + r.int(12),
    vshards: 3 + r.int(5),
    edges: 24 + r.int(16),
    updates: 4 + r.int(6),
    removes: 2 + r.int(6),
    deletes: 1 + r.int(4),
  });

  const one = await cluster(seed, shape);
  const laid = await replay(one.client(), shape, script, () => one.deliverAll());

  // A root whose type has somewhere to go, or the query would be a point read.
  const candidates = laid.types.map((t, i) => ({ t, i })).filter(({ t }) => shape.outgoing[t].length > 0);
  if (candidates.length === 0) return null;
  const pick = r.pick(candidates);
  const root = laid.ids[pick.i];

  const many = await cluster(seed, shape, 3);
  let carried = 0;
  const again = await replay(many.client(), shape, script, async () => {
    carried += await many.deliverAll();
  });
  assert.deepEqual(again.ids, laid.ids, `seed ${seed}: replaying one script twice must hand out the same ids`);
  assert.deepEqual(
    again.outcomes,
    laid.outcomes,
    `seed ${seed}: an operation was refused on one layout and accepted on the other`,
  );
  const wrote = new Set(laid.ids.map((id) => many.directory.resolve(vshardOf(id))!.host)).size;
  const hosts = await spread(many, script, seeded(seed ^ 0x5bf0), 6);

  const query = () => generateQuery(seeded(seed ^ 0x9e37), shape, pick.t, starter(shape, pick.t, root), { depth: 3, width: 2 });
  return { one, many, hosts, c: { script, shape, root, rootType: pick.t, query, wrote, carried } };
}

const starter = (shape: Shape, type: string, id: Id) => shape.types[type].gen(id) as unknown as Query<never, unknown>;

const answer = async (c: LocalCluster, q: Query<never, unknown>, driver: "async" | "rounds") =>
  canonical((await q.run(c.client(), { driver })) as unknown as Json);

describe("the differential oracle, fuzzed", () => {
  it("gives the same answer across six hosts as on one, over 40 random graphs and queries", async () => {
    let checked = 0;
    let spreadOver = 1;
    let wroteAcross = 1;
    let carried = 0;
    let answered = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const built = await fuzzCase(seed);
      if (!built) continue;
      const { one, many, hosts, c } = built;
      const expected = await answer(one, c.query(), "async");
      const got = await answer(many, c.query(), "async");
      assert.equal(
        got,
        expected,
        `seed ${seed}: a query from ${c.rootType} ${c.root} answered differently once its vshards moved apart`,
      );
      spreadOver = Math.max(spreadOver, hosts);
      wroteAcross = Math.max(wroteAcross, c.wrote);
      carried += c.carried;
      if (expected !== "[]" && expected !== '[null]') answered++;
      checked++;
    }
    assert.ok(checked >= 50, `expected most seeds to produce a case, got ${checked}`);
    assert.ok(spreadOver >= 3, `the graphs have to actually span hosts, saw at most ${spreadOver}`);
    assert.ok(wroteAcross >= 3, `the writes have to span hosts too, saw at most ${wroteAcross}`);
    assert.ok(carried > 0, "and some inverse edge has to have crossed one, or the outbox is untested");
    assert.ok(answered > checked / 2, `most answers should hold rows, got ${answered} of ${checked}`);
  });

  it("gives the same answer under both drivers, over 25 random graphs and queries", async () => {
    for (let seed = 101; seed <= 125; seed++) {
      const built = await fuzzCase(seed);
      if (!built) continue;
      const { many, c } = built;
      assert.equal(
        await answer(many, c.query(), "rounds"),
        await answer(many, c.query(), "async"),
        `seed ${seed}: the two drivers disagreed`,
      );
    }
  });

  it("gives the same answer with a vshard fenced mid-move, over 25 random graphs", async () => {
    for (let seed = 201; seed <= 225; seed++) {
      const built = await fuzzCase(seed);
      if (!built) continue;
      const { one, many, c } = built;
      const expected = await answer(one, c.query(), "async");

      // Fence every vshard the root's data could be in. Reads continue through a fence: a move stops
      // writes for the length of the copy, not reads.
      for (const [index, host] of many.hosts) {
        for (const vshard of many.directory.vshardsOn(index)) host.setState(vshard.toString(), "fenced");
      }
      assert.equal(await answer(many, c.query(), "async"), expected, `seed ${seed}: a fence changed a read`);
    }
  });

  it("gives the same answer to a query whose root moved after it was first read", async () => {
    for (let seed = 301; seed <= 320; seed++) {
      const built = await fuzzCase(seed);
      if (!built) continue;
      const { one, many, c } = built;
      const expected = await answer(one, c.query(), "async");
      const client = many.client();
      await c.query().run(client); // warms the route cache

      // Move the root's vshard out from under the warm cache.
      const vshard = vshardOf(c.root);
      const from = many.directory.resolve(vshard)!.host;
      const to = from === 7 ? 8 : 7;
      many.mover.begin(vshard, to);
      await many.mover.run(vshard);
      many.spreadCatalog();

      assert.equal(await answer(many, c.query(), "async"), expected, `seed ${seed}: a stale route changed a read`);
    }
  });
});

describe("the differential oracle over generated schemas", () => {
  it("gives the same answer across hosts as on one, over 30 schemas it has never seen", async () => {
    let checked = 0;
    let carried = 0;
    const shapes = new Set<string>();
    for (let seed = 1001; seed <= 1030; seed++) {
      const shape = generateSchema(seeded(seed ^ 0x1234));
      shapes.add(canonical(shape.lock));
      const built = await fuzzCase(seed, shape);
      if (!built) continue;
      const { one, many, c } = built;
      assert.equal(
        await answer(many, c.query(), "async"),
        await answer(one, c.query(), "async"),
        `seed ${seed}: a query over a generated schema answered differently once its vshards moved apart`,
      );
      carried += c.carried;
      checked++;
    }
    assert.ok(checked >= 25, `expected most seeds to produce a case, got ${checked}`);
    assert.equal(shapes.size, 30, "every seed should produce its own schema");
    assert.ok(carried > 0, "and inverse edges have to have crossed a host somewhere in them");
  });

  it("produces schemas with every edge kind the catalog allows", () => {
    const seen = { inverse: 0, cascade: 0, detach: 0, unique: 0, field: 0, namespaces: 0, self: 0 };
    for (let seed = 1; seed <= 80; seed++) {
      const { lock } = generateSchema(seeded(seed));
      const spaces = new Set(Object.keys(lock.objects).map((n) => n.split(".")[0]));
      if (spaces.size > 1) seen.namespaces++;
      for (const e of Object.values(lock.edges)) {
        if (e.inverse !== undefined) seen.inverse++;
        if (e.onDelete === "cascade") seen.cascade++;
        if ((e.onDelete ?? "detach") === "detach") seen.detach++;
        if (e.unique) seen.unique++;
        if (e.field !== undefined) seen.field++;
        if (e.from === e.to) seen.self++;
      }
    }
    for (const [what, n] of Object.entries(seen)) assert.ok(n > 0, `no generated schema had ${what}`);
  });
});

describe("the generators", () => {
  it("replay the same script to the same ids, which is what makes the oracle comparable", async () => {
    const script = generateGraph(seeded(9), FIXED, { objects: 12, vshards: 4, edges: 10, deletes: 3, updates: 3 });
    const a = await cluster(9, FIXED);
    const b = await cluster(9, FIXED, 4);
    const first = await replay(a.client(), FIXED, script, () => a.deliverAll());
    const second = await replay(b.client(), FIXED, script, () => b.deliverAll());
    assert.deepEqual(second.ids, first.ids);
    assert.deepEqual(second.outcomes, first.outcomes);
  });

  it("produce graphs that actually span vshards, or the oracle would prove nothing", async () => {
    const script = generateGraph(seeded(11), FIXED, { objects: 24, vshards: 6, edges: 30 });
    const c = await cluster(11, FIXED);
    const laid = await replay(c.client(), FIXED, script);
    const spread = new Set(laid.ids.map((id) => vshardOf(id).toString()));
    assert.ok(spread.size >= 3, `expected several vshards, got ${spread.size}`);
  });

  it("produce queries with depth, filters and counts", () => {
    const seen = { related: 0, counts: 0, where: 0, paged: 0 };
    for (let seed = 1; seed <= 60; seed++) {
      const q = generateQuery(seeded(seed), FIXED, "Issue", starter(FIXED, "Issue", "1"));
      const { plan } = q.compile();
      if (plan.frames.length > 1) seen.related++;
      if (plan.frames.some((f) => f.counts.length > 0)) seen.counts++;
      if (plan.frames.some((f) => f.where !== undefined)) seen.where++;
      if (plan.frames.length > 3) seen.paged++;
    }
    assert.ok(seen.related > 40, `expected most queries to follow a relation, got ${seen.related}`);
    assert.ok(seen.counts > 10, `expected counts, got ${seen.counts}`);
    assert.ok(seen.where > 10, `expected filters, got ${seen.where}`);
    assert.ok(seen.paged > 10, `expected deep trees, got ${seen.paged}`);
  });

  it("covers every object type as a root, and every mutation as an operation", () => {
    const roots = new Set<string>();
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 80; seed++) {
      const script = generateGraph(seeded(seed), FIXED, {
        objects: 20,
        vshards: 4,
        edges: 20,
        updates: 4,
        removes: 4,
        deletes: 2,
      });
      for (const op of script.ops) {
        kinds.add(op.kind);
        if (op.kind === "create" || op.kind === "with") roots.add(op.type);
      }
    }
    assert.deepEqual([...roots].sort(), Object.keys(FIXED.types).sort());
    assert.deepEqual([...kinds].sort(), ["assoc", "create", "erase", "unassoc", "update", "with"]);
  });
});
