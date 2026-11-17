// Black-box conformance checks against a database URI.
//
//   node scripts/conformance.mjs https://db.example/wiki
//
// Deliberately plain JavaScript that imports nothing from `src/`. A conformance suite that shares
// code with the implementation under test proves that the implementation agrees with itself, which
// is the one thing nobody doubted. Everything below is built from the descriptor and the vocabulary
// the database serves, so it runs against any implementation of the protocol — ours on Cloudflare,
// ours on Node, or someone else's.
//
// **No fixture.** These checks need no object to exist, because none of them is about data. A cost
// is arithmetic over the request's text, so it is the same for an id that exists and one that does
// not; a refusal is decided before any I/O. That is what lets this run against a live database
// without being told what is in it. The checks that need a fixture — forbidden indistinguishable
// from absent, transitively; paging; signature verification — are step 7's suite, which publishes a
// catalog and a graph for an implementation to load by its own means.
//
// Exits non-zero if any check fails.

import { readFileSync, readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { validate } from "./lib/jsonschema.mjs";

const argv = process.argv.slice(2);
const [uri] = argv;
const fixtureAt = flag("--fixture");
if (!uri || uri.startsWith("--")) {
  console.error("usage: node scripts/conformance.mjs <database URI> [--fixture <manifest>]");
  process.exit(2);
}

function flag(name) {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  return value;
}

/** The fixture's manifest, when one was given: which id this implementation gave each named object.
 *  Ids are minted by the implementation, so the suite cannot know them — see spec/fixture/README.md. */
const fixture = fixtureAt === undefined ? null : JSON.parse(readFileSync(fixtureAt, "utf8"));
const id = (name) => {
  const got = fixture?.ids?.[name];
  if (got === undefined) throw new Error(`the manifest names no id for "${name}"`);
  return got;
};

/** The normative schemas. Loaded from `spec/`, which is the artifact an implementation is held to;
 *  the validator beside this file imports nothing from `src/`. */
const schemas = {};
const schemaDir = new URL("../spec/schemas/", import.meta.url);
for (const name of readdirSync(schemaDir)) schemas[name] = JSON.parse(readFileSync(new URL(name, schemaDir), "utf8"));
const invalid = (name, body) => validate(schemas[name], body, schemas[name], "", schemas);

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });

