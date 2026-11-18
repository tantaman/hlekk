import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan as planLock } from "../catalog/catalog.ts";
import type { Lock } from "../catalog/catalog.ts";
import { federate } from "../testkit/federation.ts";
import { served } from "../testkit/served.ts";
import type { Policy } from "../query/serve.ts";
import type { Plan } from "../query/types.ts";
import { Backoff, retryAfterOf } from "./backoff.ts";
import { DescriptorCache, ForeignUnreachable, MAX_DESCRIPTOR_SECONDS, discover, foreignClient } from "./client.ts";
import { PROBLEMS, handle, refusal } from "./http.ts";
import type { Admission, Binding } from "./http.ts";
import { signRequest } from "./identity.ts";
import type { Caller } from "./identity.ts";
import { CATALOG_TYPE, WELL_KNOWN, apiCatalog, serveCatalog } from "./wellknown.ts";

// What this protocol takes from HTTP, each tested for the party it was adopted for: a cache, a
// browser, an agent that can only fetch a URL, and a caller that needs to be told "later".
//
// The rule every one of them is held to is in `http.ts`: a header restates the body and nothing
// breaks if it is stripped. So most of these tests come in pairs — the header, and the fact that
// what it says is also true of the bytes.

const at = (binding: Binding, route: string, init?: RequestInit) =>
  handle(new Request(`${binding.database}${route}`, init), binding);

const json = { "content-type": "application/json" };

const post = (binding: Binding, route: string, body: unknown) =>
  at(binding, route, { method: "POST", body: JSON.stringify(body), headers: json });

const query = (binding: Binding, route: string, body: unknown, headers: Record<string, string> = json) =>
  at(binding, route, { method: "QUERY", body: JSON.stringify(body), headers });

describe("the two documents that describe a database", () => {
  it("say how long they are good for, and carry a validator that is a fact about their bytes", async () => {
    const { binding } = await served();
    for (const route of ["", "/vocabulary"]) {
      const first = await at(binding, route);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("cache-control"), "public, max-age=60", route);
      const etag = first.headers.get("etag")!;
      assert.match(etag, /^"[A-Za-z0-9_-]{22}"$/, route);
      const body = await first.text();

      // Unchanged, said in headers alone.
      const again = await at(binding, route, { headers: { "if-none-match": etag } });
      assert.equal(again.status, 304, route);
      assert.equal(await again.text(), "");
      assert.equal(again.headers.get("etag"), etag);
      assert.equal(again.headers.get("cache-control"), "public, max-age=60");

      // A list, a weak tag and `*` all match; somebody else's tag does not.
      for (const header of [`"nope", ${etag}`, `W/${etag}`, "*"]) {
        assert.equal((await at(binding, route, { headers: { "if-none-match": header } })).status, 304, header);
      }
      const other = await at(binding, route, { headers: { "if-none-match": '"0000000000000000000000"' } });
      assert.equal(other.status, 200);
      assert.equal(await other.text(), body);

      // HEAD is the same answer with the body left off.
      const head = await at(binding, route, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("etag"), etag);
      assert.equal(await head.text(), "");
    }
  });

  it("have a different validator the moment what they say changes", async () => {
    const { binding } = await served();
    const before = (await at(binding, "")).headers.get("etag");
    const after = (await at({ ...binding, maxIds: 7 }, "")).headers.get("etag");
    assert.notEqual(before, after);
  });

  it("can be told to be asked for every time, which the validator keeps cheap", async () => {
    const { binding } = await served();
    const res = await at({ ...binding, describedFor: 0 }, "");
    assert.equal(res.headers.get("cache-control"), "no-cache");
    assert.ok(res.headers.get("etag"));
    assert.equal((await at({ ...binding, describedFor: 300 }, "/vocabulary")).headers.get("cache-control"), "public, max-age=300");
  });

  it("each lead to the other", async () => {
    const { binding } = await served();
    assert.equal((await at(binding, "")).headers.get("link"), '<https://issues.example/db/vocabulary>; rel="service-desc"');
    assert.equal((await at(binding, "/vocabulary")).headers.get("link"), '<https://issues.example/db>; rel="service-meta"');
  });
});

