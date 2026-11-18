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
// **`--hints`** runs the checks that need this suite to BE a calling database: it listens on a
// loopback port, serves a descriptor and a read route of its own, signs hints, and reads back what
// the database under test recorded. Only for a database that can reach this machine's loopback —
// see spec/fixture/README.md.
//
// Exits non-zero if any check fails.

import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";

import { validate } from "./lib/jsonschema.mjs";

const argv = process.argv.slice(2);
const [uri] = argv;
const fixtureAt = flag("--fixture");
const withHints = argv.includes("--hints");
if (!uri || uri.startsWith("--")) {
  console.error("usage: node scripts/conformance.mjs <database URI> [--fixture <manifest> [--hints]]");
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
check(
  "and the whole descriptor validates against spec/schemas/descriptor.json",
  descriptor !== null && invalid("descriptor.json", descriptor).length === 0,
  (descriptor === null ? ["no body"] : invalid("descriptor.json", descriptor)).join("; "),
);
// Stated exactly where it is served, or not stated at all: its absence is how a caller tells a
// database that takes no hints from one that does, without sending anything.
const takesHints = descriptor?.routes?.hint !== undefined;
check(
  "a hint route, where it states one, is {db}/hint",
  !takesHints || descriptor.routes.hint === `${uri}/hint`,
  takesHints ? `stated as ${JSON.stringify(descriptor.routes.hint)}` : "not stated: this database takes no hints",
);

// Optional, and checked for what it has to mean where it is sent. A validator is a promise that the
// same tag is the same bytes, so a responder that sends one has to honour it.
{
  const etag = descriptorRes.headers.get("etag");
  check(
    "it may say how long it is good for, and carry a validator",
    true,
    `Cache-Control ${JSON.stringify(descriptorRes.headers.get("cache-control"))}, ETag ${etag === null ? "not sent, which is allowed" : "sent"}`,
  );
  if (etag !== null) {
    const again = await fetch(uri, { headers: { "if-none-match": etag } });
    const sent = await again.text();
    check("a descriptor asked for with its own validator is a 304 with no body", again.status === 304 && sent === "", `status ${again.status}, ${sent.length} bytes`);
    const other = await fetch(uri, { headers: { "if-none-match": '"not-this-one"' } });
    check("and with somebody else's validator is the descriptor", other.status === 200, `status ${other.status}`);
  }
}

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

// ---- the kind of a refusal
//
// RFC 9457's `type` is a SHOULD, so a responder that sends none passes. One that sends it has to
// send the right one, because a program that branches on it goes back to the wrong document
// otherwise.
{
  const kindOf = async (name, body, expected) => {
    const res = await send("read", body);
    const type = res.body?.type;
    check(
      `${name} is of kind ${expected}, where a kind is stated`,
      type === undefined || type === `https://hlekk.dev/spec/problems/${expected}`,
      type === undefined ? "not stated, which is allowed" : type,
    );
    check(
      `and where it is stated, detail says what error says and status says what was sent`,
      type === undefined || (res.body.detail === res.body.error && res.body.status === res.status),
    );
  };
  await kindOf("no ids at all", { ids: [] }, "malformed");
  await kindOf("an unknown edge", { ids: [SOME_ID], hops: [{ edge: "no.such_edge" }] }, "vocabulary");
  await kindOf("too many ids", { ids: Array.from({ length: (limits.maxIds ?? 100) + 1 }, () => SOME_ID) }, "limit");
}

// ---- OPTIONS and QUERY
//
// Both optional. What is checked is that a responder which says it takes QUERY treats it as the
// request POST would have been — and it says so in `Allow`, which is the only place a caller is
// allowed to learn it from.
{
  const options = await fetch(`${uri}/read`, { method: "OPTIONS" });
  const allow = (options.headers.get("allow") ?? "").split(",").map((m) => m.trim().toUpperCase());
  await options.arrayBuffer();
  check(
    "OPTIONS on a route says what it takes, or is refused as any other method is",
    (options.status >= 200 && options.status < 300 && allow.includes("POST")) || options.status === 405,
    `status ${options.status}, Allow ${JSON.stringify(options.headers.get("allow"))}`,
  );
  if (allow.includes("QUERY")) {
    const request = { ids: [SOME_ID] };
    const asQuery = async (headers, body = JSON.stringify(request)) => {
      const res = await fetch(`${uri}/read`, { method: "QUERY", headers, body });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const queried = await asQuery({ "content-type": "application/json" });
    const posted = await send("read", request);
    check("a QUERY is answered as the POST it is the same request as", queried.status === 200 && isDeepStrictEqual(queried.body, posted.body), `status ${queried.status}`);
    // A Buffer, because fetch gives a string body a media type of its own accord and the point is
    // a request that states none.
    const untyped = await asQuery({}, Buffer.from(JSON.stringify(request)));
    check("a QUERY that states no media type is refused with 400", untyped.status === 400, `status ${untyped.status}`);
    const mistyped = await asQuery({ "content-type": "text/plain" });
    check("and one that states another is refused with 415", mistyped.status === 415, `status ${mistyped.status}`);
  } else {
    check("QUERY", true, "skipped: Allow does not name it, so a caller must not send it");
  }
}

// ---- reading by URL

const readsByUrl = descriptor?.routes?.object !== undefined || descriptor?.routes?.list !== undefined;
/** GET, with the status and the body it came with. */
async function get(path, headers = {}) {
  const res = await fetch(`${uri}/${path}`, { headers });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // left null
  }
  return { status: res.status, body, text, headers: res.headers };
}
{
  check(
    "the routes that read by URL are stated as exactly their templates, or not at all",
    !readsByUrl ||
      (descriptor.routes.object === `${uri}/objects/{id}` && descriptor.routes.list === `${uri}/objects/{id}/{edge}{?limit,after}`),
    readsByUrl ? JSON.stringify([descriptor.routes.object, descriptor.routes.list]) : "not stated: this database reads by request only",
  );
  const byUrl = await get(`objects/${SOME_ID}`);
  if (readsByUrl) {
    const byBody = await send("read", { ids: [SOME_ID] });
    // Exactly the read it stands for: the same body where there is an object, and a 404 where the
    // read has no root.
    check(
      "an object by URL is the read that names it",
      byUrl.status === 200 ? isDeepStrictEqual(byUrl.body, byBody.body) : byUrl.status === 404 && byBody.body?.roots?.length === 0,
      `GET ${byUrl.status}, read has ${byBody.body?.roots?.length} roots`,
    );
    const stray = await get(`objects/${SOME_ID}?depth=2`);
    check("a parameter that route does not define is refused", stray.status === 400, `status ${stray.status}`);
    const deeper = anyEdge ? await get(`objects/${SOME_ID}/${encodeURIComponent(anyEdge)}/${encodeURIComponent(anyEdge)}`) : null;
    check("and there is one hop and no more: a deeper path is not a route", deeper === null || deeper.status === 404, `status ${deeper?.status}`);
    const etag = byUrl.headers.get("etag");
    if (byUrl.status === 200 && etag !== null) {
      const again = await get(`objects/${SOME_ID}`, { "if-none-match": etag });
      check("an object asked for with its own validator is a 304 with no body", again.status === 304 && again.text === "", `status ${again.status}`);
    }
  } else {
    check("a database that states no such route has none", byUrl.status === 404, `status ${byUrl.status}`);
  }
}

// ---- hints, as far as they can be checked without being a caller

{
  const unsigned = await send("hint", { source: "1", edge: "conf.some_edge", target: SOME_ID });
  if (takesHints) {
    // The one route where the anonymous caller is not a caller: without a signature there is no
    // telling whose database the checking read would be sent to.
    check(
      "a hint nobody signed is refused with 401, not read as anonymous",
      unsigned.status === 401 && unsigned.body !== null && invalid("refusal.json", unsigned.body).length === 0,
      `status ${unsigned.status}`,
    );
    const getHint = await fetch(`${uri}/hint`).then((r) => r.status, () => 0);
    check("GET on the hint route is 405", getHint === 405, `status ${getHint}`);
  } else {
    check("a database that states no hint route has none", unsigned.status === 404, `status ${unsigned.status}`);
  }
}

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

  if (readsByUrl) {
    const root = await get(`objects/${id("root")}`);
    const rootByBody = await send("read", { ids: [id("root")] });
    check("an object that is there is a 200 by URL, and the same body as by request", root.status === 200 && isDeepStrictEqual(root.body, rootByBody.body), `status ${root.status}`);

    // The one place a status could be the tell. A 404 for one and a 403 for the other, or two
    // different sentences, and "forbidden is absent" is only true of the route nobody uses.
    const hiddenByUrl = await get(`objects/${id("hidden")}`);
    const absentByUrl = await get(`objects/${absent}`);
    check(
      "by URL, a hidden object and an absent one are the same 404",
      hiddenByUrl.status === 404 && absentByUrl.status === 404 && hiddenByUrl.text === absentByUrl.text,
      `${hiddenByUrl.status} and ${absentByUrl.status}`,
    );
    check(
      "down to the headers a cache would act on",
      ["cache-control", "vary", "etag"].every((h) => hiddenByUrl.headers.get(h) === absentByUrl.headers.get(h)),
    );
    const underHidden = await get(`objects/${id("hidden")}/conf.page_links`);
    check("and so is a list under a hidden one", underHidden.status === 404 && underHidden.text === absentByUrl.text, `status ${underHidden.status}`);

    // One page of one list, continued by the cursor the last page handed back — which is the whole
    // of what a client that can only GET needs in order to walk.
    const first = await get(`objects/${id("paged")}/conf.page_links?limit=2`);
    const firstByBody = await send("read", { ids: [id("paged")], hops: [{ edge: "conf.page_links", limit: 2 }] });
    check("a list by URL is the read with that one hop", first.status === 200 && isDeepStrictEqual(first.body, firstByBody.body), `status ${first.status}`);
    const walked = [];
    let cursor;
    for (let i = 0; i < 6; i++) {
      const page = await get(`objects/${id("paged")}/conf.page_links?limit=2${cursor === undefined ? "" : `&after=${encodeURIComponent(cursor)}`}`);
      const list = Object.values(page.body?.lists ?? {})[0];
      if (list === undefined) break;
      walked.push(...list.ids);
      if (!list.more || list.cursor === null) break;
      cursor = list.cursor;
    }
    check("and it pages by URL to the same five rows", JSON.stringify(walked) === JSON.stringify(all), `${walked.length} vs ${all.length}`);
    check(
      "an answer by URL that a cache may keep says it varies by caller",
      !/max-age/.test(root.headers.get("cache-control") ?? "") || /hlekk-caller/i.test(root.headers.get("vary") ?? ""),
      `Cache-Control ${JSON.stringify(root.headers.get("cache-control"))}, Vary ${JSON.stringify(root.headers.get("vary"))}`,
    );
  }

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

  // ---- hints, with this suite as the calling database
  //
  // Everything a hint is supposed to be is a statement about what the responder does NOT do with
  // one: believe it, answer it differently for an object it hides, or read anybody before it has
  // answered. None of that shows unless something is on the other end to be read, so the suite
  // becomes a database: one object type, one edge type, and a table it changes between hints.
  if (withHints && takesHints) {
    const caller = await callerDatabase();
    const cited = (source) => `${caller.uri}#${source}`;
    /** What anyone reads of the edges recorded at one of the fixture's pages. */
    const recordedAt = async (page) => {
      const res = await send("read", { ids: [page], hops: [{ as: "cited", edge: "conf.page_cited_by", limit: 50 }] });
      return { ids: res.body?.lists?.[`1:${page}`]?.ids ?? [], objects: Object.keys(res.body?.objects ?? {}) };
    };
    const until = async (settled, ms = 8000) => {
      for (const start = Date.now(); Date.now() - start < ms; ) {
        if (await settled()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };

    // Claim 2 exists and cites nothing; claim 1 cites the fixture's root. The false hint goes first,
    // so that by the time the true one has been recorded a responder working in order has also
    // decided the false one.
    caller.edges.set("2", []);
    caller.edges.set("1", [`${uri}#${id("root")}`]);
    // Claims 3 and 4 really do cite the page the fixture hides and an id nothing has, so a responder
    // that went and looked would find both edges. Each has a source of its own, so that a read made
    // on its account can be told from a read about anything else.
    caller.edges.set("3", [`${uri}#${id("hidden")}`]);
    caller.edges.set("4", [`${uri}#${absent}`]);
    const lie = await caller.hint("2", id("visible-a"));
    const truth = await caller.hint("1", id("root"));
    const toAbsent = await caller.hint("4", String(absent));
    const toHidden = await caller.hint("3", id("hidden"));

    check(
      "a signed hint is taken with 202",
      truth.status === 202 && invalid("hint-response.json", truth.body).length === 0,
      `status ${truth.status}`,
    );
    check(
      "and its answer is the same for a target that is there, one that is hidden and one that is absent",
      [lie, toAbsent, toHidden].every((h) => h.status === truth.status && h.text === truth.text),
      [lie, truth, toAbsent, toHidden].map((h) => h.status).join(", "),
    );
    check(
      "the caller is not read before its hint is answered",
      [lie, truth, toAbsent, toHidden].every((h) => h.readBeforeAnswer === false),
      "the claim is looked at afterwards, or a stranger's server sets this route's latency",
    );

    const recorded = await until(async () => (await recordedAt(id("root"))).ids.includes(cited("1")));
    check("an edge the caller really holds is recorded, as a reference to the caller's object", recorded);
    check("and the caller was read for it, rather than believed", (caller.reads.get("1") ?? 0) >= 1, `${caller.reads.get("1") ?? 0} reads`);
    const at = await recordedAt(id("root"));
    check(
      "and nothing stands behind the reference, as for any other the database holds",
      !at.objects.includes(cited("1")) && at.objects.every((key) => /^(0|[1-9][0-9]*)$/.test(key)),
    );
    check(
      "an edge the caller does not hold is not recorded, whatever its hint said",
      recorded && !(await recordedAt(id("visible-a"))).ids.includes(cited("2")),
      recorded ? "" : "not decidable: the true hint was never recorded, so the false one may not have been looked at",
    );

    // The same hint, after the edge is gone. A hint says "look", so there is no second message.
    caller.edges.set("1", []);
    const again = await caller.hint("1", id("root"));
    const withdrawn = again.status === 202 && (await until(async () => !(await recordedAt(id("root"))).ids.includes(cited("1"))));
    check("and it is withdrawn by the same hint, once a read no longer shows the edge", withdrawn, `status ${again.status}`);

    // The read is the one thing a hint causes that this side can see, so it is the one place left
    // for "forbidden is absent" to leak: a responder that looks only for targets that exist tells a
    // caller which ids do, by whether its server is called. Both hints went out before the one just
    // settled, so a responder working in order has decided them.
    const forHidden = caller.reads.get("3") ?? 0;
    const forAbsent = caller.reads.get("4") ?? 0;
    check(
      "the caller is not read on account of a target it could not have read, hidden or absent",
      withdrawn && forHidden === 0 && forAbsent === 0,
      withdrawn
        ? `${forHidden} reads for the hidden target, ${forAbsent} for the absent one`
        : "not decidable: the last hint was never settled, so these two may not have been looked at",
    );

    await caller.close();
  } else if (withHints) {
    check("hints as a caller", true, "skipped: this database states no hint route");
  }
}

/**
 * This suite, as a database that hints.
 *
 * The smallest thing that can be read over the protocol: a descriptor with one key, and a read route
 * that answers one shape — an object and the one edge type it has. Built from the specification's
 * text and nothing in `src/`, so the signature base below is a second reading of §7.2 rather than
 * the implementation's own.
 */
async function callerDatabase() {
  const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const keyId = b64url(await crypto.subtle.digest("SHA-256", raw));

  /** source id -> the references its edge lists. An id that is not here is an object that is not. */
  const edges = new Map();
  /** source id -> how many reads have asked about it. */
  const reads = new Map();
  let own = "";

  const json = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (req.method === "GET" && path === "/suite") {
      return json(res, 200, {
        v: 1,
        protocol: "hlekk",
        wire: [1],
        database: own,
        catalog: 1,
        limits: { maxDepth: 1, maxLimit: 100, maxFrames: 2, maxNodes: 1000, maxCounts: 0, maxWhere: 0, maxIds: 1, maxBody: 65536 },
        keys: [{ id: keyId, alg: "ed25519", key: b64url(raw) }],
        routes: { read: `${own}/read`, price: `${own}/price`, vocabulary: `${own}/vocabulary` },
      });
    }
    if (req.method === "GET" && path === "/suite/vocabulary") {
      return json(res, 200, {
        v: 1,
        catalog: 1,
        types: { "suite.claim": { fields: {} }, "conf.page": { fields: {} } },
        edges: { "suite.claim_cites": { from: "suite.claim", to: "conf.page", counted: true, foreign: true } },
      });
    }
    if (req.method === "POST" && path === "/suite/read") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let asked;
        try {
          asked = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return json(res, 400, { error: "body is not JSON" });
        }
        const source = asked?.ids?.[0];
        const hop = asked?.hops?.[0];
        if (typeof source !== "string") return json(res, 400, { error: "at least one id is required", at: "ids" });
        if (hop !== undefined && hop.edge !== "suite.claim_cites") return json(res, 400, { error: "no such edge", at: "hops[0]" });
        reads.set(source, (reads.get(source) ?? 0) + 1);
        const held = edges.get(source);
        const as = hop?.as ?? hop?.edge;
        return json(res, 200, {
          v: 1,
          roots: held === undefined ? [] : [source],
          objects: held === undefined ? {} : { [source]: { type: "suite.claim", version: 1, data: {} } },
          lists: held === undefined || hop === undefined ? {} : { [`1:${source}`]: { ids: held, cursor: null, more: false } },
          counts: {},
          shape: hop === undefined ? { 0: {} } : { 0: { [as]: 1 }, 1: {} },
          cost: { frames: hop === undefined ? 1 : 2, nodes: hop === undefined ? 1 : 1 + (hop.limit ?? 25) },
          // Deliberately not reusable. Sending a hint is consent to record the edge it is about, and
          // that does not depend on what the checking read says of the rest of its answer (§11.4).
          cache: { reuse: "never" },
        });
      });
      return undefined;
    }
    return json(res, 404, { error: "no such route" });
  });
  await new Promise((listening) => server.listen(0, "127.0.0.1", listening));
  own = `http://127.0.0.1:${server.address().port}/suite`;

  /** The four headers of §7.2, over exactly the four components it names, in its order. */
  const sign = async (url, body) => {
    const digest = `sha-256=:${Buffer.from(await crypto.subtle.digest("SHA-256", Buffer.from(body))).toString("base64")}:`;
    const params = `("@method" "@target-uri" "content-digest" "hlekk-caller");created=${Math.floor(Date.now() / 1000)};keyid="${keyId}";alg="ed25519"`;
    const base = [
      `"@method": POST`,
      `"@target-uri": ${url}`,
      `"content-digest": ${digest}`,
      `"hlekk-caller": ${own}`,
      `"@signature-params": ${params}`,
    ].join("\n");
    const signature = Buffer.from(await crypto.subtle.sign("Ed25519", pair.privateKey, Buffer.from(base))).toString("base64");
    return {
      "content-type": "application/json",
      "hlekk-caller": own,
      "content-digest": digest,
      "signature-input": `hlekk=${params}`,
      signature: `hlekk=:${signature}:`,
    };
  };

  return {
    uri: own,
    edges,
    reads,
    /** Sends one hint, and says whether this database had been read about its source by the time
     *  the answer's status arrived. */
    async hint(source, target) {
      const url = `${uri}/hint`;
      const body = JSON.stringify({ source, edge: "suite.claim_cites", target });
      const before = reads.get(source) ?? 0;
      const res = await fetch(url, { method: "POST", headers: await sign(url, body), body });
      const readBeforeAnswer = (reads.get(source) ?? 0) > before;
      const text = await res.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // left null
      }
      return { status: res.status, text, body: parsed, readBeforeAnswer };
    },
    close: () =>
      new Promise((closed) => {
        server.closeAllConnections();
        server.close(() => closed());
      }),
  };
}

for (const c of checks) {
  console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
}
const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} conformance checks against ${uri}`);
process.exit(passed === checks.length ? 0 : 1);
