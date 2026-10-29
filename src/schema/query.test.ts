import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LocalCluster } from "../client/local.ts";
import { plan as planCatalog } from "../catalog/catalog.ts";
import { defineObject, edge, fieldRel, id, num, oneOf, ref, str } from "./define.ts";
import { and, edgeField, exists, not, objField, or } from "./query.ts";

// The issue tracker from the design. One lock assigns every integer, and the definitions take theirs
// from it, exactly as a generated module does: hand-numbering them is how a read and a write end up
// disagreeing about which edge they mean.
const LOCK = planCatalog({
  core: { objects: { "core.user": { fields: { name: "string" } } } },
  issues: {
    objects: {
      "issues.issue": { fields: { title: "string", status: { enum: ["open", "closed"] } } },
      "issues.comment": { fields: { body: "string", authorId: { id: "core.user" } } },
      "issues.label": { fields: { name: "string" } },
    },
    edges: {
      "issues.issue_comment": { from: "issues.issue", to: "issues.comment", inverse: "issues.comment_issue" },
      "issues.comment_issue": { from: "issues.comment", to: "issues.issue", inverse: "issues.issue_comment" },
      "issues.issue_label": { from: "issues.issue", to: "issues.label" },
      "issues.issue_owner": { from: "issues.issue", to: "core.user", unique: true, inverse: "issues.user_owned_issues" },
      "issues.user_owned_issues": { from: "core.user", to: "issues.issue", inverse: "issues.issue_owner" },
      "issues.comment_author": { from: "issues.comment", to: "core.user", field: "authorId" },
    },
  },
});
const ot = (name: string) => LOCK.objects[name].otype;
const at = (name: string) => LOCK.edges[name].atype!;

const User = defineObject("core.user", ot("core.user"), { name: str() });
const Issue = defineObject("issues.issue", ot("issues.issue"), { title: str(), status: oneOf("open", "closed") });
const Comment = defineObject("issues.comment", ot("issues.comment"), { body: str(), authorId: id("core.user") });
const Label = defineObject("issues.label", ot("issues.label"), { name: str() });

const issueComments = edge("issues.issue_comment", at("issues.issue_comment"), Issue, Comment);
const issueLabels = edge("issues.issue_label", at("issues.issue_label"), Issue, Label);
const issueOwner = edge("issues.issue_owner", at("issues.issue_owner"), Issue, User, { unique: true });
const commentAuthor = fieldRel("issues.comment_author", Comment, User, "authorId");
const userOwned = edge("issues.user_owned_issues", at("issues.user_owned_issues"), User, Issue);

describe("compiling a query", () => {
  it("turns the design's issue page into one frame per related level", () => {
    const { plan } = Issue.gen("1")
      .related("comments", issueComments, (q) => q.related("author", commentAuthor).limit(50))
      .related("labels", issueLabels)
      .related("owner", issueOwner)
      .countAs("commentCount", issueComments)
      .compile();

    assert.equal(plan.frames.length, 5, "root, comments, author, labels, owner");
    assert.deepEqual(plan.frames[0].source, { kind: "ids" });
    assert.deepEqual(plan.frames[0].counts, [{ alias: "commentCount", atype: issueComments.atype }]);
    assert.deepEqual(
      plan.frames[0].children.map((c) => c.alias),
      ["comments", "labels", "owner"],
    );

    const comments = plan.frames[plan.frames[0].children[0].frame];
    assert.deepEqual(comments.source, { kind: "edge", atype: issueComments.atype });
    assert.equal(comments.limit, 50);
    const author = plan.frames[comments.children[0].frame];
    assert.deepEqual(author.source, { kind: "field", field: "authorId" }, "a field relationship stores nothing");
  });

  it("gives each level its own frame even when two follow the same edge", () => {
    const { plan } = Issue.gen("1")
      .related("recent", issueComments, (q) => q.limit(5))
      .related("all", issueComments, (q) => q.limit(500))
      .compile();
    const [recent, all] = plan.frames[0].children;
    assert.notEqual(recent.frame, all.frame, "two aliases over one edge must not share a slot");
    assert.equal(plan.frames[recent.frame].limit, 5);
    assert.equal(plan.frames[all.frame].limit, 500);
  });

  it("is immutable, so a query can be reused and extended two ways", () => {
    const base = Issue.gen("1").related("labels", issueLabels);
    const withOwner = base.related("owner", issueOwner);
    const withComments = base.related("comments", issueComments);
    assert.deepEqual(base.compile().plan.frames[0].children.map((c) => c.alias), ["labels"]);
    assert.deepEqual(withOwner.compile().plan.frames[0].children.map((c) => c.alias), ["labels", "owner"]);
    assert.deepEqual(withComments.compile().plan.frames[0].children.map((c) => c.alias), ["labels", "comments"]);
  });

  it("composes through an ordinary function, which is all a fragment ever was", () => {
    const card = <Q extends { related: (...a: never[]) => unknown }>(q: Q) => q;
    void card;
    const withCard = (q: ReturnType<typeof Issue.gen>) => q.related("labels", issueLabels).related("owner", issueOwner);
    const { plan } = withCard(Issue.gen("1")).related("comments", issueComments).compile();
    assert.deepEqual(plan.frames[0].children.map((c) => c.alias), ["labels", "owner", "comments"]);
  });

  it("refuses a query with no root", () => {
    assert.throws(() => Issue.gen(), /needs at least one id/);
  });
});

