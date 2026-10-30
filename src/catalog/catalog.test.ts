import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, CatalogError, canonical, plan, sumOf } from "./catalog.ts";
import type { Domain, Lock } from "./catalog.ts";

const issues: Record<string, Domain> = {
  core: { objects: { "core.user": { fields: { name: "string" } } } },
  issues: {
    objects: { "issues.issue": { fields: { title: "string" } }, "issues.label": { fields: { name: "string" } } },
    edges: {
      "issues.issue_label": { from: "issues.issue", to: "issues.label" },
      "issues.issue_owner": { from: "issues.issue", to: "core.user", inverse: "issues.user_owned" },
      "issues.user_owned": { from: "core.user", to: "issues.issue", inverse: "issues.issue_owner", maintained: true },
    },
  },
};

describe("plan", () => {
  it("assigns every entry an integer and bumps the version", () => {
    const lock = plan(issues);
    assert.equal(lock.version, 1);
    assert.deepEqual(
      Object.values(lock.objects)
        .map((o) => o.otype)
        .sort(),
      [1, 2, 3],
    );
    assert.deepEqual(
      Object.values(lock.edges)
        .map((e) => e.atype)
        .sort(),
      [1, 2, 3],
    );
  });

  it("keeps integers across a change and allocates only for what is new", () => {
    const first = plan(issues);
    const grown: Record<string, Domain> = {
      ...issues,
      issues: {
        ...issues.issues,
        objects: { ...issues.issues.objects, "issues.comment": { fields: { body: "string" } } },
      },
    };
    const second = plan(grown, first);
    assert.equal(second.version, 2);
    for (const name of Object.keys(first.objects)) {
      assert.equal(second.objects[name].otype, first.objects[name].otype, `${name} kept its otype`);
    }
    assert.equal(second.objects["issues.comment"].otype, 4); // the next free one
  });

  it("tombstones a removed name, so its lingering values cannot come back under it", () => {
    const first = plan(issues);
    // The edge that points at it has to go in the same plan: a dangling reference does not apply.
    const { "issues.issue_label": _dropped, ...keptEdges } = issues.issues.edges!;
    const shrunk: Record<string, Domain> = {
      ...issues,
      issues: { objects: { "issues.issue": { fields: { title: "string" } } }, edges: keptEdges },
    };
    const second = plan(shrunk, first);
    assert.ok(second.tombstones?.includes("issues.label"));
    assert.ok(second.tombstones?.includes("issues.issue_label"));
    assert.throws(() => plan(issues, second), CatalogError); // re-adding either is refused
  });

  it("refuses removing a type an edge still points at", () => {
    const first = plan(issues);
    const orphaned: Record<string, Domain> = {
      ...issues,
      issues: { objects: { "issues.issue": { fields: { title: "string" } } }, edges: issues.issues.edges },
    };
    assert.throws(() => plan(orphaned, first), CatalogError);
  });

  it("refuses an entry a domain does not own", () => {
    assert.throws(() => plan({ issues: { objects: { "core.user": { fields: {} } } } }), CatalogError);
  });

  it("refuses a field relationship that names no field, and an inverse that is not a mirror", () => {
    assert.throws(
      () => plan({ a: { objects: { "a.x": { fields: {} } }, edges: { "a.e": { from: "a.x", to: "a.x", field: "nope" } } } }),
      CatalogError,
    );
    assert.throws(
      () =>
        plan({
          a: {
            objects: { "a.x": { fields: {} }, "a.y": { fields: {} } },
            // a.back runs y to y, so it is not the mirror of a.fwd
            edges: {
              "a.fwd": { from: "a.x", to: "a.y", inverse: "a.back" },
              "a.back": { from: "a.y", to: "a.y", inverse: "a.fwd" },
            },
          },
        }),
      CatalogError,
    );
  });

  // One writer per row. Both halves of a pair used to be writable, which put two vshards in charge of
  // the same two rows with nothing ordering them against each other, so the pair could be left
  // holding one half or with the two halves disagreeing about an edge's time. Naming the derived side
  // is what makes the outbox's per-source ordering mean something, so the catalog insists on it
  // rather than leaving it to whoever writes first.
  const pair = (fwd: Record<string, unknown>, back: Record<string, unknown>) =>
    plan({
      a: {
        objects: { "a.x": { fields: {} }, "a.y": { fields: {} } },
        edges: {
          "a.fwd": { from: "a.x", to: "a.y", inverse: "a.back", ...fwd },
          "a.back": { from: "a.y", to: "a.x", inverse: "a.fwd", ...back },
        },
      },
    });

  it("takes a pair with one side maintained", () => {
    const lock = pair({}, { maintained: true });
    const cat = Catalog.compile(lock);
    assert.equal(cat.edgeNamed("a.back")!.maintained, true);
    assert.equal(cat.edgeNamed("a.fwd")!.maintained, false);
    assert.equal(cat.maintainedBy(lock.edges["a.back"].atype!)!.name, "a.fwd", "and says which side writes it");
    assert.equal(cat.maintainedBy(lock.edges["a.fwd"].atype!), undefined);
  });

  it("refuses a pair where neither side is maintained, or both are", () => {
    assert.throws(() => pair({}, {}), /neither is maintained/);
    assert.throws(() => pair({ maintained: true }, { maintained: true }), /both maintained/);
  });

  it("refuses an edge that is maintained but names no inverse", () => {
    assert.throws(
      () =>
        plan({
          a: { objects: { "a.x": { fields: {} } }, edges: { "a.e": { from: "a.x", to: "a.x", maintained: true } } },
        }),
      /maintained but names no inverse/,
    );
  });

  it("refuses an edge that names itself as its inverse, since neither side could maintain the other", () => {
    assert.throws(
      () =>
        plan({
          a: { objects: { "a.x": { fields: {} } }, edges: { "a.e": { from: "a.x", to: "a.x", inverse: "a.e" } } },
        }),
      /names itself as its inverse/,
    );
  });
});

