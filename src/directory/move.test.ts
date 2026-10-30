import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan } from "../catalog/catalog.ts";
import { LocalCluster } from "../client/local.ts";
import { vshardOf } from "../host/ids.ts";
import type { Plan } from "../query/types.ts";
import { MoveFailed, Mover } from "./move.ts";

const LOCK = plan({
  issues: {
    objects: {
      "issues.issue": { fields: { title: "string" } },
      "issues.comment": { fields: { body: "string" } },
    },
    edges: {
      "issues.issue_comment": {
        from: "issues.issue",
        to: "issues.comment",
        inverse: "issues.comment_issue",
        onDelete: "cascade",
      },
      "issues.comment_issue": { from: "issues.comment", to: "issues.issue", inverse: "issues.issue_comment", maintained: true },
    },
  },
});
const CATALOG = Catalog.compile(LOCK);
const ISSUE = CATALOG.objectNamed("issues.issue")!.otype;
const COMMENT = CATALOG.objectNamed("issues.comment")!.otype;
const ISSUE_COMMENT = CATALOG.edgeNamed("issues.issue_comment")!.atype!;

const PAGE: Plan = {
  frames: [
    {
      source: { kind: "ids" },
      children: [{ alias: "comments", frame: 1 }],
      counts: [{ alias: "commentCount", atype: ISSUE_COMMENT }],
    },
    { source: { kind: "edge", atype: ISSUE_COMMENT }, limit: 50, children: [], counts: [] },
  ],
};

/** A database holding one issue with three comments, all colocated in vshard 5. */
async function seeded() {
  const c = new LocalCluster();
  c.directory.applyLock(LOCK);
  c.spreadCatalog();
  await c.publish();
  const db = c.client();
  const issue = await db.create(ISSUE, { title: "Crash on save" }, { vshard: "5" });
  const comments: string[] = [];
  for (const t of [1, 2, 3]) {
    const id = await db.create(COMMENT, { body: `c${t}` }, { with: issue });
    await db.assocAdd(ISSUE_COMMENT, issue, id, t);
    comments.push(id);
  }
  return { c, db, issue, comments };
}

const page = async (db: Awaited<ReturnType<typeof seeded>>["db"], issue: string) =>
  (await db.query(PAGE, [issue])) as { title: string; commentCount: number; comments: { body: string }[] }[];

describe("moving a vshard", () => {
  it("carries the data, the counts and the sequence to the new host", async () => {
    const { c, db, issue } = await seeded();
    const before = await page(db, issue);
    const nextSeqBefore = c.host(0).vshards().find((v) => v.vshard === 5)!.next_seq;

    c.mover.begin(5n, 1);
    assert.equal(await c.mover.run(5n), "done");

    assert.equal(c.holderOf(5n), 1);
    assert.deepEqual(await page(db, issue), before, "the same query gives the same answer");
    const row = c.host(1).vshards().find((v) => v.vshard === 5)!;
    assert.equal(row.state, "owned");
    assert.equal(row.epoch, 1, "the epoch advanced, so a stale route is detectable");
    assert.equal(row.next_seq, nextSeqBefore, "next_seq came with it, or ids would be reissued");

    // A create on the moved vshard continues the sequence rather than colliding.
    const fresh = await db.create(COMMENT, { body: "after the move" }, { with: issue });
    assert.equal(vshardOf(fresh), 5n);
    assert.notEqual(await c.host(1).store().object(fresh), null);
  });

  it("leaves the source refusing, and the client finds the new owner", async () => {
    const { c, db, issue } = await seeded();
    c.mover.begin(5n, 1);
    await c.mover.run(5n);

    assert.equal(c.host(0).vshards().find((v) => v.vshard === 5), undefined, "purged");
    const version = await db.update(issue, { title: "edited" });
    assert.equal(version, 2);
  });

  it("never lets both hosts accept a write, at any step", async () => {
    const { c, issue } = await seeded();
    // A write at whatever epoch that host believes, which is the most generous thing a caller could
    // do: if it is accepted, that host would have taken the write.
    const accepts = (host: number) => {
      if (!c.hosts.has(host)) return false;
      const epoch = c.host(host).vshards().find((v) => v.vshard === 5)?.epoch ?? -1;
      return c.host(host).update({ id: issue, data: { title: `via ${host}` }, epoch }).ok;
    };
    const check = (where: string) => {
      const taking = [0, 1].filter(accepts);
      assert.ok(taking.length <= 1, `after ${where}, hosts ${taking.join(" and ")} both took a write`);
    };

    c.mover.begin(5n, 1);
    check("begin");
    for (const step of ["fence", "copy", "flip", "retire", "purge"] as const) {
      // Stop the move just after this step by failing the next one.
      const order = ["fence", "snapshot", "install", "retire", "purge"] as const;
      c.heal();
      const next = order[order.indexOf(step === "copy" ? "install" : step === "flip" ? "retire" : step) + 1];
      if (next) c.failAt(next);
      await c.mover.run(5n).catch(() => {});
      check(step);
      if (!c.mover.pending(5n)) break;
    }
    c.heal();
    if (c.mover.pending(5n)) await c.mover.run(5n);
    assert.equal(c.holderOf(5n), 1);
  });

  it("reads keep working while the source is fenced", async () => {
    const { c, db, issue } = await seeded();
    c.mover.begin(5n, 1);
    // Fence only.
    await c.mover.hosts.fence(0, "5");
    const out = await page(db, issue);
    assert.equal(out[0].commentCount, 3, "a fenced vshard still serves reads");
  });

  it("pauses a write for the length of the copy instead of failing it", async () => {
    const { c, db, issue } = await seeded();
    c.mover.begin(5n, 1);
    await c.mover.hosts.fence(0, "5");
    c.directory.sql.run("UPDATE moves SET state = 'copy' WHERE vshard = 5");

    // The write starts while the vshard is fenced; the move completes underneath it.
    let finished = false;
    const writing = db
      .write<number>({ kind: "update", id: issue, data: { title: "edited" } }, { deadlineMs: 2_000 })
      .then((v) => {
        finished = true;
        return v;
      });
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(finished, false, "it waited rather than erroring");

    await c.mover.run(5n);
    assert.equal(await writing, 2);
    assert.equal(c.holderOf(5n), 1);
  });

  it("gives up with a clear reason if the fence never lifts", async () => {
    const { c, db, issue } = await seeded();
    c.host(0).setState("5", "fenced");
    await assert.rejects(
      () => db.write({ kind: "update", id: issue, data: { title: "x" } }, { deadlineMs: 25 }),
      /still fenced after 25 ms/,
    );
  });
});

