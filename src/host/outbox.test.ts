import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan } from "../catalog/catalog.ts";
import { LocalCluster } from "../client/local.ts";
import { Deliverer, groups } from "./outbox.ts";
import type { OutboxRow } from "./host.ts";

// An assignment and its inverse, from the design's second example: assigning a task writes
// task -assignee-> alice on the task's host and alice -assigned_tasks-> task on Alice's.
const LOCK = plan({
  core: { objects: { "core.user": { fields: { name: "string" } } } },
  tasks: {
    objects: { "tasks.task": { fields: { title: "string" } } },
    edges: {
      "tasks.assignee": { from: "tasks.task", to: "core.user", inverse: "tasks.assigned", unique: true },
      "tasks.assigned": { from: "core.user", to: "tasks.task", inverse: "tasks.assignee" },
    },
  },
});
const CATALOG = Catalog.compile(LOCK);
const TASK = CATALOG.objectNamed("tasks.task")!.otype;
const USER = CATALOG.objectNamed("core.user")!.otype;
const ASSIGNEE = CATALOG.edgeNamed("tasks.assignee")!.atype!;
const ASSIGNED = CATALOG.edgeNamed("tasks.assigned")!.atype!;

/** Tasks on vshard 5 and users on vshard 40, moved onto separate hosts so every inverse is remote. */
async function split() {
  const c = new LocalCluster();
  c.directory.applyLock(LOCK);
  c.spreadCatalog();
  c.mover.begin(40n, 1);
  await c.mover.run(40n);
  c.spreadCatalog();
  await c.publish();
  const db = c.client();
  const alice = await db.create(USER, { name: "alice" }, { vshard: "40" });
  return { c, db, alice };
}

const assignedTo = async (c: LocalCluster, host: number, user: string) =>
  await c.host(host).store().count(user, ASSIGNED);

describe("grouping", () => {
  it("keeps each source and target pair in sequence order, and separates pairs", () => {
    const row = (vshard: number, seq: number, target: number): OutboxRow => ({
      vshard,
      seq,
      target_vshard: target,
      op: { kind: "delete", id: "1" },
    });
    const out = groups([row(5, 2, 40), row(5, 1, 40), row(5, 1, 41), row(6, 1, 40)]);
    assert.equal(out.length, 3);
    const pair = out.find((g) => g[0].vshard === 5 && g[0].target_vshard === 40)!;
    assert.deepEqual(pair.map((r) => r.seq), [1, 2]);
  });
});

