import assert from "node:assert/strict";
import { describe as suite, it } from "node:test";

import type { FieldSpec } from "../catalog/catalog.ts";
import { DEFAULT_LIMITS, Refused, check } from "./request.ts";
import type { Request, Vocabulary } from "./request.ts";

// A vocabulary with more than one object type, which is the case `worker/wiki-query.test.ts` cannot
// reach: every relation in that schema is page-to-page, so checking a filter against its hop's target
// type and checking it against the one object type are indistinguishable. Here they are not.
const FIELDS: Record<string, Record<string, FieldSpec>> = {
  "issues.issue": { title: "string", open: "boolean" },
  "core.user": { name: "string", age: "number" },
};
const EDGES: Record<string, { to: string }> = {
  "issues.issue_owner": { to: "core.user" },
  "issues.issue_labels": { to: "issues.issue" },
  "core.user_issues": { to: "issues.issue" },
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

function refusal2(req: Request, limits: typeof DEFAULT_LIMITS): Refused {
  try {
    check(req, VOCAB, limits);
  } catch (e) {
    assert.ok(e instanceof Refused, `expected Refused, got ${String(e)}`);
    return e;
  }
  throw new Error("expected the request to be refused");
}
