import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { plan as planLock } from "../../catalog/catalog.ts";
import { open } from "./database.ts";
import type { NodeHlekk } from "./database.ts";
import { listen } from "./http.ts";
import type { NodeDatabase } from "./http.ts";
import { parse } from "./serve.ts";

// A backlink between two databases in two servers, each over its own files, with real sockets, real
// keys and the real address guard. `protocol/backlinks.test.ts` proves the behaviour with the
// handler called in process; what this adds is that a hint survives everything a deployment puts
// around it — a signature made over a URI the other side reconstructs from a socket, a descriptor
// fetched to verify it, and a pin recorded in a directory that is a file.

const RELEASES = planLock({
  packages: {
    objects: { "packages.release": { fields: { tag: "string" } } },
    edges: { "packages.release_cited_by": { from: "packages.release", to: "ops.incident", foreign: true } },
  },
  ops: { objects: { "ops.incident": { fields: {} } } },
});
const INCIDENTS = planLock({
  ops: {
    objects: { "ops.incident": { fields: { ticket: "string" } } },
    edges: { "ops.deployed_release": { from: "ops.incident", to: "packages.release", foreign: true } },
  },
  packages: { objects: { "packages.release": { fields: {} } } },
});
/** An edge type that stays inside its database, which is what a backlink cannot be recorded under. */
const INCIDENTS_LOCAL = planLock({
  ops: {
    objects: { "ops.incident": { fields: { ticket: "string" } } },
    edges: { "ops.incident_follows": { from: "ops.incident", to: "ops.incident" } },
  },
});

