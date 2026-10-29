import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAsync, runRounds } from "../query/driver.ts";
import type { HostClient, Stats } from "../query/driver.ts";
import { UNKNOWN, cmpId } from "../query/types.ts";
import type { Id, Json, Maybe, Plan } from "../query/types.ts";
import { Catalog, plan } from "../catalog/catalog.ts";
import { Host } from "./host.ts";
import type { Reply } from "./host.ts";
import { MAX_SEQ, fromKey, makeId, parseId, toKey, vshardOf, vshardRange } from "./ids.ts";
import { nodeSql } from "./sql.node.ts";

// The issue tracker from the design, planned the way a real one would be: domain files with no
// integers, a lock that assigns them, and a catalog compiled from the lock.
const LOCK = plan({
  core: { objects: { "core.user": { fields: { name: "string" } } } },
  issues: {
    objects: {
      "issues.issue": { fields: { title: "string" } },
      "issues.comment": { fields: { body: "string", authorId: { id: "core.user" } } },
    },
    edges: {
      // Comments are the issue's to keep: deleting the issue deletes them.
      "issues.issue_comment": {
        from: "issues.issue",
        to: "issues.comment",
        inverse: "issues.comment_issue",
        onDelete: "cascade",
      },
      "issues.comment_issue": { from: "issues.comment", to: "issues.issue", inverse: "issues.issue_comment" },
      // The owner is a person, who outlives the issue.
      "issues.issue_owner": { from: "issues.issue", to: "core.user", inverse: "issues.user_owned", unique: true },
      "issues.user_owned": { from: "core.user", to: "issues.issue", inverse: "issues.issue_owner" },
      "issues.comment_author": { from: "issues.comment", to: "core.user", field: "authorId" },
      // An issue that blocks another cannot be deleted out from under it.
      "issues.issue_blocks": { from: "issues.issue", to: "issues.issue", onDelete: "restrict" },
    },
  },
});
const CATALOG = Catalog.compile(LOCK);

const otype = (name: string) => CATALOG.objectNamed(name)!.otype;
const atype = (name: string) => CATALOG.edgeNamed(name)!.atype!;
const ISSUE = otype("issues.issue");
const COMMENT = otype("issues.comment");
const USER = otype("core.user");
const ISSUE_COMMENT = atype("issues.issue_comment");
const COMMENT_ISSUE = atype("issues.comment_issue");
const ISSUE_OWNER = atype("issues.issue_owner");
const USER_OWNED = atype("issues.user_owned");
const ISSUE_BLOCKS = atype("issues.issue_blocks");

const open = (...vshards: string[]) => {
  const h = Host.open(nodeSql(), CATALOG);
  for (const v of vshards) h.adopt(v);
  return h;
};
const ok = <T>(r: Reply<T>): T => {
  assert.equal(r.ok, true, `refused: ${JSON.stringify(r)}`);
  return (r as { ok: true; value: T }).value;
};
/** Asserts a write was refused because the host does not own the vshard, and returns why. */
const refused = <T>(r: Reply<T>) => {
  assert.equal(r.ok, false);
  assert.ok(!r.ok && "refused" in r, `expected a refusal, got ${JSON.stringify(r)}`);
  return (r as { ok: false; refused: { vshard: string; state: string; epoch: number } }).refused;
};
/** Asserts a read settled, so the test reads an answer and not "not known here". */
const known = <T>(v: Maybe<T>): T => {
  assert.notEqual(v, UNKNOWN, "expected a known read");
  return v as T;
};

