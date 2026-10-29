import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan } from "../catalog/catalog.ts";
import { Chunk, SPAN, UNASSIGNED, chunkOf, encodeChunk, runs } from "../directory/map.ts";
import { makeId, vshardOf } from "../host/ids.ts";
import type { Plan } from "../query/types.ts";
import { LocalCluster } from "./local.ts";

const LOCK = plan({
  core: { objects: { "core.user": { fields: { name: "string" } } } },
  issues: {
    objects: {
      "issues.issue": { fields: { title: "string" } },
      "issues.comment": { fields: { body: "string", authorId: { id: "core.user" } } },
    },
    edges: {
      "issues.issue_comment": {
        from: "issues.issue",
        to: "issues.comment",
        inverse: "issues.comment_issue",
        onDelete: "cascade",
      },
      "issues.comment_issue": { from: "issues.comment", to: "issues.issue", inverse: "issues.issue_comment" },
    },
  },
});
const CATALOG = Catalog.compile(LOCK);
const ISSUE = CATALOG.objectNamed("issues.issue")!.otype;
const COMMENT = CATALOG.objectNamed("issues.comment")!.otype;
const ISSUE_COMMENT = CATALOG.edgeNamed("issues.issue_comment")!.atype!;

/** A cluster with the catalog applied and the map published. */
async function cluster(batch?: number): Promise<LocalCluster> {
  const c = new LocalCluster({ batch });
  c.directory.applyLock(LOCK);
  c.spreadCatalog();
  await c.publish();
  return c;
}

const ISSUE_PAGE: Plan = {
  frames: [
    {
      source: { kind: "ids" },
      children: [{ alias: "comments", frame: 1 }],
      counts: [{ alias: "commentCount", atype: ISSUE_COMMENT }],
    },
    { source: { kind: "edge", atype: ISSUE_COMMENT }, limit: 10, children: [], counts: [] },
  ],
};

describe("chunks", () => {
  it("collapses consecutive vshards on one host into one run", () => {
    const assigned = [0, 1, 2, 3].map((v) => ({ vshard: BigInt(v), host: 0, epoch: 0 }));
    const entries = runs(0, assigned);
    assert.equal(entries.length, 2); // the run, then the gap to the end of the span
    assert.deepEqual(entries[0], { start: 0, host: 0, epoch: 0 });
    assert.equal(entries[1].host, UNASSIGNED);
  });

  it("breaks a run on a host change and on an epoch change", () => {
    const entries = runs(0, [
      { vshard: 0n, host: 0, epoch: 0 },
      { vshard: 1n, host: 1, epoch: 1 }, // moved away
      { vshard: 2n, host: 1, epoch: 2 }, // also on host 1, but moved later
    ]);
    assert.deepEqual(
      entries.slice(0, 3).map((e) => [e.start, e.host, e.epoch]),
      [
        [0, 0, 0],
        [1, 1, 1],
        [2, 1, 2],
      ],
    );
  });

  it("round-trips and answers a lookup without allocating a run per vshard", () => {
    const assigned = [...Array(64)].map((_, v) => ({ vshard: BigInt(v), host: 0, epoch: 0 }));
    const chunk = new Chunk(encodeChunk(0, 7, runs(0, assigned)));
    assert.equal(chunk.mapVersion, 7);
    assert.equal(chunk.span, SPAN);
    assert.equal(chunk.entries, 2, "64 vshards on one host is one run plus the trailing gap");
    assert.deepEqual(chunk.lookup(0n), { host: 0, epoch: 0 });
    assert.deepEqual(chunk.lookup(63n), { host: 0, epoch: 0 });
    assert.equal(chunk.lookup(64n), undefined, "a vshard that was never assigned has no route");
  });

  it("rejects bytes that are not a chunk", () => {
    assert.throws(() => new Chunk(new Uint8Array(32)), TypeError);
    assert.throws(() => new Chunk(new Uint8Array(4)), TypeError);
  });

  it("puts a database's whole initial batch in one chunk", async () => {
    const c = await cluster();
    assert.equal(chunkOf(0n), 0);
    assert.equal(chunkOf(63n), 0);
    assert.equal(c.directory.chunkIndexes().length, 1);
    assert.equal(c.store.entries.size, 1, "a two-row database is one chunk");
  });
});

