import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { plan as planLock } from "../../catalog/catalog.ts";
import type { Binding } from "../../protocol/http.ts";
import { PUBLIC } from "../../query/serve.ts";
import type { Policy } from "../../query/serve.ts";
import type { Plan } from "../../query/types.ts";
import { open } from "./database.ts";
import type { NodeHlekk } from "./database.ts";
import { listen } from "./http.ts";
import type { ListenOptions, NodeDatabase } from "./http.ts";
import { parse } from "./serve.ts";

// The HTTP the protocol takes on, over a real socket: that a method Node's parser has to know
// arrives, that a 304 leaves with no body, and that the defaults which depend on where a database
// is reachable from come out right for one that is on loopback — which every one of these is.

const RELEASES = planLock({
  packages: { objects: { "packages.release": { fields: { tag: "string" } } } },
});
const INCIDENTS = planLock({
  ops: {
    objects: { "ops.incident": { fields: { ticket: "string" } } },
    edges: { "ops.deployed_release": { from: "ops.incident", to: "packages.release", foreign: true } },
  },
  packages: { objects: { "packages.release": { fields: { tag: "string" } } } },
});

describe("the protocol's HTTP, over a socket", () => {
  const dirs: string[] = [];
  const servers: NodeDatabase[] = [];
  const stores: NodeHlekk[] = [];
  after(async () => {
    await Promise.all(servers.map((s) => s.close()));
    for (const s of stores) s.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const start = async (
    path: string,
    opts: Omit<Parameters<typeof open>[0], "dir">,
    serving: ListenOptions = {},
    tweak: (binding: Partial<Binding>) => void = () => {},
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "hlekk-http-"));
    dirs.push(dir);
    const store = await open({ dir, format: 2, allowLoopback: true, ...opts });
    stores.push(store);
    tweak(store.binding);
    const server = await listen(store.binding, { path, ...serving });
    servers.push(server);
    return { store, server };
  };

  const release = async (store: NodeHlekk) =>
    store.db.create(store.catalog.objectNamed("packages.release")!.otype, { tag: "3.7.2" }, { vshard: "3" });

  it("carries QUERY, OPTIONS and a 304 through node:http", async () => {
    const { store, server } = await start("/releases", { lock: RELEASES, identity: false });
    const id = await release(store);
    const db = server.database;

    const body = JSON.stringify({ ids: [id] });
    const queried = await fetch(`${db}/read`, { method: "QUERY", body, headers: { "content-type": "application/json" } });
    assert.equal(queried.status, 200);
    const posted = await fetch(`${db}/read`, { method: "POST", body, headers: { "content-type": "application/json" } });
    assert.deepEqual(await queried.json(), await posted.json());

    const options = await fetch(`${db}/read`, { method: "OPTIONS" });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("allow"), "POST, QUERY, OPTIONS");

    const got = await fetch(`${db}/objects/${id}`);
    assert.equal(got.status, 200);
    const etag = got.headers.get("etag")!;
    const unchanged = await fetch(`${db}/objects/${id}`, { headers: { "if-none-match": etag } });
    assert.equal(unchanged.status, 304);
    assert.equal(await unchanged.text(), "");

    const absent = await fetch(`${db}/objects/999999`);
    assert.equal(absent.status, 404);
    assert.equal(((await absent.json()) as { error: string }).error, "no such object");
  });

  it("does not let a page read a loopback database unless its operator said so", async () => {
    const closed = await start("/db", { lock: RELEASES, identity: false });
    // The default, for a database only this machine can reach: a browser on this machine would
    // extend that to every page it opens.
    const plain = await fetch(closed.server.database);
    assert.equal(plain.headers.get("access-control-allow-origin"), null);
    const preflight = await fetch(`${closed.server.database}/read`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    assert.equal(preflight.headers.get("access-control-allow-methods"), null);
    assert.equal((await fetch(`${closed.server.origin}/.well-known/api-catalog`)).headers.get("access-control-allow-origin"), null);

    const asked = await start("/db", { lock: RELEASES, identity: false }, { cors: true });
    assert.equal((await fetch(asked.server.database)).headers.get("access-control-allow-origin"), "*");
    assert.equal(parse(["--cors"]).cors, true);
    assert.equal(parse(["--no-cors"]).cors, false);
    assert.equal(parse([]).cors, undefined);
  });

  it("lists the database where an origin says what it serves", async () => {
    const { server } = await start("/releases", { lock: RELEASES, identity: false });
    const res = await fetch(`${server.origin}/.well-known/api-catalog`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /^application\/linkset\+json; profile="https:\/\/www\.rfc-editor\.org\/info\/rfc9727"$/);
    const { linkset } = (await res.json()) as { linkset: { anchor: string; "service-meta": { href: string }[] }[] };
    assert.equal(linkset.length, 1);
    assert.equal(linkset[0]!.anchor, server.database);
    // What it points at is the descriptor, which is what says this entry is a hlekk database.
    const descriptor = (await (await fetch(linkset[0]!["service-meta"][0]!.href)).json()) as { protocol: string };
    assert.equal(descriptor.protocol, "hlekk");

    const head = await fetch(`${server.origin}/.well-known/api-catalog`, { method: "HEAD" });
    assert.match(head.headers.get("link")!, /rel="api-catalog"/);

    // And it can be left out, by an operator whose origin has a catalog of its own.
    const quiet = await start("/releases", { lock: RELEASES, identity: false }, { catalog: false });
    assert.equal((await fetch(`${quiet.server.origin}/.well-known/api-catalog`)).status, 404);
  });

  it("finds a caller's new key past the descriptor it was keeping", async () => {
    // Releases shows its objects to a caller it can verify, and to nobody else.
    const NOTHING: Policy = { object: () => false, count: () => false, cache: () => ({ reuse: "never" }) };
    const releases = await start("/releases", { lock: RELEASES }, {}, (binding) => {
      binding.policyFor = async (caller) => ({ policy: caller === null ? NOTHING : { ...PUBLIC, cache: () => ({ reuse: "never" }) } });
    });
    const incidents = await start("/incidents", { lock: INCIDENTS });
    const id = await release(releases.store);
    const incident = await incidents.store.db.create(
      incidents.store.catalog.objectNamed("ops.incident")!.otype,
      { ticket: "INC-217" },
      { vshard: "7" },
    );
    const deployed = incidents.store.catalog.edgeNamed("ops.deployed_release")!.atype!;
    await incidents.store.db.assocAdd(deployed, incident, `${releases.server.database}#${id}`, 1);
    const plan: Plan = {
      frames: [
        { source: { kind: "ids" }, children: [{ alias: "release", frame: 1 }], counts: [] },
        { source: { kind: "edge", atype: deployed }, children: [], counts: [] },
      ],
    };
    const tags = async () =>
      ((await incidents.store.db.query(plan, [incident])) as { release: { tag: string }[] }[])[0]!.release.map((r) => r.tag);

    // Signed, verified against the incidents database's descriptor — which releases now keeps for
    // the minute it was told it may.
    assert.deepEqual(await tags(), ["3.7.2"]);

    // Incidents rotates. Its next request is signed with a key the kept descriptor does not list,
    // inside that minute. A responder that trusted its copy would call this a key nobody published.
    await incidents.store.cluster.directory.rotateKey(Date.now());
    assert.deepEqual(await tags(), ["3.7.2"]);
  });
});
