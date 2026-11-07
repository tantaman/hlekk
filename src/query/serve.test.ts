import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan as planLock } from "../catalog/catalog.ts";
import { LocalCluster } from "../client/local.ts";
import { Refused } from "./request.ts";
import { PUBLIC, enforce, planOf, serve, vocabularyOf } from "./serve.ts";
import type { Policy, ReadRequest, ReadSource } from "./serve.ts";
import type { QueryResult } from "./normalize.ts";
import type { Plan } from "./types.ts";

// The design doc's own example, because it has the two shapes that matter: a stored edge with a
// maintained count, and a field relationship that follows an id in a payload and stores nothing.
const LOCK = planLock({
  core: { objects: { "core.user": { fields: { name: "string" } } } },
  issues: {
    objects: {
      "issues.issue": { fields: { title: "string" } },
      "issues.comment": { fields: { body: "string", authorId: { id: "core.user" } } },
    },
    edges: {
      "issues.issue_comments": { from: "issues.issue", to: "issues.comment" },
      "issues.comment_author": { from: "issues.comment", to: "core.user", field: "authorId" },
    },
  },
});
const CATALOG = Catalog.compile(LOCK);
const ISSUE = CATALOG.objectNamed("issues.issue")!.otype;
const COMMENT = CATALOG.objectNamed("issues.comment")!.otype;
const USER = CATALOG.objectNamed("core.user")!.otype;
const COMMENTS = CATALOG.edgeNamed("issues.issue_comments")!.atype!;
const VOCAB = vocabularyOf(CATALOG);

/** An issue with three comments, each by the same author, all in one vshard. */
async function database() {
  const c = new LocalCluster();
  c.directory.applyLock(LOCK);
  c.spreadCatalog();
  await c.publish();
  const db = c.client();
  const alice = await db.create(USER, { name: "alice" }, { vshard: "7" });
  const issue = await db.create(ISSUE, { title: "ship it" }, { vshard: "7" });
  const comments: string[] = [];
  for (const body of ["first", "second", "third"]) {
    const id = await db.create(COMMENT, { body, authorId: alice }, { with: issue });
    await db.assocAdd(COMMENTS, issue, id, comments.length + 1);
    comments.push(id);
  }
  return { db, alice, issue, comments };
}

const base = (issue: string): ReadRequest => ({
  ids: [issue],
  counts: ["issues.issue_comments"],
  hops: [{ as: "comments", edge: "issues.issue_comments", limit: 10 }],
});

describe("serving a read to another database", () => {
  it("compiles a request to a plan from the catalog alone", async () => {
    const { issue } = await database();
    const p = planOf(base(issue), CATALOG);
    assert.deepEqual(p.frames[0].source, { kind: "ids" });
    assert.deepEqual(p.frames[0].counts, [{ alias: "issues.issue_comments", atype: COMMENTS }]);
    assert.deepEqual(p.frames[0].children, [{ alias: "comments", frame: 1 }]);
    assert.deepEqual(p.frames[1].source, { kind: "edge", atype: COMMENTS });
    assert.equal(p.frames[1].limit, 10);
    // A field relationship stores nothing, so it is a field source and carries no atype.
    const withField = planOf({ ids: [issue], hops: [{ edge: "issues.comment_author" }] }, CATALOG);
    assert.deepEqual(withField.frames[1].source, { kind: "field", field: "authorId" });
  });

  it("answers, and reports what the request was priced at", async () => {
    const { db, issue, comments } = await database();
    const served = await serve(base(issue), { catalog: CATALOG, source: db, vocabulary: VOCAB });
    assert.deepEqual(served.result.roots, [issue]);
    assert.deepEqual(served.result.lists["1:" + issue].ids.sort(), [...comments].sort());
    assert.equal(served.result.counts["0:" + issue]["issues.issue_comments"], 3);
    assert.deepEqual(served.cost, { frames: 2, nodes: 1 + 10 });
    assert.deepEqual(served.cache, { reuse: "public", seconds: 60 });
  });

  it("makes a forbidden object indistinguishable from an absent one", async () => {
    const { db, issue, comments } = await database();
    const hide = comments[1];
    const policy: Policy = { ...PUBLIC, object: (id) => id !== hide };
    const served = await serve(base(issue), { catalog: CATALOG, source: db, vocabulary: VOCAB, policy });

    const list = served.result.lists["1:" + issue];
    assert.equal(served.result.objects[hide], undefined, "it is not in the objects");
    assert.ok(!list.ids.includes(hide), "and not in the list that reached it");
    assert.equal(list.ids.length, 2);

    // The count still says three. That is not a leak being tolerated: it is exactly what a DELETED
    // comment looks like, because edges to missing objects are dropped at read time while a
    // maintained count still counts them. The two cases are byte-identical, which is the decision
    // protocol.md settles -- and it only works because the engine already behaves this way.
    assert.equal(served.result.counts["0:" + issue]["issues.issue_comments"], 3);
  });

  it("keeps the edge that reached each id positional when one is dropped", async () => {
    const { db, issue, comments } = await database();
    const req: ReadRequest = { ids: [issue], hops: [{ as: "comments", edge: "issues.issue_comments", limit: 10 }] };
    const all = await serve(req, { catalog: CATALOG, source: db, vocabulary: VOCAB });
    const before = all.result.lists["1:" + issue];
    assert.ok(before.edges, "the list carries the edge that reached each id");

    const hide = before.ids[1];
    const kept = before.ids.filter((id) => id !== hide);
    const policy: Policy = { ...PUBLIC, object: (id) => id !== hide };
    const after = enforce(all.result, planOf(req, CATALOG), policy).lists["1:" + issue];

    // `edges` is positional, so dropping an id has to drop its edge with it or every remaining row
    // is paired with the wrong one.
    assert.deepEqual(after.ids, kept);
    assert.equal(after.edges!.length, kept.length);
    const timeOf = (id: string) => before.edges![before.ids.indexOf(id)]!.time;
    assert.deepEqual(after.edges!.map((e) => e!.time), kept.map(timeOf));
  });

  it("authorizes a count separately from the objects", async () => {
    const { db, issue } = await database();
    const policy: Policy = { ...PUBLIC, count: () => false };
    const served = await serve(base(issue), { catalog: CATALOG, source: db, vocabulary: VOCAB, policy });
    assert.equal(served.result.counts["0:" + issue], undefined, "the count is withheld");
    assert.equal(served.result.lists["1:" + issue].ids.length, 3, "the objects are not");
  });

  it("lets the responder say what may be reused, since only it knows its own granularity", async () => {
    const { db, issue } = await database();
    const policy: Policy = { ...PUBLIC, cache: () => ({ reuse: "never" }) };
    const served = await serve(base(issue), { catalog: CATALOG, source: db, vocabulary: VOCAB, policy });
    assert.deepEqual(served.cache, { reuse: "never" });
  });
});

