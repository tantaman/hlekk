import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan } from "../catalog/catalog.ts";
import { LocalCluster } from "../client/local.ts";
import { vshardOf } from "../host/ids.ts";
import { deterministic } from "../runtime/runtime.ts";
import { SPAN, chunkOf } from "./map.ts";

const LOCK = plan({
  app: {
    objects: { "app.note": { fields: { body: "string" } } },
    edges: { "app.note_note": { from: "app.note", to: "app.note" } },
  },
});
const CATALOG = Catalog.compile(LOCK);
const NOTE = CATALOG.objectNamed("app.note")!.otype;
const LINK = CATALOG.edgeNamed("app.note_note")!.atype!;

/** A cluster whose vshards are instantly full, so every create opens the next batch. */
async function growing(batch: number): Promise<LocalCluster> {
  const c = new LocalCluster({ batch, cap: 1, runtime: deterministic(3) });
  c.directory.applyLock(LOCK);
  c.spreadCatalog();
  await c.publish();
  return c;
}

/** Opens batches until a vshard lands in a later chunk. */
function growPastChunk(c: LocalCluster): bigint {
  for (let i = 0; i < 200; i++) {
    const opened = c.allocator.grow();
    const crossed = opened.find((v) => chunkOf(v) > 0);
    if (crossed) return crossed;
  }
  throw new Error("never crossed a chunk boundary");
}

describe("growing past one batch", () => {
  it("keeps numbering above the highest vshard in use, not the count", async () => {
    const c = await growing(8);
    assert.deepEqual(c.allocator.grow(), [8n, 9n, 10n, 11n, 12n, 13n, 14n, 15n]);
    // A reassignment leaves the count and the highest out of step; numbering must follow the highest.
    c.directory.assign(100n, 0, 0);
    assert.equal(c.allocator.grow()[0], 101n);
  });

  it("spreads a batch across hosts rather than piling it on the emptiest one", async () => {
    const c = await growing(8);
    for (const h of [1, 2, 3]) c.directory.addHost(h);
    const opened = c.allocator.grow();
    const hosts = new Set(opened.map((v) => c.directory.resolve(v)!.host));
    assert.ok(hosts.size >= 3, `a batch on ${hosts.size} host(s) would send every new root to one`);
  });

  it("opens a batch in time proportional to the batch, not to the database", async () => {
    // This was quadratic: the destination host was recomputed with a three-table join per vshard.
    const c = await growing(256);
    const first = (() => {
      const t = Date.now();
      c.allocator.grow();
      return Date.now() - t;
    })();
    for (let i = 0; i < 12; i++) c.allocator.grow(); // ~3,300 vshards in
    const later = (() => {
      const t = Date.now();
      c.allocator.grow();
      return Date.now() - t;
    })();
    assert.ok(later < Math.max(40, first * 8), `a batch took ${first} ms early and ${later} ms later`);
  });
});

describe("a map that spans chunks", () => {
  it("publishes one key per chunk, each answering only for its own span", async () => {
    const c = await growing(64);
    const beyond = growPastChunk(c);
    assert.equal(chunkOf(beyond), 1);
    await c.publish();

    assert.ok(c.directory.chunkIndexes().length >= 2, "more than one chunk exists");
    assert.ok(c.store.entries.size >= 2, "and each was published");

    const first = c.directory.chunk(0);
    const second = c.directory.chunk(1);
    const { Chunk } = await import("./map.ts");
    assert.equal(new Chunk(first).index, 0);
    assert.equal(new Chunk(second).index, 1);
    // A run's start is relative to its own chunk, so a chunk answers without the one before it.
    assert.ok(new Chunk(second).lookup(beyond), "the later chunk routes its own vshard");
    assert.equal(new Chunk(first).lookup(beyond), undefined, "and the earlier one does not claim it");
    assert.ok(new Chunk(first).lookup(0n), "while the earlier one still routes vshard 0");
  });

  it("stays small, because vshards on one host collapse into one run per chunk", async () => {
    const c = await growing(64);
    growPastChunk(c);
    const bytes = c.directory.chunkIndexes().reduce((n, i) => n + c.directory.chunk(i).byteLength, 0);
    assert.ok(c.directory.size() > SPAN, `expected more than ${SPAN} vshards, got ${c.directory.size()}`);
    assert.ok(bytes < 1_000, `${c.directory.size()} vshards should publish as a few runs, got ${bytes} bytes`);
  });

  it("reads a query whose data spans two chunks on two hosts", async () => {
    const c = await growing(64);
    const far = growPastChunk(c);
    const near = 5n;

    // Put the far vshard on its own host, so the query has to cross both a chunk and a host.
    c.directory.addHost(1);
    c.mover.begin(far, 1);
    await c.mover.run(far);
    c.spreadCatalog();
    await c.publish();

    const db = c.client();
    const here = await db.create(NOTE, { body: "here" }, { vshard: near.toString() });
    const there = await db.create(NOTE, { body: "there" }, { vshard: far.toString() });
    await db.assocAdd(LINK, here, there, 1);
    assert.notEqual(chunkOf(vshardOf(here)), chunkOf(vshardOf(there)), "the two sit in different chunks");
    assert.notEqual(c.directory.resolve(vshardOf(here))!.host, c.directory.resolve(vshardOf(there))!.host);

    const out = (await db.query(
      {
        frames: [
          { source: { kind: "ids" }, children: [{ alias: "links", frame: 1 }], counts: [] },
          { source: { kind: "edge", atype: LINK }, limit: 10, children: [], counts: [] },
        ],
      },
      [here],
    )) as { body: string; links: { body: string }[] }[];
    assert.deepEqual(out[0].links.map((l) => l.body), ["there"]);
  });

  it("holds only the chunks it routed to, not the whole map", async () => {
    const c = await growing(64);
    const far = growPastChunk(c);
    await c.publish();
    const db = c.client();

    const here = await db.create(NOTE, { body: "here" }, { vshard: "5" });
    await db.query({ frames: [{ source: { kind: "ids" }, children: [], counts: [] }] }, [here]);
    assert.equal(db.routes.held, 1, "one chunk, for the vshard it routed to");

    const there = await db.create(NOTE, { body: "there" }, { vshard: far.toString() });
    await db.query({ frames: [{ source: { kind: "ids" }, children: [], counts: [] }] }, [there]);
    assert.equal(db.routes.held, 2, "and a second once a vshard in another chunk was routed");
    assert.ok(c.directory.chunkIndexes().length >= 2);
  });
});
