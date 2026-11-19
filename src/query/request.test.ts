import assert from "node:assert/strict";
import { describe as suite, it } from "node:test";

import type { FieldSpec } from "../catalog/catalog.ts";
import { DEFAULT_LIMITS, Refused, check, checkShape, compile } from "./request.ts";
import type { Request, Vocabulary } from "./request.ts";

// A vocabulary with more than one object type, which is the case `examples/wiki/wiki-query.test.ts` cannot
// reach: every relation in that schema is page-to-page, so checking a filter against its hop's target
// type and checking it against the one object type are indistinguishable. Here they are not.
const FIELDS: Record<string, Record<string, FieldSpec>> = {
  "issues.issue": { title: "string", open: "boolean" },
  "core.user": { name: "string", age: "number" },
};
const EDGES: Record<string, { from: string; to: string }> = {
  "issues.issue_owner": { from: "issues.issue", to: "core.user" },
  "issues.issue_labels": { from: "issues.issue", to: "issues.issue" },
  "core.user_issues": { from: "core.user", to: "issues.issue" },
};
const VOCAB: Vocabulary = {
  edge: (n) => EDGES[n],
  edges: () => Object.keys(EDGES),
  fields: (t) => FIELDS[t],
};

const refusal = (req: unknown): Refused => {
  try {
    check(req as Request, VOCAB);
  } catch (e) {
    assert.ok(e instanceof Refused, `expected Refused, got ${String(e)}`);
    return e;
  }
  throw new Error("expected the request to be refused");
};

suite("a bounded request", () => {
  it("checks a filter against the type its own hop lands on", () => {
    // issue_owner lands on core.user, so core.user's fields are the ones in scope.
    assert.ok(check({ hops: [{ edge: "issues.issue_owner", where: [{ field: "name", op: "=", value: "ada" }] }] }, VOCAB));

    // `title` exists — on issues.issue, which is not where this hop landed.
    const e = refusal({ hops: [{ edge: "issues.issue_owner", where: [{ field: "title", op: "=", value: "x" }] }] });
    assert.match(e.message, /no field "title" on core\.user/);
    assert.match(e.message, /name, age/);
    assert.equal(e.at, "hops[0].where[0]");
  });

  it("checks a value against the type the field declares", () => {
    const e = refusal({ hops: [{ edge: "issues.issue_owner", where: [{ field: "age", op: ">", value: "old" }] }] });
    assert.match(e.message, /field "age" is number, but the value is string/);
  });

  it("names what was available when an edge is not exposed", () => {
    const e = refusal({ hops: [{ edge: "issues.issue_secrets" }] });
    assert.match(e.message, /no edge "issues.issue_secrets"/);
    assert.match(e.message, /issues\.issue_owner/);
  });

  it("prices a request as the product of the limits down each path", () => {
    // 1 root, then 2 owners, then 3 issues under each of those 2.
    const cost = check({ hops: [{ edge: "issues.issue_owner", limit: 2, hops: [{ edge: "core.user_issues", limit: 3 }] }] }, VOCAB);
    assert.deepEqual(cost, { frames: 3, nodes: 1 + 2 + 6 });
  });

  it("refuses what no read budget would catch", () => {
    // Three hops at the maximum limit: 100 + 10,000 + 1,000,000 answer nodes, against storage reads
    // that stay flat. This is the property the guard exists for.
    const deep: Request = {
      hops: [
        {
          edge: "issues.issue_owner",
          limit: 100,
          hops: [{ edge: "core.user_issues", limit: 100, hops: [{ edge: "issues.issue_labels", limit: 100 }] }],
        },
      ],
    };
    const e = refusal(deep);
    assert.match(e.message, /answer nodes/);
    assert.match(e.message, /product of the limits/);
    assert.equal(e.at, "query");
  });

  it("honours a budget tighter than the default", () => {
    const req: Request = { hops: [{ edge: "issues.issue_owner", limit: 2, hops: [{ edge: "core.user_issues", limit: 3 }] }] };
    assert.ok(check(req, VOCAB));
    assert.match(refusal2(req, { ...DEFAULT_LIMITS, maxNodes: 5 }).message, /answer nodes/);
    assert.match(refusal2(req, { ...DEFAULT_LIMITS, maxDepth: 1 }).message, /nest 2 deep/);
    assert.match(refusal2(req, { ...DEFAULT_LIMITS, maxFrames: 2 }).message, /3 frames/);
  });

  it("leaves the entry to the caller, since no two schemas share one", () => {
    // No `from`, and nothing here asks for it: a unique-index lookup, a list of ids or a title is the
    // one part of a request the core cannot validate.
    assert.deepEqual(check({}, VOCAB), { frames: 1, nodes: 1 });
    assert.deepEqual(check({ hops: [] }, VOCAB), { frames: 1, nodes: 1 });
  });

  it("bounds counts and filters per hop, and counts at the root", () => {
    assert.match(refusal({ counts: ["issues.nope"] }).message, /no edge "issues.nope"/);
    const many = (n: number) => Array.from({ length: n }, () => "issues.issue_owner");
    assert.match(refusal({ counts: many(5) }).message, /5 counts, the maximum is 4/);
    assert.match(
      refusal({ hops: [{ edge: "issues.issue_labels", counts: many(5) }] }).message,
      /5 counts, the maximum is 4/,
    );
    assert.match(
      refusal({
        hops: [
          {
            edge: "issues.issue_labels",
            where: Array.from({ length: 5 }, () => ({ field: "title", op: "=" as const, value: "x" })),
          },
        ],
      }).message,
      /5 filters, the maximum is 4/,
    );
  });

  it("refuses a limit that is not a whole number in range", () => {
    for (const limit of [0, -5, 1.5, DEFAULT_LIMITS.maxLimit + 1]) {
      assert.match(refusal({ hops: [{ edge: "issues.issue_labels", limit }] }).message, /limit must be/);
    }
  });
});