describe("OPTIONS, and a browser on another origin", () => {
  it("says what a route takes", async () => {
    const { binding } = await served();
    const cases: [string, string][] = [
      ["", "GET, HEAD, OPTIONS"],
      ["/vocabulary", "GET, HEAD, OPTIONS"],
      ["/read", "POST, QUERY, OPTIONS"],
      ["/price", "POST, QUERY, OPTIONS"],
      ["/objects/5", "GET, HEAD, OPTIONS"],
      ["/objects/5/issues.issue_comments", "GET, HEAD, OPTIONS"],
    ];
    for (const [route, allow] of cases) {
      const res = await at(binding, route, { method: "OPTIONS" });
      assert.equal(res.status, 204, route);
      assert.equal(res.headers.get("allow"), allow, route);
      assert.equal(await res.text(), "");
    }
    // Not a route is not a route, whatever is asked of it.
    assert.equal((await at(binding, "/nope", { method: "OPTIONS" })).status, 404);
  });

  it("answers a preflight, so a page may send a read or a signed one", async () => {
    const { binding } = await served();
    const res = await at(binding, "/read", {
      method: "OPTIONS",
      headers: { origin: "https://app.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("access-control-allow-methods"), "POST, QUERY, OPTIONS");
    const allowed = res.headers.get("access-control-allow-headers")!.split(", ");
    for (const name of ["content-type", "if-none-match", "hlekk-caller", "content-digest", "signature-input", "signature"]) {
      assert.ok(allowed.includes(name), name);
    }
    // Never with credentials: nothing a browser attaches of its own accord changes an answer here.
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  });

  it("lets a page read an answer, a refusal, and the headers that mean something", async () => {
    const { binding, issue } = await served();
    const answers = [
      await at(binding, ""),
      await post(binding, "/read", { ids: [issue] }),
      await post(binding, "/read", { ids: [] }),
      await at(binding, "/nope"),
    ];
    for (const res of answers) {
      assert.equal(res.headers.get("access-control-allow-origin"), "*", String(res.status));
      const exposed = res.headers.get("access-control-expose-headers")!.split(", ");
      for (const name of ["etag", "retry-after", "allow", "link"]) assert.ok(exposed.includes(name), name);
    }
  });

  it("is off for a database only this machine can reach, and wherever it is turned off", async () => {
    const { binding, issue } = await served();
    // Loopback: reachable from here and no further, which a browser on this machine would extend to
    // every page it opens.
    const local: Binding = { ...binding, database: "http://127.0.0.1:8080/db" };
    const closed: Binding = { ...binding, cors: false };
    for (const b of [local, closed]) {
      const res = await post(b, "/read", { ids: [issue] });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
      const preflight = await at(b, "/read", { method: "OPTIONS", headers: { "access-control-request-method": "POST" } });
      // Still an answer to OPTIONS — that is plain HTTP — and not a permission.
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("allow"), "POST, QUERY, OPTIONS");
      assert.equal(preflight.headers.get("access-control-allow-methods"), null);
    }
    // And on for a loopback database whose operator asked for it.
    const asked = await post({ ...local, cors: true }, "/read", { ids: [issue] });
    assert.equal(asked.headers.get("access-control-allow-origin"), "*");
  });
});

describe("QUERY", () => {
  it("is the same request as POST, and gets the same answer", async () => {
    const { binding, issue } = await served();
    const req = { ids: [issue], counts: ["issues.issue_comments"], hops: [{ as: "c", edge: "issues.issue_comments", limit: 2 }] };
    for (const route of ["/read", "/price"]) {
      const posted = await post(binding, route, req);
      const queried = await query(binding, route, req);
      assert.equal(queried.status, 200, route);
      assert.deepEqual(await queried.json(), await posted.json(), route);
      // Stated on both, so a caller that has only ever sent POST learns the route takes the other.
      assert.equal(posted.headers.get("accept-query"), "application/json");
      assert.equal(queried.headers.get("accept-query"), "application/json");
    }
  });

  it("is refused the same way, at the same place", async () => {
    const { binding, issue } = await served();
    const res = await query(binding, "/read", { ids: [issue], hops: [{ edge: "issues.nope" }] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).at, "hops[0]");
  });

  it("says what its content is, because a server may not guess", async () => {
    const { binding, issue } = await served();
    const body = JSON.stringify({ ids: [issue] });
    // RFC 10008: a QUERY with no media type is incorrect by definition.
    const none = await at(binding, "/read", { method: "QUERY", body: new TextEncoder().encode(body) });
    assert.equal(none.status, 400);
    assert.equal((await none.json()).at, "content-type");
    const wrong = await query(binding, "/read", { ids: [issue] }, { "content-type": "text/plain" });
    assert.equal(wrong.status, 415);
    assert.equal(wrong.headers.get("accept-query"), "application/json");
    assert.equal((await wrong.json()).type, `${PROBLEMS}media-type`);
    // A charset is a parameter, not a different type.
    assert.equal((await query(binding, "/read", { ids: [issue] }, { "content-type": "application/json; charset=utf-8" })).status, 200);
    // And POST is left as version 1 had it: no type is still a request.
    assert.equal((await at(binding, "/read", { method: "POST", body })).status, 200);
  });

  it("carries a validator, which is what a safe method with a body is for", async () => {
    const { binding, issue } = await served();
    const first = await query(binding, "/read", { ids: [issue] });
    const etag = first.headers.get("etag")!;
    assert.ok(etag);
    assert.equal(first.headers.get("cache-control"), "public, max-age=60");
    const again = await query(binding, "/read", { ids: [issue] }, { ...json, "if-none-match": etag });
    assert.equal(again.status, 304);
    // A POST is not a thing a cache revalidates, so it is handed no tag to try with.
    assert.equal((await post(binding, "/read", { ids: [issue] })).headers.get("etag"), null);
  });
});

describe("an object, by URL", () => {
  it("is the read that names it, byte for byte", async () => {
    const { binding, issue } = await served();
    const got = await at(binding, `/objects/${issue}`);
    assert.equal(got.status, 200);
    const posted = await post(binding, "/read", { ids: [issue] });
    assert.equal(await got.text(), await posted.text());
    assert.equal(got.headers.get("cache-control"), "public, max-age=60");
    assert.ok(got.headers.get("etag"));
    // From an object alone, a reader can find out what database it is in and what can be asked.
    assert.equal(
      got.headers.get("link"),
      '<https://issues.example/db>; rel="service-meta", <https://issues.example/db/vocabulary>; rel="service-desc"',
    );
  });

  it("is one page of one of its lists, continued by the cursor the last page handed back", async () => {
    const { binding, issue, comments } = await served({ comments: 5 });
    const first = await at(binding, `/objects/${issue}/issues.issue_comments?limit=2`);
    assert.equal(first.status, 200);
    const posted = await post(binding, "/read", { ids: [issue], hops: [{ edge: "issues.issue_comments", limit: 2 }] });
    assert.equal(await first.clone().text(), await posted.text());

    const page = (await first.json()).lists[`1:${issue}`];
    assert.deepEqual(page.ids, [comments[4], comments[3]]);
    assert.equal(page.more, true);
    const next = await at(binding, `/objects/${issue}/issues.issue_comments?limit=2&after=${encodeURIComponent(page.cursor)}`);
    assert.deepEqual((await next.json()).lists[`1:${issue}`].ids, [comments[2], comments[1]]);

    // With no limit it is the default page, as a hop that names none is.
    const whole = await at(binding, `/objects/${issue}/issues.issue_comments`);
    assert.equal((await whole.json()).lists[`1:${issue}`].ids.length, 5);
  });

  it("is a 404 when it is not there, and the same 404 when the policy hides it", async () => {
    const hidden = new Set<string>();
    const { binding, issue } = await served({
      policy: { object: (id) => !hidden.has(id), count: () => true, cache: () => ({ reuse: "public", seconds: 60 }) },
    });
    hidden.add(issue);
    const absent = await at(binding, "/objects/999999");
    const forbidden = await at(binding, `/objects/${issue}`);
    assert.equal(absent.status, 404);
    assert.equal(forbidden.status, 404);
    // Not merely the same status: the same bytes and the same headers, or one of them is the tell.
    assert.equal(await absent.clone().text(), await forbidden.clone().text());
    assert.deepEqual([...absent.headers].sort(), [...forbidden.headers].sort());
    const body = await absent.json();
    assert.equal(body.type, `${PROBLEMS}not-found`);
    assert.equal(body.error, "no such object");
    // An absence is an answer, and as keepable as the object would have been.
    assert.equal(absent.headers.get("cache-control"), "public, max-age=60");

    // The list under a hidden object is equally not there.
    const under = await at(binding, `/objects/${issue}/issues.issue_comments`);
    assert.equal(under.status, 404);
    assert.equal(await under.text(), await (await at(binding, "/objects/999999/issues.issue_comments")).text());
  });

  it("is a 404 for a type the projection does not expose, as by id in a body", async () => {
    const { binding, alice } = await served({
      projection: { name: "issues-only", include: ["issues.issue", "issues.comment", "issues.issue_comments"] },
    });
    assert.equal((await at(binding, `/objects/${alice}`)).status, 404);
  });

  it("is refused where a read would be, with the path into the read it stands for", async () => {
    const { binding, issue } = await served();
    const cases: [string, string, number, string, string][] = [
      ["an id that is not one", "/objects/5x", 400, "ids", "malformed"],
      ["an edge the vocabulary does not have", `/objects/${issue}/issues.nope`, 400, "hops[0]", "vocabulary"],
      ["a limit over the stated maximum", `/objects/${issue}/issues.issue_comments?limit=101`, 400, "hops[0]", "limit"],
      ["a limit that is not a number", `/objects/${issue}/issues.issue_comments?limit=two`, 400, "hops[0].limit", "malformed"],
      ["a cursor that is not one", `/objects/${issue}/issues.issue_comments?after=nonsense`, 400, "hops[0]", "malformed"],
      ["a parameter it does not take", `/objects/${issue}/issues.issue_comments?depth=3`, 400, "?depth", "malformed"],
      ["a parameter given twice", `/objects/${issue}/issues.issue_comments?limit=1&limit=2`, 400, "?limit", "malformed"],
      ["any parameter at all on an object", `/objects/${issue}?limit=1`, 400, "?limit", "malformed"],
    ];
    for (const [why, route, status, where, kind] of cases) {
      const res = await at(binding, route);
      assert.equal(res.status, status, why);
      const body = await res.json();
      assert.equal(body.at, where, why);
      assert.equal(body.type, PROBLEMS + kind, why);
    }
    // Deeper than one hop is not a route: a tree in a URL would be a second spelling of every read.
    assert.equal((await at(binding, `/objects/${issue}/issues.issue_comments/issues.comment_author`)).status, 404);
    assert.equal((await at(binding, "/objects/")).status, 404);
    assert.equal((await at(binding, `/objects/${issue}`, { method: "POST", body: "{}" })).status, 405);
  });

  it("answers a validator with 304, so an unchanged object costs its headers", async () => {
    const { binding, issue, db } = await served();
    const first = await at(binding, `/objects/${issue}`);
    const etag = first.headers.get("etag")!;
    assert.equal((await at(binding, `/objects/${issue}`, { headers: { "if-none-match": etag } })).status, 304);
    await db.update(issue, { title: "shipped", secret: "do not send" });
    const changed = await at(binding, `/objects/${issue}`, { headers: { "if-none-match": etag } });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), etag);
  });
});