describe("a backlink between two databases over real HTTP", () => {
  const dirs: string[] = [];
  const servers: NodeDatabase[] = [];
  const stores: NodeHlekk[] = [];
  after(async () => {
    await Promise.all(servers.map((s) => s.close()));
    for (const s of stores) s.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const start = async (path: string, opts: Omit<Parameters<typeof open>[0], "dir">) => {
    const dir = mkdtempSync(join(tmpdir(), "hlekk-backlinks-"));
    dirs.push(dir);
    // Format 2: a foreign edge has nowhere to put its alias in the older key.
    const store = await open({ dir, format: 2, allowLoopback: true, ...opts });
    stores.push(store);
    const server = await listen(store.binding, { path });
    servers.push(server);
    return { store, server };
  };

  it("lets a maintainer's database answer which incidents cite a release", async () => {
    const releases = await start("/releases", { lock: RELEASES, backlinks: { edge: "packages.release_cited_by" } });
    const incidents = await start("/incidents", { lock: INCIDENTS });

    const release = await releases.store.db.create(
      releases.store.catalog.objectNamed("packages.release")!.otype,
      { tag: "3.7.2" },
      { vshard: "3" },
    );
    const incident = await incidents.store.db.create(
      incidents.store.catalog.objectNamed("ops.incident")!.otype,
      { ticket: "INC-217" },
      { vshard: "7" },
    );
    const target = `${releases.server.database}#${release}`;

    // The descriptor states the route, which is how a sender knows before it sends.
    const descriptor = (await (await fetch(releases.server.database)).json()) as { routes: Record<string, string> };
    assert.equal(descriptor.routes.hint, `${releases.server.database}/hint`);

    await incidents.store.db.assocAdd(incidents.store.catalog.edgeNamed("ops.deployed_release")!.atype!, incident, target, 1);
    assert.deepEqual(await incidents.store.hint("ops.deployed_release", incident, target), { sent: true });
    assert.deepEqual(await releases.store.confirm(), ["recorded"]);

    // An agent holding only the release reference now finds the incident, with one plain read.
    const res = await fetch(`${releases.server.database}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [release], hops: [{ edge: "packages.release_cited_by" }] }),
    });
    const body = (await res.json()) as { lists: Record<string, { ids: string[] }> };
    assert.deepEqual(body.lists[`1:${release}`].ids, [`${incidents.server.database}#${incident}`]);

    // And a database that takes no hints is told apart without being sent one.
    assert.deepEqual(await releases.store.hint("packages.release_cited_by", release, `${incidents.server.database}#${incident}`), {
      sent: false,
      why: "unsupported",
    });
    assert.deepEqual(await incidents.store.confirm(), []);
  });

  it("looks at its hints one look at a time, however often it is asked to", async () => {
    // The first read of the incidents database is held AFTER it has answered: the releases database
    // has been told "the edge is there" and has not yet acted on it. That is the moment a second
    // look, started beside the first, would get ahead of it.
    let reads = 0;
    let letGo!: () => void;
    let reached!: () => void;
    const held = new Promise<void>((done) => (letGo = done));
    const holding = new Promise<void>((done) => (reached = done));
    const slow: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/incidents/read") && ++reads === 1) {
        reached();
        await held;
      }
      return res;
    };
    const releases = await start("/releases", {
      lock: RELEASES,
      backlinks: { edge: "packages.release_cited_by" },
      foreign: { fetch: slow },
    });
    const incidents = await start("/incidents", { lock: INCIDENTS });
    const release = await releases.store.db.create(
      releases.store.catalog.objectNamed("packages.release")!.otype,
      { tag: "4.0.0" },
      { vshard: "3" },
    );
    const incident = await incidents.store.db.create(
      incidents.store.catalog.objectNamed("ops.incident")!.otype,
      { ticket: "INC-300" },
      { vshard: "7" },
    );
    const target = `${releases.server.database}#${release}`;
    const deployed = incidents.store.catalog.edgeNamed("ops.deployed_release")!.atype!;

    await incidents.store.db.assocAdd(deployed, incident, target, 1);
    assert.deepEqual(await incidents.store.hint("ops.deployed_release", incident, target), { sent: true });
    const first = releases.store.confirm();
    await holding;

    // Meanwhile the edge is withdrawn, and the same hint says so. A timer fires twice.
    await incidents.store.db.assocRemove(deployed, incident, target);
    assert.deepEqual(await incidents.store.hint("ops.deployed_release", incident, target), { sent: true });
    const second = releases.store.confirm();
    const third = releases.store.confirm();
    // Both of those are one look, and it has not started: nobody is being read beside the first.
    assert.equal(second, third);
    await new Promise((turn) => setTimeout(turn, 50));
    assert.equal(reads, 1);

    // In order, then. The look that read "present" records, and the look that read "absent" comes
    // after it and removes — where side by side the removal would have found nothing to remove, and
    // the record would have landed after it and stayed.
    letGo();
    assert.deepEqual(await first, ["recorded"]);
    assert.deepEqual(await second, ["removed"]);
    assert.equal(reads, 2);
    const res = await fetch(`${releases.server.database}/objects/${release}/packages.release_cited_by`);
    const body = (await res.json()) as { lists: Record<string, { ids: string[] }> };
    assert.deepEqual(body.lists[`1:${release}`].ids, []);
  });

  it("refuses to open with a backlink edge that could never record one", async () => {
    const opening = (opts: Omit<Parameters<typeof open>[0], "dir">) => {
      const dir = mkdtempSync(join(tmpdir(), "hlekk-backlinks-"));
      dirs.push(dir);
      return { dir, opened: open({ dir, format: 2, allowLoopback: true, ...opts }) };
    };
    // A name the catalog does not have matches no target, so every hint would be declined and the
    // database would look, from outside and from its own log, exactly like one that was working.
    const misspelled = opening({ lock: RELEASES, backlinks: { edge: "packages.release_cited_bye" } });
    await assert.rejects(misspelled.opened, /no edge type "packages\.release_cited_bye".*packages\.release_cited_by$/);
    // One that exists and cannot hold a reference into another database is no better.
    await assert.rejects(
      opening({ lock: INCIDENTS_LOCAL, backlinks: { edge: "ops.incident_follows" } }).opened,
      /ops\.incident_follows cannot record a backlink/,
    );
    // And without an identity there is no hint route at all, so the option would do nothing.
    await assert.rejects(
      opening({ lock: RELEASES, identity: false, backlinks: { edge: "packages.release_cited_by" } }).opened,
      /backlinks need identity/,
    );

    // Refused cleanly: the same directory opens once the name is right.
    const store = await open({ dir: misspelled.dir, format: 2, allowLoopback: true, lock: RELEASES, backlinks: { edge: "packages.release_cited_by" } });
    stores.push(store);
    // A policy function is not checked up front — it has not been asked anything yet.
    const asked = await opening({ lock: RELEASES, backlinks: { edge: () => "no.such_edge" } }).opened;
    stores.push(asked);
  });

  it("reads the edge type to record under from the command line", () => {
    assert.equal(parse(["--backlinks", "packages.release_cited_by"]).backlinks, "packages.release_cited_by");
    assert.equal(parse([]).backlinks, undefined);
  });
});
