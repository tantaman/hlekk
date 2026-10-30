// The hand-written schema the oracle fuzzes over, as one Shape.
//
// Fixed rather than generated, and kept alongside the generated ones: what the oracle checks is that
// an answer does not depend on where the data sits, and a schema that changes every seed makes a
// failure harder to read. This one is rich enough to reach across vshards — a counted edge with an
// inverse, an uncounted one, a to-one edge, a field relationship and a self edge, which between them
// cover every source kind an operator can read.

import { Catalog, plan } from "../catalog/catalog.ts";
import type { Fields } from "../query/types.ts";
import type { Random } from "../runtime/runtime.ts";
import { defineObject, edge, fieldRel, id, num, oneOf, str } from "../schema/define.ts";
import type { FieldMap, ObjectType } from "../schema/define.ts";
import type { Outgoing, Payload, Shape } from "./shape.ts";

export const LOCK = plan({
  core: { objects: { "core.user": { fields: { name: "string", rank: "number" } } } },
  issues: {
    objects: {
      "issues.issue": { fields: { title: "string", status: { enum: ["open", "closed"] } } },
      "issues.comment": { fields: { body: "string", score: "number", authorId: { id: "core.user" } } },
      "issues.label": { fields: { name: "string" } },
    },
    edges: {
      "issues.issue_comment": {
        from: "issues.issue",
        to: "issues.comment",
        inverse: "issues.comment_issue",
        onDelete: "cascade",
      },
      "issues.comment_issue": { from: "issues.comment", to: "issues.issue", inverse: "issues.issue_comment", maintained: true },
      "issues.issue_label": { from: "issues.issue", to: "issues.label" },
      "issues.issue_owner": { from: "issues.issue", to: "core.user", unique: true, inverse: "issues.user_owned" },
      "issues.user_owned": { from: "core.user", to: "issues.issue", inverse: "issues.issue_owner", maintained: true },
      "issues.comment_author": { from: "issues.comment", to: "core.user", field: "authorId" },
      "issues.issue_related": { from: "issues.issue", to: "issues.issue" },
    },
  },
});

export const CATALOG = Catalog.compile(LOCK);
const ot = (name: string) => LOCK.objects[name].otype;
const at = (name: string) => LOCK.edges[name].atype!;

export const User = defineObject("core.user", ot("core.user"), { name: str(), rank: num() });
export const Issue = defineObject("issues.issue", ot("issues.issue"), {
  title: str(),
  status: oneOf("open", "closed"),
});
export const Comment = defineObject("issues.comment", ot("issues.comment"), {
  body: str(),
  score: num(),
  authorId: id("core.user"),
});
export const Label = defineObject("issues.label", ot("issues.label"), { name: str() });

export const issueComments = edge("issues.issue_comment", at("issues.issue_comment"), Issue, Comment);
export const issueLabels = edge("issues.issue_label", at("issues.issue_label"), Issue, Label);
export const issueOwner = edge("issues.issue_owner", at("issues.issue_owner"), Issue, User, { unique: true });
export const issueRelated = edge("issues.issue_related", at("issues.issue_related"), Issue, Issue);
export const commentIssue = edge("issues.comment_issue", at("issues.comment_issue"), Comment, Issue);
export const userOwned = edge("issues.user_owned", at("issues.user_owned"), User, Issue);
export const commentAuthor = fieldRel("issues.comment_author", Comment, User, "authorId");

/** Every object type, and every way out of it. The query generator walks this. */
export const types: Record<string, ObjectType<FieldMap>> = { User, Issue, Comment, Label };

export const outgoing: Record<string, Outgoing[]> = {
  Issue: [
    { name: "comments", rel: issueComments, to: "Comment", atype: issueComments.atype, inverse: commentIssue.atype },
    { name: "labels", rel: issueLabels, to: "Label", atype: issueLabels.atype },
    { name: "owner", rel: issueOwner, to: "User", atype: issueOwner.atype, inverse: userOwned.atype },
    { name: "related", rel: issueRelated, to: "Issue", atype: issueRelated.atype },
  ],
  Comment: [
    { name: "issue", rel: commentIssue, to: "Issue", atype: commentIssue.atype, inverse: issueComments.atype, maintained: true },
    { name: "author", rel: commentAuthor, to: "User" },
  ],
  User: [{ name: "owns", rel: userOwned, to: "Issue", atype: userOwned.atype, inverse: issueOwner.atype, maintained: true }],
  Label: [],
};

/** Fields a filter can compare, per type, with the values that occur in payloads. */
export const comparable: Shape["comparable"] = {
  Issue: [
    { field: "status", values: ["open", "closed"] },
    { field: "title", values: ["t0", "t1", "t2"] },
  ],
  Comment: [
    { field: "score", values: [0, 1, 2, 3] },
    { field: "body", values: ["b0", "b1", "b2"] },
  ],
  User: [
    { field: "rank", values: [0, 1, 2] },
    { field: "name", values: ["u0", "u1", "u2"] },
  ],
  Label: [{ field: "name", values: ["l0", "l1"] }],
};

/** A payload from a small pool of values, so a generated filter matches some rows. */
function payload(r: Random, type: string, ref: (target: string) => number | undefined): Payload {
  const plain = (data: Fields): Payload => ({ data, refs: {} });
  switch (type) {
    case "Issue":
      return plain({ title: r.pick(["t0", "t1", "t2"]), status: r.pick(["open", "closed"]) });
    case "Comment": {
      // authorId points at a user already made, so the field relationship has somewhere to land.
      const author = ref("User");
      return {
        data: { body: r.pick(["b0", "b1", "b2"]), score: r.int(4), authorId: "0" },
        refs: author === undefined ? {} : { authorId: author },
      };
    }
    case "User":
      return plain({ name: r.pick(["u0", "u1", "u2"]), rank: r.int(3) });
    default:
      return plain({ name: r.pick(["l0", "l1"]) });
  }
}

export const FIXED: Shape = { lock: LOCK, types, outgoing, comparable, payload };
