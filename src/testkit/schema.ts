// The schema the oracle fuzzes over. Fixed rather than generated: what the oracle is checking is that
// an answer does not depend on where the data sits, and that needs a schema rich enough to reach
// across vshards, not a different schema every seed.
//
// It has a counted edge with an inverse, an uncounted one, a to-one edge, a field relationship and a
// self edge, which between them cover every source kind an operator can read.

import { Catalog, plan } from "../catalog/catalog.ts";
import { defineObject, edge, fieldRel, id, num, oneOf, str } from "../schema/define.ts";

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
      "issues.comment_issue": { from: "issues.comment", to: "issues.issue", inverse: "issues.issue_comment" },
      "issues.issue_label": { from: "issues.issue", to: "issues.label" },
      "issues.issue_owner": { from: "issues.issue", to: "core.user", unique: true, inverse: "issues.user_owned" },
      "issues.user_owned": { from: "core.user", to: "issues.issue", inverse: "issues.issue_owner" },
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
export const types = { User, Issue, Comment, Label };

export interface Outgoing {
  name: string;
  rel: unknown;
  /** The type it lands on, so the generator can keep going. */
  to: keyof typeof types;
  /** Stored edges can be counted; a field relationship cannot. */
  countable: boolean;
}

export const outgoing: Record<keyof typeof types, Outgoing[]> = {
  Issue: [
    { name: "comments", rel: issueComments, to: "Comment", countable: true },
    { name: "labels", rel: issueLabels, to: "Label", countable: true },
    { name: "owner", rel: issueOwner, to: "User", countable: true },
    { name: "related", rel: issueRelated, to: "Issue", countable: true },
  ],
  Comment: [
    { name: "issue", rel: commentIssue, to: "Issue", countable: true },
    { name: "author", rel: commentAuthor, to: "User", countable: false },
  ],
  User: [{ name: "owns", rel: userOwned, to: "Issue", countable: true }],
  Label: [],
};

/** Fields that can be compared, per type, with a generator for a plausible value. */
export const comparable: Record<keyof typeof types, { field: string; values: (string | number)[] }[]> = {
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
