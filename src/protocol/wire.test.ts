import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan as planLock } from "../catalog/catalog.ts";
import { WIRE_VERSION, WireError, decodePrice, decodeRead, encodeRead, roundTrip } from "./wire.ts";
import { surfaceOf } from "./surface.ts";
import { SERVED_CATALOG, served } from "../testkit/served.ts";
import { serve } from "../query/serve.ts";
import type { Served } from "../query/serve.ts";

const answer = async (): Promise<{ served: Served; issue: string; comments: string[] }> => {
  const f = await served({ comments: 4 });
  const out = await serve(
    {
      ids: [f.issue],
      counts: ["issues.issue_comments"],
      hops: [
        {
          as: "comments",
          edge: "issues.issue_comments",
          limit: 2,
          hops: [{ as: "author", edge: "issues.comment_author" }],
        },
      ],
    },
    {
      catalog: SERVED_CATALOG,
      source: f.db,
      vocabulary: surfaceOf(SERVED_CATALOG).vocabulary,
    },
  );
  return { served: out, issue: f.issue, comments: f.comments };
};

describe("the wire format", () => {
  it("survives JSON and comes back as the answer that went in", async () => {
    const { served: out } = await answer();
    const surface = surfaceOf(SERVED_CATALOG);
    const encoded = roundTrip(encodeRead(out, surface));
    const decoded = decodeRead(encoded, SERVED_CATALOG);

    assert.deepEqual(decoded.result, out.result);
    assert.deepEqual(decoded.cost, out.cost);
    assert.deepEqual(decoded.cache, out.cache);
    assert.deepEqual(decoded.declined, []);
  });

  it("carries type names, not the catalog's integers", async () => {
    const { served: out, issue } = await answer();
    const body = encodeRead(out, surfaceOf(SERVED_CATALOG));
    assert.equal(body.v, WIRE_VERSION);
    assert.equal(body.objects[issue].type, "issues.issue");
    assert.equal("otype" in body.objects[issue], false);
  });

  // The names mean nothing on their own: two databases that both say `issues.issue` agree by
  // convention. What the decoder owes is that a name it does not know is reported rather than
  // guessed at, and that one unknown type does not lose the rest of the answer.
  it("declines a type the reading catalog does not declare, and keeps the rest", async () => {
    const { served: out, issue, comments } = await answer();
    const encoded = roundTrip(encodeRead(out, surfaceOf(SERVED_CATALOG)));

    const partial = Catalog.compile(
      planLock({
        issues: {
          objects: { "issues.issue": { fields: { title: "string", secret: { optional: "string" } } } },
        },
      }),
    );
    const decoded = decodeRead(encoded, partial);
    assert.deepEqual(decoded.declined, ["issues.comment", "core.user"].filter((t) => t in collectTypes(encoded)));
    assert.equal(issue in decoded.result.objects, true);
    assert.equal(comments[3] in decoded.result.objects, false);
    // The reference is still in the list it was reached through, which is exactly what an
    // unfollowed reference looks like. The caller sees the id and no object.
    assert.deepEqual(decoded.result.lists[`1:${issue}`].ids.length, 2);
  });

  it("maps a name to the READING catalog's own integer", async () => {
    const { served: out, issue } = await answer();
    const encoded = roundTrip(encodeRead(out, surfaceOf(SERVED_CATALOG)));
    // A catalog that declares the same name under a different integer, which is the normal case
    // across two independently planned databases.
    const other = Catalog.compile(
      planLock({
        padding: { objects: { "padding.a": { fields: {} }, "padding.b": { fields: {} } } },
        issues: { objects: { "issues.issue": { fields: { title: "string" } } } },
      }),
    );
    const mine = other.objectNamed("issues.issue")!.otype;
    assert.notEqual(mine, SERVED_CATALOG.objectNamed("issues.issue")!.otype);
    assert.equal(decodeRead(encoded, other).result.objects[issue].otype, mine);
  });

  it("sends only the fields the surface projects", async () => {
    const { served: out, issue } = await answer();
    const narrow = surfaceOf(SERVED_CATALOG, {
      name: "titles",
      include: ["issues.*"],
      fields: { "issues.issue": ["title"] },
    });
    assert.deepEqual(encodeRead(out, narrow).objects[issue].data, { title: "ship it" });
    assert.deepEqual(encodeRead(out, surfaceOf(SERVED_CATALOG)).objects[issue].data, {
      title: "ship it",
      secret: "do not send",
    });
  });

  it("refuses to name a type the surface does not expose, rather than inventing one", async () => {
    const { served: out } = await answer();
    const narrow = surfaceOf(SERVED_CATALOG, { name: "issues", include: ["issues.issue"] });
    // `serve` hides these with the policy, so reaching one here is this database failing rather than
    // a disclosure to paper over — and the handler turns it into a 500, not a partial answer.
    assert.throws(() => encodeRead(out, narrow), WireError);
  });
});

