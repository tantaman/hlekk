import { createHash, randomUUID } from "node:crypto";
import { open } from "../../../src/adapters/node/database.ts";
import { plan } from "../../../src/catalog/catalog.ts";
import { sampleDocs, seedBodies } from "./seed.mjs";

import { edgeLists, parseCursor } from "../workspace.js";

const type = "notebook.node";
const edge = () => ({ from: type, to: type });
const names = ["registry", "blocks", "links", "members", "history", "embeds"];
const parts = ["value", ...Object.values(edgeLists).flat()];
const marker = (part) => "changed_" + part;
const domain = (edgeNames) => ({
  notebook: {
    objects: { [type]: { fields: { kind: "string", value: "json" } } },
    edges: Object.fromEntries(edgeNames.map((name) => ["notebook." + name, edge()])),
  },
});
// Retain the original atypes in notebooks created before incremental sync.
const originalLock = plan(domain(names));
const lock = plan(domain([...names, ...parts.map(marker)]), originalLock);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
const titleOf = (value) =>
  (typeof value === "string" && value.trim().length <= 240 && value.trim()) ||
  fail("Give it a title of 1–240 characters.");
const validUrl = (href) => {
  try {
    return ["http:", "https:"].includes(new URL(href).protocol);
  } catch {
    return false;
  }
};
const isId = (value) => typeof value === "string" && /^\d+$/.test(value);
const blockTypes = ["paragraph", "heading", "subheading", "bullet", "quote", "embed"];

function validateBlocks(blocks) {
  if (!Array.isArray(blocks)) fail("Expected a list of document blocks.");
  const seen = new Set();
  for (const b of blocks) {
    if (
      !b ||
      !blockTypes.includes(b.type) ||
      typeof b.key !== "string" ||
      !/^[\w-]{1,80}$/.test(b.key) ||
      seen.has(b.key.toLowerCase())
    )
      fail("Invalid or repeated block key.");
    seen.add(b.key.toLowerCase());
    if (b.type === "embed" && !isId(b.target)) fail("Choose a block to embed.");
    if (!Array.isArray(b.content) || (b.type === "embed" && b.content.length)) fail("Invalid block content.");
    for (const span of b.content) {
      if (span?.type === "wiki") {
        titleOf(span.attrs?.label);
        if (span.attrs.target && !isId(span.attrs.target)) fail("Invalid wikilink target.");
      } else if (span?.type === "text" && typeof span.text === "string" && span.text.length) {
        if (
          !Array.isArray(span.marks ?? []) ||
          (span.marks ?? []).some(
            (mark) =>
              !["strong", "em", "code", "link"].includes(mark?.type) ||
              (mark.type === "link" && !validUrl(mark.attrs?.href)),
          )
        )
          fail("Unsupported text formatting.");
      } else fail("Invalid text in block.");
    }
  }
}
const frame = (source, children = []) => ({ source, children, counts: [], limit: Number.MAX_SAFE_INTEGER });

