import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan } from "../catalog/catalog.ts";
import { LocalCluster } from "../client/local.ts";
import { MAX_VSHARD, vshardOf } from "../host/ids.ts";
import { NoRoom, hash } from "./allocator.ts";
import { pickRun } from "./placement.ts";

const LOCK = plan({
  app: {
    objects: { "app.note": { fields: { body: "string", tenant: "string" } } },
    edges: {},
  },
});
const CATALOG = Catalog.compile(LOCK);
const NOTE = CATALOG.objectNamed("app.note")!.otype;

/** A cluster whose vshards fill after a few hundred bytes, so growth is reachable in a test. */
async function tiny(opts: { cap?: number; batch?: number; thresholds?: { bytes?: number; requests?: number } } = {}) {
  const c = new LocalCluster({ batch: opts.batch ?? 4, cap: opts.cap ?? 2_000, thresholds: opts.thresholds });
  c.directory.applyLock(LOCK);
  c.spreadCatalog();
  await c.publish();
  return c;
}

const body = (n: number) => "x".repeat(n);

describe("placing a root", () => {
  it("needs no vshard from the caller", async () => {
    const c = await tiny();
    const db = c.client();
    const id = await db.create(NOTE, { body: "hi", tenant: "acme" });
    assert.ok(c.directory.resolve(vshardOf(id)), "it landed somewhere the directory knows");
  });

  it("puts objects sharing an affinity key in one vshard, and spreads different ones", async () => {
    const c = await tiny({ batch: 16 });
    const db = c.client();
    const acme = await Promise.all([1, 2, 3].map(() => db.create(NOTE, { body: "a", tenant: "acme" }, { affinity: "acme" })));
    const globex = await Promise.all([1, 2, 3].map(() => db.create(NOTE, { body: "g", tenant: "globex" }, { affinity: "globex" })));

    assert.equal(new Set(acme.map(vshardOf)).size, 1, "one tenant, one vshard");
    assert.equal(new Set(globex.map(vshardOf)).size, 1);
    // With 16 vshards two keys could collide, but these two do not, which is the point of hashing.
    assert.notEqual(vshardOf(acme[0]), vshardOf(globex[0]));
  });

  it("spreads keys evenly enough to be worth hashing", () => {
    const set = 64;
    const counts = new Array(set).fill(0);
    for (let i = 0; i < 6400; i++) counts[hash(`tenant-${i}`) % set]++;
    const min = Math.min(...counts);
    const max = Math.max(...counts);
    assert.ok(max < min * 3, `expected a rough spread, got ${min}..${max}`);
  });

  it("colocates a child with its parent, whatever the affinity would have said", async () => {
    const c = await tiny({ batch: 16 });
    const db = c.client();
    const parent = await db.create(NOTE, { body: "p", tenant: "acme" }, { affinity: "acme" });
    const child = await db.create(NOTE, { body: "c", tenant: "globex" }, { with: parent });
    assert.equal(vshardOf(child), vshardOf(parent));
  });
});

describe("the active set", () => {
  it("drops a vshard once it passes half its cap", async () => {
    const c = await tiny({ cap: 2_000, batch: 4 });
    const db = c.client();
    assert.equal(c.allocator.active().length, 4);

    // Fill vshard 0 past half of a 2,000-byte cap.
    for (let i = 0; i < 3; i++) await db.create(NOTE, { body: body(400), tenant: "t" }, { vshard: "0" });
    c.collect();
    assert.ok(!c.allocator.active().includes(0n), "it stopped taking new roots");
    assert.equal(c.allocator.active().length, 3, "the others still do");
  });

  it("opens the next batch when the set empties, not one vshard", async () => {
    const c = await tiny({ cap: 1_000, batch: 4 });
    const db = c.client();
    for (const v of [0, 1, 2, 3]) {
      await db.create(NOTE, { body: body(600), tenant: "t" }, { vshard: String(v) });
    }
    c.collect();
    assert.equal(c.allocator.active().length, 0);

    const opened = c.allocator.grow();
    assert.deepEqual(opened, [4n, 5n, 6n, 7n], "a batch, so creates do not funnel onto one vshard");
    assert.equal(c.directory.size(), 8);
  });

  it("grows on demand when a create finds nothing active", async () => {
    const c = await tiny({ cap: 1_000, batch: 4 });
    const db = c.client();
    for (const v of [0, 1, 2, 3]) await db.create(NOTE, { body: body(600), tenant: "t" }, { vshard: String(v) });
    c.collect();

    const id = await db.create(NOTE, { body: "fresh", tenant: "t" });
    assert.ok(vshardOf(id) >= 4n, "it went into a newly opened vshard");
  });

  it("says so rather than silently overfilling when the vshard space runs out", async () => {
    const c = await tiny({ cap: 2_000, batch: 4 });
    // Put the layout's last vshard in use and fill everything, so there is nothing above it left to
    // open. Derived from MAX_VSHARD rather than restated: this test hardcoded `(1n << 24n) - 1n`
    // and was the only thing that broke when the field narrowed to 20 bits.
    const top = MAX_VSHARD;
    c.directory.assign(top, 0, 0);
    c.directory.sql.run("INSERT OR REPLACE INTO usage (vshard, bytes) SELECT vshard, 1000000 FROM assignments");
    assert.deepEqual(c.allocator.active(), [], "nothing is taking roots");
    assert.deepEqual(c.allocator.grow(), [], "and there is no room above the top vshard");
    assert.throws(() => c.allocator.place("t"), NoRoom);
  });
});

