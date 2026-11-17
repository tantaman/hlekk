import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handle } from "./http.ts";
import type { Binding } from "./http.ts";
import { served } from "../testkit/served.ts";
import { federate } from "../testkit/federation.ts";
import { Catalog, plan as planLock } from "../catalog/catalog.ts";
import type { Lock } from "../catalog/catalog.ts";

// What a caller can work out about a database nobody described, from one id.
//
// The pieces are tested elsewhere — the vocabulary's shape in `http.test.ts`, the refusals in
// `schemas.test.ts`. What this file holds is the LOOP: read the vocabulary, read an object, work out
// what may be asked next from the two together, ask it. That loop is the whole of dynamic discovery,
// and it is a property of the protocol rather than of any one route, so nothing else would catch it
// breaking.

interface Vocab {
  types: Record<string, { fields: Record<string, { type: string; optional: boolean }> }>;
  edges: Record<string, { from: string; to: string; counted: boolean; foreign?: boolean }>;
}

/** A caller with no schema of its own, only what the database will tell it. */
function stranger(binding: Binding) {
  const call = async (route: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await handle(
      new Request(`${binding.database}${route}`, body === undefined
        ? undefined
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      binding,
    );
    return { status: res.status, body: await res.json() };
  };
  return {
    call,
    vocabulary: async (): Promise<Vocab> => (await call("/vocabulary")).body as Vocab,
    /** Every edge that may be hung under an object of this type. */
    off: (v: Vocab, type: string) => Object.entries(v.edges).filter(([, e]) => e.from === type),
  };
}

describe("a caller discovering a database it was not told about", () => {
  it("walks it from one id, asking only what the vocabulary says it may", async () => {
    const { binding, issue, comments, alice } = await served({ comments: 3 });
    const agent = stranger(binding);
    const v = await agent.vocabulary();

    // The schema, in one call. Every type with its fields, every edge with both its endpoints.
    assert.deepEqual(Object.keys(v.types).sort(), ["core.user", "issues.comment", "issues.issue"]);
    assert.deepEqual(v.edges["issues.issue_comments"], {
      from: "issues.issue",
      to: "issues.comment",
      counted: true,
      foreign: false,
    });

    // The type of the object in hand comes back with it: the one thing an id does not carry.
    const seed = await agent.call("/read", { ids: [issue] });
    const type = seed.body.objects[issue].type;
    assert.equal(type, "issues.issue");

    // What may be asked next, worked out from the two together and nothing else.
    const off = agent.off(v, type);
    assert.deepEqual(off.map(([n]) => n), ["issues.issue_comments"]);

    const answer = await agent.call("/read", {
      ids: [issue],
      // A count only where the vocabulary said there is one to read, under a name of its own: a
      // count and a hop over the same edge default to the same name, and one answer cannot be both.
      counts: off.filter(([, e]) => e.counted).map(([n]) => ({ as: `n:${n}`, edge: n })),
      hops: off.map(([name, e]) => ({
        as: name,
        edge: name,
        limit: 10,
        // And one level further, by the same rule applied to where this edge lands.
        hops: agent.off(v, e.to).map(([deeper]) => ({ as: deeper, edge: deeper, limit: 10 })),
      })),
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.counts[`0:${issue}`]["n:issues.issue_comments"], 3);
    assert.deepEqual(answer.body.lists[`1:${issue}`].ids.sort(), [...comments].sort());
    // It reached `core.user` two hops deep without ever being told that `core.user` existed.
    assert.equal(answer.body.objects[alice].type, "core.user");
  });

  it("is told when a hop cannot start where it put it, rather than handed an empty list", async () => {
    const { binding, issue } = await served({ comments: 3 });
    const agent = stranger(binding);
    const v = await agent.vocabulary();
    // `issues.issue_comments` starts at an issue. Under a comment it can only ever return nothing,
    // and nothing is an answer a caller cannot tell from a true empty list — which is exactly the
    // answer a caller building its tree from the vocabulary must be able to rely on.
    const wrong = await agent.call("/read", {
      ids: [issue],
      hops: [{ edge: "issues.issue_comments", hops: [{ edge: "issues.issue_comments" }] }],
    });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.at, "hops[0].hops[0]");
    // And it says what IS available from there, so the correction needs no second round trip.
    assert.match(wrong.body.error, /this hop is under issues\.comment/);
    assert.match(wrong.body.error, /From issues\.comment the schema has issues\.comment_author/);
    assert.equal(v.edges["issues.comment_author"].from, "issues.comment");
  });

  it("says plainly when a type has nothing hanging off it", async () => {
    const { binding, issue } = await served();
    const agent = stranger(binding);
    // `core.user` originates no edge, so a hop under it is refused and the refusal says so rather
    // than listing alternatives that do not exist.
    const wrong = await agent.call("/read", {
      ids: [issue],
      hops: [
        {
          edge: "issues.issue_comments",
          hops: [{ edge: "issues.comment_author", hops: [{ edge: "issues.issue_comments" }] }],
        },
      ],
    });
    assert.equal(wrong.status, 400);
    assert.match(wrong.body.error, /From core\.user the schema has no edges/);
  });

  it("cannot be refused for a hop off the root, since an id does not carry its type", async () => {
    const { binding, issue, alice } = await served();
    const agent = stranger(binding);
    // `ids` may legitimately hold objects of more than one type, and pricing happens before any I/O
    // that could find out which. So a root hop that fits neither is answered as the empty list it
    // genuinely is — the one place the check above cannot reach, and the spec says so.
    const mixed = await agent.call("/read", { ids: [issue, alice], hops: [{ edge: "issues.comment_author" }] });
    assert.equal(mixed.status, 200);
    // Both roots get a list, and both are empty — which is the true answer for each of them, since
    // neither an issue nor a user has an `authorId`. An empty list the caller cannot interpret is
    // the price of the entry not carrying a type, and the spec says where that price is paid.
    assert.deepEqual(Object.keys(mixed.body.lists).sort(), [`1:${alice}`, `1:${issue}`].sort());
    assert.deepEqual(Object.values(mixed.body.lists).map((l: any) => l.ids), [[], []]);
  });

  it("is told which hops may leave the database before it spends a request on one", async () => {
    const WIKI = "https://wiki.example/db";
    const NOTES = "https://notes.example/db";
    const NOTES_LOCK: Lock = planLock({
      notes: {
        objects: { "notes.note": { fields: { body: "string" } } },
        edges: { "notes.note_about": { from: "notes.note", to: "wiki.page", foreign: true } },
      },
      wiki: {
        objects: { "wiki.page": { fields: { title: "string" } } },
        edges: { "wiki.page_links": { from: "wiki.page", to: "wiki.page" } },
      },
    });
    const f = await federate({
      members: [
        { uri: WIKI, lock: planLock({ wiki: { objects: { "wiki.page": { fields: { title: "string" } } } } }), database: "wiki" },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
      ],
    });
    const v = (await (await f.fetch(`${NOTES}/vocabulary`)).json()) as Vocab;

    // The hop out is marked; the one that stays is not. A caller reading this knows which of its
    // hops costs another round trip and another database's policy, which is what a budget is for.
    assert.equal(v.edges["notes.note_about"].foreign, true);
    assert.equal(v.edges["wiki.page_links"].foreign, false);

    // And the catalog agrees, which is what makes the vocabulary's claim worth reading.
    const catalog = Catalog.compile(NOTES_LOCK);
    assert.equal(catalog.edgeNamed("notes.note_about")!.foreign, true);
    assert.equal(catalog.edgeNamed("wiki.page_links")!.foreign, false);
  });

  it("sees a projected database as exactly what it exposes, and no more", async () => {
    const { binding, issue } = await served({
      projection: { name: "public", include: ["issues.issue", "issues.comment", "issues.issue_comments"], fields: { "issues.issue": ["title"] } },
    });
    const agent = stranger(binding);
    const v = await agent.vocabulary();
    // No `core.user`, no `comment_author`, no `secret`. A caller walking this cannot ask for any of
    // them, and cannot tell they exist.
    assert.deepEqual(Object.keys(v.types).sort(), ["issues.comment", "issues.issue"]);
    assert.deepEqual(Object.keys(v.edges), ["issues.issue_comments"]);
    assert.deepEqual(Object.keys(v.types["issues.issue"].fields), ["title"]);

    // And the walk it builds from that is answered, which is the point: a narrowed surface is still
    // a complete description of itself.
    const seed = await agent.call("/read", { ids: [issue] });
    const off = agent.off(v, seed.body.objects[issue].type);
    const answer = await agent.call("/read", { ids: [issue], hops: off.map(([n]) => ({ as: n, edge: n, limit: 5 })) });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.lists[`1:${issue}`].ids.length, 3);
  });
});