describe("predicates", () => {
  it("compiles a field comparison against the related object", () => {
    const { plan } = Issue.gen("1").related("comments", issueComments, (q) => q.where("body", "=", "hi")).compile();
    const comments = plan.frames[plan.frames[0].children[0].frame];
    assert.deepEqual(comments.where, { cmp: "=", on: "obj", field: "body", value: "hi" });
  });

  it("keeps an edge-field comparison apart from an object one, since only edges can be indexed", () => {
    const { plan } = Issue.gen("1")
      .related("comments", issueComments, (q) => q.where(edgeField("time", ">", 100)))
      .compile();
    const comments = plan.frames[plan.frames[0].children[0].frame];
    assert.deepEqual(comments.where, { cmp: ">", on: "edge", field: "time", value: 100 });
  });

  it("ands two wheres together rather than replacing one", () => {
    const { plan } = Issue.gen("1")
      .related("comments", issueComments, (q) => q.where("body", "!=", "").where(edgeField("time", "<", 5)))
      .compile();
    const where = plan.frames[plan.frames[0].children[0].frame].where!;
    assert.ok("and" in where && where.and.length === 2);
  });

  it("combines and, or and not", () => {
    const { plan } = Issue.gen("1")
      .related("comments", issueComments, (q) =>
        q.where(or(objField("body", "=", "a"), and(objField("body", "=", "b"), not(edgeField("time", "=", 0))))),
      )
      .compile();
    const where = plan.frames[plan.frames[0].children[0].frame].where!;
    assert.ok("or" in where);
    assert.ok("and" in where.or[1]);
  });

  it("gives an exists its own frame, bounded to one row", () => {
    const { plan } = Issue.gen("1")
      .related("comments", issueComments, (q) =>
        q.where(exists(commentAuthor, (a) => a.where("name", "=", "alice"))).limit(2),
      )
      .compile();
    const comments = plan.frames[plan.frames[0].children[0].frame];
    assert.ok(comments.where && "exists" in comments.where);
    const probe = plan.frames[(comments.where as { exists: number }).exists];
    assert.deepEqual(probe.source, { kind: "field", field: "authorId" });
    assert.equal(probe.limit, 1, "exists stops at the first row rather than reading the list");
    assert.deepEqual(probe.where, { cmp: "=", on: "obj", field: "name", value: "alice" });
  });
});