// ---- a signed GET, and an answer that depends on who signed

const WIKI = "https://wiki.example/db";
const NOTES = "https://notes.example/db";
const WIKI_LOCK: Lock = planLock({ wiki: { objects: { "wiki.page": { fields: { title: "string" } } } } });
const NOTES_LOCK: Lock = planLock({
  notes: {
    objects: { "notes.note": { fields: { body: "string" } } },
    edges: { "notes.note_about": { from: "notes.note", to: "wiki.page", foreign: true } },
  },
  wiki: { objects: { "wiki.page": { fields: { title: "string" } } } },
});
const PAGE = Catalog.compile(WIKI_LOCK).objectNamed("wiki.page")!.otype;
const NOTES_CATALOG = Catalog.compile(NOTES_LOCK);
const NOTE = NOTES_CATALOG.objectNamed("notes.note")!.otype;
const ABOUT = NOTES_CATALOG.edgeNamed("notes.note_about")!.atype!;
const ABOUT_PLAN: Plan = {
  frames: [
    { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
    { source: { kind: "edge", atype: ABOUT }, children: [], counts: [] },
  ],
};
const EVERYTHING: Policy = { object: () => true, count: () => true, cache: () => ({ reuse: "caller", seconds: 30 }) };
const NOTHING: Policy = { object: () => false, count: () => false, cache: () => ({ reuse: "never" }) };

describe("a read whose answer depends on who signed it", () => {
  const admitting = async (caller: Caller | null) =>
    caller !== null && caller.database === NOTES ? { policy: EVERYTHING, remember: true } : { policy: NOTHING };

  it("is signed over the URL and the digest of no body, and says it varies by caller", async () => {
    const f = await federate({
      identity: true,
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "wiki", policyFor: admitting },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
      ],
    });
    const page = await f.member(WIKI).db.create(PAGE, { title: "Country" }, { vshard: "3" });
    const url = `${WIKI}/objects/${page}`;

    const anonymous = await f.fetch(url);
    assert.equal(anonymous.status, 404);
    // Without this, an answer kept for the anonymous caller is handed to a signed one who was owed
    // more — and identity here is not in `Authorization`, which is the one header a cache distrusts.
    assert.equal(anonymous.headers.get("vary"), "hlekk-caller");

    const pair = await f.member(NOTES).cluster.directory.identity(0);
    const headers = await signRequest({
      method: "GET",
      url,
      body: "",
      caller: NOTES,
      seed: pair.seed,
      keyId: pair.public.id,
      created: Math.floor(Date.now() / 1000),
    });
    const signed = await f.fetch(url, { headers });
    assert.equal(signed.status, 200);
    assert.equal(((await signed.json()) as { objects: Record<string, { data: { title: string } }> }).objects[page].data.title, "Country");
    assert.equal(signed.headers.get("vary"), "hlekk-caller");
    // For this caller and nobody else, which a shared cache reads as "not mine to keep".
    assert.equal(signed.headers.get("cache-control"), "private, max-age=30");

    // The signature covers the URI, so it is not a signature for another object.
    const moved = await f.fetch(`${WIKI}/objects/${page}0`, { headers });
    assert.equal(moved.status, 401);
  });
});

