import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { open } from "../../../src/adapters/node/database.ts";
import { plan } from "../../../src/catalog/catalog.ts";
import { openNotebook } from "./store.mjs";
import { applyChanges } from "../workspace.js";
import { NotebookClient } from "../src/client.js";

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "folio-feed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const paragraph = (key, text) => ({ key, type: "paragraph", content: [{ type: "text", text }] });

test("a cursor reconstructs the snapshot after edits, list removals, commits and restores", async (t) => {
  const dir = await directory(t);
  let n = await openNotebook(dir);
  t.after(() => n.close());
  const first = await n.workspace();
  let mirror = first;
  async function pull() {
    const delta = await n.changes(mirror.cursor);
    mirror = applyChanges(mirror, delta);
    assert.deepEqual(mirror, await n.workspace());
    return delta.patches;
  }
  assert.deepEqual(await pull(), {});
  const id = await n.command({ action: "create", kind: "document", title: "Sync test" });
  const created = await pull();
  const initial = mirror.nodes[id].blocks[0];
  assert.deepEqual(Object.keys(created).sort(), [id, initial].sort());
  const save = (blocks) =>
    n.command({ action: "save", id, version: mirror.nodes[id].version, title: "Sync test", blocks });
  const linked = {
    key: "second",
    type: "paragraph",
    content: [{ type: "wiki", attrs: { label: "Auto-created" } }],
  };
  const a = paragraph("initial", "Original");
  await save([a, linked]);
  await pull();
  const second = mirror.nodes[id].blocks[1];
  const rev = await n.command({ action: "commit", id, version: 1, label: "Before removal" });
  assert.deepEqual(await pull(), {});
  const c = await n.command({ action: "create", kind: "collection", title: "Favorites" });
  await n.command({ action: "member", collection: c, id: initial });
  await pull();
  await n.command({ action: "member", collection: c, id: initial, remove: true });
  assert.deepEqual((await pull())[c], { members: [] });
  await save([paragraph("second", "No more link"), a]);
  const reordered = await pull();
  assert.deepEqual(reordered[id].blocks, [second, initial]);
  assert.deepEqual(reordered[second].links, []);
  assert.equal(reordered[initial], undefined);
  await save([{ type: "embed", key: "initial", target: second, content: [] }]);
  assert.deepEqual((await pull())[initial].embeds, [second]);
  await n.command({ action: "restore", id, version: 3, revision: rev });
  const restored = await pull();
  assert.deepEqual(restored[initial].embeds, []);
  assert.equal("target" in mirror.nodes[initial], false);

  const beforeEdits = mirror;
  for (let i = 0; i < 3; i++) {
    await save([paragraph("initial", "Edit " + i), linked]);
    const patch = await pull();
    assert.deepEqual(Object.keys(patch).sort(), [id, initial].sort());
    assert.equal(patch[id].blocks, undefined, "unchanged order is not downloaded");
  }
  n.close();
  n = await openNotebook(dir);
  const combined = await n.changes(beforeEdits.cursor);
  assert.deepEqual(Object.keys(combined.patches).sort(), [id, initial].sort());
  assert.deepEqual(applyChanges(beforeEdits, combined), mirror);
  assert.deepEqual(applyChanges(first, await n.changes(first.cursor)), mirror);
  await assert.rejects(n.changes("invalid"), { status: 400 });
  await assert.rejects(n.changes(first.cursor.split(":")[0] + ":99999"), { status: 409 });
  await assert.rejects(n.changes("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:0"), { status: 409 });
  await assert.rejects(n.command({ action: "save", id, version: 0, title: "Stale", blocks: [] }), {
    status: 409,
  });
  assert.deepEqual(await n.changes(mirror.cursor), { cursor: mirror.cursor, patches: {} });
});

test("original notebook migration and interrupted publication recover the graph and cursor together", async (t) => {
  const dir = await directory(t);
  const type = "notebook.node";
  const lock = plan({
    notebook: {
      objects: { [type]: { fields: { kind: "string", value: "json" } } },
      edges: Object.fromEntries(
        ["registry", "blocks", "links", "members", "history", "embeds"].map((name) => [
          "notebook." + name,
          { from: type, to: type },
        ]),
      ),
    },
  });
  const old = await open({ dir, lock, identity: false });
  old.cluster.openIndexVshards(1);
  await old.cluster.publish();
  const otype = old.catalog.objectNamed(type).otype;
  const collection = await old.db.create(otype, { kind: "collection", value: { title: "Original" } });
  const root = await old.db.createUnique(1, "workspace", otype, {
    kind: "workspace",
    value: { ready: true, home: collection, pending: null },
  });
  const pending = [{ kind: "add", name: "registry", from: root, to: collection, order: 0 }];
  await old.db.update(root, { kind: "workspace", value: { ready: true, home: collection, pending } });
  old.close();
  const migrated = await openNotebook(dir);
  const before = await migrated.workspace();
  assert.equal(before.nodes[collection].title, "Original");
  migrated.close();

  const raw = await open({ dir, identity: false });
  const [feedId, previous] = before.cursor.split(":");
  const sequence = Number(previous);
  const update = { kind: "update", nodeKind: "collection", id: collection, value: { title: "Recovered" } };
  await raw.db.update(root, {
    kind: "workspace",
    value: { ready: true, home: collection, feedId, sequence, pending: [update] },
  });
  // Simulate stopping after the graph and marker landed, before publishing the cursor.
  await raw.db.update(collection, { kind: "collection", value: update.value });
  await raw.db.assocAdd(
    raw.catalog.edgeNamed("notebook.changed_value").atype,
    root,
    collection,
    -(sequence + 1),
  );
  raw.close();
  const recovered = await openNotebook(dir);
  t.after(() => recovered.close());
  const after = await recovered.workspace();
  assert.equal(after.cursor, feedId + ":" + (sequence + 1));
  assert.deepEqual(after.nodes[collection], {
    id: collection,
    kind: "collection",
    title: "Recovered",
    members: [],
  });
  assert.deepEqual(applyChanges(before, await recovered.changes(before.cursor)), after);
});

