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

const [uri] = process.argv.slice(2);
if (!uri) {
  console.error("usage: node scripts/conformance.mjs <database URI>");
  process.exit(2);
}

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

/** A refusal has to name where, or a caller can only retry blind. */
function refused(name, response, where) {
  const at = response.body?.at;
  check(
    name,
    response.status === 400 && typeof at === "string" && (where === undefined || at === where),
    `status ${response.status}, at ${JSON.stringify(at)}`,
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
check("it exposes at least one edge, and each names its endpoints", edges.length > 0 && edges.every(
  ([, e]) => typeof e.from === "string" && typeof e.to === "string" && typeof e.counted === "boolean",
));
check(
  "every edge's endpoints are types it also states",
  edges.every(([, e]) => e.from in (vocabulary?.types ?? {}) && e.to in (vocabulary?.types ?? {})),
);

const countable = edges.find(([, e]) => e.counted)?.[0];
const uncounted = edges.find(([, e]) => !e.counted)?.[0];

// An id that need not exist. A cost is arithmetic over the request, and a refusal happens before any
// read, so nothing below depends on what this database holds.
const SOME_ID = "1";

// ---- a priced request costs what the read then reports

if (countable) {
  const request = { ids: [SOME_ID], hops: [{ edge: countable, limit: 2 }] };
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
    Object.keys(read.body?.objects ?? {}).every((id) => /^(0|[1-9][0-9]*)$/.test(id)),
  );
} else {
  check("a countable edge is exposed, so pricing can be checked", false, "no edge reports counted: true");
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

if (countable) {
  // Nested to the stated depth at the stated limit, which is the product this guard exists for: the
  // answer is exponential in depth while storage reads stay flat, so nothing about the I/O would
  // reveal it.
  let hop = { edge: countable, limit: limits.maxLimit ?? 100 };
  for (let i = 1; i < (limits.maxDepth ?? 4); i++) hop = { edge: countable, limit: limits.maxLimit ?? 100, hops: [hop] };
  refused("an over-budget request is refused", await send("read", { ids: [SOME_ID], hops: [hop] }), "query");

  // And refused by the price route too, on the same arithmetic.
  refused("and refused when priced, not only when read", await send("price", { ids: [SOME_ID], hops: [hop] }), "query");

  refused(
    "a hop deeper than the stated maximum is refused",
    await send("read", {
      ids: [SOME_ID],
      hops: [deeper(countable, (limits.maxDepth ?? 4) + 1)],
    }),
  );

  refused(
    "a limit over the stated maximum is refused",
    await send("read", { ids: [SOME_ID], hops: [{ edge: countable, limit: (limits.maxLimit ?? 100) + 1 }] }),
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

function deeper(edge, depth) {
  let hop = { edge, limit: 1 };
  for (let i = 1; i < depth; i++) hop = { edge, limit: 1, hops: [hop] };
  return hop;
}

for (const c of checks) {
  console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
}
const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} conformance checks against ${uri}`);
process.exit(passed === checks.length ? 0 : 1);