describe("not now", () => {
  it("is a 429 with how long, for a caller a deployment's own check turns away", async () => {
    const { binding, issue } = await served();
    const seen: Admission[] = [];
    const limited: Binding = {
      ...binding,
      admit: (asked) => {
        seen.push(asked);
        if (asked.cost.nodes > 5) throw new Backoff(12, "caller");
      },
    };
    const small = await post(limited, "/read", { ids: [issue] });
    assert.equal(small.status, 200);

    const big = await post(limited, "/read", { ids: [issue], hops: [{ edge: "issues.issue_comments", limit: 50 }] });
    assert.equal(big.status, 429);
    assert.equal(big.headers.get("retry-after"), "12");
    assert.equal(retryAfterOf(big.headers), 12);
    const body = await big.json();
    assert.equal(body.type, `${PROBLEMS}too-many`);
    assert.equal(body.status, 429);

    // Told the price before anything was read, and which route, and who — nobody, here.
    assert.deepEqual(seen.map((a) => [a.route, a.cost.nodes, a.caller]), [["read", 1, null], ["read", 51, null]]);
  });

  it("is a 503 when it is nobody's doing, and is asked of every way of reading", async () => {
    const { binding, issue } = await served();
    const routes: string[] = [];
    const down: Binding = {
      ...binding,
      admit: (asked) => {
        routes.push(asked.route);
        throw new Backoff(0.2, "database");
      },
    };
    const answers = [
      await post(down, "/read", { ids: [issue] }),
      await post(down, "/price", { ids: [issue] }),
      await at(down, `/objects/${issue}`),
      await at(down, `/objects/${issue}/issues.issue_comments`),
      await query(down, "/read", { ids: [issue] }),
    ];
    for (const res of answers) {
      assert.equal(res.status, 503);
      // Whole seconds and at least one: zero is an invitation to the loop this exists to prevent.
      assert.equal(res.headers.get("retry-after"), "1");
      assert.equal((await res.json()).type, `${PROBLEMS}unavailable`);
    }
    assert.deepEqual(routes, ["read", "price", "object", "list", "read"]);
    // The descriptor is not a read, and says what it always says.
    assert.equal((await at(down, "")).status, 200);
  });

  it("is not asked about a request that was wrong anyway", async () => {
    const { binding } = await served();
    let asked = 0;
    const counting: Binding = { ...binding, admit: () => void asked++ };
    assert.equal((await post(counting, "/read", { ids: [] })).status, 400);
    assert.equal((await post(counting, "/read", { ids: ["1"], hops: [{ edge: "no.such" }] })).status, 400);
    assert.equal(asked, 0);
  });

  it("reaches a caller as an error that still knows how long", async () => {
    const { binding, issue } = await served();
    const busy: Binding = { ...binding, admit: () => { throw new Backoff(9, "database"); } };
    const client = foreignClient(binding.database, {
      catalog: binding.catalog,
      fetch: async (input, init) => handle(new Request(input as string, init as RequestInit), busy),
    });
    await assert.rejects(
      client.exec({ frames: [{ source: { kind: "ids" }, children: [], counts: [] }] }, [{ kind: "object", id: `${binding.database}#${issue}`, frame: 0 }]),
      (e) => e instanceof ForeignUnreachable && e.retryAfter === 9 && /status 503/.test(e.message),
    );
  });
});

