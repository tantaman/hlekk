// That the routes which operate a deployment are closed to everyone but its operator.
//
// Three things are worth holding, and the last is the one a route list would not give. A request
// without the token is refused. It is refused before it costs anything: no binding touched, nothing
// forwarded. And every route the Worker has is on one side of the line or the other, by name — so a
// route added tomorrow fails this file until someone says which side it is on, rather than being
// public because nobody thought about it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { MIN_TOKEN_LENGTH, isOperatorPath, operatorHeaders, operatorRefusal, refuseOperator } from "./guard.ts";
import { ROSTER_TTL_MS, narrowRoster, rosterOf } from "./roster.ts";
import type { Roster } from "./roster.ts";
import * as entry from "./wiki-app.ts";
import worker from "./wiki-app.ts";

const TOKEN = "t".repeat(MIN_TOKEN_LENGTH) + "-operator";
const OTHER = "x".repeat(MIN_TOKEN_LENGTH) + "-operator"; // same length, so only the content differs

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request("https://wiki.example.com" + path, { headers });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("isOperatorPath", () => {
  it("takes everything under the two prefixes", () => {
    for (const p of ["/admin/init", "/admin/where", "/admin/anything/at/all", "/ingest/pages", "/admin", "/ingest", "/admin/"]) {
      assert.equal(isOperatorPath(p), true, p);
    }
  });

  it("takes nothing else, including a path that merely starts the same way", () => {
    for (const p of ["/", "/page", "/query", "/cluster", "/administrator", "/ingestion", "/wiki/admin/init", ""]) {
      assert.equal(isOperatorPath(p), false, p);
    }
  });
});

describe("refuseOperator", () => {
  it("refuses everything when no token is configured, whatever is sent", async () => {
    // The committed state. No header can open a deployment nobody has armed.
    for (const headers of [{}, bearer(TOKEN), bearer("")]) {
      const res = await refuseOperator(get("/admin/where", headers), undefined);
      assert.equal(res?.status, 403);
    }
  });

  it("treats a short token as no token", async () => {
    // `HLEKK_ADMIN_TOKEN=1` looks like the arming flags beside it. Honouring it would make the whole
    // operator surface a one-guess secret, and sending exactly "1" would be that guess.
    for (const weak of ["", "1", "true", "x".repeat(MIN_TOKEN_LENGTH - 1)]) {
      const res = await refuseOperator(get("/admin/where", bearer(weak)), weak);
      assert.equal(res?.status, 403, JSON.stringify(weak));
    }
  });

  it("asks for the token when one is configured and none arrives", async () => {
    const res = await refuseOperator(get("/admin/where"), TOKEN);
    assert.equal(res?.status, 401);
    assert.equal(res?.headers.get("www-authenticate"), "Bearer");
  });

  it("refuses a wrong token, of the same length or another", async () => {
    for (const sent of [OTHER, TOKEN + "x", TOKEN.slice(1), "x"]) {
      const res = await refuseOperator(get("/admin/where", bearer(sent)), TOKEN);
      assert.equal(res?.status, 401, sent);
    }
  });

  it("refuses the right token under another scheme", async () => {
    for (const authorization of [`Basic ${TOKEN}`, TOKEN, `Bearer`, `Bearer  `]) {
      const res = await refuseOperator(get("/admin/where", { authorization }), TOKEN);
      assert.equal(res?.status, 401, authorization);
    }
  });

  it("lets the right token through", async () => {
    assert.equal(await refuseOperator(get("/admin/where", bearer(TOKEN)), TOKEN), null);
    // The scheme is case-insensitive in HTTP; the token is not.
    assert.equal(await refuseOperator(get("/admin/where", { authorization: `bearer ${TOKEN}` }), TOKEN), null);
    assert.notEqual(await refuseOperator(get("/admin/where", bearer(TOKEN.toUpperCase())), TOKEN), null);
  });

  it("says nothing in a refusal that depends on the path", async () => {
    // A refusal for a route that exists and one that does not must be the same bytes, or the guard
    // is a way to enumerate the operator surface.
    const real = await refuseOperator(get("/admin/wipe"), TOKEN);
    const made = await refuseOperator(get("/admin/no-such-route"), TOKEN);
    assert.equal(await real!.text(), await made!.text());
  });
});

// ---- the Worker itself

/** A binding that fails the test if anything reads it. */
const untouchable = (name: string) =>
  new Proxy({}, { get: (_, key) => { throw new Error(`${name}.${String(key)} was touched`); } });

type WorkerEnv = Parameters<typeof worker.fetch>[1];

const sealed = (extra: Record<string, unknown> = {}): WorkerEnv =>
  ({
    HLEKK_HOSTS: untouchable("HLEKK_HOSTS"),
    HLEKK_DIRECTORY: untouchable("HLEKK_DIRECTORY"),
    HLEKK_MAP: untouchable("HLEKK_MAP"),
    ...extra,
  }) as unknown as WorkerEnv;

