import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan } from "../catalog/catalog.ts";
import { LocalCluster } from "../client/local.ts";
import type { LocalOptions } from "../client/local.ts";
import type { ChunkBudget } from "../host/host.ts";
import { vshardOf } from "../host/ids.ts";
import { nodeSql } from "../host/sql.node.ts";
import type { Sql } from "../host/sql.ts";
import type { Plan } from "../query/types.ts";
import { MoveFailed, Mover } from "./move.ts";
import type { MoveHosts } from "./move.ts";

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
async function seeded(opts: LocalOptions = {}) {
  const c = new LocalCluster(opts);
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
    for (const step of ["fence", "snapshot", "install", "discard", "retire", "purge"] as const) {
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

// ---- a copy in chunks

/** A row a chunk, so the vshard in `seeded` crosses in many of them. */
const ROW: ChunkBudget = { rows: 1, bytes: Infinity };

/** The cluster's own move hosts, counting copies and falling over after `failAfter` of them. */
function counting(hosts: MoveHosts, failAfter = Infinity) {
  const seen = { copies: 0 };
  const wrapped: MoveHosts = {
    ...hosts,
    copy: async (...args) => {
      if (seen.copies >= failAfter) throw new Error("the copy fell over");
      const next = await hosts.copy(...args);
      seen.copies++;
      return next;
    },
  };
  return { wrapped, seen };
}

/** How many chunks a whole copy of vshard 5 takes at a row a chunk. */
async function chunksInVshard5(): Promise<number> {
  const { c } = await seeded();
  const { wrapped, seen } = counting(c.mover.hosts);
  const mover = new Mover(c.directory, wrapped, 8, ROW);
  mover.begin(5n, 1);
  await mover.run(5n);
  return seen.copies;
}

describe("a move in chunks", () => {
  it("carries a vshard a row at a time, data, counts and sequence", async () => {
    const { c, db, issue } = await seeded();
    const before = await page(db, issue);
    const seq = c.host(0).vshards().find((v) => v.vshard === 5)!.next_seq;
    const { wrapped, seen } = counting(c.mover.hosts);
    const mover = new Mover(c.directory, wrapped, 8, ROW);

    mover.begin(5n, 1);
    assert.equal(await mover.run(5n), "done");

    assert.ok(seen.copies >= 10, `a vshard of a dozen rows took ${seen.copies} chunks`);
    assert.equal(c.holderOf(5n), 1);
    assert.deepEqual(await page(db, issue), before);
    assert.equal(c.host(1).vshards().find((v) => v.vshard === 5)!.next_seq, seq);
    assert.equal(c.host(0).stateOf(5n), "absent", "purged, a row a call");
  });

  it("resumes a copy that fell over from its cursor, not from the top", async () => {
    const total = await chunksInVshard5();
    const { c, db, issue } = await seeded();
    const before = await page(db, issue);

    const first = counting(c.mover.hosts, 4);
    const dying = new Mover(c.directory, first.wrapped, 8, ROW);
    dying.begin(5n, 1);
    await assert.rejects(() => dying.run(5n), MoveFailed);

    const move = c.mover.pending(5n)!;
    assert.equal(move.state, "copy");
    assert.match(move.cursor ?? "", /"table"/, "the cursor was recorded");
    assert.equal(c.holderOf(5n), 0, "the route did not flip");
    assert.equal(c.host(0).stateOf(5n), "fenced");
    assert.equal(c.host(1).stateOf(5n), "absent", "four chunks in, the target serves none of it");

    const second = counting(c.mover.hosts);
    assert.equal(await new Mover(c.directory, second.wrapped, 8, ROW).run(5n), "done");
    assert.equal(second.seen.copies, total - 4, "exactly the chunks the first run did not finish");
    assert.deepEqual(await page(db, issue), before);
  });

  it("starts a copy from the top on an empty target, so nothing an abandoned copy left comes back", async () => {
    const { c, db, issue, comments } = await seeded();
    const dying = new Mover(c.directory, counting(c.mover.hosts, 3).wrapped, 8, ROW);
    dying.begin(5n, 1);
    await assert.rejects(() => dying.run(5n), MoveFailed);

    // Abandoned by hand: the record dropped and the source unfenced. The first comment was among
    // the rows the copy had already staged on host 1, and it is deleted after.
    c.directory.sql.run("DELETE FROM moves WHERE vshard = 5");
    c.host(0).setState("5", "owned");
    await db.delete(comments[0]);

    c.mover.begin(5n, 1);
    assert.equal(await new Mover(c.directory, c.mover.hosts, 8, ROW).run(5n), "done");
    assert.equal(c.holderOf(5n), 1);
    assert.equal(await c.host(1).store().object(comments[0]), null, "the deleted comment stayed deleted");
    const out = await page(db, issue);
    assert.equal(out[0].commentCount, 2);
    assert.deepEqual(out[0].comments.map((x) => x.body).sort(), ["c2", "c3"]);
  });

  it("fences again and copies from the top when the source is found taking writes", async () => {
    const { c, db, issue } = await seeded();
    const dying = new Mover(c.directory, counting(c.mover.hosts, 2).wrapped, 8, ROW);
    dying.begin(5n, 1);
    await assert.rejects(() => dying.run(5n), MoveFailed);

    // Something unfenced the source mid-copy, and a write landed on it.
    c.host(0).setState("5", "owned");
    assert.equal(await db.update(issue, { title: "written mid-copy" }), 2);

    assert.equal(await new Mover(c.directory, c.mover.hosts, 8, ROW).run(5n), "done");
    assert.equal(c.holderOf(5n), 1);
    assert.equal((await page(db, issue))[0].title, "written mid-copy", "the write is on the new owner");
  });

  it("fails loudly rather than copying in a loop when the source will not stay fenced", async () => {
    const { c } = await seeded();
    const leaky: MoveHosts = { ...c.mover.hosts, fence: async () => {} };
    const mover = new Mover(c.directory, leaky, 8, ROW);
    mover.begin(5n, 1);
    await assert.rejects(() => mover.run(5n), /not fenced/);
    assert.equal(c.holderOf(5n), 0);
  });

  it("is not unfenced by a restart in the middle of it", async () => {
    const files = new Map<string, Sql>();
    const storage = (name: string) => files.get(name) ?? files.set(name, nodeSql()).get(name)!;
    const { c, db, issue } = await seeded({ storage });
    const before = await page(db, issue);
    const dying = new Mover(c.directory, counting(c.mover.hosts, 3).wrapped, 8, ROW);
    dying.begin(5n, 1);
    await assert.rejects(() => dying.run(5n), MoveFailed);

    // The process restarts over the same storage.
    const reopened = new LocalCluster({ storage });
    assert.equal(reopened.host(0).stateOf(5n), "fenced", "reopening adopted nothing that was mid-move");
    await reopened.publish();
    assert.equal(await new Mover(reopened.directory, reopened.mover.hosts, 8, ROW).run(5n), "done");
    assert.deepEqual(await page(reopened.client(), issue), before);
  });

  it("resumes a move a directory recorded before copies were chunked", async () => {
    const { c, db, issue } = await seeded();
    const before = await page(db, issue);
    c.directory.sql.run("DROP TABLE moves");
    c.directory.sql.run(
      "CREATE TABLE moves (vshard INTEGER PRIMARY KEY, from_host INTEGER NOT NULL, to_host INTEGER NOT NULL," +
        " epoch INTEGER NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)",
    );
    c.directory.sql.run("INSERT INTO moves (vshard, from_host, to_host, epoch, state) VALUES (5, 0, 1, 1, 'copy')");
    await c.mover.hosts.fence(0, "5");

    const mover = new Mover(c.directory, c.mover.hosts, 8, ROW);
    assert.equal(mover.pending(5n)?.cursor, null, "the column was added, empty");
    assert.equal(await mover.run(5n), "done");
    assert.deepEqual(await page(db, issue), before);
  });
});
