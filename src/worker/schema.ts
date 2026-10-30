// The demo's schema. One domain file's worth of names, planned into a lock, plus the runtime values a
// query is built from — which is what a generated projection would hand an app.

import { plan } from "../catalog/catalog.ts";
import { defineObject, edge, fieldRel, id, oneOf, str } from "../schema/define.ts";

export const LOCK = plan({
  core: { objects: { "core.user": { fields: { name: "string" } } } },
  issues: {
    objects: {
      "issues.issue": { fields: { title: "string", status: { enum: ["open", "closed"] } } },
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
      "issues.comment_issue": {
        from: "issues.comment",
        to: "issues.issue",
        inverse: "issues.issue_comment",
        maintained: true,
      },
      // The owner is a person, who outlives the issue.
      "issues.issue_owner": { from: "issues.issue", to: "core.user", unique: true, inverse: "issues.user_owned" },
      "issues.user_owned": { from: "core.user", to: "issues.issue", inverse: "issues.issue_owner", maintained: true },
      "issues.comment_author": { from: "issues.comment", to: "core.user", field: "authorId" },
    },
  },
});

const ot = (name: string) => LOCK.objects[name].otype;
const at = (name: string) => LOCK.edges[name].atype!;

export const User = defineObject("core.user", ot("core.user"), { name: str() });
export const Issue = defineObject("issues.issue", ot("issues.issue"), {
  title: str(),
  status: oneOf("open", "closed"),
});
export const Comment = defineObject("issues.comment", ot("issues.comment"), {
  body: str(),
  authorId: id("core.user"),
});

export const issueComments = edge("issues.issue_comment", at("issues.issue_comment"), Issue, Comment);
/** The maintained half of the owner pair: nothing writes it directly, and reading it is the only way
 *  to see that a cross-host inverse edge arrived. */
export const userOwned = edge("issues.user_owned", at("issues.user_owned"), User, Issue);
export const issueOwner = edge("issues.issue_owner", at("issues.issue_owner"), Issue, User, { unique: true });
export const commentAuthor = fieldRel("issues.comment_author", Comment, User, "authorId");