/** Bindings that exist and do nothing, for a request that is supposed to get past the guard. */
const inert = (extra: Record<string, unknown> = {}): WorkerEnv => {
  const namespace = { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response("{}") }) };
  return { HLEKK_HOSTS: namespace, HLEKK_DIRECTORY: namespace, HLEKK_MAP: {}, ...extra } as unknown as WorkerEnv;
};

const source = readFileSync(new URL("./wiki-app.ts", import.meta.url), "utf8");
const routes = [...source.matchAll(/path === "([^"]+)"/g)].map((m) => m[1]!);
const methodFor = (path: string) => (path.startsWith("/ingest/") || path === "/admin/wipe" ? "POST" : "GET");
const ask = (path: string, headers: Record<string, string> = {}) =>
  new Request("https://wiki.example.com" + path, {
    method: methodFor(path.split("?")[0]!),
    headers,
    ...(methodFor(path.split("?")[0]!) === "POST" ? { body: "{}" } : {}),
  });

describe("the wiki Worker's entry module", () => {
  it("exports nothing the Workers runtime will refuse", () => {
    // The runtime takes an entry module's named exports to be handlers: a function, a class, or an
    // object of them. A number or a string there is a startup error on workerd and invisible under
    // Node, so this holds the line the platform draws. `default` is the handler object itself.
    for (const [name, value] of Object.entries(entry)) {
      if (name === "default") continue;
      assert.equal(typeof value, "function", `export ${name} is a ${typeof value}`);
    }
  });
});

describe("the wiki Worker's routes", () => {
  /** What a visitor may reach. Everything else the Worker serves has to be an operator path. */
  const PUBLIC = ["/", "/wiki", "/cluster", "/health", "/lookup", "/page", "/relation", "/schema", "/price", "/query", "/counts"];

  it("are each either public by name or behind the guard", () => {
    assert.ok(routes.length >= 20, `found ${routes.length} routes; the pattern has stopped matching`);
    const unclassified = routes.filter((r) => !PUBLIC.includes(r) && !isOperatorPath(r));
    assert.deepEqual(unclassified, [], "a new route is public until it is listed here or moved under /admin/");
    // And the ones that started this are all on the closed side.
    for (const r of [
      "/admin/init", "/admin/where", "/admin/size", "/admin/wipe", "/admin/r2probe", "/admin/cpu", "/admin/route",
      "/ingest/pages", "/ingest/edges",
    ]) {
      assert.ok(routes.includes(r), `${r} is no longer a route; update this list`);
      assert.ok(isOperatorPath(r), r);
    }
  });

  it("refuse every operator route on a deployment with no token, touching nothing", async () => {
    for (const r of routes.filter(isOperatorPath)) {
      const res = await worker.fetch(ask(r), sealed());
      assert.equal(res.status, 403, r);
    }
  });

  it("refuse every operator route without the token, touching nothing", async () => {
    for (const r of routes.filter(isOperatorPath)) {
      for (const headers of [{}, bearer(OTHER)]) {
        const res = await worker.fetch(ask(r, headers), sealed({ HLEKK_ADMIN_TOKEN: TOKEN }));
        assert.equal(res.status, 401, r);
      }
    }
  });

  it("do not let a wipe or a probe through on their own arming", async () => {
    // Each of these had its own gate before there was a token. That gate says what a request may
    // name; it was never meant to say who is asking, and an armed deployment must still ask.
    const armed = { HLEKK_WIPE: "wiki-old", HLEKK_R2PROBE: "probe.bin", HLEKK_BULK: untouchable("HLEKK_BULK") };
    for (const path of ["/admin/wipe?database=wiki-old", "/admin/r2probe?key=probe.bin"]) {
      assert.equal((await worker.fetch(ask(path), sealed(armed))).status, 403, path);
      assert.equal((await worker.fetch(ask(path), sealed({ ...armed, HLEKK_ADMIN_TOKEN: TOKEN }))).status, 401, path);
    }
  });

  it("do not forward a refused request to another deployment", async () => {
    // The forward runs before any route is matched, so without the guard ahead of it `?placement=b`
    // would carry an operator request past this deployment's check and on to one that may not have it.
    const forwarded: string[] = [];
    const alt = { fetch: async (r: Request) => (forwarded.push(r.url), new Response("{}")) };
    for (const env of [sealed({ HLEKK_ALT: alt }), sealed({ HLEKK_ALT: alt, HLEKK_ADMIN_TOKEN: TOKEN })]) {
      const res = await worker.fetch(ask("/ingest/pages?placement=b"), env);
      assert.ok(res.status === 401 || res.status === 403);
    }
    assert.deepEqual(forwarded, []);
  });

  it("forward an authorized one with its header, so the other deployment can check it too", async () => {
    const seen: { url: string; authorization: string | null }[] = [];
    const alt = {
      fetch: async (r: Request) => (seen.push({ url: r.url, authorization: r.headers.get("authorization") }), new Response("{}")),
    };
    await worker.fetch(ask("/admin/where?placement=b", bearer(TOKEN)), sealed({ HLEKK_ALT: alt, HLEKK_ADMIN_TOKEN: TOKEN }));
    assert.deepEqual(seen, [{ url: "https://wiki.example.com/admin/where", authorization: `Bearer ${TOKEN}` }]);
  });

  it("let the right token reach an operator route", async () => {
    const res = await worker.fetch(ask("/admin/cpu?mops=1", bearer(TOKEN)), inert({ HLEKK_ADMIN_TOKEN: TOKEN }));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { mops: number }).mops, 1);
  });

  it("leave a visitor's routes alone", async () => {
    // No token configured and none sent: the page is served, and a read gets as far as the database.
    const page = await worker.fetch(ask("/"), inert());
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    // Past the guard means reaching for a binding, which the sealed env reports by throwing.
    await assert.rejects(Promise.resolve(worker.fetch(ask("/page?ns=0&title=Country"), sealed())), /was touched/);
  });
});

