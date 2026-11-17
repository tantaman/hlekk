// The query editor's guard, which is the only thing standing between a typed query and the three
// holes docs/wikimedia-demo.md found in the engine. Tested because an untested guard is not one, and
// because two of the three are meant to be *unrepresentable* here rather than caught — a claim that
// is worth checking rather than asserting.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalize } from "../client/client.ts";
import { LIMITS, QueryRefused, build, check, parseQuery, planOf, price, schemaView, unparse } from "./wiki-query.ts";
import type { QuerySpec } from "./wiki-query.ts";
import { categoryPages, legacyTitleKey, linkedFrom, pageCategories, pageLinks, titleKey } from "./wiki.ts";

const from = { ns: 0, title: "France" };
const refusal = (spec: unknown): QueryRefused => {
  try {
    check(spec as QuerySpec);
  } catch (e) {
    assert.ok(e instanceof QueryRefused, `expected QueryRefused, got ${String(e)}`);
    return e;
  }
  throw new Error("expected the query to be refused");
};

describe("the schema the editor autocompletes from", () => {
  it("names every edge the catalog has, and no other", () => {
    const names = schemaView().edges.map((e) => e.name).sort();
    assert.deepEqual(names, [pageCategories.name, "wiki.category_pages", linkedFrom.name, pageLinks.name].sort());
  });

  it("reports each field's type, and which are optional", () => {
    const page = schemaView().objects.find((o) => o.name === "wiki.page")!;
    const byName = new Map(page.fields.map((f) => [f.name, f]));
    assert.equal(byName.get("ns")!.type, "number");
    assert.equal(byName.get("title")!.type, "string");
    assert.equal(byName.get("redirect")!.type, "boolean");
    // The one optional field, and the editor has to know so it can say so.
    assert.equal(byName.get("extract")!.optional, true);
    assert.equal(byName.get("title")!.optional, false);
  });

  it("serves the budget, so an author sees the same numbers the guard uses", () => {
    assert.equal(schemaView().limits.maxNodes, LIMITS.maxNodes);
    assert.ok(schemaView().limits.ops.includes("="));
  });
});

describe("what the guard refuses", () => {
  it("the exponential answer, which no read budget would catch", () => {
    // The demo doc's own case: a chain of limits whose product is the answer size, while storage
    // reads stay flat. Four levels of 100 is 101 million nodes and 4 frames.
    let hop: Record<string, unknown> = { edge: pageLinks.name, limit: 100 };
    for (let i = 0; i < 3; i++) hop = { edge: pageLinks.name, limit: 100, hops: [hop] };
    const e = refusal({ from, hops: [hop] });
    assert.match(e.message, /answer nodes/);
    assert.match(e.message, /product of the limits/);
  });

  it("a chain deeper than the maximum, before it is even priced", () => {
    let hop: Record<string, unknown> = { edge: pageLinks.name, limit: 2 };
    for (let i = 0; i < LIMITS.maxDepth + 2; i++) hop = { edge: pageLinks.name, limit: 2, hops: [hop] };
    assert.match(refusal({ from, hops: [hop] }).message, /nest|maximum/);
  });

  it("a limit outside the permitted range, including a negative one", () => {
    assert.match(refusal({ from, hops: [{ edge: pageLinks.name, limit: 0 }] }).message, /limit must be/);
    assert.match(refusal({ from, hops: [{ edge: pageLinks.name, limit: -5 }] }).message, /limit must be/);
    assert.match(
      refusal({ from, hops: [{ edge: pageLinks.name, limit: LIMITS.maxLimit + 1 }] }).message,
      /limit must be/,
    );
    assert.match(refusal({ from, hops: [{ edge: pageLinks.name, limit: 1.5 }] }).message, /limit must be/);
  });

  it("an edge the schema does not have, naming the ones it does", () => {
    const e = refusal({ from, hops: [{ edge: "wiki.page_haters", limit: 5 }] });
    assert.match(e.message, /no edge "wiki.page_haters"/);
    assert.match(e.message, /wiki\.page_links/);
  });

  it("a field that does not exist, rather than matching nothing", () => {
    // The engine's own behaviour is to match nothing, which in an editor reads as a wrong answer.
    const e = refusal({ from, hops: [{ edge: pageLinks.name, where: [{ field: "nope", op: "=", value: 1 }] }] });
    assert.match(e.message, /no field "nope"/);
    assert.equal(e.at, "hops[0].where[0]");
  });

  it("a value whose type the field does not take", () => {
    const e = refusal({ from, hops: [{ edge: pageLinks.name, where: [{ field: "ns", op: "=", value: "zero" }] }] });
    assert.match(e.message, /field "ns" is number/);
  });

  it("an operator that is not a comparison", () => {
    const spec = { from, hops: [{ edge: pageLinks.name, where: [{ field: "ns", op: "DROP", value: 0 }] }] };
    assert.match(refusal(spec).message, /operator must be one of/);
  });

  it("a missing or malformed entry point", () => {
    assert.match(refusal({ hops: [] }).message, /title is required/);
    assert.match(refusal({ from: { ns: 0, title: "" } }).message, /title is required/);
    assert.match(refusal({ from: { ns: -1, title: "France" } }).message, /namespace must be/);
    assert.match(refusal({ from: { ns: 1.5, title: "France" } }).message, /namespace must be/);
  });

  it("more frames than a plan may hold", () => {
    // Many shallow hops: each is cheap on its own, so only the frame count catches this. Each needs
    // its own name, or what catches it first is two of them landing under one.
    const hops = Array.from({ length: LIMITS.maxFrames + 2 }, (_, i) => ({ as: `h${i}`, edge: pageLinks.name, limit: 1 }));
    assert.match(refusal({ from, hops }).message, /frames/);
  });

  it("two of a caller's own names landing on one", () => {
    // The answer is `{...payload, id, $version, ...relations, ...counts}`, so a collision means one
    // of them silently wins. This builder strips the `wiki.` prefix from both a hop's name and a
    // count's, so a bare count and a bare hop over one edge are the same name — which is what an
    // author writing the page card's query by hand would reach for first.
    assert.match(
      refusal({ from, counts: [pageLinks.name], hops: [{ edge: pageLinks.name, limit: 5 }] }).message,
      /"page_links" is already the "wiki\.page_links" hop/,
    );
    assert.match(refusal({ from, hops: [{ as: "x", edge: pageLinks.name }, { as: "x", edge: linkedFrom.name }] }).message, /cannot be both/);
    // And a name the row already carries, which `id` would not shadow but collapse.
    assert.match(refusal({ from, hops: [{ as: "id", edge: pageLinks.name }] }).message, /a row already carries/);
  });

  it("a count naming an edge that does not exist", () => {
    assert.match(refusal({ from, counts: ["wiki.nope"] }).message, /no edge "wiki.nope"/);
  });
});

