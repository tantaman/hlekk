import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan } from "../catalog/catalog.ts";
import { vshardOf } from "../host/ids.ts";
import { RESERVATION_TTL_MS, ValueTaken, normalize } from "./client.ts";
import { LocalCluster } from "./local.ts";

// The design's third example: look up a user by email. The coordinator cannot know which host holds
// that user, so this needs a global index sharded by the value.
const LOCK = plan({
  core: { objects: { "core.user": { fields: { email: "string", name: "string" } } }, edges: {} },
});
const CATALOG = Catalog.compile(LOCK);
const USER = CATALOG.objectNamed("core.user")!.otype;
const BY_EMAIL = 1;

async function cluster(batch = 8) {
  const c = new LocalCluster({ batch, cap: 1_000_000 });
  c.directory.applyLock(LOCK);
  c.spreadCatalog();
  c.openIndexVshards(4);
  c.spreadCatalog();
  await c.publish();
  return c;
}

describe("looking a user up by email", () => {
  it("finds one the client never held an id for", async () => {
    const c = await cluster();
    const db = c.client();
    const alice = await db.createUnique(BY_EMAIL, "Alice@Example.com ", USER, { email: "alice@example.com", name: "alice" });

    assert.equal(await db.lookupUnique(BY_EMAIL, "alice@example.com"), alice);
    assert.equal(await db.lookupUnique(BY_EMAIL, "ALICE@EXAMPLE.COM"), alice, "compared the same way it was stored");
    assert.equal(await db.lookupUnique(BY_EMAIL, "bob@example.com"), null);
  });

  it("normalizes case and surrounding space, so one address gets one entry", () => {
    assert.equal(normalize("  Alice@Example.COM "), "alice@example.com");
  });

  it("puts the entry in an index vshard, not with the object", async () => {
    const c = await cluster();
    const db = c.client();
    const alice = await db.createUnique(BY_EMAIL, "alice@example.com", USER, { email: "alice@example.com", name: "a" });
    const indexVshards = c.directory.indexVshards();
    assert.ok(indexVshards.length > 0);
    assert.ok(!indexVshards.includes(vshardOf(alice)), "the user is not in an index vshard");
    const entryVshard = c.directory.indexVshardFor("alice@example.com");
    assert.ok(indexVshards.includes(entryVshard));
  });

  it("sends every spelling of one value to the same host, which is what makes the check real", async () => {
    const c = await cluster();
    const a = c.directory.indexVshardFor(normalize("Alice@Example.com"));
    const b = c.directory.indexVshardFor(normalize("  alice@example.com  "));
    assert.equal(a, b);
  });
});

describe("uniqueness", () => {
  it("refuses a second object for the same value, naming the one that holds it", async () => {
    const c = await cluster();
    const db = c.client();
    const alice = await db.createUnique(BY_EMAIL, "alice@example.com", USER, { email: "alice@example.com", name: "a" });

    await assert.rejects(
      () => db.createUnique(BY_EMAIL, "alice@example.com", USER, { email: "alice@example.com", name: "impostor" }),
      (e: unknown) => e instanceof ValueTaken && e.by === alice,
    );
  });

  it("lets only one of two callers racing for a value win", async () => {
    const c = await cluster();
    const db = c.client();
    const attempts = [1, 2, 3, 4, 5].map((n) =>
      db
        .createUnique(BY_EMAIL, "race@example.com", USER, { email: "race@example.com", name: `n${n}` })
        .then((id) => ({ ok: true as const, id }))
        .catch((e: unknown) => ({ ok: false as const, e })),
    );
    const results = await Promise.all(attempts);
    const winners = results.filter((r) => r.ok);
    assert.equal(winners.length, 1, `exactly one should win, ${winners.length} did`);
    for (const loser of results.filter((r) => !r.ok)) {
      assert.ok((loser as { e: unknown }).e instanceof ValueTaken);
    }
    assert.equal(await db.lookupUnique(BY_EMAIL, "race@example.com"), (winners[0] as { id: string }).id);
  });

  it("does not report a reserved value as an answer: the object is not there yet", async () => {
    const c = await cluster();
    const db = c.client();
    const vshard = c.directory.indexVshardFor("pending@example.com");
    await db.write({
      kind: "indexReserve",
      vshard: vshard.toString(),
      idx: BY_EMAIL,
      key: "pending@example.com",
      now: Date.now(),
      ttlMs: RESERVATION_TTL_MS,
    });
    assert.equal(await db.lookupUnique(BY_EMAIL, "pending@example.com"), null);
  });
});