describe("ids", () => {
  it("round-trips through the 8-byte key", () => {
    for (const id of ["0", "1", makeId(0n, MAX_SEQ), makeId(1n, 0n), makeId((1n << 24n) - 1n, MAX_SEQ)]) {
      assert.equal(fromKey(toKey(id)), id);
    }
  });

  it("puts the vshard in the high bits", () => {
    assert.equal(vshardOf(makeId(7n, 42n)), 7n);
    assert.equal(vshardOf("0"), 0n);
  });

  it("covers a vshard's whole slab, and only it", () => {
    const [lo, hi] = vshardRange(5n);
    assert.equal(fromKey(lo), makeId(5n, 0n));
    assert.equal(fromKey(hi), makeId(5n, MAX_SEQ));
    assert.equal(BigInt(fromKey(hi)) + 1n, BigInt(makeId(6n, 0n)));
  });

  it("fails loudly rather than coercing", () => {
    assert.throws(() => parseId("1e3"), TypeError);
    assert.throws(() => parseId("-1"), TypeError);
    assert.throws(() => parseId("01"), TypeError);
    assert.throws(() => makeId(1n << 24n, 0n), RangeError);
    assert.throws(() => makeId(0n, MAX_SEQ + 1n), RangeError);
  });

  it("orders ids numerically, as the blob keys do", () => {
    // Plain string compare would put "10" before "9" and disagree with the host.
    assert.equal(cmpId("9", "10"), -1);
    const ids = ["9", "10", "100", "11"];
    assert.deepEqual([...ids].sort(cmpId), ["9", "10", "11", "100"]);
  });
});

describe("objects", () => {
  it("creates, reads, updates and deletes", async () => {
    const h = open("1");
    const id = ok(h.create({ otype: ISSUE, data: { title: "Crash on save" }, vshard: "1", epoch: 0 }));
    assert.equal(vshardOf(id), 1n);

    const store = h.store();
    assert.deepEqual(await store.object(id), { id, otype: ISSUE, version: 1, data: { title: "Crash on save" } });

    assert.equal(ok(h.update({ id, data: { title: "edited" }, epoch: 0 })), 2);
    const after = await h.store().object(id);
    assert.deepEqual(after, { id, otype: ISSUE, version: 2, data: { title: "edited" } });

    ok(h.delete({ id, epoch: 0 }));
    assert.equal(await h.store().object(id), null); // known absent, not UNKNOWN
  });

  it("hands out ascending sequences within a vshard", () => {
    const h = open("3");
    const ids = [0, 1, 2].map(() => ok(h.create({ otype: ISSUE, data: {}, vshard: "3", epoch: 0 })));
    assert.deepEqual(ids, [makeId(3n, 0n), makeId(3n, 1n), makeId(3n, 2n)]);
    assert.equal(h.vshards()[0].next_seq, 3);
  });

  it("colocates a child with its parent", () => {
    const h = open("1", "2");
    const issue = ok(h.create({ otype: ISSUE, data: {}, vshard: "2", epoch: 0 }));
    const comment = ok(h.create({ otype: COMMENT, data: { body: "hi" }, with: issue, epoch: 0 }));
    assert.equal(vshardOf(comment), vshardOf(issue));
  });

  it("reads UNKNOWN for a vshard it does not own", async () => {
    const h = open("1");
    assert.equal(await h.store().object(makeId(9n, 0n)), UNKNOWN);
  });

  it("refuses a write to a vshard it does not own, and writes nothing", async () => {
    const h = open("1");
    assert.deepEqual(refused(h.create({ otype: ISSUE, data: {}, vshard: "9", epoch: 0 })), {
      vshard: "9",
      state: "absent",
      epoch: -1,
    });

    const id = ok(h.create({ otype: ISSUE, data: { v: 1 }, vshard: "1", epoch: 0 }));
    h.setState("1", "fenced");
    assert.deepEqual(refused(h.update({ id, data: { v: 2 }, epoch: 0 })), {
      vshard: "1",
      state: "fenced",
      epoch: 0,
    });

    h.setState("1", "owned");
    assert.deepEqual(known(await h.store().object(id))?.data, { v: 1 }); // the refused write left no trace
  });

  it("refuses a write routed at a stale epoch", () => {
    const h = open("1");
    h.adopt("1", 4); // as if a move had landed it here at epoch 4
    assert.deepEqual(refused(h.create({ otype: ISSUE, data: {}, vshard: "1", epoch: 3 })), {
      vshard: "1",
      state: "owned",
      epoch: 4,
    });
    ok(h.create({ otype: ISSUE, data: {}, vshard: "1", epoch: 4 }));
  });
});