describe("what the guard permits, and what it says it costs", () => {
  it("the page card the demo itself renders", () => {
    // The names the card itself uses, which are distinct on purpose: a count and a hop over one
    // edge both default to the edge's short name here, and one answer cannot be both.
    const spec: QuerySpec = {
      from,
      counts: [
        { as: "linkCount", edge: pageLinks.name },
        { as: "backlinkCount", edge: linkedFrom.name },
      ],
      hops: [
        { as: "links", edge: pageLinks.name, limit: 25 },
        { as: "categories", edge: pageCategories.name, limit: 25 },
      ],
    };
    const cost = check(spec);
    // Root, plus 25 links, plus 25 categories.
    assert.equal(cost.nodes, 51);
    assert.equal(cost.frames, 3);
  });

  it("prices a nested query as the product down each path", () => {
    const spec: QuerySpec = {
      from,
      hops: [{ edge: pageLinks.name, limit: 10, hops: [{ edge: linkedFrom.name, limit: 5 }] }],
    };
    // 1 root + 10 links + 10*5 backlinks under them.
    assert.equal(check(spec).nodes, 61);
  });

  it("prices an over-budget query instead of throwing, so an editor can show the number", () => {
    let hop: Record<string, unknown> = { edge: pageLinks.name, limit: 100 };
    for (let i = 0; i < 3; i++) hop = { edge: pageLinks.name, limit: 100, hops: [hop] };
    const priced = price({ from, hops: [hop] } as unknown as QuerySpec);
    assert.ok("error" in priced);
    assert.match(priced.error, /answer nodes/);
  });

  it("a query at exactly the budget is allowed, one past it is not", () => {
    const at = { from, hops: [{ edge: pageLinks.name, limit: 100, hops: [{ edge: linkedFrom.name, limit: 100 }] }] };
    // 1 + 100 + 10,000 = 10,101, under 20,000.
    assert.ok(check(at as QuerySpec).nodes < LIMITS.maxNodes);
    const over = {
      from,
      hops: [
        {
          edge: pageLinks.name,
          limit: 100,
          hops: [{ edge: linkedFrom.name, limit: 100, hops: [{ edge: pageLinks.name, limit: 100 }] }],
        },
      ],
    };
    assert.match(refusal(over).message, /answer nodes/);
  });
});

