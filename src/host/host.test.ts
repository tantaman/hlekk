import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runAsync, runRounds } from "../query/driver.ts";
import type { HostClient, Stats } from "../query/driver.ts";
import { UNKNOWN, cmpId } from "../query/types.ts";
import type { Id, Json, Maybe, Plan } from "../query/types.ts";
import { Catalog, plan } from "../catalog/catalog.ts";
import { Host } from "./host.ts";
import type { Reply } from "./host.ts";
import {
  MAX_SEQ,
  MAX_VSHARD,
  RESERVED_BITS,
  SEQ_BITS,
  VSHARD_BITS,
  fromKey,
  makeId,
  parseId,
  toKey,
  vshardOf,
  vshardRange,
} from "./ids.ts";
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
      "issues.comment_issue": { from: "issues.comment", to: "issues.issue", inverse: "issues.issue_comment", maintained: true },
      // The owner is a person, who outlives the issue.
      "issues.issue_owner": { from: "issues.issue", to: "core.user", inverse: "issues.user_owned", unique: true },
      "issues.user_owned": { from: "core.user", to: "issues.issue", inverse: "issues.issue_owner", maintained: true },
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
    for (const id of ["0", "1", makeId(0n, MAX_SEQ), makeId(1n, 0n), makeId(MAX_VSHARD, MAX_SEQ)]) {
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
    assert.throws(() => makeId(MAX_VSHARD + 1n, 0n), RangeError);
    assert.throws(() => makeId(0n, MAX_SEQ + 1n), RangeError);
    // The reserved sign bit: an id at or above 2^63 is refused on the way in, which is the
    // threshold where SQLite would coerce it to REAL and let two distinct ids compare equal.
    assert.throws(() => parseId((1n << (VSHARD_BITS + SEQ_BITS)).toString()), RangeError);
    assert.equal(RESERVED_BITS, 1n);
    assert.equal(VSHARD_BITS + SEQ_BITS, 63n, "every id stays below 2^63");
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
    const next = known(await h.store().edges(issue, ISSUE_COMMENT, { time: last.time, db: last.db, id2: last.id2 }, 2));
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

  // A move brings two vshards onto one host while a row for that pair is still waiting. The inline
  // path is what makes a colocated pair atomic, and taking it here would put this op ahead of the one
  // already queued — leaving, once the queue drains, an edge that was added after it was removed.
  it("does not let an inline apply overtake an op already queued for the same pair", async () => {
    const h = open("1");
    const issue = ok(h.create({ otype: ISSUE, data: { title: "i" }, vshard: "1", epoch: 0 }));
    const far = makeId(2n, 7n); // a comment on a vshard this host does not hold
    ok(h.assocAdd({ atype: ISSUE_COMMENT, id1: issue, id2: far, time: 1, epoch: 0 }));
    assert.deepEqual(
      h.pending().map((r) => r.op.kind),
      ["add"],
      "the inverse is queued, since its vshard is elsewhere",
    );

    h.adopt("2", 0, 8); // the vshard arrives, as a move would bring it
    ok(h.assocRemove({ atype: ISSUE_COMMENT, id1: issue, id2: far, epoch: 0 }));
    assert.deepEqual(
      h.pending().map((r) => r.op.kind),
      ["add", "remove"],
      "and so is the withdrawal, behind it",
    );

    for (const row of h.pending()) {
      ok(h.apply(row.op));
      h.ack(row.vshard, row.seq);
    }
    assert.equal(h.pending().length, 0);
    assert.equal(await h.store().count(far, COMMENT_ISSUE), 0, "the add did not outlive the remove");
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

    const go = async (
      driver: (plan: Plan, roots: Id[], route: (id: Id) => HostClient, stats: Stats) => Promise<{ rows: Json[] }>,
      root: Id,
      route: (id: Id) => HostClient,
    ): Promise<Run> => {
      const stats: Stats = { rounds: 0, requests: 0 };
      return { out: (await driver(plan, [root], route, stats)).rows, stats };
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

  // Two types that each cascade to the other. Legal in the catalog, and the first thing a generated
  // schema with two cascades finds. Across hosts the outbox terminates it, because the op arrives
  // after the first object's row is already gone; on one host the cascade runs inline, and an
  // object's own row is not deleted until its cascade returns, so nothing else can stop it.
  it("terminates a cascade cycle between two vshards that share a host", () => {
    const CYCLE = plan({
      pair: {
        objects: { "pair.a": { fields: {} }, "pair.b": { fields: {} } },
        edges: {
          "pair.a_b": { from: "pair.a", to: "pair.b", onDelete: "cascade" },
          "pair.b_a": { from: "pair.b", to: "pair.a", onDelete: "cascade" },
        },
      },
    });
    const cat = Catalog.compile(CYCLE);
    const h = Host.open(nodeSql(), cat);
    h.adopt("1");
    h.adopt("2");
    const A = cat.objectNamed("pair.a")!.otype;
    const B = cat.objectNamed("pair.b")!.otype;
    const AB = cat.edgeNamed("pair.a_b")!.atype!;
    const BA = cat.edgeNamed("pair.b_a")!.atype!;

    const a = ok(h.create({ otype: A, data: {}, vshard: "1", epoch: 0 }));
    const b = ok(h.create({ otype: B, data: {}, vshard: "2", epoch: 0 }));
    ok(h.assocAdd({ atype: AB, id1: a, id2: b, time: 1, epoch: 0 }));
    ok(h.assocAdd({ atype: BA, id1: b, id2: a, time: 1, epoch: 0 }));

    ok(h.delete({ id: a, epoch: 0 }));
    assert.equal(h.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM objects")[0].n, 0, "the pair went together");
  });
});

describe("what a vshard costs", () => {
  const bytesOf = (h: Host, vshard: string) => h.stats().find((s) => s.vshard === vshard)!.bytes;

  it("measures a payload in bytes, not characters", () => {
    const ascii = open("1");
    const wide = open("1");
    // Same number of characters, three times the bytes. LENGTH() on TEXT counts characters, so this
    // is the case a character count reports as identical.
    ok(ascii.create({ otype: ISSUE, data: { title: "aaaaaaaaaa" }, vshard: "1", epoch: 0 }));
    ok(wide.create({ otype: ISSUE, data: { title: "あああああああああ" }, vshard: "1", epoch: 0 }));
    assert.ok(
      bytesOf(wide, "1") > bytesOf(ascii, "1") + 15,
      `wide ${bytesOf(wide, "1")} should exceed ascii ${bytesOf(ascii, "1")} by about two bytes per character`,
    );
  });

  it("charges an edge for its index entry as well as its row", () => {
    const h = open("1");
    const issue = ok(h.create({ otype: ISSUE, data: { title: "t" }, vshard: "1", epoch: 0 }));
    const empty = bytesOf(h, "1");
    const targets = [];
    for (let i = 0; i < 20; i++) {
      targets.push(ok(h.create({ otype: COMMENT, data: { body: "b", authorId: "0" }, with: issue, epoch: 0 })));
    }
    const withObjects = bytesOf(h, "1");
    for (const t of targets) ok(h.assocAdd({ atype: ISSUE_COMMENT, id1: issue, id2: t, time: 1, epoch: 0 }));
    const withEdges = bytesOf(h, "1");

    // 20 forward edges, their 20 colocated inverses and the counts for both. `assocs_range` carries
    // the whole primary key, this table being WITHOUT ROWID, so the index weighs more than the rows
    // it points at — a flat per-edge constant left the larger half of that uncharged.
    const perEdge = (withEdges - withObjects) / 40;
    assert.ok(perEdge > 50, `an edge and its index entry should exceed 50 bytes, got ${perEdge.toFixed(1)}`);
    assert.ok(withObjects > empty, "the objects were charged too");
  });

  it("counts the rows a vshard owns outside objects and assocs", () => {
    const h = open("1");
    const a = ok(h.create({ otype: ISSUE, data: { title: "t" }, vshard: "1", epoch: 0 }));
    const before = bytesOf(h, "1");
    // An edge to another vshard queues an inverse in the outbox, which is a row this vshard owns and
    // a move carries, so it has to be charged for it.
    ok(h.assocAdd({ atype: ISSUE_OWNER, id1: a, id2: makeId(9n, 1n), time: 1, epoch: 0 }));
    assert.ok(h.pending().length > 0, "there is an outbox row to charge for");
    assert.ok(bytesOf(h, "1") > before, "the outbox row was charged");
  });

  it("reports the engine's own size, which the shares do not sum to", () => {
    const h = open("1");
    const empty = h.size();
    assert.ok(empty > 0, "a database with the schema in it occupies something");
    for (let i = 0; i < 400; i++) {
      ok(h.create({ otype: ISSUE, data: { title: "x".repeat(300) }, vshard: "1", epoch: 0 }));
    }
    assert.ok(h.size() > empty, "writing grew it");
    // The gap is keys, indexes, page overhead and the freelist. It is why the controller measures the
    // per-DO limit on this figure and uses the shares only to compare vshards with each other.
    assert.ok(h.size() > bytesOf(h, "1"), `real ${h.size()} should exceed the share ${bytesOf(h, "1")}`);
  });

  it("charges a vshard for its own rows and not its neighbour's", () => {
    const h = open("1", "2");
    ok(h.create({ otype: ISSUE, data: { title: "x".repeat(500) }, vshard: "1", epoch: 0 }));
    const one = bytesOf(h, "1");
    // Growing vshard 2 must not move vshard 1's figure: attributing the database's overhead pro rata
    // did exactly that, and charged the whole fixed cost of a database to its first vshard.
    for (let i = 0; i < 50; i++) {
      ok(h.create({ otype: ISSUE, data: { title: "y".repeat(500) }, vshard: "2", epoch: 0 }));
    }
    assert.equal(bytesOf(h, "1"), one, "vshard 1 is unchanged by what vshard 2 holds");
    assert.ok(bytesOf(h, "2") > one * 10, "and vshard 2 is charged for all of it");
  });
});

// The batched add exists for one reason — one durable commit instead of N — so what these check is
// that buying that costs none of the guarantees the per-edge path gives. The load-bearing one is the
// first: the batch is held to the per-edge path's own answer rather than to a hand-written
// expectation, so a divergence in counts, ordering or payloads shows up as a difference rather than
// as two tests that were both written wrong.
describe("a batched edge add", () => {
  const seedTwo = () => {
    const a = open("1");
    const b = open("1");
    const mk = (h: Host) => {
      const issue = ok(h.create({ otype: ISSUE, data: { title: "i" }, vshard: "1", epoch: 0 }));
      const comments = [1, 2, 3, 4, 5].map((t) =>
        ok(h.create({ otype: COMMENT, data: { body: `c${t}` }, with: issue, epoch: 0 })),
      );
      return { issue, comments };
    };
    return { a, b, ia: mk(a), ib: mk(b) };
  };

  it("agrees with the per-edge path on rows, order and counts", async () => {
    const { a, b, ia, ib } = seedTwo();
    // a: one mutation per edge. b: all of them in one.
    ia.comments.forEach((c, i) => ok(a.assocAdd({ atype: ISSUE_COMMENT, id1: ia.issue, id2: c, time: i + 1, epoch: 0 })));
    const written = ok(
      b.assocAddMany({
        edges: ib.comments.map((c, i) => ({ atype: ISSUE_COMMENT, id1: ib.issue, id2: c, time: i + 1 })),
        epoch: 0,
      }),
    );
    assert.equal(written, 5);

    const pa = known(await a.store().edges(ia.issue, ISSUE_COMMENT, null, 10));
    const pb = known(await b.store().edges(ib.issue, ISSUE_COMMENT, null, 10));
    // Ids are per-host but allocated identically from the same seeded vshard, so the lists compare.
    assert.deepEqual(pb.rows.map((e) => e.id2), pa.rows.map((e) => e.id2));
    assert.deepEqual(pb.rows.map((e) => e.time), pa.rows.map((e) => e.time));
    assert.equal(pb.complete, pa.complete);
    assert.equal(
      await b.store().count(ib.issue, ISSUE_COMMENT),
      await a.store().count(ia.issue, ISSUE_COMMENT),
    );
    assert.equal(await b.store().count(ib.issue, ISSUE_COMMENT), 5);
  });

  it("is one unit: a refusal in the middle writes none of the batch", async () => {
    const { b, ib } = seedTwo();
    // COMMENT_ISSUE is maintained, so #own refuses it — mid-batch, after a good edge.
    const r = b.assocAddMany({
      edges: [
        { atype: ISSUE_COMMENT, id1: ib.issue, id2: ib.comments[0]!, time: 1 },
        { atype: COMMENT_ISSUE, id1: ib.comments[1]!, id2: ib.issue, time: 2 },
        { atype: ISSUE_COMMENT, id1: ib.issue, id2: ib.comments[2]!, time: 3 },
      ],
      epoch: 0,
    });
    assert.equal(r.ok, false);
    // The good first edge is gone with the rest of it, which is the whole point of one transaction.
    const page = known(await b.store().edges(ib.issue, ISSUE_COMMENT, null, 10));
    assert.deepEqual(page.rows, []);
    assert.equal(await b.store().count(ib.issue, ISSUE_COMMENT), 0);
  });

  it("can be retried whole without double-counting", async () => {
    const { b, ib } = seedTwo();
    const edges = ib.comments.map((c, i) => ({ atype: ISSUE_COMMENT, id1: ib.issue, id2: c, time: i + 1 }));
    ok(b.assocAddMany({ edges, epoch: 0 }));
    ok(b.assocAddMany({ edges, epoch: 0 })); // the coarse retry a resumable load makes
    assert.equal(await b.store().count(ib.issue, ISSUE_COMMENT), 5);
    const page = known(await b.store().edges(ib.issue, ISSUE_COMMENT, null, 10));
    assert.equal(page.rows.length, 5);
  });

  it("holds the ownership fence, at the batch's epoch", () => {
    const { b, ib } = seedTwo();
    const r = b.assocAddMany({
      edges: [{ atype: ISSUE_COMMENT, id1: ib.issue, id2: ib.comments[0]!, time: 1 }],
      epoch: 7, // the host owns this vshard at epoch 0
    });
    assert.equal(r.ok, false);
  });

  it("writes nothing for an empty batch", async () => {
    const { b, ib } = seedTwo();
    assert.equal(ok(b.assocAddMany({ edges: [], epoch: 0 })), 0);
    assert.equal(await b.store().count(ib.issue, ISSUE_COMMENT), 0);
  });
});
