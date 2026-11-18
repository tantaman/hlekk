import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { listen } from "./http.ts";
import type { NodeDatabase } from "./http.ts";
import { served } from "../../testkit/served.ts";
import { MAX_BODY } from "../../protocol/http.ts";
import { decodePrice, decodeRead } from "../../protocol/wire.ts";
import { SERVED_CATALOG } from "../../testkit/served.ts";

// Over a real socket, with a real `fetch`. Everything the handler's own tests prove is proved
// without a network; what this adds is that the translation either way is faithful — status, headers,
// body, and the size cap at the socket rather than after it.
describe("the protocol over node:http", () => {
  const open: NodeDatabase[] = [];
  after(async () => {
    await Promise.all(open.map((s) => s.close()));
  });

  const start = async (path = "/db") => {
    const { binding, issue, comments } = await served({ comments: 4 });
    const { database: _ignored, ...parts } = binding;
    const node = await listen(parts, { path });
    open.push(node);
    return { node, issue, comments };
  };

  it("advertises the URI it is actually reachable at", async () => {
    const { node } = await start();
    assert.equal(node.database, `${node.origin}/db`);
    const d = await (await fetch(node.database)).json();
    assert.equal(d.database, node.database);
    // The routes it names are the routes it answers.
    for (const route of Object.values(d.routes) as string[]) {
      const res = await fetch(route, route.endsWith("/vocabulary") ? undefined : { method: "POST", body: "{}" });
      assert.notEqual(res.status, 404, route);
    }
  });

  it("serves a public identity from a different local mount", async () => {
    const { binding } = await served({ database: "https://public.example/catalog" });
    const node = await listen(binding, { path: "/internal" });
    open.push(node);
    const descriptor = await (await fetch(node.origin + "/internal")).json();
    assert.equal(descriptor.database, binding.database);
    assert.equal(descriptor.routes.read, binding.database + "/read");
  });

  it("answers a read a client can decode", async () => {
    const { node, issue, comments } = await start();
    const res = await fetch(`${node.database}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: [issue],
        counts: ["issues.issue_comments"],
        hops: [{ as: "comments", edge: "issues.issue_comments", limit: 2 }],
      }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "public, max-age=60");
    const decoded = decodeRead(await res.json(), SERVED_CATALOG);
    assert.deepEqual(decoded.result.roots, [issue]);
    assert.deepEqual(decoded.result.lists[`1:${issue}`].ids, [comments[3], comments[2]]);
    assert.equal(decoded.result.counts[`0:${issue}`]["issues.issue_comments"], 4);
  });

  it("prices over the wire too", async () => {
    const { node, issue } = await start();
    const res = await fetch(`${node.database}/price`, {
      method: "POST",
      body: JSON.stringify({ ids: [issue], hops: [{ edge: "issues.issue_comments", limit: 3 }] }),
    });
    assert.deepEqual(decodePrice(await res.json()), { frames: 2, nodes: 4 });
  });

  it("refuses at the socket a body it would otherwise read whole", async () => {
    const { node } = await start();
    const res = await fetch(`${node.database}/read`, { method: "POST", body: "x".repeat(MAX_BODY + 64) });
    assert.equal(res.status, 413);
  });

  it("carries a refusal's `at` and a 405's `allow` across the translation", async () => {
    const { node, issue } = await start();
    const refused = await fetch(`${node.database}/read`, {
      method: "POST",
      body: JSON.stringify({ ids: [issue], hops: [{ edge: "nope" }] }),
    });
    assert.equal(refused.status, 400);
    assert.equal((await refused.json()).at, "hops[0]");

    const wrong = await fetch(`${node.database}/read`);
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), "POST, QUERY, OPTIONS");

    assert.equal((await fetch(`${node.origin}/nope`)).status, 404);
  });

  it("serves at the origin root when the path is empty", async () => {
    const { node } = await start("");
    assert.equal(node.database, node.origin);
    assert.equal((await fetch(`${node.origin}/`)).status, 200);
    assert.equal((await fetch(`${node.origin}/vocabulary`)).status, 200);
  });
});