describe("a create that does not finish", () => {
  it("releases the value when the object cannot be made", async () => {
    const c = await cluster();
    const db = c.client();
    // An otype the catalog does not know is still storable, so break it another way: a payload over
    // the row cap. The reservation must not survive it.
    const huge = "x".repeat(3 * 1024 * 1024);
    await assert.rejects(() => db.createUnique(BY_EMAIL, "huge@example.com", USER, { email: "e", name: huge }));
    assert.equal(await db.lookupUnique(BY_EMAIL, "huge@example.com"), null);

    // And the value is free for the next caller.
    const id = await db.createUnique(BY_EMAIL, "huge@example.com", USER, { email: "huge@example.com", name: "ok" });
    assert.equal(await db.lookupUnique(BY_EMAIL, "huge@example.com"), id);
  });

  it("expires a reservation nobody confirmed, so a crash cannot hold a value forever", async () => {
    const c = await cluster();
    const db = c.client();
    const key = "ghost@example.com";
    const vshard = c.directory.indexVshardFor(key);
    const reservedAt = 1_000;

    // A caller reserved the value and then died.
    await db.write({ kind: "indexReserve", vshard: vshard.toString(), idx: BY_EMAIL, key, now: reservedAt, ttlMs: 5_000 });
    await assert.rejects(
      () => db.createUnique(BY_EMAIL, key, USER, { email: key, name: "next" }, {}, { now: reservedAt + 1_000, ttlMs: 5_000 }),
      ValueTaken,
      "while the reservation is live, nobody else gets it",
    );

    const id = await db.createUnique(BY_EMAIL, key, USER, { email: key, name: "next" }, {}, { now: reservedAt + 6_000, ttlMs: 5_000 });
    assert.equal(await db.lookupUnique(BY_EMAIL, key), id, "once it expires, the value is reusable");
  });

  it("sweeps expired reservations on an alarm", async () => {
    const c = await cluster();
    const db = c.client();
    const key = "swept@example.com";
    const vshard = c.directory.indexVshardFor(key);
    await db.write({ kind: "indexReserve", vshard: vshard.toString(), idx: BY_EMAIL, key, now: 1_000, ttlMs: 5_000 });

    assert.equal(c.sweepIndexes(2_000, 5_000), 0, "not yet expired");
    assert.equal(c.sweepIndexes(10_000, 5_000), 1, "expired and reclaimed");
    assert.equal(c.sweepIndexes(10_000, 5_000), 0, "and only once");
  });
});

describe("an index vshard that moves", () => {
  it("carries its entries, and lookups follow", async () => {
    const c = await cluster();
    const db = c.client();
    const alice = await db.createUnique(BY_EMAIL, "alice@example.com", USER, { email: "alice@example.com", name: "a" });
    const vshard = c.directory.indexVshardFor("alice@example.com");
    const before = c.directory.resolve(vshard)!.host;

    c.mover.begin(vshard, before + 7);
    await c.mover.run(vshard);
    c.spreadCatalog();

    assert.notEqual(c.directory.resolve(vshard)!.host, before);
    assert.equal(await db.lookupUnique(BY_EMAIL, "alice@example.com"), alice, "the entry travelled with the vshard");
    await assert.rejects(
      () => db.createUnique(BY_EMAIL, "alice@example.com", USER, { email: "x", name: "y" }),
      ValueTaken,
      "and still holds the value",
    );
  });
});