describe("a new database", () => {
  it("costs one host and one chunk, with 64 vshards on it", async () => {
    const c = await cluster();
    assert.equal(c.directory.size(), 64);
    assert.equal(c.directory.hostIndexes().length, 1);
    assert.deepEqual(c.directory.vshardsOn(0).length, 64);
    assert.equal(c.hosts.size, 1);
  });

  it("spreads roots across its vshards, so the founding data can be peeled apart", async () => {
    const c = await cluster();
    const db = c.client();
    // Placement is explicit until the allocator lands; what matters is that it can differ per root.
    const a = await db.create(ISSUE, { title: "a" }, { vshard: "3" });
    const b = await db.create(ISSUE, { title: "b" }, { vshard: "40" });
    assert.notEqual(vshardOf(a), vshardOf(b));
  });
});

describe("the client", () => {
  it("reads and writes without the caller naming a host", async () => {
    const c = await cluster();
    const db = c.client();
    const issue = await db.create(ISSUE, { title: "Crash on save" }, { vshard: "5" });
    const c1 = await db.create(COMMENT, { body: "repro", authorId: "0" }, { with: issue });
    await db.assocAdd(ISSUE_COMMENT, issue, c1, 1);

    const out = (await db.query(ISSUE_PAGE, [issue])) as {
      title: string;
      commentCount: number;
      comments: { body: string }[];
    }[];
    assert.equal(out[0].title, "Crash on save");
    assert.equal(out[0].commentCount, 1);
    assert.deepEqual(out[0].comments.map((x) => x.body), ["repro"]);
  });

  it("keeps the published map off the request path once a chunk is cached", async () => {
    const c = await cluster();
    const db = c.client();
    const issue = await db.create(ISSUE, { title: "i" }, { vshard: "5" });
    const before = { ...c.store, reads: c.store.reads };
    await db.query(ISSUE_PAGE, [issue]);
    await db.query(ISSUE_PAGE, [issue]);
    assert.equal(c.store.reads, before.reads, "no further chunk reads: the isolate holds it");
    assert.equal(c.calls.resolve, 0, "and the directory was never asked");
  });

  it("writes the inverse of a colocated edge inline, with nothing queued", async () => {
    const c = await cluster();
    const db = c.client();
    const issue = await db.create(ISSUE, { title: "i" }, { vshard: "5" });
    const comment = await db.create(COMMENT, { body: "b", authorId: "0" }, { with: issue });
    await db.assocAdd(ISSUE_COMMENT, issue, comment, 1);
    assert.equal(c.host(0).pending().length, 0);
    assert.equal(await c.host(0).store().count(comment, CATALOG.edgeNamed("issues.comment_issue")!.atype!), 1);
  });
});

