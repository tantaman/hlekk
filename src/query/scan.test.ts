// The scan cap: a filtered list examines at most its share of the responder's `maxScan`, stops there
// with a cursor past the last row it read, and is continued from that cursor without losing a row.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan as planLock } from "../catalog/catalog.ts";
import { LocalCluster } from "../client/local.ts";
import type { QueryResult } from "./normalize.ts";
import { DEFAULT_LIMITS, Refused, check } from "./request.ts";
import type { Hop, Limits } from "./request.ts";
import { planOf, serve, vocabularyOf } from "./serve.ts";
import type { ReadRequest } from "./serve.ts";
import type { Plan } from "./types.ts";

const LOCK = planLock({
  core: { objects: { "core.user": { fields: { name: "string" } } } },
  issues: {
    objects: {
      "issues.issue": { fields: { title: "string" } },
      "issues.comment": { fields: { body: "string", keep: "boolean", authorId: { id: "core.user" } } },
    },
    edges: {
      "issues.issue_comments": { from: "issues.issue", to: "issues.comment" },
      "issues.comment_author": { from: "issues.comment", to: "core.user", field: "authorId" },
    },
  },
});
const CATALOG = Catalog.compile(LOCK);
const VOCAB = vocabularyOf(CATALOG);
const ISSUE = CATALOG.objectNamed("issues.issue")!.otype;
const COMMENT = CATALOG.objectNamed("issues.comment")!.otype;
const USER = CATALOG.objectNamed("core.user")!.otype;
const COMMENTS = CATALOG.edgeNamed("issues.issue_comments")!.atype!;

const N = 40;
/** Which comments a `keep = true` filter passes, by creation index. */
const kept = (i: number) => i % 7 === 3;

/**
 * One issue with forty comments, `c0` to `c39`, written oldest first so the list reads `c39` first.
 * `spread` puts the comments in several vshards over four hosts, so a list's targets are read from
 * hosts other than the one holding the list.
 */
async function database(spread = false) {
  const c = new LocalCluster();
  c.directory.applyLock(LOCK);
  if (spread) c.scatter(4);
  c.spreadCatalog();
  await c.publish();
  const db = c.client();
  const alice = await db.create(USER, { name: "alice" }, { vshard: "7" });
  const issue = await db.create(ISSUE, { title: "busy" }, { vshard: "7" });
  for (let i = 0; i < N; i++) {
    const id = spread
      ? await db.create(COMMENT, { body: `c${i}`, keep: kept(i), authorId: alice }, { vshard: String(11 + (i % 5) * 13) })
      : await db.create(COMMENT, { body: `c${i}`, keep: kept(i), authorId: alice }, { with: issue });
    await db.assocAdd(COMMENTS, issue, id, i + 1);
  }
  return { c, db, issue };
}

const limits = (maxScan: number): Limits => ({ ...DEFAULT_LIMITS, maxScan });

/** Every page of the issue's filtered comments, continued until it says there is no more. */
async function pages(d: Awaited<ReturnType<typeof database>>, hop: Hop, maxScan: number) {
  const out: { bodies: string[]; more: boolean; cursor: string | null }[] = [];
  let after: string | undefined;
  for (let i = 0; i < 100; i++) {
    const req: ReadRequest = { ids: [d.issue], hops: [{ as: "c", ...hop, ...(after ? { after } : {}) }] };
    const { result } = await serve(req, { catalog: CATALOG, source: d.db, vocabulary: VOCAB, limits: limits(maxScan) });
    const list = result.lists[`1:${d.issue}`]!;
    out.push({ bodies: list.ids.map((id) => result.objects[id]!.data.body as string), more: list.more, cursor: list.cursor });
    if (!list.more) return out;
    assert.ok(list.cursor, "a list that says more carries a cursor");
    after = list.cursor;
  }
  throw new Error("the list never ended");
}

/** Newest first, as the list reads. */
const expected = (pass: (i: number) => boolean) =>
  [...Array(N).keys()].reverse().filter(pass).map((i) => `c${i}`);

const KEEP: Hop = { edge: "issues.issue_comments", limit: 10, where: [{ field: "keep", op: "=", value: true }] };