// What is wrong with a request whichever database it is asked of. A caller with no single
// vocabulary to check against makes these on their own, and they have to be the checks `check`
// makes: a second copy of them had already let through a count this one refuses.
suite("a request checked without a vocabulary", () => {
  const shape = (req: unknown): Refused => {
    try {
      checkShape(req as Request);
    } catch (e) {
      assert.ok(e instanceof Refused, `expected Refused, got ${String(e)}`);
      return e;
    }
    throw new Error("expected the request to be refused");
  };

  it("refuses what `check` refuses of the same request, at the same place", () => {
    const wrong: unknown[] = [
      { hops: [{ edge: "issues.issue_labels", limitt: 2 }] },
      { counts: [{ as: "n", edge: "issues.issue_labels", extra: 1 }] },
      { hops: [{ edge: "issues.issue_labels", counts: [{ as: "n", edge: "issues.issue_labels", extra: 1 }] }] },
      { hops: [{ edge: "issues.issue_labels", where: [{ field: "title", op: "~", value: "x" }] }] },
      { hops: [{ edge: "issues.issue_labels", where: [{ field: "title", op: "=" }] }] },
      { hops: [{ edge: "issues.issue_labels", hops: [{ edge: "issues.issue_owner", where: [{ field: "name", op: "=", value: "a", not: 1 }] }] }] },
    ];
    for (const req of wrong) {
      const [alone, checked] = [shape(req), refusal(req)];
      assert.deepEqual([alone.at, alone.message], [checked.at, checked.message], JSON.stringify(req));
    }
  });

  it("names no edge and no field, so a request for several databases passes where it is well formed", () => {
    checkShape({ counts: ["an.edge.nobody.has"], hops: [{ edge: "another", limit: 5000, where: [{ field: "anything", op: "=", value: 1 }] }] });
    assert.equal(shape({ hops: [{ edge: "x", limit: 0 }] }).at, "hops[0].limit");
    assert.equal(shape({ hops: [{ edge: "x", after: 7 }] }).at, "hops[0].after");
  });

  it("compiles a request the way a name resolves, and tells each frame where it came from", () => {
    const seen: [number, string][] = [];
    const plan = compile(
      { counts: ["c"], hops: [{ edge: "a", as: "first", hops: [{ edge: "b", limit: 3, where: [{ field: "f", op: ">", value: 1 }] }] }] },
      { source: (hop) => ({ kind: "edge", atype: hop.edge.charCodeAt(0) }), counted: () => 9, cursor: () => ({ time: 0, db: 0, id2: "0" }) },
      undefined,
      (frame, _node, at) => seen.push([frame, at]),
    );
    assert.deepEqual(seen, [[0, ""], [1, "hops[0]"], [2, "hops[0].hops[0]"]]);
    assert.deepEqual(plan.frames[0], { source: { kind: "ids" }, limit: undefined, after: undefined, children: [{ alias: "first", frame: 1 }], counts: [{ alias: "c", atype: 9 }], where: undefined });
    assert.deepEqual([plan.frames[1]!.limit, plan.frames[2]!.limit], [25, 3], "a hop with no limit takes the default; the entry takes none");
    assert.deepEqual(plan.frames[2]!.where, { cmp: ">", on: "obj", field: "f", value: 1 });
  });
});

function refusal2(req: Request, limits: typeof DEFAULT_LIMITS): Refused {
  try {
    check(req, VOCAB, limits);
  } catch (e) {
    assert.ok(e instanceof Refused, `expected Refused, got ${String(e)}`);
    return e;
  }
  throw new Error("expected the request to be refused");
}