describe("a stale route", () => {
  /** Moves a vshard the crude way: the directory re-points it and both hosts are told. The move
   *  protocol does this properly; here it only has to produce a stale route. */
  const handOff = (c: LocalCluster, vshard: bigint, to: number) => {
    const from = c.directory.resolve(vshard)!;
    const target = c.host(to);
    const source = c.host(from.host);
    const epoch = from.epoch + 1;
    for (const row of source.sql.all<{ id: Uint8Array; otype: number; version: number; data: string }>(
      "SELECT id, otype, version, data FROM objects",
    )) {
      target.sql.run("INSERT OR REPLACE INTO objects (id, otype, version, data) VALUES (?, ?, ?, ?)", row.id, row.otype, row.version, row.data);
    }
    for (const row of source.sql.all<{ id1: Uint8Array; atype: number; id2: Uint8Array; time: number; data: string | null }>(
      "SELECT id1, atype, id2, time, data FROM assocs",
    )) {
      target.sql.run("INSERT OR REPLACE INTO assocs (id1, atype, id2, time, data) VALUES (?, ?, ?, ?, ?)", row.id1, row.atype, row.id2, row.time, row.data);
    }
    for (const row of source.sql.all<{ id1: Uint8Array; atype: number; n: number }>("SELECT id1, atype, n FROM assoc_counts")) {
      target.sql.run("INSERT OR REPLACE INTO assoc_counts (id1, atype, n) VALUES (?, ?, ?)", row.id1, row.atype, row.n);
    }
    target.adopt(vshard.toString(), epoch);
    c.directory.assign(vshard, to, epoch);
    source.setState(vshard.toString(), "moved");
  };

  it("costs one extra round on a read, and never a wrong answer", async () => {
    const c = await cluster();
    const db = c.client();
    const issue = await db.create(ISSUE, { title: "i" }, { vshard: "5" });
    await db.query(ISSUE_PAGE, [issue]); // warms the route cache at epoch 0

    handOff(c, 5n, 1); // the map the client holds is now wrong, and stays unpublished
    const before = c.calls.exec;
    const out = (await db.query(ISSUE_PAGE, [issue])) as { title: string }[];
    assert.equal(out[0].title, "i", "the answer is right even though the route was not");
    assert.equal(c.calls.exec - before, 2, "one refused request, then one to the new owner");
    assert.equal(c.calls.resolve, 1, "the directory placed it, not the stale published chunk");
  });

  it("re-routes a write rather than losing it", async () => {
    const c = await cluster();
    const db = c.client();
    const issue = await db.create(ISSUE, { title: "i" }, { vshard: "5" });

    handOff(c, 5n, 1);
    const version = await db.update(issue, { title: "edited" });
    assert.equal(version, 2);
    assert.equal(c.holderOf(5n), 1);
    const held = await c.host(1).store().object(issue);
    assert.deepEqual(held && typeof held === "object" && "data" in held ? held.data : null, { title: "edited" });
  });

  it("gives up rather than looping when the map will not settle", async () => {
    const c = await cluster();
    const db = c.client();
    const issue = await db.create(ISSUE, { title: "i" }, { vshard: "5" });
    // Retire the vshard everywhere: every re-route finds a host that refuses it.
    c.host(0).setState("5", "moved");
    await assert.rejects(() => db.update(issue, { title: "x" }), /gave up after/);
  });
});

describe("the catalog reaches the hosts", () => {
  it("applies in version order and nowhere else", async () => {
    const c = new LocalCluster();
    assert.equal(c.directory.catalog().version, 0);
    c.directory.applyLock(LOCK);
    assert.equal(c.directory.catalog().version, 1);
    assert.throws(() => c.directory.applyLock(LOCK), /version 1, but this database is at 1/);
  });

  it("is what decides a cascade, so a host without it does not cascade", async () => {
    const c = new LocalCluster();
    c.directory.applyLock(LOCK);
    const db = c.client();
    // Deliberately not spread: the host is still on the empty catalog.
    const issue = await db.create(ISSUE, { title: "i" }, { vshard: "5" });
    const comment = await db.create(COMMENT, { body: "b", authorId: "0" }, { with: issue });
    await db.assocAdd(ISSUE_COMMENT, issue, comment, 1);
    await db.delete(issue);
    assert.notEqual(await c.host(0).store().object(comment), null, "no catalog, no onDelete");

    c.spreadCatalog();
    const issue2 = await db.create(ISSUE, { title: "i2" }, { vshard: "5" });
    const comment2 = await db.create(COMMENT, { body: "b2", authorId: "0" }, { with: issue2 });
    await db.assocAdd(ISSUE_COMMENT, issue2, comment2, 1);
    await db.delete(issue2);
    assert.equal(await c.host(0).store().object(comment2), null, "with it, the cascade runs");
  });
});

describe("unroutable ids", () => {
  it("refuses a vshard no host owns", async () => {
    const c = await cluster();
    const db = c.client();
    await assert.rejects(() => db.update(makeId(5000n, 1n), { x: 1 }), /no host owns vshard 5000/);
  });
});
