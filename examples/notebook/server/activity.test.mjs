import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyChanges } from "../workspace.js";
import { openNotebook } from "./store.mjs";

test("capture posts one regular document, retries safely, and opens into the normal edit and revision flow", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "folio-thought-"));
  let n = await openNotebook(dir);
  t.after(async () => {
    n.close();
    await rm(dir, { recursive: true });
  });
  const first = await n.workspace();
  const blocks = [
    { key: "start", type: "heading", content: [{ type: "text", text: "Look closer" }] },
    {
      key: "body",
      type: "paragraph",
      content: [
        { type: "text", text: "Connect ", marks: [{ type: "em" }] },
        { type: "wiki", attrs: { label: first.nodes[first.home].title } },
      ],
    },
  ];
  const post = { action: "capture", key: randomUUID(), blocks };
  const id = await n.command(post);
  assert.equal(await n.command(post), id);
  const after = await n.workspace();
  assert.deepEqual(applyChanges(first, await n.changes(first.cursor)), after);
  assert.equal(after.nodes[id].kind, "document");
  assert.equal(after.nodes[id].title, "Look closer");
  assert.ok(after.nodes[id].capturedAt);
  const [heading, body] = after.nodes[id].blocks;
  assert.equal(after.nodes[heading].type, "heading");
  assert.deepEqual(after.nodes[body].content[0].marks, [{ type: "em" }]);
  assert.deepEqual(after.nodes[body].links, [first.home]);
  assert.deepEqual(await n.history(id), []);
  const duplicate = await n.command({ ...post, key: randomUUID() });
  assert.equal((await n.workspace()).nodes[duplicate].title, "Look closer (2)");
  await assert.rejects(n.command({ ...post, key: randomUUID(), blocks: [] }), { status: 400 });

  const save = (version) => n.command({ action: "save", id, title: "Developed thought", version, blocks });
  await save(1);
  await save(2);
  const revision = await n.command({ action: "commit", id, version: 3, label: "First pass" });
  await n.command({ action: "restore", id, version: 3, revision });
  const collection = await n.command({ action: "create", kind: "collection", title: "Posts" });
  await n.command({ action: "member", collection, id });
  await n.command({ action: "member", collection, id });
  await n.command({ action: "member", collection, id, remove: true });
  n.close();
  n = await openNotebook(dir);
  const { nodes } = await n.workspace();
  assert.deepEqual(nodes[id].blocks, [heading, body]);
  assert.equal(nodes[id].capturedAt, after.nodes[id].capturedAt);
  const { items } = await n.activity();
  assert.deepEqual(
    items.filter((e) => e.target === id).map((e) => e.verb),
    ["restored", "committed", "edited", "captured"],
  );
  assert.deepEqual(
    items.filter((e) => e.target === collection).map((e) => e.verb),
    ["removedMember", "addedMember", "createdCollection"],
  );
  assert.ok(items.every((e) => !nodes[e.id]));
});

test("activity pages continue across equal timestamps", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "folio-pages-"));
  const n = await openNotebook(dir);
  t.after(async () => {
    n.close();
    await rm(dir, { recursive: true });
  });
  t.mock.method(Date, "now", () => 2000000000000);
  for (let i = 0; i < 42; i++)
    await n.command({ action: "create", kind: "collection", title: "Collection " + i });
  const page = await n.activity();
  assert.equal(page.items.length, 40);
  const more = await n.activity(page.next);
  assert.equal(more.next, null);
  const all = [...page.items, ...more.items].filter((e) => e.verb === "createdCollection");
  assert.equal(new Set(all.map((e) => e.id)).size, 42);
  assert.equal(all.length, 42);
  await assert.rejects(n.activity("invalid"), { status: 400 });
});
