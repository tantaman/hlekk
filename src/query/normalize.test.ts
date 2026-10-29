import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { plan as planCatalog } from "../catalog/catalog.ts";
import { LocalCluster } from "../client/local.ts";
import { defineObject, edge, fieldRel, id, oneOf, str } from "../schema/define.ts";
import { decodeCursor } from "../schema/query.ts";
import { listAt } from "./normalize.ts";

const LOCK = planCatalog({
  core: { objects: { "core.user": { fields: { name: "string" } } } },
  issues: {
    objects: {
      "issues.issue": { fields: { title: "string", status: { enum: ["open", "closed"] } } },
      "issues.comment": { fields: { body: "string", authorId: { id: "core.user" } } },
    },
    edges: {
      "issues.issue_comment": { from: "issues.issue", to: "issues.comment" },
      "issues.issue_owner": { from: "issues.issue", to: "core.user", unique: true },
      "issues.comment_author": { from: "issues.comment", to: "core.user", field: "authorId" },
    },
  },
});
const ot = (n: string) => LOCK.objects[n].otype;
const at = (n: string) => LOCK.edges[n].atype!;

const User = defineObject("core.user", ot("core.user"), { name: str() });
const Issue = defineObject("issues.issue", ot("issues.issue"), { title: str(), status: oneOf("open", "closed") });
const Comment = defineObject("issues.comment", ot("issues.comment"), { body: str(), authorId: id("core.user") });
const issueComments = edge("issues.issue_comment", at("issues.issue_comment"), Issue, Comment);
const issueOwner = edge("issues.issue_owner", at("issues.issue_owner"), Issue, User, { unique: true });
const commentAuthor = fieldRel("issues.comment_author", Comment, User, "authorId");

/** Alice authors three of four comments and owns the issue, so nesting would hold her five times. */
async function shared() {
  const c = new LocalCluster();
  c.directory.applyLock(LOCK);
  c.spreadCatalog();
  await c.publish();
  const db = c.client();
  const alice = await db.create(User.otype, { name: "alice" }, { vshard: "40" });
  const bob = await db.create(User.otype, { name: "bob" }, { vshard: "40" });
  const issue = await db.create(Issue.otype, { title: "Crash on save", status: "open" }, { vshard: "5" });
  await db.assocAdd(issueOwner.atype, issue, alice, 1);
  for (const [i, author] of [alice, alice, bob, alice].entries()) {
    const comment = await db.create(Comment.otype, { body: `c${i + 1}`, authorId: author }, { with: issue });
    await db.assocAdd(issueComments.atype, issue, comment, i + 1);
  }
  return { db, issue, alice, bob };
}

const query = () =>
  Issue.gen("placeholder")
    .related("comments", issueComments, (q) => q.related("author", commentAuthor).limit(50))
    .related("owner", issueOwner)
    .countAs("commentCount", issueComments);

