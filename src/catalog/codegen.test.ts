import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { describe, it } from "node:test";

import { LocalCluster } from "../client/local.ts";
import { Catalog, CatalogError, plan } from "./catalog.ts";
import { generate, resolve } from "./projection.ts";

const LOCK = plan({
  core: { objects: { "core.user": { fields: { name: "string" } } } },
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
});
const CATALOG = Catalog.compile(LOCK);

/** The module an app would import, written where node can load it. */
function emit(): { dir: string; file: string } {
  const projection = resolve(CATALOG, { name: "issues-web", include: ["issues.*", "core.user"] });
  const runtime = resolvePath(import.meta.dirname, "../schema/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "hlekk-gen-"));
  const file = join(dir, "schema.gen.ts");
  writeFileSync(file, generate(projection, { importFrom: runtime }));
  return { dir, file };
}

describe("generated code, actually loaded", () => {
  it("imports, and its integers match the lock it came from", async () => {
    const { dir, file } = emit();
    try {
      const gen = (await import(file)) as Record<string, { otype?: number; atype?: number }> & {
        projection: { name: string; catalog: number; hash: string };
      };
      assert.equal(gen.projection.name, "issues-web");
      assert.equal(gen.projection.catalog, LOCK.version);
      assert.equal(gen.Issue.otype, LOCK.objects["issues.issue"].otype);
      assert.equal(gen.issueComment.atype, LOCK.edges["issues.issue_comment"].atype);
      assert.equal(gen.commentAuthor.atype, undefined, "a field relationship stores nothing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds and runs a query, so the loop from lock to answer closes", async () => {
    const { dir, file } = emit();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gen = (await import(file)) as any;
      const c = new LocalCluster();
      c.directory.applyLock(LOCK);
      c.spreadCatalog();
      await c.publish();
      const db = c.client();

      const alice = await db.create(gen.User.otype, { name: "alice" }, { vshard: "40" });
      const issue = await db.create(gen.Issue.otype, { title: "Crash on save", status: "open" }, { vshard: "5" });
      await db.assocAdd(gen.issueOwner.atype, issue, alice, 1);
      for (const [i, body] of ["first", "second"].entries()) {
        const comment = await db.create(gen.Comment.otype, { body, authorId: alice }, { with: issue });
        await db.assocAdd(gen.issueComment.atype, issue, comment, i + 1);
      }

      const [page] = await gen.Issue.gen(issue)
        .related("comments", gen.issueComment, (q: any) => q.related("author", gen.commentAuthor))
        .related("owner", gen.issueOwner)
        .countAs("commentCount", gen.issueComment)
        .run(db);

      assert.equal(page.title, "Crash on save");
      assert.equal(page.commentCount, 2);
      assert.deepEqual(
        page.comments.map((x: { body: string }) => x.body),
        ["second", "first"],
      );
      assert.equal(page.comments[0].author.name, "alice");
      assert.equal(page.owner.name, "alice", "unique: true survived codegen as one object");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to emit two definitions under one identifier", () => {
    const clashing = Catalog.compile(
      plan({
        a: { objects: { "a.user": { fields: {} } } },
        b: { objects: { "b.user": { fields: {} } } },
      }),
    );
    assert.throws(
      () => generate(resolve(clashing, { name: "both", include: ["a.*", "b.*"] })),
      (e: unknown) => e instanceof CatalogError && /both generate as User/.test(e.message),
    );
  });
});
