import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DESCRIPTOR_VERSION, MAX_BODY, descriptorOf, handle, mountOf } from "./http.ts";
import type { Binding } from "./http.ts";
import { WIRE_VERSION } from "./wire.ts";
import { VOCABULARY_VERSION } from "./surface.ts";
import { served } from "../testkit/served.ts";
import { encodeCursor } from "../schema/query.ts";

// A `Request` object and no network. The handler is a function from one to a `Response`, which is
// what lets these tests be about the binding — status codes, routes, caps — rather than about
// whichever server happens to be in front of it.
const at = (binding: Binding, route: string, init?: RequestInit) =>
  handle(new Request(`${binding.database}${route}`, init), binding);

const post = (binding: Binding, route: string, body: unknown) =>
  at(binding, route, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("the protocol over HTTP", () => {
  it("answers a descriptor on the database URI itself", async () => {
    const { binding } = await served();
    const res = await at(binding, "");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /application\/json/);
    const d = await res.json();
    assert.equal(d.v, DESCRIPTOR_VERSION);
    assert.equal(d.protocol, "hlekk");
    assert.deepEqual(d.wire, [WIRE_VERSION]);
    // The URI it answers at, so a caller can tell it reached the database it meant.
    assert.equal(d.database, "https://issues.example/db");
    // The limits a caller builds its requests against, the entry width included.
    assert.equal(d.limits.maxDepth, 4);
    assert.equal(d.limits.maxIds, 100);
    assert.equal(d.limits.maxBody, MAX_BODY);
    // Empty rather than absent: step 5 fills it, and "authenticates nobody" has to be sayable.
    assert.deepEqual(d.keys, []);
    assert.deepEqual(d.routes, {
      read: "https://issues.example/db/read",
      price: "https://issues.example/db/price",
      vocabulary: "https://issues.example/db/vocabulary",
    });
  });

  it("mounts at the database URI's own path, root included", async () => {
    const { binding } = await served();
    assert.equal(mountOf(binding), "/db");
    assert.equal(mountOf({ ...binding, database: "https://issues.example" }), "");
    assert.equal(descriptorOf({ ...binding, database: "https://issues.example" }).routes.read, "https://issues.example/read");

    // At the root the descriptor is on `/`, and the routes hang off it with no double slash.
    const root: Binding = { ...binding, database: "https://issues.example" };
    assert.equal((await handle(new Request("https://issues.example/"), root)).status, 200);
    assert.equal((await handle(new Request("https://issues.example/vocabulary"), root)).status, 200);
  });

  it("refuses the slashed spelling of its own URI rather than repairing it", async () => {
    const { binding } = await served();
    const res = await at(binding, "/");
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /it is https:\/\/issues\.example\/db/);
  });

  it("states the exposed vocabulary", async () => {
    const { binding } = await served();
    const res = await at(binding, "/vocabulary");
    assert.equal(res.status, 200);
    const v = await res.json();
    assert.equal(v.v, VOCABULARY_VERSION);
    assert.deepEqual(Object.keys(v.edges).sort(), ["issues.comment_author", "issues.issue_comments"]);
    // A field relationship stores nothing, so it has no maintained counter to read.
    assert.equal(v.edges["issues.issue_comments"].counted, true);
    assert.equal(v.edges["issues.comment_author"].counted, false);
    assert.deepEqual(v.types["issues.issue"].fields.title, { type: "string", optional: false });
    assert.deepEqual(v.types["issues.issue"].fields.secret, { type: "string", optional: true });
  });

  it("answers a read with type names, a cost and a cacheability", async () => {
    const { binding, issue, comments } = await served();
    const res = await post(binding, "/read", {
      ids: [issue],
      counts: ["issues.issue_comments"],
      hops: [{ as: "comments", edge: "issues.issue_comments", limit: 10 }],
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.v, WIRE_VERSION);
    assert.deepEqual(body.roots, [issue]);
    // A name, never the catalog's integer: `otype` 3 here is a different type in another database.
    assert.equal(body.objects[issue].type, "issues.issue");
    assert.equal(body.objects[issue].data.title, "ship it");
    assert.deepEqual(body.lists[`1:${issue}`].ids.sort(), [...comments].sort());
    assert.equal(body.counts[`0:${issue}`]["issues.issue_comments"], 3);
    assert.deepEqual(body.cost, { frames: 2, nodes: 11 });
    assert.deepEqual(body.cache, { reuse: "public", seconds: 60 });
    // The header says what the body says, so a proxy that strips one leaves the other true.
    assert.equal(res.headers.get("cache-control"), "public, max-age=60");
  });

  it("prices what the read then reports", async () => {
    const { binding, issue } = await served();
    const req = { ids: [issue], hops: [{ edge: "issues.issue_comments", limit: 7 }] };
    const priced = await (await post(binding, "/price", req)).json();
    const read = await (await post(binding, "/read", req)).json();
    assert.equal(priced.v, WIRE_VERSION);
    assert.deepEqual(priced.cost, read.cost);
    assert.deepEqual(priced.cost, { frames: 2, nodes: 8 });
    // Priced for the entry's width, not for one root: the tree is gathered once per root.
    const wide = await (await post(binding, "/price", { ...req, ids: [issue, issue, issue] })).json();
    assert.deepEqual(wide.cost, { frames: 2, nodes: 3 + 21 });
  });

  it("continues a list from the cursor an earlier answer handed back", async () => {
    const { binding, issue, comments } = await served({ comments: 5 });
    const first = await (await post(binding, "/read", {
      ids: [issue],
      hops: [{ as: "comments", edge: "issues.issue_comments", limit: 2 }],
    })).json();
    const page = first.lists[`1:${issue}`];
    assert.equal(page.ids.length, 2);
    assert.equal(page.more, true);
    // Newest first, so the first page is the last two written.
    assert.deepEqual(page.ids, [comments[4], comments[3]]);

    const next = await (await post(binding, "/read", {
      ids: [issue],
      hops: [{ as: "comments", edge: "issues.issue_comments", limit: 2, after: page.cursor }],
    })).json();
    assert.deepEqual(next.lists[`1:${issue}`].ids, [comments[2], comments[1]]);
  });

  it("refuses a cursor that is not one, and a continuation of a field relationship", async () => {
    const { binding, issue } = await served();
    for (const after of ["", "nonsense", "v1:x:5", "v0:1:5", `v1:1:${"9".repeat(40)}`]) {
      const res = await post(binding, "/read", {
        ids: [issue],
        hops: [{ edge: "issues.issue_comments", after }],
      });
      assert.equal(res.status, 400, after);
      assert.equal((await res.json()).at, "hops[0]");
    }
    const field = await post(binding, "/read", {
      ids: [issue],
      hops: [{ edge: "issues.comment_author", after: encodeCursor(1, 0, "5") }],
    });
    assert.equal(field.status, 400);
    assert.match((await field.json()).error, /has no list/);
  });

  it("turns a refusal into a 400 that names where", async () => {
    const { binding, issue } = await served();
    const cases: [string, unknown, string, RegExp][] = [
      ["an unknown edge", { ids: [issue], hops: [{ edge: "issues.nope" }] }, "hops[0]", /no edge/],
      ["too many ids", { ids: Array.from({ length: 101 }, () => issue) }, "ids", /101 ids/],
      ["no ids at all", { ids: [] }, "ids", /at least one id/],
      [
        "a count on a field relationship",
        { ids: [issue], counts: ["issues.comment_author"] },
        "counts[0]",
        /has no count/,
      ],
      [
        // Every hop starts where its parent lands, so what refuses this is the budget and not the
        // shape: three roots times 100 comments times 100 authors is 30,303 answer nodes, and
        // nothing about the I/O underneath would reveal that.
        "an over-budget request",
        {
          ids: [issue, issue, issue],
          hops: [
            {
              edge: "issues.issue_comments",
              limit: 100,
              hops: [{ edge: "issues.comment_author", limit: 100 }],
            },
          ],
        },
        "query",
        /answer nodes/,
      ],
      [
        "a hop that does not start where its parent lands",
        {
          ids: [issue],
          hops: [{ edge: "issues.issue_comments", hops: [{ edge: "issues.issue_comments" }] }],
        },
        "hops[0].hops[0]",
        /starts at issues\.issue, and this hop is under issues\.comment/,
      ],
    ];
    for (const [why, body, where, message] of cases) {
      for (const route of ["/read", "/price"]) {
        const res = await post(binding, route, body);
        assert.equal(res.status, 400, `${why} on ${route}`);
        const refused = await res.json();
        assert.equal(refused.at, where, why);
        assert.match(refused.error, message, why);
      }
    }
  });

  it("refuses a body over the cap before parsing it", async () => {
    const { binding } = await served();
    // A claimed length, refused before a byte is read.
    const claimed = await at(binding, "/read", {
      method: "POST",
      body: "{}",
      headers: { "content-length": String(MAX_BODY + 1) },
    });
    assert.equal(claimed.status, 413);

    // And a body that is genuinely too large, whatever it claimed. Deliberately not valid JSON: a
    // 413 rather than a 400 is what shows the size was decided before the parse.
    const actual = await at(binding, "/read", { method: "POST", body: `[${"x".repeat(MAX_BODY)}` });
    assert.equal(actual.status, 413);
    assert.match((await actual.json()).error, /the maximum is/);
  });

  it("refuses a body that is not JSON, and a method that is not the route's", async () => {
    const { binding } = await served();
    const bad = await at(binding, "/read", { method: "POST", body: "not json" });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /not JSON/);

    const wrong = await at(binding, "/read", { method: "GET" });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), "POST");

    const alsoWrong = await at(binding, "/vocabulary", { method: "POST", body: "{}" });
    assert.equal(alsoWrong.status, 405);
    assert.equal(alsoWrong.headers.get("allow"), "GET");
  });

  it("falls through on a route that is not its own, so a deployment can mount it beside others", async () => {
    const { binding } = await served();
    for (const route of ["/nope", "/read/more", "/vocabulary/x"]) {
      assert.equal((await at(binding, route)).status, 404);
    }
    assert.equal((await handle(new Request("https://issues.example/elsewhere"), binding)).status, 404);
  });

  it("says nothing about a fault inside the engine", async () => {
    const { binding, issue } = await served();
    const broken: Binding = {
      ...binding,
      source: {
        normalized: () => Promise.reject(new Error("vshard 7 is on fire, host 3, /var/lib/x")),
      },
    };
    const res = await post(broken, "/read", { ids: [issue] });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.deepEqual(body, { error: "internal error" });
    assert.doesNotMatch(JSON.stringify(body), /fire|vshard|host/);
  });

  it("narrows to a projection, in the vocabulary and in the answer alike", async () => {
    const { binding, issue, comments } = await served({
      projection: {
        name: "public",
        include: ["issues.issue", "issues.issue_comments", "issues.comment"],
        fields: { "issues.issue": ["title"] },
      },
    });

    const v = await (await at(binding, "/vocabulary")).json();
    assert.deepEqual(Object.keys(v.edges), ["issues.issue_comments"]);
    assert.deepEqual(Object.keys(v.types["issues.issue"].fields), ["title"]);
    assert.equal(v.projection.name, "public");

    const body = await (await post(binding, "/read", {
      ids: [issue],
      hops: [{ edge: "issues.issue_comments" }],
    })).json();
    // The dropped field is not in the answer. Narrowing that showed in the vocabulary and not in
    // the payload would be a label rather than a boundary.
    assert.deepEqual(body.objects[issue].data, { title: "ship it" });
    assert.equal(body.objects[comments[0]].type, "issues.comment");

    // The edge the projection left out is not traversable, and nor is a filter on a dropped field.
    const edge = await post(binding, "/read", { ids: [issue], hops: [{ edge: "issues.comment_author" }] });
    assert.equal(edge.status, 400);
    const filter = await post(binding, "/read", {
      ids: [issue],
      hops: [{ edge: "issues.issue_comments", where: [{ field: "body", op: "=", value: "comment 0" }] }],
    });
    assert.equal(filter.status, 200); // body is projected on the comment
    const dropped = await post(binding, "/read", {
      ids: [issue],
      hops: [
        {
          edge: "issues.issue_comments",
          hops: [{ edge: "issues.issue_comments", where: [{ field: "secret", op: "=", value: "x" }] }],
        },
      ],
    });
    assert.equal(dropped.status, 400);
  });

  it("will not answer for a type its projection does not expose, even by id", async () => {
    const { binding, alice } = await served({
      projection: { name: "issues-only", include: ["issues.issue", "issues.comment", "issues.issue_comments"] },
    });
    // Nothing exposed reaches `core.user`: the field relationship that lands on it was not included,
    // so it is not an endpoint either. Entering by its id is the one way in, since an id does not
    // carry its type — and it is closed as absent rather than as forbidden.
    const res = await post(binding, "/read", { ids: [alice] });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.objects, {});
    assert.deepEqual(body.roots, []);
  });

  it("exposes an included edge's unselected endpoint as an id with no fields", async () => {
    const { binding, alice } = await served({
      projection: { name: "authors", include: ["issues.comment", "issues.comment_author"] },
    });
    // `core.user` was not selected, but an included edge lands on it, so a caller can hold the id
    // and follow the edge to it while reading nothing — which is what `ProjectedObject.ref` is.
    const v = await (await at(binding, "/vocabulary")).json();
    assert.deepEqual(v.types["core.user"].fields, {});

    const body = await (await post(binding, "/read", { ids: [alice] })).json();
    assert.equal(body.objects[alice].type, "core.user");
    assert.deepEqual(body.objects[alice].data, {});
  });

  it("states no-store when the policy says a response may not be reused", async () => {
    const { binding, issue } = await served({
      policy: { object: () => true, count: () => true, cache: () => ({ reuse: "never" }) },
    });
    const res = await post(binding, "/read", { ids: [issue] });
    assert.deepEqual((await res.json()).cache, { reuse: "never" });
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
});