describe("pricing the scan", () => {
  const priced = (req: Omit<ReadRequest, "ids">, maxScan: number, roots = 1) => check(req, VOCAB, limits(maxScan), roots);

  it("charges nothing to a request that filters nothing", () => {
    assert.equal(priced({ hops: [{ edge: "issues.issue_comments" }] }, 10).scan, undefined);
  });

  it("gives one filtered list the whole allowance", () => {
    assert.equal(priced({ hops: [KEEP] }, 10).scan, 10);
  });

  it("splits it evenly over every list the request could filter", () => {
    const under = { hops: [{ edge: "issues.issue_comments", limit: 5, hops: [{ edge: "issues.comment_author", where: [{ field: "name", op: "=" as const, value: "alice" }] }] }] };
    assert.equal(priced(under, 10).scan, 2, "five comments, so five author lists filtered");
    assert.equal(priced({ hops: [KEEP] }, 10, 2).scan, 5, "two roots, two lists");
    assert.equal(priced({ hops: [KEEP, { ...KEEP, as: "again" }] }, 10).scan, 5, "two filtered hops off one root");
  });

  it("refuses a request that would leave each list no row at all", () => {
    const under = { hops: [{ edge: "issues.issue_comments", limit: 5, hops: [{ edge: "issues.comment_author", where: [{ field: "name", op: "=" as const, value: "x" }] }] }] };
    assert.throws(() => priced(under, 3), (e: unknown) => e instanceof Refused && /leaves none a row/.test(e.message));
  });

  it("is reported by the read as it was priced", async () => {
    const d = await database();
    const served = await serve({ ids: [d.issue], hops: [KEEP] }, { catalog: CATALOG, source: d.db, vocabulary: VOCAB, limits: limits(10) });
    assert.equal(served.cost.scan, 10);
  });
});

describe("a filtered list at its share", () => {
  it("stops with what it found, says more, and continues past every row it read", async () => {
    const got = await pages(await database(), KEEP, 10);
    // Four pages of ten, and then one more: a filtered list says more while rows follow the last one
    // it kept, whether or not they would pass, which is what a list always did and not the cap's.
    assert.equal(got.length, 5, "forty rows at ten a page, and the tail after the last kept row");
    assert.ok(got.slice(0, -1).every((p) => p.more), "each page but the last says more");
    assert.deepEqual(got.flatMap((p) => p.bodies), expected(kept), "every passing row once, in order");
    assert.ok(got.every((p) => p.bodies.length < 10), "and none of them filled its limit: the share stopped them");
  });

  it("may be empty and still say more, and continuing it makes progress", async () => {
    const only = { ...KEEP, where: [{ field: "body", op: "=" as const, value: "c0" }] };
    const got = await pages(await database(), only, 10);
    assert.deepEqual(got[0], { ...got[0], bodies: [], more: true }, "nothing in the first ten, and it says so");
    assert.notEqual(got[0].cursor, null);
    assert.deepEqual(got.flatMap((p) => p.bodies), ["c0"], "found, at the far end");
  });

  it("continues from the last row it kept when its limit fills inside the share", async () => {
    // Limit 1 under a share of 10: the filter reads ahead of what the limit keeps, and a cursor past
    // the rows it read ahead would skip the next passing one.
    const got = await pages(await database(), { ...KEEP, limit: 1 }, 10);
    assert.deepEqual(got.flatMap((p) => p.bodies), expected(kept));
  });

  it("gives the same pages however the data is spread", async () => {
    const one = await pages(await database(false), KEEP, 10);
    const four = await pages(await database(true), KEEP, 10);
    assert.deepEqual(four.map((p) => [p.bodies, p.more]), one.map((p) => [p.bodies, p.more]));
  });

  it("gives the same answer from both drivers", async () => {
    const d = await database(true);
    const plan: Plan = { ...planOf({ ids: [d.issue], hops: [{ as: "c", ...KEEP }] }, CATALOG), scan: 10 };
    const bodies = (r: QueryResult) => r.lists[`1:${d.issue}`]!.ids.map((id) => r.objects[id]!.data.body);
    const rounds = await d.db.normalized(plan, [d.issue], { driver: "rounds" });
    const async = await d.db.normalized(plan, [d.issue], { driver: "async" });
    assert.deepEqual(bodies(rounds), bodies(async));
    assert.deepEqual(rounds.lists[`1:${d.issue}`], async.lists[`1:${d.issue}`], "the same cursor too");
  });

  it("does not cap the engine's own caller, which sets no scan", async () => {
    const d = await database();
    const plan = planOf({ ids: [d.issue], hops: [{ as: "c", ...KEEP }] }, CATALOG);
    const r = await d.db.normalized(plan, [d.issue]);
    const list = r.lists[`1:${d.issue}`]!;
    assert.deepEqual(list.ids.map((id) => r.objects[id]!.data.body), expected(kept), "all six in one page, from all forty rows");
  });

  it("refuses to read an exists that ran out of scan as false", async () => {
    const d = await database();
    // Issues that have a comment called c0, which is the fortieth row of the list.
    const plan = (scan: number): Plan => ({
      scan,
      frames: [
        { source: { kind: "ids" }, where: { exists: 1 }, children: [], counts: [] },
        { source: { kind: "edge", atype: COMMENTS }, where: { cmp: "=", on: "obj", field: "body", value: "c0" }, limit: 1, children: [], counts: [] },
      ],
    });
    await assert.rejects(() => d.db.query(plan(10), [d.issue]), /does not show there is none/);
    assert.equal((await d.db.query(plan(100), [d.issue])).length, 1, "with room to find it, it is found");
  });
});