describe("refusing before any I/O", () => {
  /** A source that records whether it was reached. The point of pricing a request from its text is
   *  that a refused one costs the responder nothing, so that has to be asserted and not assumed. */
  const counting = () => {
    const calls: Plan[] = [];
    return {
      calls,
      source: {
        normalized(p: Plan, ids: string[]): Promise<QueryResult> {
          calls.push(p);
          void ids;
          return Promise.resolve({ roots: [], objects: {}, lists: {}, counts: {}, shape: {} });
        },
      } satisfies ReadSource,
    };
  };

  const refused = async (req: unknown): Promise<{ error: Refused; reached: boolean }> => {
    const { calls, source } = counting();
    try {
      await serve(req as ReadRequest, { catalog: CATALOG, source, vocabulary: VOCAB });
    } catch (e) {
      assert.ok(e instanceof Refused, `expected Refused, got ${String(e)}`);
      return { error: e, reached: calls.length > 0 };
    }
    throw new Error("expected the request to be refused");
  };

  it("refuses an entry that is not a non-empty list of ids", async () => {
    for (const ids of [[], undefined, "7", [7]]) {
      const { error, reached } = await refused({ ids, hops: [] });
      assert.equal(error.at, "ids");
      assert.equal(reached, false);
    }
  });

  it("refuses more ids than one request may enter from", async () => {
    const { error } = await refused({ ids: Array.from({ length: 101 }, (_, i) => String(i + 1)) });
    assert.match(error.message, /101 ids, the maximum is 100/);
  });

  it("refuses a tree that would cost too much, without reading anything", async () => {
    const { error, reached } = await refused({
      ids: ["1"],
      hops: [
        {
          edge: "issues.issue_comments",
          limit: 100,
          hops: [{ edge: "issues.comment_author", limit: 100, hops: [{ edge: "core.nope", limit: 100 }] }],
        },
      ],
    });
    assert.match(error.message, /no edge "core.nope"/);
    assert.equal(reached, false);
  });

  it("refuses a count on an edge that has no counter", async () => {
    // A field relationship follows an id in a payload, so there is no assoc_counts row to read. It
    // is still traversable, which is the distinction.
    const { error, reached } = await refused({ ids: ["1"], counts: ["issues.comment_author"] });
    assert.match(error.message, /has no count/);
    assert.equal(reached, false);
    const { source } = counting();
    assert.ok(await serve({ ids: ["1"], hops: [{ edge: "issues.comment_author" }] }, {
      catalog: CATALOG,
      source,
      vocabulary: VOCAB,
    }));
  });
});
