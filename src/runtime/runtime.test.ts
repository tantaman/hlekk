import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan } from "../catalog/catalog.ts";
import { LocalCluster } from "../client/local.ts";
import { vshardOf } from "../host/ids.ts";
import { VirtualClock, deterministic, seeded } from "./runtime.ts";

const LOCK = plan({ app: { objects: { "app.note": { fields: { body: "string" } } } } });
const NOTE = Catalog.compile(LOCK).objectNamed("app.note")!.otype;

async function cluster(seed: number) {
  const c = new LocalCluster({ batch: 16, runtime: deterministic(seed) });
  c.directory.applyLock(LOCK);
  c.spreadCatalog();
  await c.publish();
  return c;
}

describe("the seeded random", () => {
  it("replays exactly from a seed, and differs between seeds", () => {
    const a = [...Array(8)].map(() => seeded(42).next());
    const b = [...Array(8)].map(() => seeded(42).next());
    assert.deepEqual(a, b);
    assert.notDeepEqual(seeded(42).next(), seeded(43).next());
  });

  it("stays in range and spreads", () => {
    const r = seeded(7);
    const counts = new Array(4).fill(0);
    for (let i = 0; i < 4000; i++) {
      const n = r.int(4);
      assert.ok(n >= 0 && n < 4);
      counts[n]++;
    }
    assert.ok(Math.max(...counts) < Math.min(...counts) * 2, `expected a spread, got ${counts.join(",")}`);
  });
});

describe("the virtual clock", () => {
  it("advances only when something waits, so a long deadline costs no real time", async () => {
    const clock = new VirtualClock();
    const started = Date.now();
    assert.equal(clock.now(), 0);
    await clock.sleep(3_600_000); // an hour
    assert.equal(clock.now(), 3_600_000);
    assert.ok(Date.now() - started < 1_000, "an hour of virtual time took no real time");
  });

  it("fires timers in time order, and in the order they were set within an instant", async () => {
    const clock = new VirtualClock();
    const fired: string[] = [];
    void clock.sleep(20).then(() => fired.push("late"));
    void clock.sleep(10).then(() => fired.push("early"));
    void clock.sleep(10).then(() => fired.push("also early"));
    await clock.idle();
    assert.deepEqual(fired, ["early", "also early", "late"]);
  });
});

describe("a cluster on a deterministic runtime", () => {
  it("places the same objects the same way from the same seed", async () => {
    const run = async (seed: number) => {
      const c = await cluster(seed);
      const db = c.client();
      const ids: string[] = [];
      // No affinity key, so placement is the allocator's own choice: the part that used to be
      // Math.random and made a failure unreproducible.
      for (let i = 0; i < 12; i++) ids.push(await db.create(NOTE, { body: `n${i}` }));
      return ids.map((id) => vshardOf(id).toString());
    };
    assert.deepEqual(await run(1), await run(1), "same seed, same placement");
    assert.notDeepEqual(await run(1), await run(2), "different seed, different placement");
  });

  it("waits out a move's full default deadline without taking it in real time", async () => {
    const c = await cluster(5);
    const db = c.client();
    const issue = await db.create(NOTE, { body: "n" }, { vshard: "5" });
    c.host(0).setState("5", "fenced"); // a fence that never lifts

    const started = Date.now();
    // The real default is five seconds, which no suite could afford to wait for.
    await assert.rejects(() => db.update(issue, { body: "x" }), /still fenced after 5000 ms/);
    assert.ok(Date.now() - started < 2_000, `took ${Date.now() - started} ms of real time`);
  });
});
