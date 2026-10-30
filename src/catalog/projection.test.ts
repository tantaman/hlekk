import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, CatalogError, plan } from "./catalog.ts";
import { generate, resolve } from "./projection.ts";

// Two domains that both link to core.user, which is what a projection has to keep apart.
const LOCK = plan({
  core: { objects: { "core.user": { fields: { name: "string", email: "string", bio: { optional: "string" } } } } },
  issues: {
    objects: {
      "issues.issue": { fields: { title: "string", status: { enum: ["open", "closed"] } } },
      "issues.comment": { fields: { body: "string", authorId: { id: "core.user" } } },
    },
    edges: {
      "issues.issue_comment": { from: "issues.issue", to: "issues.comment", inverse: "issues.comment_issue" },
      "issues.comment_issue": { from: "issues.comment", to: "issues.issue", inverse: "issues.issue_comment", maintained: true },
      "issues.issue_owner": { from: "issues.issue", to: "core.user", unique: true },
      "issues.comment_author": { from: "issues.comment", to: "core.user", field: "authorId" },
    },
  },
  marketplace: {
    objects: { "marketplace.listing": { fields: { price: "number" } } },
    edges: { "marketplace.listing_buyer": { from: "marketplace.listing", to: "core.user" } },
  },
});
const CATALOG = Catalog.compile(LOCK);

const ISSUES_WEB = { name: "issues-web", include: ["issues.*", "core.user"], fields: { "core.user": ["name"] } };

describe("resolving a projection", () => {
  it("takes a domain by glob and single entries from elsewhere", () => {
    const r = resolve(CATALOG, ISSUES_WEB);
    const names = r.objects.map((o) => o.type.name);
    assert.ok(names.includes("issues.issue"));
    assert.ok(names.includes("core.user"));
    assert.ok(!names.includes("marketplace.listing"), "another domain's types are not in it");
    assert.ok(!r.edges.some((e) => e.name.startsWith("marketplace.")));
  });

  it("narrows a type's fields, so one app's User is not another's", () => {
    const r = resolve(CATALOG, ISSUES_WEB);
    const user = r.objects.find((o) => o.type.name === "core.user")!;
    assert.deepEqual(Object.keys(user.fields), ["name"]);
    assert.equal(user.creatable, false, "email is required and this projection cannot see it");

    const full = resolve(CATALOG, { name: "admin", include: ["core.user"] });
    assert.equal(full.objects.find((o) => o.type.name === "core.user")!.creatable, true);
  });

  it("turns an unselected endpoint into a reference", () => {
    const r = resolve(CATALOG, { name: "market", include: ["marketplace.*"] });
    const user = r.objects.find((o) => o.type.name === "core.user")!;
    assert.equal(user.ref, true);
    assert.deepEqual(user.fields, {}, "an id to hold and link to, with no fields");
    assert.equal(user.creatable, false);
  });

  it("refuses to include or narrow something that is not there", () => {
    assert.throws(() => resolve(CATALOG, { name: "x", include: ["issues.nope"] }), CatalogError);
    assert.throws(() => resolve(CATALOG, { name: "x", include: ["core.user"], fields: { "core.user": ["nope"] } }), CatalogError);
    assert.throws(() => resolve(CATALOG, { name: "x", include: ["core.user"], fields: { "issues.nope": [] } }), CatalogError);
  });
});

describe("the projection hash", () => {
  it("does not change when the catalog changes somewhere else", () => {
    const before = resolve(CATALOG, ISSUES_WEB);

    // Another team adds a type and an edge of their own.
    const grown = Catalog.compile(
      plan(
        {
          core: { objects: { "core.user": { fields: { name: "string", email: "string", bio: { optional: "string" } } } } },
          issues: {
            objects: {
              "issues.issue": { fields: { title: "string", status: { enum: ["open", "closed"] } } },
              "issues.comment": { fields: { body: "string", authorId: { id: "core.user" } } },
            },
            edges: {
              "issues.issue_comment": { from: "issues.issue", to: "issues.comment", inverse: "issues.comment_issue" },
              "issues.comment_issue": { from: "issues.comment", to: "issues.issue", inverse: "issues.issue_comment", maintained: true },
              "issues.issue_owner": { from: "issues.issue", to: "core.user", unique: true },
              "issues.comment_author": { from: "issues.comment", to: "core.user", field: "authorId" },
            },
          },
          marketplace: {
            objects: { "marketplace.listing": { fields: { price: "number" } }, "marketplace.offer": { fields: {} } },
            edges: {
              "marketplace.listing_buyer": { from: "marketplace.listing", to: "core.user" },
              "marketplace.listing_offer": { from: "marketplace.listing", to: "marketplace.offer" },
            },
          },
        },
        LOCK,
      ),
    );
    const after = resolve(grown, ISSUES_WEB);
    assert.notEqual(after.catalog, before.catalog, "the catalog version moved");
    assert.equal(after.hash, before.hash, "but this projection's shape did not");
  });

  it("changes when something the projection does include changes", () => {
    const before = resolve(CATALOG, ISSUES_WEB);
    const wider = resolve(CATALOG, { ...ISSUES_WEB, fields: { "core.user": ["name", "email"] } });
    assert.notEqual(wider.hash, before.hash);
  });
});

describe("generated code", () => {
  const src = generate(resolve(CATALOG, ISSUES_WEB));

  it("says what it was generated from, and not to edit it", () => {
    assert.match(src, /Generated from catalog v\d+ for projection issues-web\. Do not edit\./);
    assert.match(src, /export const projection = \{ name: "issues-web", catalog: \d+, hash: "[0-9a-f]+" \}/);
  });

  it("names types by integer, so a rename never breaks a deployed client", () => {
    const issue = CATALOG.objectNamed("issues.issue")!;
    assert.ok(src.includes(`defineObject("issues.issue", ${issue.otype},`));
    const comments = CATALOG.edgeNamed("issues.issue_comment")!;
    assert.ok(src.includes(`edge("issues.issue_comment", ${comments.atype},`));
  });

  it("renders each field kind, and marks a stored edge, a unique one and a field relationship", () => {
    assert.ok(src.includes('status: oneOf("open", "closed")'));
    assert.ok(src.includes("authorId: id(\"core.user\")"));
    assert.ok(src.includes("{ unique: true }"), "issue_owner is to-one");
    assert.ok(src.includes('fieldRel("issues.comment_author"'), "comment_author stores nothing");
    assert.ok(!src.includes('edge("issues.comment_author"'), "so it is not a stored edge");
  });

  it("generates no create where the projection cannot supply a required field", () => {
    assert.match(src, /defineObject\("core\.user".*\{ create: false \}\);/);
    assert.match(src, /defineObject\("issues\.issue".*\{ create: true \}\)/);
  });

  it("emits a reference for an endpoint the projection does not select", () => {
    const market = generate(resolve(CATALOG, { name: "market", include: ["marketplace.*"] }));
    assert.match(market, /export const User = ref\("core\.user", \d+\);/);
    assert.ok(!market.includes('defineObject("core.user"'));
  });

  it("holds no other team's types, which is what keeps one from becoming a god class", () => {
    assert.ok(!src.includes("marketplace"));
  });
});