export async function openNotebook(dir) {
  const store = await open({ dir, lock: originalLock, identity: false });
  const { db, cluster } = store;
  if (store.catalog.version < lock.version) {
    cluster.directory.applyLock(lock);
    cluster.spreadCatalog();
  }
  const catalog = cluster.directory.catalog();
  if (!cluster.directory.indexVshards().length) {
    cluster.openIndexVshards(1);
    await cluster.publish();
  }
  const otype = catalog.objectNamed(type).otype;
  const atype = (name) => catalog.edgeNamed("notebook." + name).atype;
  async function unique(key, kind, value) {
    return (await db.lookupUnique(1, key)) ?? (await db.createUnique(1, key, otype, { kind, value }));
  }
  const root = await unique("workspace", "workspace", { ready: false, pending: null });
  async function read(ids, hops = []) {
    return db.query(
      {
        frames: [
          frame(
            { kind: "ids" },
            hops.map((alias, i) => ({ alias, frame: i + 1 })),
          ),
          ...hops.map((name) => frame({ kind: "edge", atype: atype(name) })),
        ],
      },
      ids,
    );
  }
  async function one(id, hops) {
    if (!isId(id)) fail("Unknown node.", 404);
    return (await read([id], hops))[0] ?? fail("Unknown node.", 404);
  }
  async function entries(id, name) {
    return (await one(id, [name]))[name];
  }
  const rootValue = async () => (await one(root)).value;

  const prior = await rootValue();
  if (!prior.feedId) {
    await db.update(root, { kind: "workspace", value: { ...prior, feedId: randomUUID(), sequence: 0 } });
  }
  const cursorOf = (value) => value.feedId + ":" + value.sequence;

  // A marker holds the latest sequence for one node value or one outgoing list.
  // Moving the same marker forward coalesces edits without retaining old draft text.
  async function markChanges(ops, sequence) {
    const touched = new Map();
    for (const op of ops) {
      let part, id;
      if (op.kind === "update" || op.name === "registry") {
        part = "value";
        id = op.id ?? op.to;
      } else if (parts.includes(op.name)) {
        part = op.name;
        id = op.from;
      } else continue; // Named revisions have a separate, on-demand history endpoint.
      const atypeId = atype(marker(part));
      touched.set(part + ":" + id, { atype: atypeId, id1: root, id2: id, time: -sequence });
    }
    await db.assocAddMany([...touched.values()]);
  }

  // Graph operations can span Hlekk mutations. Replaying the prepared after-images
  // repairs interrupted saves before serving a subsequent read or comparing versions.
  async function apply(ops) {
    for (const op of ops) {
      if (op.kind === "update") await db.update(op.id, { kind: op.nodeKind, value: op.value });
      else if (op.kind === "remove") await db.assocRemove(atype(op.name), op.from, op.to);
      else await db.assocAdd(atype(op.name), op.from, op.to, op.order ?? 0);
    }
  }
  async function recover() {
    const value = await rootValue();
    if (value.pending) {
      await apply(value.pending);
      const sequence = value.sequence + 1;
      await markChanges(value.pending, sequence);
      await db.update(root, { kind: "workspace", value: { ...value, sequence, pending: null } });
    }
  }
  async function transact(ops) {
    if (!ops.length) return;
    const value = await rootValue();
    await db.update(root, { kind: "workspace", value: { ...value, pending: ops } });
    await recover();
  }
  const add = (name, from, to, order = 0) => ({ kind: "add", name, from, to, order });
  const remove = (name, from, to) => ({ kind: "remove", name, from, to });
  const register = (id) => add("registry", root, id);
  const update = (id, nodeKind, value) => ({ kind: "update", id, nodeKind, value });
  async function replace(ops, name, from, ids) {
    const previous = await entries(from, name);
    const wanted = new Set(ids);
    for (const row of previous) if (!wanted.has(row.id)) ops.push(remove(name, from, row.id));
    const positions = new Map(previous.map((row) => [row.id, row.$edge.time]));
    ids.forEach((id, i) => {
      // Hlekk reads newest first. Negative positions keep editor order independent of the clock.
      if (positions.get(id) !== -i) ops.push(add(name, from, id, -i));
    });
  }
  const docValue = (title, cover = false) => ({ title, cover, version: 0, edited: Date.now() });
  async function newDocument(ops, title) {
    const id = await db.create(otype, { kind: "document", value: docValue(title) });
    const key = "initial";
    const first = await unique("block:" + id + ":" + key, "block", { key, type: "paragraph", content: [] });
    ops.push(register(id), register(first), add("blocks", id, first));
    return id;
  }
  async function save(doc, title, blocks, version) {
    if (doc.kind !== "document") fail("Choose a document.");
    if (version !== doc.value.version)
      fail("This document changed in another tab. Copy your edits before reloading.", 409);
    title = titleOf(title);
    validateBlocks(blocks);
    const registered = await entries(root, "registry");
    const registeredIds = new Set(registered.map((n) => n.id));
    const docs = registered.filter((n) => n.kind === "document");
    const docIds = new Set(docs.map((d) => d.id));
    const byTitle = new Map(docs.map((d) => [d.value.title.toLowerCase(), d.id]));
    if (byTitle.has(title.toLowerCase()) && byTitle.get(title.toLowerCase()) !== doc.id)
      fail("A document already has that title.", 409);
    byTitle.set(title.toLowerCase(), doc.id);
    const ops = [],
      ids = [];
    for (const b of blocks) {
      const id = await unique("block:" + doc.id + ":" + b.key, "block", {});
      ids.push(id);
      const previous = await one(id);
      const knownLinks = previous.value.content?.filter((s) => s.type === "wiki") ?? [];
      const targets = new Set();
      const content = [];
      for (const span of b.content) {
        if (span.type === "wiki") {
          const label = span.attrs.label.trim();
          const known = knownLinks.find((s) => s.attrs.label === label)?.attrs.target;
          let target = span.attrs.target || known || byTitle.get(label.toLowerCase());
          if (target && !docIds.has(target)) fail("Unknown linked document.");
          if (!target) {
            target = await newDocument(ops, label);
            docIds.add(target);
            byTitle.set(label.toLowerCase(), target);
          }
          targets.add(target);
          content.push({ type: "wiki", attrs: { label, target } });
        } else {
          for (const mark of span.marks ?? []) {
            if (mark.type !== "link") continue;
            const href = new URL(mark.attrs.href).href;
            const target = await unique("url:" + createHash("sha256").update(href).digest("hex"), "url", {
              href,
              title: href,
            });
            targets.add(target);
            if (!registeredIds.has(target)) {
              ops.push(register(target));
              registeredIds.add(target);
            }
          }
          content.push(span);
        }
      }
      const value = { key: b.key, type: b.type, content };
      if (b.type === "embed") {
        const source = await one(b.target);
        if (source.kind !== "block" || source.value.type === "embed" || source.id === id)
          fail("Choose a text block to embed.");
        value.target = b.target;
      }
      if (!same(previous.value, value)) ops.push(update(id, "block", value));
      if (!registeredIds.has(id)) ops.push(register(id));
      await replace(ops, "links", id, [...targets]);
      await replace(ops, "embeds", id, value.target ? [value.target] : []);
    }
    await replace(ops, "blocks", doc.id, ids);
    ops.push(update(doc.id, "document", { ...doc.value, title, edited: Date.now(), version: version + 1 }));
    await transact(ops);
    return doc.id;
  }

  async function initialize() {
    await recover();
    if ((await rootValue()).ready) return;
    const collections = new Map(),
      docs = new Map(),
      ops = [];
    for (const [key, title, group] of sampleDocs) {
      if (!collections.has(group)) {
        const id = await unique("collection:" + group, "collection", { title: group });
        collections.set(group, id);
        ops.push(register(id));
      }
      const id = await unique("sample:" + key, "document", docValue(title, key === "noticing"));
      docs.set(key, id);
      ops.push(register(id), add("members", collections.get(group), id));
    }
    await transact(ops);
    for (const [key, id] of docs) {
      const doc = await one(id);
      if (doc.value.version) continue;
      const blocks = seedBodies[key].map(([type, ...content], i) => ({ key: "seed-" + i, type, content }));
      await save(doc, doc.value.title, blocks, 0);
    }
    await db.update(root, {
      kind: "workspace",
      value: { ...(await rootValue()), ready: true, home: docs.get("noticing") },
    });
  }
  await initialize();

  async function workspace() {
    const registry = await entries(root, "registry");
    const grouped = (kind) => registry.filter((r) => r.kind === kind).map((r) => r.id);
    const nodes = {};
    for (const [kind, hops] of Object.entries(edgeLists)) {
      for (const row of await read(grouped(kind), hops)) {
        nodes[row.id] = { id: row.id, kind, ...row.value };
        for (const name of hops) nodes[row.id][name] = row[name].map((r) => r.id);
      }
    }
    const value = await rootValue();
    return { home: value.home, cursor: cursorOf(value), nodes };
  }
  async function changes(after) {
    const cursor = parseCursor(after);
    if (!cursor) fail("Invalid sync cursor.");
    const { feedId, sequence: since } = cursor;
    const value = await rootValue();
    if (feedId !== value.feedId || since > value.sequence) fail("Fetch a new workspace snapshot.", 409);
    const patches = {};
    if (since !== value.sequence) {
      const frames = [frame({ kind: "ids" })];
      for (const part of parts) {
        frames[0].children.push({ alias: part, frame: frames.length });
        const changed = frame({ kind: "edge", atype: atype(marker(part)) });
        // The Hlekk index sorts (time, db, id2) descending. All local IDs are
        // positive, so this seeks past every marker at 'since' in one step.
        changed.after = { time: -since, db: 0, id2: "0" };
        frames.push(changed);
        if (part !== "value") {
          changed.children.push({ alias: "targets", frame: frames.length });
          frames.push(frame({ kind: "edge", atype: atype(part) }));
        }
      }
      const [rows] = await db.query({ frames }, [root]);
      for (const row of rows.value) {
        patches[row.id] = { value: { id: row.id, kind: row.kind, ...row.value } };
      }
      for (const part of parts.slice(1)) {
        for (const row of rows[part]) {
          (patches[row.id] ??= {})[part] = row.targets.map((target) => target.id);
        }
      }
    }
    return { cursor: cursorOf(value), patches };
  }
  async function command(c) {
    if (!c || typeof c !== "object") fail("Invalid notebook action.");
    if (c.action === "create") {
      const title = titleOf(c.title);
      if (!["document", "collection"].includes(c.kind)) fail("Unknown node type.");
      if (
        (await entries(root, "registry")).some(
          (n) => n.kind === c.kind && n.value.title.toLowerCase() === title.toLowerCase(),
        )
      )
        fail("That title is already in use.", 409);
      if (c.collection && (await one(c.collection)).kind !== "collection") fail("Unknown collection.");
      const ops = [];
      let id;
      if (c.kind === "document") id = await newDocument(ops, title);
      else {
        id = await db.create(otype, { kind: "collection", value: { title } });
        ops.push(register(id));
      }
      if (c.collection) ops.push(add("members", c.collection, id));
      await transact(ops);
      return id;
    }
    if (c.action === "member") {
      if ((await one(c.collection)).kind !== "collection") fail("Choose a collection.");
      const member = await one(c.id);
      if (!["document", "collection", "block", "url"].includes(member.kind) || c.id === c.collection)
        fail("Choose another node.");
      await transact([c.remove ? remove("members", c.collection, c.id) : add("members", c.collection, c.id)]);
      return c.collection;
    }
    const doc = await one(c.id);
    if (doc.kind !== "document") fail("Choose a document.");
    if (c.action === "save") return save(doc, c.title, c.blocks, c.version);
    if (doc.value.version !== c.version)
      fail("This document changed in another tab. Reload to see the latest draft.", 409);
    if (c.action === "commit") {
      const label = titleOf(c.label);
      const blocks = (await entries(doc.id, "blocks")).map((row) => row.value);
      const revision = await db.create(
        otype,
        { kind: "revision", value: { label, date: Date.now(), title: doc.value.title, blocks } },
        { with: doc.id },
      );
      await transact([add("history", doc.id, revision, Date.now())]);
      return revision;
    }
    if (c.action === "restore") {
      const revision = (await entries(doc.id, "history")).find((n) => n.id === c.revision);
      if (!revision) fail("Revision not found.", 404);
      const { title, blocks } = revision.value;
      return save(doc, title, blocks, c.version);
    }
    fail("Unknown notebook action.");
  }
  // One Node adapter process owns the directory. Serialize its callers, including reads.
  let tail = Promise.resolve();
  function run(fn) {
    const result = tail.then(recover).then(fn);
    tail = result.catch(() => {});
    return result;
  }
  return {
    workspace: () => run(workspace),
    changes: (after) => run(() => changes(after)),
    command: (c, feedId) =>
      run(async () => {
        if (feedId && feedId !== (await rootValue()).feedId)
          fail("The notebook changed. Reopen it before editing.", 409);
        return command(c);
      }),
    history: (id) =>
      run(async () =>
        (await entries(id, "history")).map(({ id, value }) => ({
          id,
          label: value.label,
          date: value.date,
          count: value.blocks.length,
        })),
      ),
    close: () => store.close(),
  };
}
