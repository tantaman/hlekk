// One small database, served over the protocol, for the tests that are about the boundary rather
// than about the engine.
//
// Shared rather than copied into each test file because the fixture is half of what those tests
// assert: the HTTP handler's tests, the encoder's round-trip, the Node adapter and step 4's two
// databases all have to be looking at the same graph, or an answer that differs says nothing about
// which side changed.
//
// The schema is design.md's own example, for the two shapes that matter at this boundary: a stored
// edge with a maintained count, and a field relationship that follows an id in a payload and stores
// nothing — so it can be traversed, has no count to read, and cannot be continued.

import { Catalog, plan as planLock } from "../catalog/catalog.ts";
import type { Lock } from "../catalog/catalog.ts";
import { LocalCluster } from "../client/local.ts";
import type { Hlekk } from "../client/client.ts";
import type { Binding } from "../protocol/http.ts";
import { surfaceOf } from "../protocol/surface.ts";
import type { Projection } from "../catalog/projection.ts";
import type { Policy } from "../query/serve.ts";
import type { Id } from "../query/types.ts";

export const SERVED_LOCK: Lock = planLock({
  core: { objects: { "core.user": { fields: { name: "string" } } } },
  issues: {
    objects: {
      "issues.issue": { fields: { title: "string", secret: { optional: "string" } } },
      "issues.comment": { fields: { body: "string", authorId: { id: "core.user" } } },
    },
    edges: {
      "issues.issue_comments": { from: "issues.issue", to: "issues.comment" },
      "issues.comment_author": { from: "issues.comment", to: "core.user", field: "authorId" },
    },
  },
});

export const SERVED_CATALOG = Catalog.compile(SERVED_LOCK);

export const T = {
  user: SERVED_CATALOG.objectNamed("core.user")!.otype,
  issue: SERVED_CATALOG.objectNamed("issues.issue")!.otype,
  comment: SERVED_CATALOG.objectNamed("issues.comment")!.otype,
  comments: SERVED_CATALOG.edgeNamed("issues.issue_comments")!.atype!,
};

export interface ServedFixture {
  cluster: LocalCluster;
  db: Hlekk;
  alice: Id;
  issue: Id;
  /** Newest last, as written: `assocAdd` times them 1, 2, 3 so a page's order is known. */
  comments: Id[];
  binding: Binding;
}

export interface ServedOptions {
  database?: string;
  projection?: Projection;
  policy?: Policy;
  /** How many comments the issue has. Three unless a test needs to page. */
  comments?: number;
}

/** An issue with its comments, each by the same author, and the binding that serves them. */
export async function served(opts: ServedOptions = {}): Promise<ServedFixture> {
  const cluster = new LocalCluster();
  cluster.directory.applyLock(SERVED_LOCK);
  cluster.spreadCatalog();
  await cluster.publish();
  const db = cluster.client();

  const alice = await db.create(T.user, { name: "alice" }, { vshard: "7" });
  const issue = await db.create(T.issue, { title: "ship it", secret: "do not send" }, { vshard: "7" });
  const comments: Id[] = [];
  for (let i = 0; i < (opts.comments ?? 3); i++) {
    const id = await db.create(T.comment, { body: `comment ${i}`, authorId: alice }, { with: issue });
    await db.assocAdd(T.comments, issue, id, i + 1);
    comments.push(id);
  }

  const binding: Binding = {
    database: opts.database ?? "https://issues.example/db",
    catalog: SERVED_CATALOG,
    source: db,
    surface: surfaceOf(SERVED_CATALOG, opts.projection),
    policy: opts.policy,
  };
  return { cluster, db, alice, issue, comments, binding };
}