describe("a move interrupted", () => {
  it("resumes from the step it recorded, rather than leaving the vshard fenced", async () => {
    const { c, db, issue } = await seeded();
    const before = await page(db, issue);

    c.mover.begin(5n, 1);
    c.kill(1); // the target falls over during the copy
    await assert.rejects(() => c.mover.run(5n), MoveFailed);

    assert.equal(c.mover.pending(5n)?.state, "copy", "it stopped at the copy and said so");
    assert.equal(c.holderOf(5n), 0, "the route did not flip");
    assert.equal(c.host(0).vshards().find((v) => v.vshard === 5)?.state, "fenced");

    c.revive(1);
    assert.equal(await c.mover.run(5n), "done", "an alarm picks it back up");
    assert.equal(c.holderOf(5n), 1);
    assert.deepEqual(await page(db, issue), before);
  });

  it("is safe to resume whichever step crashed", async () => {
    for (const step of ["fence", "snapshot", "install", "retire", "purge"] as const) {
      const { c, db, issue } = await seeded();
      const before = await page(db, issue);

      c.mover.begin(5n, 1);
      c.failAt(step);
      await assert.rejects(() => c.mover.run(5n), MoveFailed, `${step} should have failed the move`);
      assert.ok(c.mover.pending(5n), `${step} left a move to resume`);

      c.heal();
      assert.equal(await c.mover.run(5n), "done", `resumable after ${step}`);
      assert.equal(c.holderOf(5n), 1, `landed after ${step} crashed`);
      assert.deepEqual(await page(db, issue), before, `data intact after ${step} crashed`);
    }
  });

  it("recovers every move in flight from one call, as an alarm would", async () => {
    const { c } = await seeded();
    c.mover.begin(5n, 1);
    c.mover.begin(6n, 1);
    c.failAt("install");
    await assert.rejects(() => c.mover.resume());
    assert.equal(c.mover.inFlight().length, 2);

    c.heal();
    await c.mover.resume();
    assert.equal(c.mover.inFlight().length, 0);
    assert.equal(c.holderOf(5n), 1);
    assert.equal(c.holderOf(6n), 1);
  });

  it("stops retrying a step that keeps failing, rather than hammering it", async () => {
    const { c } = await seeded();
    const mover = new Mover(c.directory, c.mover.hosts, 2);
    mover.begin(7n, 1);
    c.failAt("fence");
    for (let i = 0; i < 2; i++) await mover.run(7n).catch(() => {});
    await assert.rejects(() => mover.run(7n), /leaving it alone/);
  });
});

describe("a move under write load", () => {
  it("loses no write and duplicates no id", async () => {
    const { c, db, issue } = await seeded();
    const bodies = [...Array(12)].map((_, i) => `w${i}`);

    // Writes and the move run together. Each write pauses if it meets the fence.
    const writes = bodies.map(async (body) => {
      const id = await db.write<string>({ kind: "create", otype: COMMENT, data: { body }, with: issue }, { deadlineMs: 2_000 });
      await db.write({ kind: "assocAdd", atype: ISSUE_COMMENT, id1: issue, id2: id, time: 100 }, { deadlineMs: 2_000 });
      return id;
    });
    c.mover.begin(5n, 1);
    const moving = c.mover.run(5n);
    const ids = await Promise.all(writes);
    await moving;

    assert.equal(new Set(ids).size, ids.length, "no id was handed out twice");
    const out = await page(db, issue);
    assert.equal(out[0].commentCount, 3 + bodies.length, "every write survived the move");
    const got = new Set(out[0].comments.map((x) => x.body));
    for (const body of bodies) assert.ok(got.has(body), `${body} survived`);
  });
});