describe("delivering an inverse to another host", () => {
  it("arrives, and the row is dropped once acknowledged", async () => {
    const { c, db, alice } = await split();
    const task = await db.create(TASK, { title: "ship it" }, { vshard: "5" });
    await db.assocAdd(ASSIGNEE, task, alice, 1);

    assert.equal(c.queued(), 1, "the inverse is on another host, so it was queued");
    assert.equal(await assignedTo(c, 1, alice), 0, "and has not arrived yet");

    const pass = await new Deliverer(c.host(0), db).drain();
    assert.deepEqual({ delivered: pass.delivered, pending: pass.pending }, { delivered: 1, pending: 0 });
    assert.equal(await assignedTo(c, 1, alice), 1, "listing Alice's tasks is now one read on one host");
  });

  it("is a no-op when redelivered after a lost acknowledgement", async () => {
    const { c, db, alice } = await split();
    const task = await db.create(TASK, { title: "t" }, { vshard: "5" });
    await db.assocAdd(ASSIGNEE, task, alice, 1);
    const row = c.host(0).pending()[0];

    await db.write({ kind: "apply", op: row.op });
    await db.write({ kind: "apply", op: row.op }); // the ack was lost, so the alarm sends it again
    assert.equal(await assignedTo(c, 1, alice), 1, "counted once, not twice");
  });

  it("withdraws the inverse when the forward edge goes", async () => {
    const { c, db, alice } = await split();
    const task = await db.create(TASK, { title: "t" }, { vshard: "5" });
    await db.assocAdd(ASSIGNEE, task, alice, 1);
    await c.deliverAll();
    assert.equal(await assignedTo(c, 1, alice), 1);

    await db.assocRemove(ASSIGNEE, task, alice);
    await c.deliverAll();
    assert.equal(await assignedTo(c, 1, alice), 0);
    assert.equal(c.queued(), 0);
  });

  it("applies an add and its later remove in order, never the other way round", async () => {
    const { c, db, alice } = await split();
    const task = await db.create(TASK, { title: "t" }, { vshard: "5" });
    await db.assocAdd(ASSIGNEE, task, alice, 1);
    await db.assocRemove(ASSIGNEE, task, alice);

    const queued = c.host(0).pending();
    assert.deepEqual(queued.map((r) => r.op.kind), ["add", "remove"]);
    await c.deliverAll();
    // Applied out of order, the remove would land first and the add would leave a stale edge.
    assert.equal(await assignedTo(c, 1, alice), 0);
  });

  // Found by the simulation, which writes lazily and so lets two sources interleave. The design says
  // "each inverse edge has exactly one writer, the vshard of its forward edge, so per-source ordering
  // is enough". That holds while a caller writes one side of a pair. Write both between the same two
  // objects and there are two writers for the same two rows, with no ordering between them — so what
  // survives is decided by whichever source is delivered last. Recorded as an open question; the
  // generators keep to one side per pair of objects so the rest of the suite is not asking it.
  it("is left holding half a pair when both its sides are written, which the design records as open", async () => {
    const { c, db, alice } = await split();
    const task = await db.create(TASK, { title: "t" }, { vshard: "5" });

    await db.assocAdd(ASSIGNEE, task, alice, 1);
    await db.assocRemove(ASSIGNEE, task, alice); // task's vshard: add, then withdraw
    await db.assocAdd(ASSIGNED, alice, task, 1); // Alice's vshard, maintaining the other half
    await c.deliverAll();
    assert.equal(c.queued(), 0, "everything was delivered");

    assert.equal(await assignedTo(c, 1, alice), 0, "the withdrawal through the task's vshard landed");
    assert.equal(
      await c.host(0).store().count(task, ASSIGNEE),
      1,
      "and the add through Alice's put the other half back, which nothing asked for",
    );
  });

  it("stops a pair at its first failure, so nothing overtakes it, and other pairs carry on", async () => {
    const { c, db, alice } = await split();
    const task = await db.create(TASK, { title: "t" }, { vshard: "5" });
    await db.assocAdd(ASSIGNEE, task, alice, 1);
    await db.assocRemove(ASSIGNEE, task, alice);
    assert.equal(c.queued(), 2);

    // Retire the target vshard everywhere, so delivery cannot place it.
    c.host(1).setState("40", "moved");
    const pass = await new Deliverer(c.host(0), db).drain();
    assert.equal(pass.delivered, 0);
    assert.equal(pass.stalled, 1);
    assert.equal(c.queued(), 2, "both rows are still there for the next alarm");

    c.host(1).adopt("40", c.directory.resolve(40n)!.epoch);
    await c.deliverAll();
    assert.equal(c.queued(), 0);
    assert.equal(await assignedTo(c, 1, alice), 0, "and they applied in order when they did land");
  });
});

describe("delivery across a move", () => {
  it("finds the target's new owner and retries there", async () => {
    const { c, db, alice } = await split();
    const task = await db.create(TASK, { title: "t" }, { vshard: "5" });
    await db.assocAdd(ASSIGNEE, task, alice, 1);
    assert.equal(c.queued(), 1);

    // The target moves before the row is ever delivered.
    c.mover.begin(40n, 2);
    await c.mover.run(40n);
    c.spreadCatalog();

    await c.deliverAll();
    assert.equal(c.queued(), 0);
    assert.equal(await assignedTo(c, 2, alice), 1, "it landed on the host that owns the vshard now");
  });

  it("carries undelivered rows with the source vshard when that moves", async () => {
    const { c, db, alice } = await split();
    const task = await db.create(TASK, { title: "t" }, { vshard: "5" });
    await db.assocAdd(ASSIGNEE, task, alice, 1);
    assert.equal(c.host(0).pending().length, 1);

    // Move the source. Outbox rows belong to their source vshard and move with it.
    c.mover.begin(5n, 3);
    await c.mover.run(5n);
    c.spreadCatalog();

    assert.equal(c.host(0).pending().length, 0, "they left with the vshard");
    assert.equal(c.host(3).pending().length, 1, "and arrived with it");
    await c.deliverAll();
    assert.equal(await assignedTo(c, 1, alice), 1);
  });

  it("delivers a cascade that crossed a vshard", async () => {
    const c = new LocalCluster();
    const lock = plan({
      issues: {
        objects: { "issues.issue": { fields: {} }, "issues.comment": { fields: {} } },
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
    const cat = Catalog.compile(lock);
    c.directory.applyLock(lock);
    c.spreadCatalog();
    c.mover.begin(40n, 1);
    await c.mover.run(40n);
    c.spreadCatalog();
    await c.publish();

    const db = c.client();
    const issue = await db.create(cat.objectNamed("issues.issue")!.otype, {}, { vshard: "5" });
    const far = await db.create(cat.objectNamed("issues.comment")!.otype, {}, { vshard: "40" });
    await db.assocAdd(cat.edgeNamed("issues.issue_comment")!.atype!, issue, far, 1);
    await c.deliverAll();

    await db.delete(issue);
    await c.deliverAll();
    assert.equal(await c.host(1).store().object(far), null, "the cascade reached the other vshard");
  });
});