test("a returning client renders its cache before the delta arrives and reloads a replaced notebook", async (t) => {
  let disk = null,
    failRequest = false,
    release;
  const cache = {
    read: async () => structuredClone(disk),
    write: async (_, next) => {
      disk = structuredClone(next);
    },
  };
  const a = await openNotebook(await directory(t));
  const b = await openNotebook(await directory(t));
  t.after(() => {
    a.close();
    b.close();
  });
  let server = a;
  const paths = [];
  t.mock.method(globalThis, "fetch", async (path) => {
    paths.push(path);
    if (failRequest) throw new Error("Offline");
    if (path === "/api/workspace") return Response.json(await server.workspace());
    const after = new URL(path, "http://localhost").searchParams.get("after");
    if (release) await release.promise;
    try {
      return Response.json(await server.changes(after));
    } catch (error) {
      return Response.json({ error: error.message }, { status: error.status });
    }
  });
  await new NotebookClient(cache).load();
  assert.deepEqual(paths, ["/api/workspace"]);
  const old = structuredClone(disk);
  await server.command({ action: "create", kind: "collection", title: "Added while closed" });
  const warm = new NotebookClient(cache);
  release = Promise.withResolvers();
  const cached = Promise.withResolvers();
  warm.listen(() => {
    if (warm.state.workspace && !warm.state.verified) cached.resolve();
  });
  const loading = warm.load();
  await cached.promise;
  assert.deepEqual(warm.state.workspace, old);
  release.resolve();
  await loading;
  assert.equal(paths.length, 2);
  assert.ok(paths[1].startsWith("/api/changes?"));
  assert.deepEqual(disk, await server.workspace());
  failRequest = true;
  const offline = new NotebookClient(cache);
  await offline.load();
  assert.deepEqual(offline.state.workspace, disk);
  assert.equal(offline.state.verified, false);
  await assert.rejects(offline.action({ action: "create", kind: "document", title: "Offline" }), /Reconnect/);
  failRequest = false;
  server = b;
  await offline.load();
  assert.deepEqual(disk, await b.workspace());
  assert.equal(paths.at(-1), "/api/workspace");
});

test("cursorless workspaces render, save through the legacy API, and upgrade on a full refresh", async (t) => {
  const notebook = await openNotebook(await directory(t));
  t.after(() => notebook.close());
  const snapshot = await notebook.workspace();
  const { cursor, ...legacy } = snapshot;
  let disk = legacy;
  const cache = {
    read: async () => structuredClone(disk),
    write: async (_, next) => {
      disk = structuredClone(next);
    },
  };
  const client = new NotebookClient(cache);
  const paths = [];
  let upgraded = false;
  t.mock.method(globalThis, "fetch", async (path, init) => {
    paths.push(path);
    if (path === "/api/workspace") {
      const current = await notebook.workspace();
      if (!upgraded) delete current.cursor;
      return Response.json(current);
    }
    if (path === "/api/command") {
      assert.equal(init.headers["X-Folio-Notebook"], undefined);
      return Response.json({ id: await notebook.command(JSON.parse(init.body)) });
    }
    assert.ok(upgraded);
    const after = new URL(path, "http://localhost").searchParams.get("after");
    assert.equal(after, disk.cursor);
    return Response.json(await notebook.changes(after));
  });
  await client.load();
  assert.equal(client.state.verified, true);
  const id = legacy.home;
  const session = client.draft(client.state.workspace.nodes[id]);
  t.after(() => clearTimeout(client.timer));
  client.change(id, { title: "Edited during upgrade" }, session);
  await client.flush();
  assert.equal(client.state.workspace.nodes[id].title, "Edited during upgrade");
  assert.deepEqual(paths, ["/api/workspace", "/api/command", "/api/workspace"]);
  upgraded = true;
  await client.load();
  assert.equal(disk.cursor, (await notebook.workspace()).cursor);
  await client.load();
  assert.ok(paths.at(-1).startsWith("/api/changes?after="));
});

test("a warm feed cache falls back once when an older server returns a 404 for changes", async (t) => {
  const notebook = await openNotebook(await directory(t));
  t.after(() => notebook.close());
  const snapshot = await notebook.workspace();
  const { cursor, ...legacy } = snapshot;
  let disk = snapshot;
  const client = new NotebookClient({
    read: async () => disk,
    write: async (_, next) => {
      disk = next;
    },
  });
  const paths = [];
  t.mock.method(globalThis, "fetch", async (path) => {
    paths.push(path);
    if (path.startsWith("/api/changes?")) return new Response("Not found", { status: 404 });
    return Response.json(legacy);
  });
  await client.load();
  await client.load();
  assert.equal(client.state.verified, true);
  assert.deepEqual(disk, legacy);
  assert.deepEqual(paths, [
    "/api/changes?after=" + encodeURIComponent(cursor),
    "/api/workspace",
    "/api/workspace",
  ]);
});