describe("a refusal", () => {
  it("says which kind it is, as something a program can branch on", async () => {
    const { binding, issue } = await served();
    const cases: [string, Promise<Response>, number, string][] = [
      ["a body that is not JSON", at(binding, "/read", { method: "POST", body: "not json" }), 400, "malformed"],
      ["an unknown member", post(binding, "/read", { ids: [issue], nope: 1 }), 400, "malformed"],
      ["an unknown edge", post(binding, "/read", { ids: [issue], hops: [{ edge: "issues.nope" }] }), 400, "vocabulary"],
      ["a count where there is none", post(binding, "/read", { ids: [issue], counts: ["issues.comment_author"] }), 400, "vocabulary"],
      [
        "a hop that does not start where its parent lands",
        post(binding, "/read", { ids: [issue], hops: [{ edge: "issues.issue_comments", hops: [{ edge: "issues.issue_comments" }] }] }),
        400,
        "vocabulary",
      ],
      ["too many ids", post(binding, "/read", { ids: Array.from({ length: 101 }, () => issue) }), 400, "limit"],
      [
        "a price over budget",
        post(binding, "/price", { ids: [issue, issue, issue], hops: [{ edge: "issues.issue_comments", limit: 100, hops: [{ edge: "issues.comment_author", limit: 100 }] }] }),
        400,
        "limit",
      ],
      ["a signature nobody here checks", at(binding, "/read", { method: "POST", body: "{}", headers: { signature: "hlekk=:AA==:" } }), 400, "signature"],
      ["a route that is not one", at(binding, "/nope"), 404, "not-found"],
      ["a method the route does not take", at(binding, "/read"), 405, "method"],
      ["a body over the cap", at(binding, "/read", { method: "POST", body: "x".repeat(70_000) }), 413, "too-large"],
    ];
    for (const [why, sent, status, kind] of cases) {
      const res = await sent;
      assert.equal(res.status, status, why);
      const body = await res.json();
      // RFC 9457's members, and version 1's own beside them saying the same thing.
      assert.equal(body.type, PROBLEMS + kind, why);
      assert.equal(body.status, status, why);
      assert.equal(typeof body.title, "string", why);
      assert.equal(body.detail, body.error, why);
      // Served as what version 1 said every body is. The members are the point, not the label.
      assert.match(res.headers.get("content-type")!, /^application\/json/, why);
      // And not kept by anything in between: a 404 today is a route a deployment may serve tomorrow.
      assert.equal(res.headers.get("cache-control"), "no-store", why);
    }
  });

  it("has one shape wherever it is made", () => {
    assert.deepEqual(refusal(413, "too-large", "body over 5 bytes"), {
      type: `${PROBLEMS}too-large`,
      title: "The body is over the stated cap",
      status: 413,
      detail: "body over 5 bytes",
      error: "body over 5 bytes",
    });
    assert.deepEqual(Object.keys(refusal(400, "vocabulary", "x", { at: "hops[0]", offset: 4 })), ["type", "title", "status", "detail", "error", "at", "offset"]);
  });
});