describe("picking what to shed", () => {
  const weight = (w: Record<string, number>) => (v: bigint) => w[v.toString()] ?? 0;

  it("takes a prefix, so what is left behind stays contiguous", () => {
    // Shedding 2 alone would split 1..3 into two runs and cost the map an entry; 1..2 does not.
    const picked = pickRun([1n, 2n, 3n, 9n], weight({ "1": 10, "2": 10, "3": 10, "9": 1 }), 20);
    assert.deepEqual(picked, [1n, 2n]);
  });

  it("moves as few vshards as will do, since each one is a stop-the-world pause", () => {
    const picked = pickRun([1n, 2n, 3n, 4n], weight({ "1": 10, "2": 10, "3": 10, "4": 10 }), 20);
    assert.deepEqual(picked, [1n, 2n]);
    // One heavy vshard beats three light ones that add up to the same.
    assert.deepEqual(pickRun([1n, 2n, 3n, 9n], weight({ "1": 40, "2": 40, "3": 40, "9": 200 }), 100), [9n]);
  });

  it("sheds the least it can when several prefixes clear the bar", () => {
    const picked = pickRun([1n, 2n, 5n, 6n], weight({ "1": 50, "2": 50, "5": 100, "6": 100 }), 100);
    assert.equal(picked.length, 1);
    assert.deepEqual(picked, [5n], "one vshard of exactly 100, not two of 50 or one of 200");
  });

  it("never sheds the whole host", () => {
    const picked = pickRun([1n, 2n], weight({ "1": 10, "2": 10 }), 1000);
    assert.notEqual(picked.length, 2);
  });

  it("takes the heaviest prefix it can when nothing clears the bar", () => {
    const picked = pickRun([1n, 2n, 3n], weight({ "1": 1, "2": 1, "3": 1 }), 1000);
    assert.ok(picked.length > 0 && picked.length < 3);
  });
});

describe("the placement controller", () => {
  it("moves nothing while every host is under threshold", async () => {
    const c = await tiny({ thresholds: { bytes: 1_000_000 } });
    const db = c.client();
    await db.create(NOTE, { body: "small", tenant: "t" });
    assert.deepEqual(await c.rebalance(), []);
    assert.equal(c.directory.hostIndexes().length, 1, "a small database stays on one DO");
  });

  it("sheds onto a new host when one crosses the byte threshold, and the data is intact after", async () => {
    const c = await tiny({ cap: 1_000_000, batch: 8, thresholds: { bytes: 3_000 } });
    const db = c.client();
    const ids: string[] = [];
    for (const v of [0, 1, 2, 3, 4, 5, 6, 7]) {
      ids.push(await db.create(NOTE, { body: body(600), tenant: "t" }, { vshard: String(v) }));
    }

    const sheds = await c.rebalance();
    assert.ok(sheds.length > 0, "it decided to move something");
    assert.ok(c.directory.hostIndexes().length > 1, "onto another host");
    for (const shed of sheds) {
      assert.equal(shed.why, "bytes");
      assert.ok(shed.vshards.length > 0 && shed.vshards.length < 8, "and not the whole host");
    }

    // Everything still reads, through whatever host owns it now.
    for (const id of ids) {
      const route = c.directory.resolve(vshardOf(id))!;
      const held = await c.host(route.host).store().object(id);
      assert.ok(held && typeof held === "object", `${id} is readable on host ${route.host}`);
    }
  });

  it("sheds on request pressure too, not only bytes", async () => {
    const c = await tiny({ cap: 1_000_000, batch: 8, thresholds: { bytes: 1e12, requests: 10 } });
    const db = c.client();
    const ids: string[] = [];
    for (const v of [0, 1, 2, 3]) ids.push(await db.create(NOTE, { body: "n", tenant: "t" }, { vshard: String(v) }));
    // Drive reads at a few vshards so their request counters climb.
    for (let i = 0; i < 6; i++) {
      for (const id of ids) await db.query({ frames: [{ source: { kind: "ids" }, children: [], counts: [] }] }, [id]);
    }

    const sheds = await c.rebalance();
    assert.ok(sheds.length > 0);
    assert.equal(sheds[0].why, "requests");
  });

  it("publishes once per rebalance, not once per move", async () => {
    const c = await tiny({ cap: 1_000_000, batch: 8, thresholds: { bytes: 3_000 } });
    const db = c.client();
    for (const v of [0, 1, 2, 3, 4, 5, 6, 7]) await db.create(NOTE, { body: body(600), tenant: "t" }, { vshard: String(v) });

    const before = c.store.writes;
    const sheds = await c.rebalance();
    const moves = sheds.reduce((n, s) => n + s.vshards.length, 0);
    assert.ok(moves > 1, "this rebalance moved more than one vshard");
    assert.equal(c.store.writes - before, c.directory.chunkIndexes().length, "one publish, covering every chunk");
  });

  it("settles rather than moving the same vshards back and forth", async () => {
    const c = await tiny({ cap: 1_000_000, batch: 8, thresholds: { bytes: 3_000 } });
    const db = c.client();
    for (const v of [0, 1, 2, 3, 4, 5, 6, 7]) await db.create(NOTE, { body: body(600), tenant: "t" }, { vshard: String(v) });

    let rounds = 0;
    for (; rounds < 10; rounds++) {
      const sheds = await c.rebalance();
      if (sheds.length === 0) break;
    }
    assert.ok(rounds < 10, `expected it to settle, still moving after ${rounds} rounds`);
    assert.deepEqual(await c.rebalance(), [], "and to stay settled");
  });
});
