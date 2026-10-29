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
import type { Script, TypeName } from "./generate.ts";
import { Comment, Issue, LOCK, Label, User, types } from "./schema.ts";

/** The oracle's contract, from the design: a query across many hosts must equal the same query
 *  against one host that holds every vshard. */
async function cluster(seed: number): Promise<LocalCluster> {
  const c = new LocalCluster({ batch: 64, runtime: deterministic(seed) });
  c.directory.applyLock(LOCK);
  c.spreadCatalog();
  await c.publish();
  return c;
}

const starters: Record<TypeName, (id: Id) => Query<never, unknown>> = {
  Issue: (id) => Issue.gen(id) as unknown as Query<never, unknown>,
  Comment: (id) => Comment.gen(id) as unknown as Query<never, unknown>,
  User: (id) => User.gen(id) as unknown as Query<never, unknown>,
  Label: (id) => Label.gen(id) as unknown as Query<never, unknown>,
};

/** Spreads a script's vshards over `hosts` hosts by moving them, which is how a real database gets
 *  there. The ids do not change, so the answers must not either. */
async function spread(c: LocalCluster, script: Script, r: Random, hosts: number): Promise<number> {
  for (const vshard of script.vshards) {
    const to = 1 + r.int(hosts - 1); // never host 0, so every listed vshard actually moves
    c.mover.begin(BigInt(vshard), to);
    await c.mover.run(BigInt(vshard));
  }
  c.spreadCatalog();
  await c.publish();
  await c.deliverAll();
  // How many hosts the script's own vshards ended up on. A one-host answer would prove nothing.
  return new Set(script.vshards.map((v) => c.directory.resolve(BigInt(v))!.host)).size;
}

interface Case {
  script: Script;
  root: Id;
  rootType: TypeName;
  query: () => Query<never, unknown>;
}

/** Builds one case: a graph, and a query over a root the graph actually made. */
async function fuzzCase(seed: number): Promise<{ one: LocalCluster; many: LocalCluster; hosts: number; c: Case } | null> {
  const r = seeded(seed);
  const script = generateGraph(r, { objects: 20 + r.int(12), vshards: 3 + r.int(5), edges: 24 + r.int(16) });

  const one = await cluster(seed);
  const laid = await replay(one.client(), script);
  await one.deliverAll();

  // Pick a root whose type has somewhere to go.
  const candidates = laid.types.map((t, i) => ({ t, i })).filter(({ t }) => t !== "Label");
  if (candidates.length === 0) return null;
  const pick = r.pick(candidates);
  const root = laid.ids[pick.i];

  const many = await cluster(seed);
  const again = await replay(many.client(), script);
  assert.deepEqual(again.ids, laid.ids, `seed ${seed}: replaying one script twice must hand out the same ids`);
  await many.deliverAll();
  const hosts = await spread(many, script, seeded(seed ^ 0x5bf0), 4);

  // The query is generated from its own stream, so it does not depend on how the graph consumed r.
  const qr = seeded(seed ^ 0x9e37);
  const query = () => generateQuery(seeded(seed ^ 0x9e37), pick.t, starters[pick.t](root), { depth: 3, width: 2 });
  void qr;
  return { one, many, hosts, c: { script, root, rootType: pick.t, query } };
}

const answer = async (c: LocalCluster, q: Query<never, unknown>, driver: "async" | "rounds") =>
  canonical((await q.run(c.client(), { driver })) as unknown as Json);

describe("the differential oracle, fuzzed", () => {
  it("gives the same answer across four hosts as on one, over 40 random graphs and queries", async () => {
    let checked = 0;
    let spreadOver = 1;
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
      checked++;
    }
    assert.ok(checked >= 50, `expected most seeds to produce a case, got ${checked}`);
    assert.ok(spreadOver >= 3, `the graphs have to actually span hosts, saw at most ${spreadOver}`);
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
      for (const vshard of many.directory.vshardsOn(0)) many.host(0).setState(vshard.toString(), "fenced");
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

describe("the generators", () => {
  it("replay the same script to the same ids, which is what makes the oracle comparable", async () => {
    const script = generateGraph(seeded(9), { objects: 12, vshards: 4, edges: 10 });
    const a = await cluster(9);
    const b = await cluster(9);
    assert.deepEqual((await replay(a.client(), script)).ids, (await replay(b.client(), script)).ids);
  });

  it("produce graphs that actually span vshards, or the oracle would prove nothing", async () => {
    const script = generateGraph(seeded(11), { objects: 24, vshards: 6, edges: 30 });
    const c = await cluster(11);
    const laid = await replay(c.client(), script);
    const spread = new Set(laid.ids.map((id) => vshardOf(id).toString()));
    assert.ok(spread.size >= 3, `expected several vshards, got ${spread.size}`);
  });

  it("produce queries with depth, filters and counts", () => {
    const seen = { related: 0, counts: 0, where: 0, paged: 0 };
    for (let seed = 1; seed <= 60; seed++) {
      const q = generateQuery(seeded(seed), "Issue", Issue.gen("1") as unknown as Query<never, unknown>);
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

  it("covers every object type as a root", () => {
    const roots = new Set<string>();
    for (let seed = 1; seed <= 80; seed++) {
      const script = generateGraph(seeded(seed), { objects: 20, vshards: 4, edges: 20 });
      for (const op of script.ops) if (op.kind !== "assoc") roots.add(op.type);
    }
    assert.deepEqual([...roots].sort(), Object.keys(types).sort());
  });
});