describe("a caller that keeps a descriptor for as long as it was told it may", () => {
  /** One wiki and one notes database, with notes following an edge into the wiki. */
  async function two(describedFor?: number) {
    let clock = Date.now();
    const descriptors = new DescriptorCache();
    const f = await federate({
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "wiki" },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
      ],
      foreign: { descriptors, now: () => clock },
    });
    if (describedFor !== undefined) f.member(WIKI).binding.describedFor = describedFor;
    const page = await f.member(WIKI).db.create(PAGE, { title: "Country" }, { vshard: "3" });
    const note = await f.member(NOTES).db.create(NOTE, { body: "n" }, { vshard: "7" });
    await f.member(NOTES).db.assocAdd(ABOUT, note, `${WIKI}#${page}`, 1);
    const read = () => f.member(NOTES).db.query(ABOUT_PLAN, [note]);
    return { f, descriptors, read, tick: (ms: number) => (clock += ms) };
  }

  it("does not ask again inside that time, and asks with its validator after it", async () => {
    const { f, descriptors, read, tick } = await two();
    const wiki = f.member(WIKI);
    await read();
    assert.equal(wiki.served.descriptor, 1);
    await read();
    await read();
    // Three reads, one descriptor. Before a responder said how long one is good for, that was three.
    assert.equal(wiki.served.descriptor, 1);
    assert.equal(descriptors.hits, 2);

    // Past the minute it was given. Asked for again — and answered in headers, because it has not
    // changed.
    tick(61_000);
    await read();
    assert.equal(wiki.served.descriptor, 2);
    assert.equal(descriptors.confirmed, 1);
    // And good for another minute on the strength of that.
    await read();
    assert.equal(wiki.served.descriptor, 2);
  });

  it("asks every time when the database says to, and still sends nothing twice", async () => {
    const { f, descriptors, read } = await two(0);
    await read();
    await read();
    await read();
    assert.equal(f.member(WIKI).served.descriptor, 3);
    assert.equal(descriptors.hits, 0);
    assert.equal(descriptors.confirmed, 2);
  });

  it("does not believe a lifetime longer than it is prepared to go without looking", async () => {
    const { f, read, tick } = await two(86_400);
    await read();
    tick(MAX_DESCRIPTOR_SECONDS * 1000 + 1);
    await read();
    // A day was claimed. A caller that believed it would not look at this database's keys for a day.
    assert.equal(f.member(WIKI).served.descriptor, 2);
  });

  it("can be made to look past a lifetime, which is how a rotation it has not seen is found", async () => {
    const { binding } = await served();
    const descriptors = new DescriptorCache();
    let asked = 0;
    const transport = {
      descriptors,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        asked++;
        return handle(new Request(input as string, init), binding);
      }) as typeof fetch,
    };
    await discover(binding.database, transport);
    await discover(binding.database, transport);
    assert.equal(asked, 1);
    assert.equal(descriptors.fresh(binding.database), true);
    await discover(binding.database, { ...transport, fresh: true });
    assert.equal(asked, 2);
    // Without a cache it is what it always was: one request each time.
    await discover(binding.database, { fetch: transport.fetch });
    assert.equal(asked, 3);
  });
});