describe("running a built query", () => {
  async function seeded() {
    const c = new LocalCluster();
    c.directory.applyLock(LOCK);
    c.spreadCatalog();
    await c.publish();
    const db = c.client();

    const alice = await db.create(User.otype, { name: "alice" }, { vshard: "40" });
    const bob = await db.create(User.otype, { name: "bob" }, { vshard: "40" });
    const issue = await db.create(Issue.otype, { title: "Crash on save", status: "open" }, { vshard: "5" });
    await db.assocAdd(issueOwner.atype, issue, alice, 1);
    const bugs = await db.create(Label.otype, { name: "bug" }, { vshard: "7" });
    await db.assocAdd(issueLabels.atype, issue, bugs, 1);

    const authors = [alice, bob, bob, alice];
    for (const [i, author] of authors.entries()) {
      const comment = await db.create(Comment.otype, { body: `c${i + 1}`, authorId: author }, { with: issue });
      await db.assocAdd(issueComments.atype, issue, comment, i + 1);
    }
    await c.deliverAll();
    return { c, db, issue, alice };
  }

  it("renders the design's issue page", async () => {
    const { db, issue } = await seeded();
    const [page] = await Issue.gen(issue)
      .related("comments", issueComments, (q) => q.related("author", commentAuthor).limit(50))
      .related("labels", issueLabels)
      .related("owner", issueOwner)
      .countAs("commentCount", issueComments)
      .run(db);

    assert.equal(page.title, "Crash on save");
    assert.equal(page.status, "open");
    assert.equal(page.commentCount, 4);
    assert.deepEqual(page.comments.map((c) => c.body), ["c4", "c3", "c2", "c1"], "newest first");
    assert.deepEqual(page.comments.map((c) => c.author?.name), ["alice", "bob", "bob", "alice"]);
    assert.deepEqual(page.labels.map((l) => l.name), ["bug"]);
  });

  it("gives one object, not a list, where the edge is to-one", async () => {
    const { db, issue } = await seeded();
    const [page] = await Issue.gen(issue).related("owner", issueOwner).run(db);
    assert.equal(page.owner?.name, "alice", "unique: true means one owner");
    assert.ok(!Array.isArray(page.owner));
  });

  it("gives null for a to-one relation with nothing on the other end", async () => {
    const { db } = await seeded();
    const orphan = await db.create(Issue.otype, { title: "no owner", status: "open" }, { vshard: "5" });
    const [page] = await Issue.gen(orphan).related("owner", issueOwner).run(db);
    assert.equal(page.owner, null);
  });

  it("filters, with the limit honored against the rows that pass", async () => {
    const { db, issue } = await seeded();
    const [page] = await Issue.gen(issue)
      .related("comments", issueComments, (q) =>
        q.where(exists(commentAuthor, (a) => a.where("name", "=", "alice"))).related("author", commentAuthor).limit(2),
      )
      .run(db);
    assert.deepEqual(page.comments.map((c) => c.body), ["c4", "c1"], "alice's two, newest first");
    assert.deepEqual(page.comments.map((c) => c.author?.name), ["alice", "alice"]);
  });

  it("follows an inverse edge, so one read answers what a user owns", async () => {
    const { db, alice, issue } = await seeded();
    const [page] = await User.gen(alice).related("owns", userOwned).run(db);
    assert.deepEqual(page.owns.map((i) => i.id), [issue]);
    assert.equal(page.name, "alice");
  });

  it("agrees between the two drivers", async () => {
    const { db, issue } = await seeded();
    const build = () =>
      Issue.gen(issue)
        .related("comments", issueComments, (q) => q.related("author", commentAuthor))
        .countAs("commentCount", issueComments);
    assert.deepEqual(await build().run(db, { driver: "async" }), await build().run(db, { driver: "rounds" }));
  });

  it("can be handed to the database instead, which is the same thing", async () => {
    const { db, issue } = await seeded();
    const q = Issue.gen(issue).related("labels", issueLabels);
    assert.deepEqual(await db.query(q), await q.run(db));
  });
});

describe("a reference endpoint", () => {
  it("can be linked to and read as an id, with no fields", async () => {
    const Bare = ref("core.user", ot("core.user"));
    const owner = edge("issues.issue_owner", at("issues.issue_owner"), Issue, Bare, { unique: true });
    const { plan } = Issue.gen("1").related("owner", owner).compile();
    assert.deepEqual(plan.frames[plan.frames[0].children[0].frame].source, {
      kind: "edge",
      atype: at("issues.issue_owner"),
    });
    assert.equal(Bare.isRef, true);
    assert.equal(Bare.creatable, false);
  });
});

describe("what the types reject", () => {
  it("is checked by the compiler, not at runtime", () => {
    // @ts-expect-error -- "nope" is not a field of Comment
    void (() => Issue.gen("1").related("comments", issueComments, (q) => q.where("nope", "=", 1)));
    // @ts-expect-error -- body is a string, not a number
    void (() => Issue.gen("1").related("comments", issueComments, (q) => q.where("body", "=", 1)));
    // @ts-expect-error -- issueLabels does not start at Comment
    void (() => Issue.gen("1").related("comments", issueComments, (q) => q.related("x", issueLabels)));
    // @ts-expect-error -- userOwned does not start at Issue
    void (() => Issue.gen("1").related("owns", userOwned));
    assert.ok(true, "the assertions above are the test; it compiles or it does not");
  });

  it("knows a count is a number and a list is a list", async () => {
    const q = Issue.gen("1").countAs("n", issueComments).related("labels", issueLabels);
    type Shape = Awaited<ReturnType<typeof q.run>>[number];
    const check: (s: Shape) => [number, string, string] = (s) => [s.n, s.labels[0].name, s.title];
    void check;
    assert.ok(true);
  });
});