describe("edges", () => {
  const seed = () => {
    const h = open("1");
    const issue = ok(h.create({ otype: ISSUE, data: { title: "i" }, vshard: "1", epoch: 0 }));
    const comments = [1, 2, 3].map((t) => {
      const c = ok(h.create({ otype: COMMENT, data: { body: `c${t}` }, with: issue, epoch: 0 }));
      ok(h.assocAdd({ atype: ISSUE_COMMENT, id1: issue, id2: c, time: t, epoch: 0 }));
      return c;
    });
    return { h, issue, comments };
  };

  it("reads a list newest first and maintains its count", async () => {
    const { h, issue, comments } = seed();
    const page = known(await h.store().edges(issue, ISSUE_COMMENT, null, 10));
    assert.deepEqual(page.rows.map((e) => e.id2), [...comments].reverse());
    assert.equal(page.complete, true);
    assert.equal(await h.store().count(issue, ISSUE_COMMENT), 3);
  });

  it("pages with an exact cursor and knows whether the list goes on", async () => {
    const { h, issue, comments } = seed();
    const first = known(await h.store().edges(issue, ISSUE_COMMENT, null, 2));
    assert.equal(first.complete, false); // a third row exists
    const last = first.rows[first.rows.length - 1];
    const next = known(await h.store().edges(issue, ISSUE_COMMENT, { time: last.time, id2: last.id2 }, 2));
    assert.deepEqual(next.rows.map((e) => e.id2), [comments[0]]);
    assert.equal(next.complete, true);
  });

  it("counts zero for a list that never existed", async () => {
    const { h, issue } = seed();
    assert.equal(await h.store().count(issue, 99), 0);
  });

  it("is idempotent on add and remove", async () => {
    const { h, issue, comments } = seed();
    ok(h.assocAdd({ atype: ISSUE_COMMENT, id1: issue, id2: comments[0], time: 9, epoch: 0 }));
    assert.equal(await h.store().count(issue, ISSUE_COMMENT), 3); // re-add moved it, did not duplicate

    ok(h.assocRemove({ atype: ISSUE_COMMENT, id1: issue, id2: comments[0], epoch: 0 }));
    ok(h.assocRemove({ atype: ISSUE_COMMENT, id1: issue, id2: comments[0], epoch: 0 }));
    assert.equal(await h.store().count(issue, ISSUE_COMMENT), 2); // the second remove is a no-op
  });
});

describe("inverse edges", () => {
  it("writes a colocated pair inline, in the same transaction", async () => {
    const h = open("1");
    const issue = ok(h.create({ otype: ISSUE, data: {}, vshard: "1", epoch: 0 }));
    const user = ok(h.create({ otype: USER, data: {}, vshard: "1", epoch: 0 }));
    ok(h.assocAdd({ atype: ISSUE_OWNER, id1: issue, id2: user, time: 1, epoch: 0 }));

    assert.equal(await h.store().count(user, USER_OWNED), 1);
    assert.equal(h.pending().length, 0); // nothing queued: it went in with the forward edge
  });

  it("queues an inverse bound for another host, and delivers it idempotently", async () => {
    const a = open("1");
    const b = open("2");
    const issue = ok(a.create({ otype: ISSUE, data: {}, vshard: "1", epoch: 0 }));
    const user = ok(b.create({ otype: USER, data: {}, vshard: "2", epoch: 0 }));

    ok(a.assocAdd({ atype: ISSUE_OWNER, id1: issue, id2: user, time: 1, epoch: 0 }));
    const rows = a.pending();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target_vshard, 2);
    assert.equal(rows[0].op.kind, "add");

    ok(b.apply(rows[0].op));
    ok(b.apply(rows[0].op)); // a redelivery after a lost ack is a no-op
    assert.equal(await b.store().count(user, USER_OWNED), 1);

    a.ack(rows[0].vshard, rows[0].seq);
    assert.equal(a.pending().length, 0);
  });

  it("queues removes in order behind adds, per source vshard", () => {
    const a = open("1");
    const issue = ok(a.create({ otype: ISSUE, data: {}, vshard: "1", epoch: 0 }));
    const far = makeId(2n, 0n);
    ok(a.assocAdd({ atype: ISSUE_OWNER, id1: issue, id2: far, time: 1, epoch: 0 }));
    ok(a.assocRemove({ atype: ISSUE_OWNER, id1: issue, id2: far, epoch: 0 }));
    assert.deepEqual(a.pending().map((r) => [r.seq, r.op.kind]), [[1, "add"], [2, "remove"]]);
  });
});