describe("an origin's own list of what it serves", () => {
  it("is RFC 9727's catalog, with the two documents a database already serves", () => {
    assert.deepEqual(apiCatalog(["https://db.example/wiki"]), {
      linkset: [
        {
          anchor: "https://db.example/wiki",
          "service-desc": [{ href: "https://db.example/wiki/vocabulary", type: "application/json" }],
          "service-meta": [{ href: "https://db.example/wiki", type: "application/json" }],
        },
      ],
    });
    // A URI that is not a database's canonical one is refused here as everywhere.
    assert.throws(() => apiCatalog(["https://db.example/wiki/"]), /canonical/);
  });

  it("is served at the well-known path and nowhere else, with the type and the link the RFC asks for", async () => {
    const dbs = ["https://db.example/wiki"];
    const get = serveCatalog(new Request(`https://db.example${WELL_KNOWN}`), dbs)!;
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("content-type"), CATALOG_TYPE);
    assert.match(CATALOG_TYPE, /^application\/linkset\+json; profile="https:\/\/www\.rfc-editor\.org\/info\/rfc9727"$/);
    assert.deepEqual(await get.json(), apiCatalog(dbs));

    const head = serveCatalog(new Request(`https://db.example${WELL_KNOWN}`, { method: "HEAD" }), dbs)!;
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("link"), '</.well-known/api-catalog>; rel="api-catalog"');
    assert.equal(await head.text(), "");

    assert.equal(serveCatalog(new Request(`https://db.example${WELL_KNOWN}`, { method: "POST" }), dbs)!.status, 405);
    assert.equal(serveCatalog(new Request("https://db.example/wiki"), dbs), null);
    assert.equal(get.headers.get("access-control-allow-origin"), null);
    assert.equal(serveCatalog(new Request(`https://db.example${WELL_KNOWN}`), dbs, { cors: true })!.headers.get("access-control-allow-origin"), "*");
  });
});
