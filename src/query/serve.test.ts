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

  // Hiding has to be transitive, and filtering entry by entry is not. A descendant the request
  // reached only by hopping THROUGH a hidden object passes `policy.object` on its own, and its list
  // is keyed by its own parent rather than by the hidden object, so neither check removes it -- it
  // stayed in `objects` with its full payload. Had the hidden object genuinely been absent the
  // engine would never have gathered the descendant at all, so its presence was both the tell and
  // the disclosure the policy was asked to prevent.
  describe("a forbidden object takes its descendants with it", () => {
    /** An issue whose three comments have three different authors, so each author is reachable by
     *  exactly one path and hiding a comment strands one of them. The shared-author database cannot
     *  show this: alice survives on her own merits through the comments that were not hidden. */
    async function perAuthor() {
      const c = new LocalCluster();
      c.directory.applyLock(LOCK);
      c.spreadCatalog();
      await c.publish();
      const db = c.client();
      const issue = await db.create(ISSUE, { title: "ship it" }, { vshard: "7" });
      const authors: string[] = [];
      const comments: string[] = [];
      for (const name of ["alice", "bob", "carol"]) {
        const author = await db.create(USER, { name: `SECRET-${name}` }, { vshard: "7" });
        const id = await db.create(COMMENT, { body: name, authorId: author }, { with: issue });
        await db.assocAdd(COMMENTS, issue, id, comments.length + 1);
        authors.push(author);
        comments.push(id);
      }
      return { db, issue, comments, authors };
    }

    const twoLevel = (issue: string): ReadRequest => ({
      ids: [issue],
      hops: [
        {
          as: "comments",
          edge: "issues.issue_comments",
          limit: 10,
          hops: [{ as: "author", edge: "issues.comment_author" }],
        },
      ],
    });

    it("drops an object reachable only through the one that was hidden", async () => {
      const { db, issue, comments, authors } = await perAuthor();
      const hide = comments[1];
      const stranded = authors[1];
      const policy: Policy = { ...PUBLIC, object: (id) => id !== hide };
      const served = await serve(twoLevel(issue), { catalog: CATALOG, source: db, vocabulary: VOCAB, policy });

      assert.equal(served.result.objects[hide], undefined, "the hidden comment is gone");
      assert.equal(
        served.result.objects[stranded],
        undefined,
        "and so is the author, whose only route into the answer was through it",
      );
      // Not merely absent from `objects`: the list that named it has to go too, or the id alone says
      // the object exists and was withheld.
      assert.equal(served.result.lists["2:" + hide], undefined, "the hidden comment's own list");
      assert.equal(served.result.lists["2:" + stranded], undefined);
      for (const list of Object.values(served.result.lists)) {
        assert.ok(!list.ids.includes(stranded), "nothing names the stranded author");
        assert.ok(!list.ids.includes(hide));
      }
      // And the payload is what was at stake, so assert on the data rather than only the key.
      const names = Object.values(served.result.objects).map((o) => o.data.name).filter((n) => n !== undefined);
      assert.deepEqual(names.sort(), ["SECRET-alice", "SECRET-carol"]);
    });

    it("keeps an object that some other permitted path still reaches", async () => {
      // The other half of the rule. An absent parent would not have hidden an object its siblings
      // also reach, so hiding one must not either -- transitive is not the same as contagious.
      const { db, issue, comments } = await database();
      const hide = comments[1];
      const policy: Policy = { ...PUBLIC, object: (id) => id !== hide };
      const served = await serve(twoLevel(issue), { catalog: CATALOG, source: db, vocabulary: VOCAB, policy });

      const authors = Object.values(served.result.objects).filter((o) => o.otype === USER);
      assert.equal(authors.length, 1, "the shared author survives through the comments that were not hidden");
      assert.equal(authors[0].data.name, "alice");
      assert.equal(Object.keys(served.result.objects).filter((id) => id === hide).length, 0);
    });

    it("hides a whole subtree when the root is the forbidden one", async () => {
      const { db, issue } = await perAuthor();
      const policy: Policy = { ...PUBLIC, object: (id) => id !== issue };
      const served = await serve(twoLevel(issue), { catalog: CATALOG, source: db, vocabulary: VOCAB, policy });
      assert.deepEqual(served.result.roots, []);
      assert.deepEqual(served.result.objects, {}, "nothing below an unreachable root is disclosed");
      assert.deepEqual(served.result.lists, {});
      assert.deepEqual(served.result.counts, {});
    });
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

  // The budget is spent per root, because the tree is gathered once per root. Pricing it for one and
  // then serving a hundred understated the request by a factor of a hundred -- and the surplus was
  // work an unauthenticated caller got for free from a request the guard had certified as within
  // budget, which is property 2 in request.ts's header failing in the only direction that matters.
  it("prices the tree once per root, not once per request", async () => {
    const { source } = counting();
    const nested: Omit<ReadRequest, "ids"> = {
      hops: [{ edge: "issues.issue_comments", limit: 10, hops: [{ edge: "issues.comment_author", limit: 10 }] }],
    };
    const one = await serve({ ...nested, ids: ["1"] }, { catalog: CATALOG, source, vocabulary: VOCAB });
    assert.deepEqual(one.cost, { frames: 3, nodes: 1 + 10 + 100 });

    // Three roots is three of everything below them, and the reported cost has to say so or a
    // caller shown the price was shown the wrong one.
    const three = await serve({ ...nested, ids: ["1", "2", "3"] }, { catalog: CATALOG, source, vocabulary: VOCAB });
    assert.deepEqual(three.cost, { frames: 3, nodes: 3 * (1 + 10 + 100) });
    assert.equal(three.cost.frames, one.cost.frames, "the compiled query is the same size either way");
  });

  it("refuses a tree that only fits because it was priced for one root", async () => {
    // 10,101 nodes for a single root, which is inside the 20,000 default -- and 1,010,100 from the
    // hundred ids the same request may enter from. The request has to be refused for what it will
    // actually do, and before any I/O, since the amplification is the whole point of the guard.
    const wide: Omit<ReadRequest, "ids"> = {
      hops: [{ edge: "issues.issue_comments", limit: 100, hops: [{ edge: "issues.comment_author", limit: 100 }] }],
    };
    const { source } = counting();
    const single = await serve({ ...wide, ids: ["1"] }, { catalog: CATALOG, source, vocabulary: VOCAB });
    assert.deepEqual(single.cost, { frames: 3, nodes: 10_101 }, "one root is genuinely within budget");

    const { error, reached } = await refused({ ...wide, ids: Array.from({ length: 100 }, (_, i) => String(i + 1)) });
    assert.equal(error.at, "query");
    assert.match(error.message, /1,010,100 answer nodes, the maximum is 20,000/);
    assert.match(error.message, /times the 100 roots it enters from/);
    assert.equal(reached, false, "and nothing was read to find that out");
  });

  it("refuses the entry before pricing the tree, so a bad entry is not reported as a cost", async () => {
    // Ordering, asserted: `check` needs the entry's width, so the entry is validated first. This
    // tree is over budget on its own (20,201 nodes for one root), so a request carrying both faults
    // would report the cost if the price were still taken first -- and "this costs too much" is not
    // an error a caller whose `ids` is a string can act on.
    const hop = { edge: "issues.issue_comments", limit: 100, hops: [{ edge: "issues.comment_author", limit: 100 }] };
    const overBudget = { hops: [hop, { ...hop, as: "again" }] };
    const { error: onItsOwn } = await refused({ ...overBudget, ids: ["1"] });
    assert.equal(onItsOwn.at, "query", "the tree alone is refused for its cost");

    for (const ids of ["7", [], [7], undefined]) {
      const { error } = await refused({ ...overBudget, ids });
      assert.equal(error.at, "ids", `expected the entry to be named, for ids ${JSON.stringify(ids)}`);
    }
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