describe("the same query over one host and two", () => {
  // The oracle from the design: a query across hosts must equal the query against one host that holds
  // every vshard. Here the issue sits in vshard 1 with its comments colocated, and the authors sit in
  // vshard 2, so the two-host run has to cross the network for them and the one-host run does not.
  const plan: Plan = {
    frames: [
      {
        source: { kind: "ids" },
        children: [{ alias: "comments", frame: 1 }],
        counts: [{ alias: "commentCount", atype: ISSUE_COMMENT }],
      },
      {
        source: { kind: "edge", atype: ISSUE_COMMENT },
        limit: 10,
        children: [{ alias: "author", frame: 2 }],
        counts: [],
      },
      { source: { kind: "field", field: "authorId" }, limit: 1, children: [], counts: [] },
    ],
  };

  /** Lays the same graph down over a given set of hosts, with authors on the last one. */
  const build = (hosts: Host[], authorHost: Host) => {
    const issues = hosts[0];
    const alice = ok(authorHost.create({ otype: USER, data: { name: "alice" }, vshard: authorHost === issues ? "1" : "2", epoch: 0 }));
    const bob = ok(authorHost.create({ otype: USER, data: { name: "bob" }, vshard: authorHost === issues ? "1" : "2", epoch: 0 }));
    const issue = ok(issues.create({ otype: ISSUE, data: { title: "Crash on save" }, vshard: "1", epoch: 0 }));
    const authors = [alice, bob, bob, alice, bob];
    authors.forEach((a, i) => {
      const c = ok(issues.create({ otype: COMMENT, data: { body: `c${i + 1}`, authorId: a }, with: issue, epoch: 0 }));
      ok(issues.assocAdd({ atype: ISSUE_COMMENT, id1: issue, id2: c, time: i + 1, epoch: 0 }));
    });
    return issue;
  };

  const client = (h: Host): HostClient => ({ exec: (plan, tasks) => h.exec(plan, tasks) });

  interface Run {
    out: Json[];
    stats: Stats;
  }

  const answers = async (): Promise<Run[]> => {
    const one = open("1", "2");
    const root1 = build([one], one);
    const route1 = () => client(one);

    const issues = open("1");
    const users = open("2");
    const root2 = build([issues], users);
    const byVshard = (id: Id) => (vshardOf(id) === 1n ? client(issues) : client(users));

    const go = async (driver: typeof runRounds, root: Id, route: (id: Id) => HostClient): Promise<Run> => {
      const stats: Stats = { rounds: 0, requests: 0 };
      return { out: await driver(plan, [root], route, stats), stats };
    };
    return [
      await go(runRounds, root1, route1),
      await go(runAsync, root1, route1),
      await go(runRounds, root2, byVshard),
      await go(runAsync, root2, byVshard),
    ];
  };

  it("needs one request when everything is colocated and more when it is not", async () => {
    const [one, , two] = await answers();
    // The issue and its comments share a vshard, and the host prefetches below the root, so a host
    // that also holds the authors answers the whole query in one request.
    assert.equal(one.stats.requests, 1);
    assert.ok(two.stats.requests > 1, `expected a second host to be asked, got ${two.stats.requests}`);
  });

  it("agrees across drivers and placements", async () => {
    const [{ out: a }, { out: b }, { out: c }, { out: d }] = await answers();
    // Ids differ between the two layouts, so compare the shape the query asked for.
    const shape = (x: Json[]) => JSON.stringify(x, (k, v) => (k === "id" || k === "authorId" ? undefined : v));
    assert.equal(shape(a), shape(b));
    assert.equal(shape(c), shape(d));
    assert.equal(shape(a), shape(c), "a query across hosts must equal the same query on one host");
  });

  it("reads the comments and their authors", async () => {
    const [{ out: a }] = await answers();
    const root = a[0] as { commentCount: number; comments: { body: string; author: { name: string }[] }[] };
    assert.equal(root.commentCount, 5);
    assert.deepEqual(
      root.comments.map((c) => [c.body, c.author[0].name]),
      [["c5", "bob"], ["c4", "alice"], ["c3", "bob"], ["c2", "bob"], ["c1", "alice"]],
    );
  });
});