/** A read or price request. Returns the status and the parsed body, never throwing on a 4xx. */
async function send(route, body) {
  const res = await fetch(`${uri}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    // left null; the check that cares will say so
  }
  return { status: res.status, body: parsed };
}

/** A refusal has to name where, or a caller can only retry blind — and it has to be the shape the
 *  spec says a refusal is. */
function refused(name, response, where) {
  const at = response.body?.at;
  const shape = response.body === null ? ["no body"] : invalid("refusal.json", response.body);
  check(
    name,
    response.status === 400 && typeof at === "string" && (where === undefined || at === where) && shape.length === 0,
    `status ${response.status}, at ${JSON.stringify(at)}${shape.length > 0 ? `, ${shape.join("; ")}` : ""}`,
  );
}

// ---- the descriptor

const descriptorRes = await fetch(uri);
const descriptor = await descriptorRes.json().catch(() => null);
check("the descriptor is served on the database URI", descriptorRes.status === 200, `status ${descriptorRes.status}`);
check("it is JSON and names the protocol", descriptor?.protocol === "hlekk", `protocol ${descriptor?.protocol}`);
check("it names the wire versions it speaks", Array.isArray(descriptor?.wire) && descriptor.wire.length > 0);
check(
  "it names the URI it answers at, and that is the one asked",
  descriptor?.database === uri,
  `advertised ${JSON.stringify(descriptor?.database)}`,
);
const limits = descriptor?.limits ?? {};
check(
  "it states the limits a caller must build against",
  ["maxDepth", "maxLimit", "maxNodes", "maxIds", "maxBody"].every((k) => Number.isInteger(limits[k])),
  JSON.stringify(limits),
);
check("it states its keys, even when it has none", Array.isArray(descriptor?.keys));
check(
  "it names its routes",
  ["read", "price", "vocabulary"].every((r) => typeof descriptor?.routes?.[r] === "string"),
);

// ---- the vocabulary

const vocabularyRes = await fetch(`${uri}/vocabulary`);
const vocabulary = await vocabularyRes.json().catch(() => null);
check("the vocabulary is served", vocabularyRes.status === 200, `status ${vocabularyRes.status}`);
const edges = Object.entries(vocabulary?.edges ?? {});
check("each exposed edge names its endpoints", edges.every(
  ([, e]) => typeof e.from === "string" && typeof e.to === "string" && typeof e.counted === "boolean",
));
check(
  "every edge's endpoints are types it also states",
  edges.every(([, e]) => e.from in (vocabulary?.types ?? {}) && e.to in (vocabulary?.types ?? {})),
);
// What makes the vocabulary enough to walk a database nobody described: the edges off an object are
// the ones whose `from` is its type, and the answer says what that type is.
check(
  "every edge states where it starts, so a caller can tell which may hang off a type",
  edges.every(([, e]) => typeof e.from === "string" && e.from.length > 0),
);
check(
  "and whether a hop may leave this database, before a request is spent on it",
  edges.every(([, e]) => e.foreign === undefined || typeof e.foreign === "boolean"),
  edges.some(([, e]) => e.foreign !== undefined) ? "stated" : "not stated, which is allowed",
);
check(
  "and the whole vocabulary validates against spec/schemas/vocabulary.json",
  vocabulary !== null && invalid("vocabulary.json", vocabulary).length === 0,
  (vocabulary === null ? ["no body"] : invalid("vocabulary.json", vocabulary)).join("; "),
);

const countable = edges.find(([, e]) => e.counted)?.[0];
const uncounted = edges.find(([, e]) => !e.counted)?.[0];

/**
 * A chain of hops where each starts where the one above it lands, up to `want` long.
 *
 * Built from the vocabulary rather than guessed, because a responder refuses a hop that does not
 * start where its parent lands — which is what lets a caller tell an empty list from a meaningless
 * traversal. A chain can only be as long as the type graph allows, so a schema with no cycle in it
 * caps this and the checks that need a longer one say they were skipped.
 */
function chain(want, limit) {
  const first = edges[0];
  if (first === undefined) return null;
  const out = [{ edge: first[0], limit }];
  let at = first[1].to;
  for (let i = 1; i < want; i++) {
    const next = edges.find(([, e]) => e.from === at);
    if (next === undefined) break;
    out.push({ edge: next[0], limit });
    at = next[1].to;
  }
  // Nested, innermost last, which is the shape a request carries.
  return out.reduceRight((inner, hop) => (inner === null ? hop : { ...hop, hops: [inner] }), null);
}

/** How many hops a chain of this depth actually got. */
const depthOf = (hop) => (hop === null ? 0 : 1 + depthOf(hop.hops?.[0] ?? null));

// An id that need not exist. A cost is arithmetic over the request, and a refusal happens before any
// read, so nothing below depends on what this database holds.
const SOME_ID = "1";

// ---- a priced request costs what the read then reports

{
  const request = { ids: [SOME_ID] };
  const priced = await send("price", request);
  const read = await send("read", request);
  check("a price is served", priced.status === 200 && priced.body?.cost !== undefined, `status ${priced.status}`);
  check("the read is served", read.status === 200, `status ${read.status}`);
  check(
    "the price is what the read then reports",
    JSON.stringify(priced.body?.cost) === JSON.stringify(read.body?.cost),
    `priced ${JSON.stringify(priced.body?.cost)}, read ${JSON.stringify(read.body?.cost)}`,
  );
  check(
    "the read states its own cacheability",
    typeof read.body?.cache?.reuse === "string",
    `cache ${JSON.stringify(read.body?.cache)}`,
  );
  check(
    "the answer carries type names, not integers",
    Object.values(read.body?.objects ?? {}).every((o) => typeof o.type === "string" && o.otype === undefined),
  );
  check(
    "every object key is a bare decimal id of this database",
    Object.keys(read.body?.objects ?? {}).every((key) => /^(0|[1-9][0-9]*)$/.test(key)),
  );
  check(
    "the answer validates against spec/schemas/read-response.json",
    invalid("read-response.json", read.body).length === 0,
    invalid("read-response.json", read.body).join("; "),
  );
  check(
    "and the price against spec/schemas/price-response.json",
    invalid("price-response.json", priced.body).length === 0,
    invalid("price-response.json", priced.body).join("; "),
  );

}

// ---- the refusals, each naming where

refused("an unknown edge is refused", await send("read", { ids: [SOME_ID], hops: [{ edge: "no.such_edge" }] }), "hops[0]");

refused(
  "too many ids is refused",
  await send("read", { ids: Array.from({ length: (limits.maxIds ?? 100) + 1 }, () => SOME_ID) }),
  "ids",
);

refused("no ids at all is refused", await send("read", { ids: [] }), "ids");

if (uncounted) {
  // A field relationship follows an id in a payload and stores nothing, so it has no maintained
  // counter. Asking for its count is a question the protocol has to refuse rather than answer with
  // a scan.
  refused(
    "a count on an edge that has none is refused",
    await send("read", { ids: [SOME_ID], counts: [uncounted] }),
    "counts[0]",
  );
} else {
  check("an uncounted edge is exposed, so the count refusal can be checked", true, "skipped: none exposed");
}

// A hop that does not start where its parent lands can only ever return nothing, and a caller that
// built its tree from the vocabulary must be able to tell that from a true empty list.
const mismatch = edges.find(([, a]) => edges.some(([, b]) => b.from !== a.to));
if (mismatch !== undefined) {
  const under = edges.find(([, b]) => b.from !== mismatch[1].to);
  refused(
    "a hop that does not start where its parent lands is refused",
    await send("read", { ids: [SOME_ID], hops: [{ edge: mismatch[0], hops: [{ edge: under[0] }] }] }),
    "hops[0].hops[0]",
  );
} else {
  check("every edge starts where every other lands, so the mismatch cannot be built", true, "skipped");
}

// The product this guard exists for: the answer is exponential in depth while storage reads stay
// flat, so nothing about the I/O would reveal it. Built from a valid chain and widened by the entry,
// because the entry's width is part of the price.
const wide = Array.from({ length: limits.maxIds ?? 100 }, () => SOME_ID);
const budget = chain(2, limits.maxLimit ?? 100);
if (depthOf(budget) >= 2 && limits.maxDepth >= 2 && wide.length * (1 + limits.maxLimit + limits.maxLimit ** 2) > limits.maxNodes) {
  refused("an over-budget request is refused", await send("read", { ids: wide, hops: [budget] }), "query");
  // And refused by the price route too, on the same arithmetic.
  refused("and refused when priced, not only when read", await send("price", { ids: wide, hops: [budget] }), "query");
} else {
  check("over-budget two-hop request", true, "skipped: the vocabulary and limits do not support this case");
}

const tooDeep = chain((limits.maxDepth ?? 4) + 1, 1);
if (depthOf(tooDeep) > (limits.maxDepth ?? 4)) {
  refused("a hop deeper than the stated maximum is refused", await send("read", { ids: [SOME_ID], hops: [tooDeep] }));
} else {
  check(
    "a chain longer than the stated depth exists, so the depth refusal can be checked",
    true,
    `skipped: the type graph caps a valid chain at ${depthOf(tooDeep)}`,
  );
}

if (countable) {
  // A count and a hop over one edge default to the same name, which is the first thing a caller
  // working from the vocabulary reaches for. Letting the later one win returns an empty list beside
  // a count saying it is not empty.
  refused(
    "a count and a hop that would land under one name are refused",
    await send("read", { ids: [SOME_ID], counts: [countable], hops: [{ edge: countable, limit: 2 }] }),
  );
}

const anyEdge = edges[0]?.[0];
if (anyEdge) {
  refused(
    "a name the row already carries is refused",
    await send("read", { ids: [SOME_ID], hops: [{ as: "id", edge: anyEdge, limit: 1 }] }),
    "hops[0]",
  );
  refused(
    "a limit over the stated maximum is refused",
    await send("read", { ids: [SOME_ID], hops: [{ edge: anyEdge, limit: (limits.maxLimit ?? 100) + 1 }] }),
    "hops[0]",
  );
}

// ---- a body over the stated cap

const big = await fetch(`${uri}/read`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "x".repeat((limits.maxBody ?? 65536) + 64),
}).then((r) => r.status, () => 0);
check("a body over the stated cap is refused with 413", big === 413, `status ${big}`);

// ---- methods and unknown routes

const getRead = await fetch(`${uri}/read`).then((r) => r.status, () => 0);
check("GET on a POST route is 405", getRead === 405, `status ${getRead}`);
const unknown = await fetch(`${uri}/no-such-route`).then((r) => r.status, () => 0);
check("an unknown route is 404", unknown === 404, `status ${unknown}`);

// ---- what only a fixture can show
//
// Everything above runs against a live database without being told what is in it. These need the
// published catalog, graph and policy of spec/fixture/, because what they check is what a policy
// does — and a policy is only observable by asking for something it hides.

if (fixture !== null) {
  check(
    "the manifest names the database the suite was pointed at",
    fixture.database === uri,
    `manifest says ${JSON.stringify(fixture.database)}`,
  );

  const hiddenRoot = await send("read", { ids: [id("hidden")] });
  const fixtureIds = new Set(Object.values(fixture.ids));
  let absent = 0;
  while (fixtureIds.has(String(absent))) absent++;
  const absentRoot = await send("read", { ids: [String(absent)] });
  check("hidden and absent roots have identical wire responses",
    hiddenRoot.status === 200 && absentRoot.status === 200 &&
    isDeepStrictEqual(hiddenRoot.body, absentRoot.body));

  // Forbidden indistinguishable from absent, TRANSITIVELY. `root` links to three pages and one of
  // them is hidden; `behind-hidden` is reachable only through it. Had `hidden` genuinely not
  // existed, the engine would never have gathered what is under it — so its descendants being in
  // the answer would be both the tell and the disclosure.
  const through = await send("read", {
    ids: [id("root")],
    hops: [{ as: "links", edge: "conf.page_links", limit: 10, hops: [{ as: "deeper", edge: "conf.page_links", limit: 10 }] }],
  });
  const objects = Object.keys(through.body?.objects ?? {});
  check("a hidden object is absent from the answer", !objects.includes(id("hidden")), objects.length + " objects");
  check(
    "and so is one reachable only through it",
    !objects.includes(id("behind-hidden")),
    "forbidden has to be indistinguishable from absent transitively, or the descendants are the tell",
  );
  const links = through.body?.lists?.[`1:${id("root")}`]?.ids ?? [];
  check(
    "a hidden object is absent from the list that named it, not nulled in place",
    !links.includes(id("hidden")) && links.includes(id("visible-a")),
    `list holds ${links.length}`,
  );
  check(
    "and the list is short beside a count that still counts it, which is what a deleted object looks like",
    links.length === 2,
    `list holds ${links.length}, expected the two that are visible`,
  );

  // A count is a separately authorized operation. The object is readable and the count is not.
  const counted = await send("read", { ids: [id("countless-owner")], counts: ["conf.page_tags"] });
  check(
    "an object whose count is forbidden is still readable",
    id("countless-owner") in (counted.body?.objects ?? {}),
    `status ${counted.status}`,
  );
  check(
    "and the count is absent rather than zero",
    Object.keys(counted.body?.counts ?? {}).length === 0,
    `counts ${JSON.stringify(counted.body?.counts)}`,
  );

  // Paging. The same list read two at a time has to be the list read whole, in the same order.
  const whole = await send("read", { ids: [id("paged")], hops: [{ as: "l", edge: "conf.page_links", limit: 10 }] });
  const all = whole.body?.lists?.[`1:${id("paged")}`]?.ids ?? [];
  const pages = [];
  let after;
  for (let i = 0; i < 6; i++) {
    const hop = { as: "l", edge: "conf.page_links", limit: 2, ...(after === undefined ? {} : { after }) };
    const page = await send("read", { ids: [id("paged")], hops: [hop] });
    const list = page.body?.lists?.[`1:${id("paged")}`];
    if (list === undefined) break;
    pages.push(...list.ids);
    if (!list.more || list.cursor === null) break;
    after = list.cursor;
  }
  check("a list read in pages is the list read whole", JSON.stringify(pages) === JSON.stringify(all), `${pages.length} vs ${all.length}`);
  check("and it is five pages long, so the paging was real", all.length === 5, `${all.length} rows`);

  // A reference this database holds and did not follow. A URI is mintable before the database
  // behind it exists, so the reference is in the list and nothing stands behind it.
  const onward = await send("read", {
    ids: [id("elsewhere-owner")],
    hops: [{ as: "out", edge: "conf.page_elsewhere", limit: 10 }],
  });
  const refs = onward.body?.lists?.[`1:${id("elsewhere-owner")}`]?.ids ?? [];
  check("a reference into another database is listed", refs.some((r) => r.includes("#")), JSON.stringify(refs));
  check(
    "and nothing stands behind it: a database answering a read never follows one",
    refs.every((r) => !(r in (onward.body?.objects ?? {}))),
  );

  // Signatures are not ignored. A syntactically valid one that cannot be verified must be refused —
  // not read as the anonymous caller, because then stripping a header would be a downgrade.
  const forged = await fetch(`${uri}/read`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "hlekk-caller": "https://nobody.invalid/db",
      "content-digest": "sha-256=:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=:",
      "signature-input":
        'hlekk=("@method" "@target-uri" "content-digest" "hlekk-caller");created=1700000000;keyid="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";alg="ed25519"',
      signature: `hlekk=:${"A".repeat(86)}==:`,
    },
    body: JSON.stringify({ ids: [id("root")] }),
  }).then((r) => r.status, () => 0);
  // 401 or 403 from a database that verifies and could not; 400 from one that verifies nothing and
  // says so, which is a refusal and not an oversight — a caller that presented a credential has to
  // learn that nobody checked it.
  check(
    "a signature that cannot be verified is refused, not read as anonymous",
    forged >= 400 && forged < 500,
    `status ${forged}${forged === 200 ? " — stripping a header would then be a downgrade" : ""}`,
  );
}

for (const c of checks) {
  console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
}
const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} conformance checks against ${uri}`);
process.exit(passed === checks.length ? 0 : 1);