// ---- the roster a visitor gets instead of /admin/where

describe("narrowRoster", () => {
  it("copies three numbers per host and a count, and nothing else the operator's view holds", () => {
    const where = {
      database: "wiki-simple-cat",
      catalog: 1,
      mapVersion: 7,
      publishes: 3,
      inFlight: 0,
      indexVshards: ["128", "129", "130"],
      hosts: [
        { host: 0, vshards: 3, objects: 22_000, pending: 4, holding: [{ vshard: "0", state: "owned", epoch: 0, objects: 22_000 }] },
        { host: 1, vshards: 3, objects: 0, pending: 0, holding: [] },
      ],
    };
    assert.deepEqual(narrowRoster(where), {
      hosts: [
        { host: 0, objects: 22_000, vshards: 3 },
        { host: 1, objects: 0, vshards: 3 },
      ],
      indexVshards: 3,
    });
  });
});

describe("rosterOf", () => {
  const roster: Roster = { hosts: [{ host: 0, objects: 1, vshards: 1 }], indexVshards: 1 };

  it("reads once for every caller that arrives inside the window", async () => {
    let loads = 0;
    const load = async () => (loads++, roster);
    const key = {};
    // Three at once, which is a page of visitors arriving on a cold isolate, and one later.
    const got = await Promise.all([rosterOf(key, 1_000, load), rosterOf(key, 1_000, load), rosterOf(key, 1_001, load)]);
    await rosterOf(key, 1_000 + ROSTER_TTL_MS - 1, load);
    assert.equal(loads, 1);
    assert.deepEqual(got, [roster, roster, roster]);
  });

  it("reads again once the window has passed, and separately per deployment", async () => {
    let loads = 0;
    const load = async () => (loads++, roster);
    const key = {};
    await rosterOf(key, 0, load);
    await rosterOf(key, ROSTER_TTL_MS, load);
    assert.equal(loads, 2);
    await rosterOf({}, ROSTER_TTL_MS, load);
    assert.equal(loads, 3);
  });

  it("does not hold a failure", async () => {
    // An overloaded directory answers the first visitor with an error. Holding that for the window
    // would turn one bad moment into ten minutes without a grid.
    let loads = 0;
    const key = {};
    await assert.rejects(rosterOf(key, 0, async () => { loads++; throw new Error("Durable Object is overloaded"); }));
    assert.deepEqual(await rosterOf(key, 1, async () => (loads++, roster)), roster);
    assert.equal(loads, 2);
  });
});

// ---- what a driver sends

describe("operatorHeaders", () => {
  it("sends the token to operator paths and to no others", () => {
    assert.deepEqual(operatorHeaders("/ingest/pages", TOKEN), { authorization: `Bearer ${TOKEN}` });
    assert.deepEqual(operatorHeaders("/admin/route?ids=1,2", TOKEN), { authorization: `Bearer ${TOKEN}` });
    // A load also reads /page and /counts. The token does not ride along on those.
    assert.deepEqual(operatorHeaders("/counts?ids=1,2", TOKEN), {});
    assert.deepEqual(operatorHeaders("/page?title=/admin/init", TOKEN), {});
  });

  it("sends nothing when there is no token to send", () => {
    assert.deepEqual(operatorHeaders("/ingest/pages", undefined), {});
    assert.deepEqual(operatorHeaders("/ingest/pages", ""), {});
  });
});

describe("operatorRefusal", () => {
  it("tells a driver which thing it forgot", () => {
    assert.match(operatorRefusal("/ingest/pages", 401, undefined)!, /set HLEKK_ADMIN_TOKEN/);
    assert.match(operatorRefusal("/ingest/pages", 401, TOKEN)!, /not the token set on that Worker/);
    assert.match(operatorRefusal("/admin/where", 403, undefined)!, /closed on that deployment/);
  });

  it("leaves every other failure to be retried or reported as it was", () => {
    assert.equal(operatorRefusal("/ingest/pages", 500, TOKEN), null);
    assert.equal(operatorRefusal("/page", 401, TOKEN), null);
    // A 403 with a token set is the route's own refusal — a wipe not armed for that database.
    assert.equal(operatorRefusal("/admin/wipe?database=x", 403, TOKEN), null);
  });
});