describe("onDelete", () => {
  it("cascades to colocated children in the same transaction", async () => {
    const h = open("1");
    const issue = ok(h.create({ otype: ISSUE, data: { title: "i" }, vshard: "1", epoch: 0 }));
    const comments = [1, 2].map((t) => {
      const c = ok(h.create({ otype: COMMENT, data: { body: `c${t}` }, with: issue, epoch: 0 }));
      ok(h.assocAdd({ atype: ISSUE_COMMENT, id1: issue, id2: c, time: t, epoch: 0 }));
      return c;
    });

    ok(h.delete({ id: issue, epoch: 0 }));
    assert.equal(await h.store().object(issue), null);
    for (const c of comments) assert.equal(await h.store().object(c), null, "its comments went with it");
    assert.equal(await h.store().count(issue, ISSUE_COMMENT), 0);
  });

  it("detaches rather than cascading when the edge declares nothing, and withdraws the inverse", async () => {
    const h = open("1");
    const issue = ok(h.create({ otype: ISSUE, data: {}, vshard: "1", epoch: 0 }));
    const user = ok(h.create({ otype: USER, data: { name: "alice" }, vshard: "1", epoch: 0 }));
    ok(h.assocAdd({ atype: ISSUE_OWNER, id1: issue, id2: user, time: 1, epoch: 0 }));
    assert.equal(await h.store().count(user, USER_OWNED), 1);

    ok(h.delete({ id: issue, epoch: 0 }));
    assert.notEqual(await h.store().object(user), null, "the owner outlives the issue");
    assert.equal(await h.store().count(user, USER_OWNED), 0, "and no longer claims to own it");
  });

  it("holds a delete back on restrict, writing nothing", async () => {
    const h = open("1");
    const issue = ok(h.create({ otype: ISSUE, data: {}, vshard: "1", epoch: 0 }));
    const blocked = ok(h.create({ otype: ISSUE, data: {}, vshard: "1", epoch: 0 }));
    ok(h.assocAdd({ atype: ISSUE_BLOCKS, id1: issue, id2: blocked, time: 1, epoch: 0 }));

    const r = h.delete({ id: issue, epoch: 0 });
    assert.ok(!r.ok && "restricted" in r, `expected a restriction, got ${JSON.stringify(r)}`);
    assert.notEqual(await h.store().object(issue), null, "the delete left no trace");
    assert.equal(await h.store().count(issue, ISSUE_BLOCKS), 1);

    ok(h.assocRemove({ atype: ISSUE_BLOCKS, id1: issue, id2: blocked, epoch: 0 }));
    ok(h.delete({ id: issue, epoch: 0 })); // now it goes
  });

  it("leaves the vshard through the outbox when a cascade crosses one", () => {
    const a = open("1");
    const issue = ok(a.create({ otype: ISSUE, data: {}, vshard: "1", epoch: 0 }));
    const far = makeId(2n, 7n); // a comment on another vshard
    ok(a.assocAdd({ atype: ISSUE_COMMENT, id1: issue, id2: far, time: 1, epoch: 0 }));

    ok(a.delete({ id: issue, epoch: 0 }));
    const kinds = a.pending().map((r) => r.op.kind);
    assert.ok(kinds.includes("delete"), `expected a queued delete, got ${kinds.join(", ")}`);
    assert.ok(kinds.includes("remove"), "and the inverse withdrawn");
  });

  it("a delivered cascade is delete-if-present, so a cycle terminates", () => {
    const a = open("1");
    const b = open("2");
    const far = ok(b.create({ otype: COMMENT, data: {}, vshard: "2", epoch: 0 }));
    ok(b.delete({ id: far, epoch: 0 }));
    ok(b.apply({ kind: "delete", id: far })); // already gone: a no-op, not an error
    assert.equal(a.pending().length, 0);
  });
});