describe("the lock sum", () => {
  it("does not depend on the order keys were written in", () => {
    assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }] , b: 1 }));
  });

  it("catches two plans merged on one version", () => {
    const base = plan(issues);
    // Both branches plan version 2 from the same base, so git merges the version line silently.
    const mine = plan({ ...issues, mine: { objects: { "mine.a": { fields: {} } } } }, base);
    const theirs = plan({ ...issues, theirs: { objects: { "theirs.b": { fields: {} } } } }, base);
    assert.equal(mine.version, theirs.version);
    assert.notEqual(mine.sum, theirs.sum);

    // A hand-merged lock carrying one branch's sum does not apply.
    const merged: Lock = { ...mine, objects: { ...mine.objects, ...theirs.objects } };
    assert.throws(() => Catalog.compile(merged), CatalogError);
    assert.equal(sumOf({ ...merged, sum: undefined }), sumOf(merged)); // the sum covers contents, not itself
  });
});

describe("the compiled catalog", () => {
  const c = Catalog.compile(plan(issues));

  it("pairs inverses by atype", () => {
    const fwd = c.edgeNamed("issues.issue_owner")!;
    const back = c.edgeNamed("issues.user_owned")!;
    assert.equal(c.inverseOf(fwd.atype!), back.atype);
    assert.equal(c.inverseOf(back.atype!), fwd.atype);
  });

  it("has no inverse for an edge that declares none", () => {
    assert.equal(c.inverseOf(c.edgeNamed("issues.issue_label")!.atype!), undefined);
  });

  it("lists the edge types declared from a type, for onDelete", () => {
    const issue = c.objectNamed("issues.issue")!;
    assert.deepEqual(
      c.edgesFrom(issue.otype).map((e) => e.name),
      ["issues.issue_label", "issues.issue_owner"],
    );
    // An edge declaring no onDelete drops its own edges and leaves the targets alone.
    assert.equal(c.edgeNamed("issues.issue_label")!.onDelete, "detach");
  });

  it("refuses a reused integer", () => {
    const lock = plan(issues);
    const names = Object.keys(lock.objects);
    const clash: Lock = {
      ...lock,
      sum: undefined,
      objects: { ...lock.objects, [names[1]]: { ...lock.objects[names[1]], otype: lock.objects[names[0]].otype } },
    };
    assert.throws(() => Catalog.compile(clash), CatalogError);
  });
});
