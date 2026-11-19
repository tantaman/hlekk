import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openNotebook } from "./store.mjs";
import { NotebookClient } from "../src/client.js";

const text = (text) => ({ type: "text", text });
const block = (key, ...content) => ({ key, type: "paragraph", content });

test("draft edits, ordered edges, explicit history, shared blocks, and durable restore", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "notebook-test-"));
  let n = await openNotebook(dir);
  t.after(async () => {
    n.close();
    await rm(dir, { recursive: true });
  });
  const create = (kind, title) => n.command({ action: "create", kind, title });
  const id = await create("document", "A draft"),
    collection = await create("collection", "Saved thoughts");
  const original = [
    block("a", text("First")),
    block(
      "b",
      { type: "wiki", attrs: { label: "Another thought" } },
      {
        type: "text",
        text: "Reference",
        marks: [{ type: "link", attrs: { href: "https://example.com/a" } }],
      },
    ),
  ];
  const save = (version, blocks, title = "A draft") =>
    n.command({ action: "save", id, version, blocks, title });
  await save(0, original);
  let { nodes } = await n.workspace();
  const [first, second] = nodes[id].blocks;
  const targets = nodes[second].links;
  assert.deepEqual(
    targets.map((i) => nodes[i].kind),
    ["document", "url"],
  );
  assert.equal(nodes[targets[0]].title, "Another thought");
  assert.deepEqual(await n.history(id), []);
  const revision = await n.command({ action: "commit", id, version: 1, label: "First pass" });
  await n.command({ action: "member", collection, id: first });
  const other = await create("document", "Shared view");
  await n.command({
    action: "save",
    id: other,
    title: "Shared view",
    version: 0,
    blocks: [{ key: "embed", type: "embed", target: first, content: [] }],
  });
  await save(1, [block("b", text("Changed")), block("a", text("Edited"))], "Renamed");
  ({ nodes } = await n.workspace());
  assert.deepEqual(nodes[id].blocks, [second, first]);
  assert.deepEqual(nodes[second].links, []);
  assert.equal(nodes[nodes[nodes[other].blocks[0]].embeds[0]].content[0].text, "Edited");
  assert.deepEqual(nodes[collection].members, [first]);
  await assert.rejects(save(1, original), { status: 409 });
  await save(2, [block("b", text("Only one"))]);
  assert.equal((await n.history(id)).length, 1);
  await n.command({ action: "restore", id, version: 3, revision });
  n.close();
  n = await openNotebook(dir);
  ({ nodes } = await n.workspace());
  assert.deepEqual(nodes[id].blocks, [first, second]);
  assert.equal(nodes[id].title, "A draft");
  assert.equal(nodes[first].content[0].text, "First");
  assert.deepEqual(nodes[second].links, targets);
  assert.deepEqual(nodes[collection].members, [first]);
  assert.equal((await n.history(id)).length, 1);
  await assert.rejects(n.command({ action: "restore", id: other, version: 1, revision }), { status: 404 });
});

test("concurrent tabs preserve the winning draft and reject stale writes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "notebook-tabs-"));
  const n = await openNotebook(dir);
  t.after(async () => {
    n.close();
    await rm(dir, { recursive: true });
  });
  const id = await n.command({ action: "create", kind: "document", title: "Notes" });
  const writes = await Promise.allSettled(
    ["First", "Second"].map((value) =>
      n.command({ action: "save", id, version: 0, title: "Notes", blocks: [block("a", text(value))] }),
    ),
  );
  assert.deepEqual(
    writes.map((w) => w.status),
    ["fulfilled", "rejected"],
  );
  const { nodes } = await n.workspace();
  assert.equal(nodes[nodes[id].blocks[0]].content[0].text, "First");
  assert.equal(nodes[id].version, 1);
});

test("a mounted editor keeps both title and block edits across separate autosaves", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "notebook-autosave-"));
  const n = await openNotebook(dir);
  const client = new NotebookClient();
  t.after(async () => {
    clearTimeout(client.timer);
    n.close();
    await rm(dir, { recursive: true });
  });
  t.mock.method(globalThis, "fetch", async (path, init) => {
    const data =
      path === "/api/workspace"
        ? await n.workspace()
        : path.startsWith("/api/changes?")
          ? await n.changes(new URL(path, "http://localhost").searchParams.get("after"))
          : { id: await n.command(JSON.parse(init.body)) };
    return Response.json(data);
  });
  await client.load();
  const id = client.state.workspace.home;
  const session = client.draft(client.state.workspace.nodes[id]);
  client.change(id, { blocks: [block("a", text("Body one"))] }, session);
  await client.flush();
  client.change(id, { title: "New title" }, session);
  await client.flush();
  client.change(id, { blocks: [block("a", text("Body two"))] }, session);
  await client.action({ action: "commit", id, label: "Keep this" });
  const { nodes } = await n.workspace();
  assert.equal(nodes[id].title, "New title");
  assert.equal(nodes[nodes[id].blocks[0]].content[0].text, "Body two");
  assert.equal((await n.history(id)).length, 1);
});