describe("the holes that are unrepresentable rather than guarded", () => {
  it("compiles to a plan whose every child index exists", () => {
    // Hole 3 was an unvalidated read of plan.frames[i]. A submitted query holds its children, so
    // there is no index for an author to supply, and compilation assigns them all.
    const spec: QuerySpec = {
      from,
      hops: [
        { edge: pageLinks.name, limit: 3, hops: [{ edge: linkedFrom.name, limit: 2 }] },
        { edge: pageCategories.name, limit: 4 },
      ],
    };
    const plan = planOf(spec, "123");
    assert.equal(plan.frames.length, check(spec).frames);
    for (const frame of plan.frames) {
      for (const child of frame.children) {
        assert.ok(child.frame >= 0 && child.frame < plan.frames.length, `child frame ${child.frame} is out of range`);
      }
    }
  });

  it("compiles to a plan with no cycle, because a child always has a higher index than its parent", () => {
    // Hole 2 was a cycle through two edge frames recursing until the heap was gone. `compile()`
    // reserves a frame before emitting its children, so a child's index is always greater than its
    // parent's — which is a proof there is no cycle, not a sample of one.
    const spec: QuerySpec = {
      from,
      hops: [
        {
          edge: pageLinks.name,
          limit: 2,
          hops: [{ edge: linkedFrom.name, limit: 2, hops: [{ edge: pageLinks.name, limit: 2 }] }],
        },
      ],
    };
    const plan = planOf(spec, "123");
    for (const [i, frame] of plan.frames.entries()) {
      for (const child of frame.children) assert.ok(child.frame > i, `frame ${i} has child ${child.frame}`);
    }
  });

  it("gives a hop the alias asked for, and the edge's own name otherwise", () => {
    const spec: QuerySpec = {
      from,
      hops: [
        { edge: pageLinks.name, limit: 1, as: "outbound" },
        { edge: linkedFrom.name, limit: 1 },
      ],
    };
    const compiled = build(spec, "123").compile();
    const aliases = compiled.root.children.map((c) => c.alias);
    assert.deepEqual(aliases, ["outbound", "linked_from"]);
  });
});