describe("the normalized form", () => {
  it("holds each object once, however many paths reach it", async () => {
    const { db, issue, alice, bob } = await shared();
    const nested = await Issue.gen(issue)
      .related("comments", issueComments, (q) => q.related("author", commentAuthor).limit(50))
      .related("owner", issueOwner)
      .run(db);
    // Nested, Alice is three comment authors plus the owner.
    const appearances = JSON.stringify(nested).split(`"${alice}"`).length - 1;
    assert.ok(appearances >= 4, `expected Alice to repeat in the nested form, saw ${appearances}`);

    const r = await db.normalized(query().compile().plan, [issue]);
    assert.equal(Object.keys(r.objects).filter((k) => k === alice).length, 1);
    assert.equal(r.objects[alice].data.name, "alice");
    assert.equal(r.objects[bob].data.name, "bob");
    assert.equal(Object.keys(r.objects).length, 1 + 2 + 4, "the issue, two users, four comments");
  });

  it("carries each object's type and version", async () => {
    const { db, issue } = await shared();
    const r = await db.normalized(query().compile().plan, [issue]);
    assert.deepEqual(
      { otype: r.objects[issue].otype, version: r.objects[issue].version },
      { otype: Issue.otype, version: 1 },
    );
    await db.update(issue, { title: "edited", status: "open" });
    const again = await db.normalized(query().compile().plan, [issue]);
    assert.equal(again.objects[issue].version, 2);
  });

  it("keys lists by frame, so two aliases over one edge type do not collide", async () => {
    const { db, issue } = await shared();
    const q = Issue.gen(issue)
      .related("recent", issueComments, (sub) => sub.limit(2))
      .related("all", issueComments, (sub) => sub.limit(50));
    const { plan } = q.compile();
    const [recent, all] = plan.frames[0].children;
    const r = await db.normalized(plan, [issue]);

    assert.equal(r.lists[listAt(recent.frame, issue)].ids.length, 2);
    assert.equal(r.lists[listAt(all.frame, issue)].ids.length, 4);
    assert.deepEqual(r.shape[0], { recent: recent.frame, all: all.frame });
  });

  it("keeps the ids in the order the query produced them", async () => {
    const { db, issue } = await shared();
    const { plan } = query().compile();
    const r = await db.normalized(plan, [issue]);
    const comments = r.lists[listAt(plan.frames[0].children[0].frame, issue)];
    assert.deepEqual(
      comments.ids.map((cid) => r.objects[cid].data.body),
      ["c4", "c3", "c2", "c1"],
      "newest first",
    );
  });

  it("carries the edge that reached each id, positionally", async () => {
    const { db, issue } = await shared();
    const { plan } = query().compile();
    const r = await db.normalized(plan, [issue]);
    const comments = r.lists[listAt(plan.frames[0].children[0].frame, issue)];
    assert.deepEqual(comments.edges?.map((e) => e?.time), [4, 3, 2, 1]);
  });

  it("has no edges for a field hop, since none reached it", async () => {
    const { db, issue } = await shared();
    const { plan } = query().compile();
    const r = await db.normalized(plan, [issue]);
    const commentsFrame = plan.frames[0].children[0].frame;
    const authorFrame = plan.frames[commentsFrame].children[0].frame;
    const anyComment = r.lists[listAt(commentsFrame, issue)].ids[0];
    assert.equal(r.lists[listAt(authorFrame, anyComment)].edges, undefined);
  });

  it("says where a truncated list continues, and that it does", async () => {
    const { db, issue } = await shared();
    const q = Issue.gen(issue).related("comments", issueComments, (sub) => sub.limit(2));
    const { plan } = q.compile();
    const r = await db.normalized(plan, [issue]);
    const comments = r.lists[listAt(plan.frames[0].children[0].frame, issue)];
    assert.equal(comments.more, true);
    assert.ok(comments.cursor);
    assert.equal(decodeCursor(comments.cursor!).time, 3, "after the second-newest edge");
  });

  it("says a list is finished when it is", async () => {
    const { db, issue } = await shared();
    const { plan } = query().compile();
    const r = await db.normalized(plan, [issue]);
    assert.equal(r.lists[listAt(plan.frames[0].children[0].frame, issue)].more, false);
  });

  it("keeps counts by the alias they were asked for under", async () => {
    const { db, issue } = await shared();
    const { plan } = query().compile();
    const r = await db.normalized(plan, [issue]);
    assert.deepEqual(r.counts[listAt(0, issue)], { commentCount: 4 });
  });

  it("names its roots, since a query can start from several", async () => {
    const { db, issue } = await shared();
    const second = await db.create(Issue.otype, { title: "another", status: "open" }, { vshard: "5" });
    const { plan } = query().compile();
    const r = await db.normalized(plan, [issue, second]);
    assert.deepEqual(r.roots, [issue, second]);
    assert.ok(issue in r.objects && second in r.objects);
  });

  it("describes the same answer the nested form does", async () => {
    const { db, issue } = await shared();
    const q = Issue.gen(issue).related("comments", issueComments, (sub) => sub.related("author", commentAuthor).limit(50));
    const [nested] = await q.run(db);
    const r = await db.normalized(q);

    const { plan } = q.compile();
    const commentsFrame = plan.frames[0].children[0].frame;
    const authorFrame = plan.frames[commentsFrame].children[0].frame;
    assert.deepEqual(
      r.lists[listAt(commentsFrame, issue)].ids,
      nested.comments.map((c) => c.id),
      "the same comments, in the same order",
    );
    for (const comment of nested.comments) {
      assert.deepEqual(r.lists[listAt(authorFrame, comment.id)].ids, [comment.author!.id]);
      assert.equal(r.objects[comment.author!.id].data.name, comment.author!.name);
    }
  });

  it("can be handed a built query directly", async () => {
    const { db, issue } = await shared();
    const q = Issue.gen(issue).related("owner", issueOwner);
    assert.deepEqual(await db.normalized(q), await db.normalized(q.compile().plan, [issue]));
  });
});