describe("decoding a stranger's answer", () => {
  const good = async () => roundTrip(encodeRead((await answer()).served, surfaceOf(SERVED_CATALOG))) as Record<string, unknown>;

  it("accepts a reference in a list, which is what an unfollowed one looks like", async () => {
    const body = await good();
    const lists = body.lists as Record<string, { ids: string[]; edges?: unknown[] }>;
    const key = Object.keys(lists)[0]!;
    const entry = lists[key]!;
    const forged = {
      ...body,
      lists: { [key]: { ids: ["https://elsewhere.example/db#5"], cursor: null, more: false } },
    };
    const decoded = decodeRead(forged, SERVED_CATALOG);
    // The reference is kept and no object stands behind it. That is the only way a caller can tell
    // "the responder holds a reference it will not follow" from "there is nothing there".
    assert.deepEqual(decoded.result.lists[key]!.ids, ["https://elsewhere.example/db#5"]);
    void entry;
  });

  it("refuses an object key that is not a bare id of the database answering", async () => {
    const body = await good();
    const objects = body.objects as Record<string, unknown>;
    const [first] = Object.keys(objects);
    // The check that stops a responder supplying objects for a database it does not own: a
    // qualified key would be cached as if the caller had asked that database itself.
    for (const key of ["https://elsewhere.example/db#5", "5x", "", "-1", "0x5"]) {
      const forged = { ...body, objects: { ...objects, [key]: objects[first] } };
      const err = caught(() => decodeRead(forged, SERVED_CATALOG)) as WireError;
      assert.ok(err instanceof WireError, `${key}: ${err}`);
      assert.match(err.message, /bare decimal/);
    }
  });

  it("refuses a wire version it does not speak", async () => {
    const body = await good();
    for (const v of [0, 2, "1", undefined]) {
      const err = caught(() => decodeRead({ ...body, v }, SERVED_CATALOG)) as WireError;
      assert.equal(err.at, "v");
    }
    assert.equal((caught(() => decodePrice({ v: 2, cost: { frames: 1, nodes: 1 } })) as WireError).at, "v");
  });

  it("refuses an edges array that does not pair with its ids", async () => {
    const body = await good();
    const lists = body.lists as Record<string, { ids: string[]; edges?: unknown[] }>;
    const key = Object.keys(lists).find((k) => lists[k].edges !== undefined)!;
    const forged = { ...body, lists: { ...lists, [key]: { ...lists[key], edges: [] } } };
    const err = caught(() => decodeRead(forged, SERVED_CATALOG)) as WireError;
    assert.match(err.message, /edges for/);
  });

  it("refuses a reuse mode it does not know, rather than keeping the answer anyway", async () => {
    const body = await good();
    const err = caught(() => decodeRead({ ...body, cache: { reuse: "forever" } }, SERVED_CATALOG)) as WireError;
    assert.equal(err.at, "cache.reuse");
  });

  it("names where, for every shape that is not the one promised", async () => {
    const body = await good();
    const cases: [unknown, string][] = [
      [null, "body"],
      [{ ...body, roots: "5" }, "roots"],
      [{ ...body, roots: [5] }, "roots[0]"],
      [{ ...body, objects: [] }, "objects"],
      [{ ...body, lists: 7 }, "lists"],
      [{ ...body, counts: { "0:5": { a: "3" } } }, 'counts."0:5".a'],
      [{ ...body, shape: { x: {} } }, "shape.x"],
      [{ ...body, cost: {} }, "cost.frames"],
      [{ ...body, cache: undefined }, "cache"],
    ];
    for (const [forged, at] of cases) {
      const err = caught(() => decodeRead(forged, SERVED_CATALOG)) as WireError;
      assert.ok(err instanceof WireError, `${at}: ${err}`);
      assert.equal(err.at, at);
    }
  });

  it("refuses a list whose cursor or ids are the wrong shape", async () => {
    const body = await good();
    const lists = body.lists as Record<string, unknown>;
    const key = Object.keys(lists)[0];
    const at = `lists.${JSON.stringify(key)}`;
    const cases: [unknown, string][] = [
      [{ ids: ["5"], cursor: 7, more: false }, `${at}.cursor`],
      [{ ids: ["5"], cursor: null, more: "no" }, `${at}.more`],
      // A reference is fine in a list — it is how an unfollowed one is reported — but not a
      // non-canonical spelling of one.
      [{ ids: ["https://X.example/db#5"], cursor: null, more: false }, `${at}.ids[0]`],
      [{ ids: ["5x"], cursor: null, more: false }, `${at}.ids[0]`],
    ];
    for (const [entry, where] of cases) {
      const err = caught(() => decodeRead({ ...body, lists: { [key]: entry } }, SERVED_CATALOG)) as WireError;
      assert.equal(err.at, where);
    }
  });
});

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a throw");
}

const collectTypes = (body: unknown): Record<string, true> =>
  Object.fromEntries(
    Object.values((body as { objects: Record<string, { type: string }> }).objects).map((o) => [o.type, true as const]),
  );