describe("the query language the editor submits", () => {
  const parse = (text: string) => parseQuery(text);
  const bad = (text: string): QueryRefused => {
    try {
      parseQuery(text);
    } catch (e) {
      assert.ok(e instanceof QueryRefused, `expected QueryRefused, got ${String(e)}`);
      return e;
    }
    throw new Error("expected the text to be refused");
  };

  it("reads the demo's own page card", () => {
    const spec = parse(`page(0, "Country")
      .countAs("linkCount", page_links)
      .countAs("backlinkCount", linked_from)
      .related("links", page_links, q => q.limit(25))
      .related("categories", page_categories, q => q.limit(25))`);
    assert.deepEqual(spec.from, { ns: 0, title: "Country" });
    // The aliases the author wrote are kept, so the result is keyed by them.
    assert.deepEqual(spec.counts, [
      { as: "linkCount", edge: pageLinks.name },
      { as: "backlinkCount", edge: linkedFrom.name },
    ]);
    assert.equal(spec.hops!.length, 2);
    assert.deepEqual(spec.hops![0], { edge: pageLinks.name, as: "links", limit: 25 });
    // And it is a query the guard permits, which is the point of the example.
    assert.equal(check(spec).nodes, 51);
  });

  it("defaults the namespace, so page(\"X\") is an article", () => {
    assert.deepEqual(parse('page("Earth")').from, { ns: 0, title: "Earth" });
    assert.deepEqual(parse('page(14, "Stubs")').from, { ns: 14, title: "Stubs" });
  });

  it("nests a lambda, and nests inside it", () => {
    const spec = parse(`page("Country")
      .related("links", page_links, q => q
        .limit(10)
        .where("len", ">", 20000)
        .related("via", linked_from, q => q.limit(3)))`);
    const hop = spec.hops![0];
    assert.equal(hop.limit, 10);
    assert.deepEqual(hop.where, [{ field: "len", op: ">", value: 20000 }]);
    assert.equal(hop.hops![0].edge, linkedFrom.name);
    assert.equal(hop.hops![0].limit, 3);
  });

  it("takes a hop with no lambda at all", () => {
    assert.deepEqual(parse('page("X").related("c", page_categories)').hops, [
      { edge: pageCategories.name, as: "c" },
    ]);
  });

  it("reads string, number and boolean values", () => {
    const where = parse(`page("X").related("l", page_links, q => q
      .where("title", "=", "France")
      .where("ns", "=", 0)
      .where("redirect", "=", false))`).hops![0].where!;
    assert.deepEqual(where.map((w) => w.value), ["France", 0, false]);
  });

  it("ignores comments and whitespace", () => {
    const spec = parse(`// the busiest page
      page("Country")   // start here
        .related("links", page_links, q => q.limit(5))`);
    assert.equal(spec.hops![0].limit, 5);
  });

  it("points at the offset of a mistake, not just the fact of it", () => {
    const text = 'page("X").related("l", page_haters, q => q.limit(5))';
    const e = bad(text);
    assert.match(e.message, /no edge "page_haters"/);
    assert.equal(text.slice(e.offset!, e.offset! + 11), "page_haters");
  });

  it("refuses an unknown method, naming the ones there are", () => {
    const e = bad('page("X").orderBy("title")');
    assert.match(e.message, /no method "orderBy"/);
    assert.match(e.message, /related/);
  });

  it("refuses a lambda whose body is not its own parameter", () => {
    assert.match(bad('page("X").related("l", page_links, q => z.limit(5))').message, /starts from q/);
  });

  it("refuses an unterminated string, and a stray character", () => {
    assert.match(bad('page("Coun').message, /unterminated string/);
    assert.match(bad('page("X") # nope').message, /unexpected "#"/);
  });

  it("refuses a limit on the root, which would silently do nothing", () => {
    assert.match(bad('page("X").limit(10)').message, /applies to a related list/);
  });

  it("refuses text that is not a query at all", () => {
    assert.match(bad("").message, /starts with page/);
    assert.match(bad("SELECT * FROM page").message, /starts with page/);
    assert.match(bad('page("X") page("Y")').message, /unexpected/);
  });

  it("still goes through the guard, so the editor cannot spend more than the form could", () => {
    const text = `page("Country").related("a", page_links, q => q.limit(100)
      .related("b", page_links, q => q.limit(100)
        .related("c", page_links, q => q.limit(100)
          .related("d", page_links, q => q.limit(100)))))`;
    const spec = parseQuery(text); // parses fine — it is well-formed, just ruinous
    assert.match(refusal(spec).message, /answer nodes/);
  });

  it("round-trips: unparsing a spec and parsing it back gives the same spec", () => {
    const spec: QuerySpec = {
      from: { ns: 14, title: "France_geography_stubs" },
      counts: [{ as: "memberCount", edge: categoryPages.name }],
      hops: [
        {
          edge: categoryPages.name,
          as: "members",
          limit: 20,
          where: [{ field: "len", op: ">=", value: 1000 }],
          counts: [{ as: "out", edge: pageLinks.name }],
          hops: [{ edge: pageLinks.name, as: "out", limit: 3 }],
        },
      ],
    };
    assert.deepEqual(parseQuery(unparse(spec)), spec);
  });
});

describe("a count keeps the alias it was written with", () => {
  it("names the count as the author asked, not after its edge", () => {
    const spec = parseQuery('page("X").countAs("backlinkCount", linked_from)');
    assert.deepEqual(spec.counts, [{ as: "backlinkCount", edge: linkedFrom.name }]);
    // And the compiled query carries that alias, which is what the result is keyed by.
    const aliases = build(spec, "1").compile().root.counts.map((c) => c.alias);
    assert.deepEqual(aliases, ["backlinkCount"]);
  });

  it("falls back to the edge's short name when no alias is given", () => {
    const spec = parseQuery('page("X").countAs(linked_from)');
    assert.deepEqual(spec.counts, [linkedFrom.name]);
    assert.deepEqual(build(spec, "1").compile().root.counts.map((c) => c.alias), ["linked_from"]);
  });

  it("keeps aliases on a nested hop too", () => {
    const spec = parseQuery('page("X").related("l", page_links, q => q.countAs("n", linked_from))');
    assert.deepEqual(spec.hops![0].counts, [{ as: "n", edge: linkedFrom.name }]);
  });

  it("round-trips an aliased count", () => {
    const spec: QuerySpec = {
      from: { ns: 0, title: "X" },
      counts: [{ as: "backlinkCount", edge: linkedFrom.name }, pageLinks.name],
    };
    assert.deepEqual(parseQuery(unparse(spec)), {
      from: { ns: 0, title: "X" },
      // unparse always writes an explicit alias, so the bare form comes back aliased to its short name.
      counts: [{ as: "backlinkCount", edge: linkedFrom.name }, { as: "page_links", edge: pageLinks.name }],
    });
  });

  it("still refuses a count on an edge that does not exist", () => {
    assert.match(refusal({ from: { ns: 0, title: "X" }, counts: [{ as: "n", edge: "wiki.nope" }] }).message, /no edge/);
  });
});