// The three ways a caller's own names could be lost, each of which produced an answer it could not
// tell from a true one. Found by writing the discovery test above: a caller working from the
// vocabulary names a count and a hop by the edge name, because that is what the vocabulary calls it.
describe("a name a caller chose that the answer would lose", () => {
  it("refuses a count and a hop that would land under one name", async () => {
    const { binding, issue } = await served({ comments: 3 });
    const agent = stranger(binding);
    // Before: the count overwrote the list, so three comments came back as an empty list with
    // `more: true` — and 3 as the count, which is what made it look right.
    const both = await agent.call("/read", {
      ids: [issue],
      counts: ["issues.issue_comments"],
      hops: [{ edge: "issues.issue_comments", limit: 10 }],
    });
    assert.equal(both.status, 400);
    assert.equal(both.body.at, "counts[0]");
    assert.match(both.body.error, /one answer cannot be both/);

    // Either of them alone is fine, and so are both under names of their own.
    assert.equal((await agent.call("/read", { ids: [issue], counts: ["issues.issue_comments"] })).status, 200);
    const named = await agent.call("/read", {
      ids: [issue],
      counts: [{ as: "n", edge: "issues.issue_comments" }],
      hops: [{ edge: "issues.issue_comments", limit: 10 }],
    });
    assert.equal(named.status, 200);
    assert.equal(named.body.counts[`0:${issue}`].n, 3);
    assert.equal(named.body.lists[`1:${issue}`].ids.length, 3);
  });

  it("refuses two hops under one name, rather than doing both and keeping one", async () => {
    const { binding, issue } = await served({ comments: 3 });
    const agent = stranger(binding);
    const twice = await agent.call("/read", {
      ids: [issue],
      hops: [
        { as: "c", edge: "issues.issue_comments", limit: 10 },
        { as: "c", edge: "issues.issue_comments", limit: 2 },
      ],
    });
    assert.equal(twice.status, 400);
    assert.equal(twice.body.at, "hops[1]");
  });

  it("refuses a name a row already carries, which `id` would not shadow but collapse", async () => {
    const { binding, issue } = await served({ comments: 3 });
    const agent = stranger(binding);
    // The normalized form reads `row.id` to key every object, list and count. A relationship called
    // `id` therefore does not hide a field — it takes the answer's structure with it, and before
    // this the list for that frame was missing from the answer altogether.
    for (const as of ["id", "$version", "$edge", "$anything"]) {
      const res = await agent.call("/read", { ids: [issue], hops: [{ as, edge: "issues.issue_comments" }] });
      assert.equal(res.status, 400, as);
      assert.match(res.body.error, /a name a row already carries/, as);
    }
    // And the same for a count, whose name is the caller's too.
    const counted = await agent.call("/read", { ids: [issue], counts: [{ as: "id", edge: "issues.issue_comments" }] });
    assert.equal(counted.status, 400);
  });

  it("refuses a collision nested under a hop, not only at the root", async () => {
    const { binding, issue } = await served({ comments: 3 });
    const agent = stranger(binding);
    const deep = await agent.call("/read", {
      ids: [issue],
      hops: [
        {
          as: "c",
          edge: "issues.issue_comments",
          counts: ["issues.comment_author"],
          hops: [{ edge: "issues.comment_author" }],
        },
      ],
    });
    // The count is refused first, because a field relationship has none to read — which is the
    // stricter of the two reasons and the one worth hearing.
    assert.equal(deep.status, 400);
    assert.equal(deep.body.at, "hops[0].counts[0]");

    const collides = await agent.call("/read", {
      ids: [issue],
      hops: [
        {
          as: "c",
          edge: "issues.issue_comments",
          hops: [
            { as: "a", edge: "issues.comment_author" },
            { as: "a", edge: "issues.comment_author" },
          ],
        },
      ],
    });
    assert.equal(collides.status, 400);
    assert.equal(collides.body.at, "hops[0].hops[1]");
  });
});
