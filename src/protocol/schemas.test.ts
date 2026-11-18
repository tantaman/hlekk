import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, it } from "node:test";

import { validate } from "../../scripts/lib/jsonschema.mjs";
import { handle } from "./http.ts";
import type { Binding } from "./http.ts";
import { HintQueue, parseHint } from "./hint.ts";
import { served } from "../testkit/served.ts";

// The schemas in `spec/schemas/` are what an implementation other than this one is held to, so what
// this file checks is that THIS implementation is held to them as well. A spec whose own reference
// implementation does not validate against it is a document, not a specification.
//
// The validator is `scripts/lib/jsonschema.mjs`, which the conformance suite also uses and which
// imports nothing from `src/`. One validator and one set of schemas, so a suite run against someone
// else's database is checking the same thing this is.

const DIR = new URL("../../spec/schemas/", import.meta.url);
const docs: Record<string, unknown> = {};
for (const name of readdirSync(DIR)) docs[name] = JSON.parse(readFileSync(new URL(name, DIR), "utf8"));

const against = (name: string, body: unknown): string[] =>
  validate(docs[name], body, docs[name], "", docs) as string[];

const at = (binding: Binding, route: string, init?: RequestInit) =>
  handle(new Request(`${binding.database}${route}`, init), binding);

const post = (binding: Binding, route: string, body: unknown) =>
  at(binding, route, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

describe("every body this implementation serves", () => {
  it("validates against the descriptor schema", async () => {
    const { binding } = await served();
    assert.deepEqual(against("descriptor.json", await (await at(binding, "")).json()), []);
  });

  it("validates against the vocabulary schema, with and without a projection", async () => {
    const { binding } = await served();
    assert.deepEqual(against("vocabulary.json", await (await at(binding, "/vocabulary")).json()), []);

    const narrowed = await served({
      projection: { name: "public", include: ["issues.*"], fields: { "issues.issue": ["title"] } },
    });
    assert.deepEqual(against("vocabulary.json", await (await at(narrowed.binding, "/vocabulary")).json()), []);
  });

  it("validates against the read-response schema, lists, counts and edges included", async () => {
    const { binding, issue } = await served({ comments: 4 });
    const body = await (
      await post(binding, "/read", {
        ids: [issue],
        counts: ["issues.issue_comments"],
        hops: [
          {
            as: "comments",
            edge: "issues.issue_comments",
            limit: 2,
            hops: [{ as: "author", edge: "issues.comment_author" }],
          },
        ],
      })
    ).json();
    assert.deepEqual(against("read-response.json", body), []);
  });

  it("validates against the price-response schema", async () => {
    const { binding, issue } = await served();
    const body = await (await post(binding, "/price", { ids: [issue] })).json();
    assert.deepEqual(against("price-response.json", body), []);
  });

  it("validates every refusal against the refusal schema", async () => {
    const { binding, issue } = await served();
    const refusals: Promise<Response>[] = [
      post(binding, "/read", { ids: [] }),
      post(binding, "/read", { ids: [issue], hops: [{ edge: "no.such_edge" }] }),
      post(binding, "/read", { ids: [issue], counts: ["issues.comment_author"] }),
      at(binding, "/read", { method: "GET" }),
      at(binding, "/nope"),
      at(binding, "/read", { method: "POST", body: "x".repeat(70_000) }),
    ];
    for (const res of await Promise.all(refusals)) {
      assert.ok(res.status >= 400, `expected a refusal, got ${res.status}`);
      assert.deepEqual(against("refusal.json", await res.json()), []);
    }
  });

  it("refuses a request the schema refuses, so the two agree on what a request is", async () => {
    const { binding, issue } = await served();
    const bad: [string, unknown][] = [
      ["no ids", {}],
      ["an id that is not a decimal", { ids: ["5x"] }],
      ["an unknown member", { ids: [issue], nope: 1 }],
      ["a limit of zero", { ids: [issue], hops: [{ edge: "issues.issue_comments", limit: 0 }] }],
      ["an operator that is not one", { ids: [issue], hops: [{ edge: "issues.issue_comments", where: [{ field: "a", op: "~", value: 1 }] }] }],
      ["a hop with no edge", { ids: [issue], hops: [{ limit: 1 }] }],
    ];
    for (const [why, body] of bad) {
      assert.notDeepEqual(against("read-request.json", body), [], `the schema should refuse ${why}`);
      const res = await post(binding, "/read", body);
      assert.ok(res.status === 400, `the handler should refuse ${why}, got ${res.status}`);
    }
  });

  it("accepts the requests the schema accepts", async () => {
    const { binding, issue } = await served();
    const good: unknown[] = [
      { ids: [issue] },
      { ids: [issue], counts: ["issues.issue_comments"] },
      { ids: [issue], counts: [{ as: "n", edge: "issues.issue_comments" }] },
      { ids: [issue], hops: [{ edge: "issues.issue_comments", limit: 3, after: "v2:1:0:5" }] },
      {
        ids: [issue],
        hops: [{ as: "c", edge: "issues.issue_comments", where: [{ field: "body", op: "=", value: "x" }], hops: [] }],
      },
    ];
    for (const body of good) {
      assert.deepEqual(against("read-request.json", body), [], JSON.stringify(body));
      const res = await post(binding, "/read", body);
      assert.equal(res.status, 200, JSON.stringify(body));
    }
  });
});

describe("a hint", () => {
  it("is refused by the handler exactly where the schema refuses it", () => {
    const good: unknown[] = [
      { source: "5", edge: "notes.note_about", target: "6" },
      { source: "0", edge: "e", target: "9223372036854775807" },
    ];
    const bad: [string, unknown][] = [
      ["a missing target", { source: "5", edge: "notes.note_about" }],
      ["a source that is a reference", { source: "https://a.example/db#5", edge: "notes.note_about", target: "6" }],
      ["a target that is a reference", { source: "5", edge: "notes.note_about", target: "https://a.example/db#6" }],
      ["an id with a leading zero", { source: "05", edge: "notes.note_about", target: "6" }],
      ["an empty edge name", { source: "5", edge: "", target: "6" }],
      ["an edge name past the bound", { source: "5", edge: "e".repeat(129), target: "6" }],
      ["an unknown member", { source: "5", edge: "notes.note_about", target: "6", time: 1 }],
      ["an id that is a number", { source: 5, edge: "notes.note_about", target: "6" }],
    ];
    for (const body of good) {
      assert.deepEqual(against("hint-request.json", body), [], JSON.stringify(body));
      assert.doesNotThrow(() => parseHint(body), JSON.stringify(body));
    }
    for (const [why, body] of bad) {
      assert.notDeepEqual(against("hint-request.json", body), [], `the schema should refuse ${why}`);
      assert.throws(() => parseHint(body), `the parser should refuse ${why}`);
    }
  });

  it("is advertised by a descriptor that still validates, and only by a database that can take one", async () => {
    const { binding } = await served();
    const taking: Binding = { ...binding, hints: new HintQueue(), callerKeys: async () => [] };
    const descriptor = await (await at(taking, "")).json();
    assert.equal(descriptor.routes.hint, "https://issues.example/db/hint");
    assert.deepEqual(against("descriptor.json", descriptor), []);
    // Somewhere to put a hint and no way to know who sent it is not a database that takes them.
    const blind = await (await at({ ...binding, hints: new HintQueue() }, "")).json();
    assert.equal(blind.routes.hint, undefined);
    assert.equal((await at({ ...binding, hints: new HintQueue() }, "/hint", { method: "POST", body: "{}" })).status, 404);
  });

  it("is answered with a body the response schema accepts and nothing else", () => {
    assert.deepEqual(against("hint-response.json", { v: 1 }), []);
    assert.notDeepEqual(against("hint-response.json", { v: 1, recorded: true }), []);
  });
});

describe("the schemas themselves", () => {
  it("use only keywords the validator implements, so no constraint is silently skipped", () => {
    for (const [name, schema] of Object.entries(docs)) {
      // The validator throws on a keyword it does not implement rather than ignoring it: a schema
      // whose constraint is skipped is worse than no schema.
      assert.doesNotThrow(() => validate(schema, {}, schema, "", docs), name);
      assert.doesNotThrow(() => validate(schema, { v: 1, ids: ["1"] }, schema, "", docs), name);
    }
  });

  it("define the common shapes in one place", () => {
    // `common.json` owns what a reference is, so the per-body schemas cannot drift from each other.
    const common = docs["common.json"] as { $defs: Record<string, unknown> };
    assert.deepEqual(Object.keys(common.$defs).sort(), [
      "cacheability",
      "cost",
      "database",
      "id",
      "key",
      "reference",
      "refusal",
      "typeName",
    ]);
    const text = JSON.stringify(docs);
    assert.ok(text.includes('"common.json#/$defs/id"'), "the bodies point at it");
  });
});