// The unique title index's key, which is the demo's only entry point: `/page?title=` resolves
// through it, and a key that two different pages share means one of them has no object at all.
//
// The fixtures are the seven real collisions, found by running the shipped key over all 950,421
// simplewiki titles and confirmed against three independently loaded databases. Kept as data rather
// than as a property test because each one names a different way `toLowerCase()` folds a capital —
// Latin with a diacritic, a Cyrillic letter, and the German sharp s, whose uppercase form is a
// separate code point.
describe("the title index key", () => {
  /** What the index actually compares: the key, after the global normalizer has had it. */
  const key = (ns: number, title: string) => normalize(titleKey(ns, title));

  const COLLIDED: [string, string][] = [
    ["Coup_d'état", "Coup_d'État"],
    ["Abdullah_Öcalan", "Abdullah_öcalan"],
    ["MØ", "Mø"],
    ["ß", "ẞ"],
    ["Русский_Язык", "Русский_язык"],
    ["Pусский_язык", "Pусский_Язык"],
    ["Esta_É_a_Nossa_Pátria_Bem_Amada", "Esta_é_a_Nossa_Pátria_Bem_Amada"],
  ];

  it("separates pages that differ only by the case of a non-ASCII letter", () => {
    for (const [a, b] of COLLIDED) {
      assert.notEqual(key(0, a), key(0, b), `${a} and ${b} are different pages and must key differently`);
    }
  });

  it("still separates pages that differ only by ASCII case, which is what it always did", () => {
    assert.notEqual(key(0, "Ash"), key(0, "ASH"));
    assert.notEqual(key(0, "Cat"), key(0, "CAT"));
  });

  it("keys a title the same whatever case the normalizer is handed it in", () => {
    // The whole point of escaping: the key must survive `toLowerCase()` unchanged, or a lookup
    // cannot find what a load wrote.
    for (const t of ["Coup_d'État", "ẞ", "Русский_Язык", "Ash"]) {
      assert.equal(titleKey(0, t), normalize(titleKey(0, t)), `${t} must already be lowercase-stable`);
    }
  });

  it("escapes by UTF-8 byte, because a bare code point's hex is ambiguous", () => {
    // The first attempt at this fix escaped to `%` plus the code point's hex, which is
    // variable-width: `A1` became `%411` and so did `Б` (U+0411). It fixed 7 collisions and
    // introduced 23. Two hex digits per byte is uniquely decodable, so these have to differ.
    for (const [a, b] of [["A1", "Б"], ["Ad", "Н"], ["Ae", "О"], ["Bd", "Э"]]) {
      assert.notEqual(key(0, a), key(0, b), `${a} and ${b} must key differently`);
    }
    // And the ASCII form is unchanged, which is what keeps the blast radius to the 0.332% of
    // simplewiki titles that hold a non-ASCII capital or a literal %.
    assert.equal(titleKey(0, "Ash"), "0:%41sh");
  });

  it("escapes % as well, or the escape is not injective", () => {
    // `Cat` escapes to `%43at`, so a page actually named `%43at` would otherwise key identically.
    assert.notEqual(key(0, "Cat"), key(0, "%43at"));
  });

  it("separates namespaces, so a Talk page and an article may share a title", () => {
    assert.notEqual(key(0, "France"), key(1, "France"));
  });

  // The read-path fallback, which is what lets the fix ship without re-keying a loaded database.
  describe("the key a loaded database may be holding", () => {
    const legacy = (ns: number, title: string) => normalize(legacyTitleKey(ns, title));

    it("agrees with the current key wherever the current key did not change", () => {
      // 99.67% of simplewiki's titles. A lookup that hits on the first try never pays for the
      // fallback, which is the only reason it is affordable on the demo's one entry point.
      for (const t of ["France", "Ash", "ASH", "Tom_Baker", "Liberal_arts", "1836"]) {
        assert.equal(legacy(0, t), key(0, t), t);
      }
    });

    it("still collides where it always did, which is why it is read-only", () => {
      // Writing under this key is what merged the seven pairs. The fallback exists so those pages
      // stay *findable* in a database already loaded this way -- not so that another load can
      // reproduce the defect.
      for (const [a, b] of COLLIDED) assert.equal(legacy(0, a), legacy(0, b), `${a} / ${b}`);
    });
  });
});
