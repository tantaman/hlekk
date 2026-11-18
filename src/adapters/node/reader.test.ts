import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { plan as planLock } from "../../catalog/catalog.ts";
import { Reader } from "../../reader/reader.ts";
import type { Page } from "../../reader/reader.ts";
import { open } from "./database.ts";
import type { NodeHlekk } from "./database.ts";
import { listen } from "./http.ts";
import type { NodeDatabase } from "./http.ts";
import { PrivateAddress } from "./guard.ts";
import { connect, reader } from "./reader.ts";

// A reader and two databases, over real sockets and the real resolver.
//
// `reader/reader.test.ts` hands the reader the handler itself. What this adds is the half that file
// cannot: the guard is a thing of this platform, and a reader that reaches a database on this
// machine only because nobody checked is the failure it exists to prevent.

const NOTES = planLock({
  notes: {
    objects: { "notes.note": { fields: { title: "string" } } },
    edges: { "notes.about": { from: "notes.note", to: "wiki.page", foreign: true } },
  },
  wiki: { objects: { "wiki.page": { fields: {} } } },
});
const WIKI = planLock({ wiki: { objects: { "wiki.page": { fields: { title: "string" } } } } });

describe("a reader on Node", () => {
  const dirs: string[] = [];
  const stores: NodeHlekk[] = [];
  const servers: NodeDatabase[] = [];
  after(async () => {
    await Promise.all(servers.map((s) => s.close()));
    for (const s of stores) s.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const serve = async (lock: Parameters<typeof open>[0]["lock"], path: string) => {
    const dir = mkdtempSync(join(tmpdir(), "hlekk-reader-"));
    dirs.push(dir);
    const store = await open({ dir, lock, format: 2 });
    const server = await listen(store.binding, { path });
    stores.push(store);
    servers.push(server);
    return { store, server };
  };

  it("reads two file-backed databases over HTTP, and neither needed to know about it", async () => {
    const wiki = await serve(WIKI, "/wiki");
    const notes = await serve(NOTES, "/notes");
    const page = await wiki.store.db.create(wiki.store.catalog.objectNamed("wiki.page")!.otype, { title: "Country" });
    const note = await notes.store.db.create(notes.store.catalog.objectNamed("notes.note")!.otype, { title: "a note" });
    await notes.store.db.assocAdd(notes.store.catalog.edgeNamed("notes.about")!.atype!, note, `${wiki.server.database}#${page}`, 1);

    const db = await connect(notes.server.database, { allowLoopback: true });
    assert.deepEqual(db.edgesFrom("notes.note"), ["notes.about"]);
    const [row] = await db.read(note, { hops: [{ edge: "notes.about", as: "about" }] });
    const about = (row!.about as Page).items;
    assert.deepEqual(about.map((r) => [r.id, r.$type, r.title]), [[`${wiki.server.database}#${page}`, "wiki.page", "Country"]]);
  });

  it("refuses a database on this machine unless it was told that is what it is for", async () => {
    const wiki = await serve(WIKI, "/wiki");
    await assert.rejects(connect(wiki.server.database), PrivateAddress);
    await assert.rejects(reader().read(`${wiki.server.database}#1`), PrivateAddress);
  });

  it("checks every database a read reaches, not only the one it entered by", async () => {
    // The case that matters. The reader was pointed somewhere it may go; what it must refuse is
    // where an edge in that database's answer tells it to go next.
    const inside = await serve(WIKI, "/wiki");
    const page = await inside.store.db.create(inside.store.catalog.objectNamed("wiki.page")!.otype, { title: "internal" });
    const notes = await serve(NOTES, "/notes");
    const note = await notes.store.db.create(notes.store.catalog.objectNamed("notes.note")!.otype, { title: "a lure" });
    await notes.store.db.assocAdd(notes.store.catalog.edgeNamed("notes.about")!.atype!, note, `${inside.server.database}#${page}`, 1);
    const lure = `${notes.server.database}#${note}`;

    // Both are loopback here, so the policy is stated by hand: one database is public, one is not.
    const guard = async (database: string) => {
      if (database === inside.server.database) throw new PrivateAddress(database, "127.0.0.1");
    };
    const r = new Reader({ guard });
    assert.equal((await r.read(lure)).length, 1, "the database it was pointed at reads");
    await assert.rejects(r.read(lure, { hops: [{ edge: "notes.about" }] }), PrivateAddress);

    // Left out and named, for a caller that would rather have the rest.
    const omit = { databases: {} as Record<string, number> };
    const [row] = await r.read(lure, { hops: [{ edge: "notes.about", as: "about" }] }, { omit });
    assert.deepEqual((row!.about as Page).items, []);
    assert.deepEqual(omit.databases, { [inside.server.database]: 1 });
  });
});
