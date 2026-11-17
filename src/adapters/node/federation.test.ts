import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import { Catalog, plan as planLock } from "../../catalog/catalog.ts";
import { Hlekk } from "../../client/client.ts";
import { LocalCluster } from "../../client/local.ts";
import { foreignClient } from "../../protocol/client.ts";
import { surfaceOf } from "../../protocol/surface.ts";
import { listen } from "./http.ts";
import type { NodeDatabase } from "./http.ts";
import { privateAddressGuard } from "./guard.ts";

// Two databases in two servers, over a real socket and a real `fetch`.
//
// `protocol/federation.test.ts` proves the read with the handler called in process. What this adds is
// that nothing in that shortcut was carrying the test: the wire format survives a socket, the client
// reads a descriptor over one, and `AbortSignal`, redirects and the response cap are real. It is also
// the shape of the deployment PLAN.md step 4 ends on, with Cloudflare swapped for node:http.

const LOCK = planLock({
  notes: {
    objects: { "notes.note": { fields: { body: "string" } } },
    edges: { "notes.note_about": { from: "notes.note", to: "wiki.page", foreign: true } },
  },
  wiki: { objects: { "wiki.page": { fields: { title: "string" } } } },
});
const CATALOG = Catalog.compile(LOCK);
const T = {
  note: CATALOG.objectNamed("notes.note")!.otype,
  page: CATALOG.objectNamed("wiki.page")!.otype,
  about: CATALOG.edgeNamed("notes.note_about")!.atype!,
};

describe("two databases over real HTTP", () => {
  const open: NodeDatabase[] = [];
  after(async () => {
    await Promise.all(open.map((s) => s.close()));
  });

  /** One database, listening, with its URI resolved from the socket. */
  const start = async (name: string, path: string) => {
    // A foreign edge type needs format 2, so this says so rather than inheriting the suite's.
    const cluster = new LocalCluster({ database: name, format: 2 });
    cluster.directory.applyLock(LOCK);
    cluster.spreadCatalog();
    await cluster.publish();
    const node = await listen(
      {
        catalog: CATALOG,
        source: cluster.client(),
        surface: surfaceOf(CATALOG),
      },
      { path },
    );
    open.push(node);
    // The URI is the identity, and it is only knowable once the port is. A deployment configures it;
    // a test takes it from the socket and tells the directory, which is the same recording.
    cluster.directory.setDatabaseUri(node.database);
    return { cluster, node };
  };

  it("reads an object out of the other process", async () => {
    const wiki = await start("wiki", "/wiki");
    const notes = await start("notes", "/notes");

    const page = await wiki.cluster.client().create(T.page, { title: "Country" }, { vshard: "3" });

    // The notes client, with a foreign client over the real network and the real address guard —
    // which has to be told that loopback is allowed, because refusing it is the whole point of it.
    const guard = privateAddressGuard({ allowLoopback: true });
    Hlekk.forget(notes.cluster.transport);
    const db = Hlekk.from(notes.cluster.transport, notes.cluster.runtime.clock, (database) =>
      foreignClient(database, { catalog: CATALOG, guard }),
    );

    const note = await db.create(T.note, { body: "a note" }, { vshard: "7" });
    await db.assocAdd(T.about, note, `${wiki.node.database}#${page}`, 1);

    const rows = (await db.query(
      {
        frames: [
          { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
          { source: { kind: "edge", atype: T.about }, children: [], counts: [] },
        ],
      },
      [note],
    )) as { about: { id: string; title: string }[] }[];

    assert.deepEqual(
      rows[0].about.map((a) => [a.id, a.title]),
      [[`${wiki.node.database}#${page}`, "Country"]],
    );
  });

  it("refuses a database whose address the guard will not allow", async () => {
    const wiki = await start("wiki2", "/wiki");
    const notes = await start("notes2", "/notes");
    const page = await wiki.cluster.client().create(T.page, { title: "Country" }, { vshard: "3" });

    // The same federation, with loopback refused — which is what a deployment runs, because a
    // stranger's URI must not reach this network.
    Hlekk.forget(notes.cluster.transport);
    const db = Hlekk.from(notes.cluster.transport, notes.cluster.runtime.clock, (database) =>
      foreignClient(database, { catalog: CATALOG, guard: privateAddressGuard() }),
    );
    const note = await db.create(T.note, { body: "a note" }, { vshard: "7" });
    await db.assocAdd(T.about, note, `${wiki.node.database}#${page}`, 1);

    await assert.rejects(
      db.query(
        {
          frames: [
            { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
            { source: { kind: "edge", atype: T.about }, children: [], counts: [] },
          ],
        },
        [note],
      ),
      /not a public address/,
    );
  });

  it("will not follow a redirect, since a database that moved is a different database", async () => {
    const wiki = await start("wiki3", "/wiki");
    const client = foreignClient(wiki.node.database, {
      catalog: CATALOG,
      // A server that redirects, in front of the real one.
      fetch: async () => new Response(null, { status: 302, headers: { location: `${wiki.node.database}/read` } }),
    });
    await assert.rejects(client.exec({ frames: [] }, [{ kind: "object", id: `${wiki.node.database}#1`, frame: 0 }]), /could not be read/);
  });
});
