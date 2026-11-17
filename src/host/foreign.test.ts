import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, CatalogError, plan as planLock } from "../catalog/catalog.ts";
import { LocalCluster } from "../client/local.ts";
import { assertSound } from "../testkit/invariants.ts";
import { ForeignEdge, targetOf } from "../query/types.ts";
import { decodeCursor } from "../schema/query.ts";
import { FormatError } from "./schema.ts";
import { Host } from "./host.ts";
import { nodeSql } from "./sql.node.ts";

// An edge into another database, stored. Nothing here follows one — step 4 does — so what these
// tests are about is that the reference can be written, paged, counted and removed as an edge, and
// that every way of writing one that cannot be read back is refused instead.

const OTHER = "https://other.example/db";
const THIRD = "https://third.example/db";
const MINE = "https://mine.example/db";

const LOCK = planLock({
  notes: {
    objects: {
      "notes.note": { fields: { body: "string", aboutId: { optional: { id: "notes.note" } } } },
    },
    edges: {
      // Permits a foreign target, so it may name an object in another database. It therefore cannot
      // have an inverse or cascade, both of which would be a remote write.
      "notes.note_about": { from: "notes.note", to: "notes.note", foreign: true },
      // Local only, for the refusals.
      "notes.note_next": { from: "notes.note", to: "notes.note" },
      // A field relationship that follows a payload id, and permits a foreign one.
      "notes.note_about_field": { from: "notes.note", to: "notes.note", field: "aboutId", foreign: true },
    },
  },
});
const CATALOG = Catalog.compile(LOCK);
const NOTE = CATALOG.objectNamed("notes.note")!.otype;
const ABOUT = CATALOG.edgeNamed("notes.note_about")!.atype!;
const NEXT = CATALOG.edgeNamed("notes.note_next")!.atype!;

async function database(format: 1 | 2 = 2) {
  const c = new LocalCluster({ uri: MINE, format });
  c.directory.applyLock(LOCK);
  c.spreadCatalog();
  await c.publish();
  const db = c.client();
  const note = await db.create(NOTE, { body: "about a page" }, { vshard: "7" });
  return { c, db, note };
}

describe("an edge into another database", () => {
  it("is written, counted, paged and removed as an edge", async () => {
    const { c, db, note } = await database();

    await db.assocAdd(ABOUT, note, `${OTHER}#5`, 10);
    await db.assocAdd(ABOUT, note, `${THIRD}#9`, 20);
    const local = await db.create(NOTE, { body: "local" }, { with: note });
    await db.assocAdd(ABOUT, note, local, 30);

    // The maintained count counts a foreign edge like any other: it is an outbound edge of a local
    // object, and that is as true of a foreign target as a local one.
    const host = c.host(c.holderOf(7n)!);
    assert.equal(await host.store().count(note, ABOUT), 3);

    // Newest first, and each row carries the alias it was interned under rather than the URI: a host
    // stores the number and never resolves one.
    const page = await host.store().edges(note, ABOUT, null, 10);
    assert.ok(typeof page === "object");
    assert.deepEqual(page.rows.map((e) => [e.time, e.db, e.id2]), [
      [30, 0, local],
      [20, 2, "9"],
      [10, 1, "5"],
    ]);
    assert.deepEqual(c.directory.aliases().map((a) => [a.alias, a.uri]), [[1, OTHER], [2, THIRD]]);

    await db.assocRemove(ABOUT, note, `${OTHER}#5`);
    assert.equal(await host.store().count(note, ABOUT), 2);
    const after = await host.store().edges(note, ABOUT, null, 10);
    assert.ok(typeof after === "object");
    assert.deepEqual(after.rows.map((e) => [e.db, e.id2]), [[0, local], [2, "9"]]);

    assertSound(c, { quiesced: true });
  });

  it("holds the same local id in two databases as two edges", async () => {
    const { c, db, note } = await database();
    // The collision format 1 cannot represent: on `(id1, atype, id2)` these are one row, and the
    // second write would have dropped the first with no error and no change to its count.
    await db.assocAdd(ABOUT, note, `${OTHER}#5`, 10);
    await db.assocAdd(ABOUT, note, `${THIRD}#5`, 11);
    await db.assocAdd(ABOUT, note, "5", 12); // and a local 5, which exists as an id whether or not an object does

    const host = c.host(c.holderOf(7n)!);
    assert.equal(await host.store().count(note, ABOUT), 3);
    const page = await host.store().edges(note, ABOUT, null, 10);
    assert.ok(typeof page === "object");
    assert.deepEqual(page.rows.map((e) => e.db).sort(), [0, 1, 2]);
    assert.deepEqual(new Set(page.rows.map((e) => e.id2)), new Set(["5"]));
    assertSound(c, { quiesced: true });
  });

  // The failure `cmpId`'s comment warns about, one level up: the SQL, `edgeOrder` and the cursor
  // codec have to agree on the tie-break or a cursor lands in the wrong place. At one time the order
  // is by alias descending, so foreign comes before local.
  it("pages through a tie between a local and a foreign edge, from either side of it", async () => {
    const { c, db, note } = await database();
    const local = await db.create(NOTE, { body: "local" }, { with: note });
    // All at one time, so only the tie-break orders them.
    await db.assocAdd(ABOUT, note, local, 5);
    await db.assocAdd(ABOUT, note, `${OTHER}#5`, 5);
    await db.assocAdd(ABOUT, note, `${THIRD}#5`, 5);

    const host = c.host(c.holderOf(7n)!);
    const all = await host.store().edges(note, ABOUT, null, 10);
    assert.ok(typeof all === "object");
    const order = all.rows.map((e) => `${e.db}:${e.id2}`);
    assert.deepEqual(order, [`2:5`, `1:5`, `0:${local}`], "foreign before local, by alias descending");

    // Now read it a row at a time, continuing from each row's own cursor. Every row has to come back
    // exactly once and in the same order, which is what says the SQL and the comparator agree.
    const walked: string[] = [];
    let after = null as null | { time: number; db: number; id2: string };
    for (let i = 0; i < 5; i++) {
      const page = await host.store().edges(note, ABOUT, after, 1);
      assert.ok(typeof page === "object");
      if (page.rows.length === 0) break;
      const row = page.rows[0]!;
      walked.push(`${row.db}:${row.id2}`);
      after = { time: row.time, db: row.db, id2: row.id2 };
    }
    assert.deepEqual(walked, order);

    // And the cursor the engine hands a caller round-trips through the codec with its alias.
    const { time, db: alias, id2 } = decodeCursor(`v2:5:1:5`);
    assert.deepEqual({ time, alias, id2 }, { time: 5, alias: 1, id2: "5" });
  });

  it("keeps a reference to this database as a local edge", async () => {
    const { c, db, note } = await database();
    const local = await db.create(NOTE, { body: "local" }, { with: note });
    // Written as a qualified reference to our own URI. Letting it through as an alias would make one
    // object reachable under two keys, and the registry refuses to intern this database anyway.
    await db.assocAdd(ABOUT, note, `${MINE}#${local}`, 7);
    const host = c.host(c.holderOf(7n)!);
    const page = await host.store().edges(note, ABOUT, null, 10);
    assert.ok(typeof page === "object");
    assert.deepEqual(page.rows.map((e) => [e.db, e.id2]), [[0, local]]);
    assert.deepEqual(c.directory.aliases(), []);
  });

  it("is a reference the read path will not guess at", async () => {
    const { c, db, note } = await database();
    await db.assocAdd(ABOUT, note, `${OTHER}#5`, 10);
    // Dropping it would read as a dangling reference, and loading it by its low half would return
    // whichever local object shares those bits. So a read that reaches one asks the database that
    // holds it — and with no client for that database, says exactly that rather than answering.
    const plan = {
      frames: [
        { source: { kind: "ids" as const }, children: [{ alias: "about", frame: 1 }], counts: [] },
        { source: { kind: "edge" as const, atype: ABOUT }, children: [], counts: [] },
      ],
    };
    await assert.rejects(db.query(plan, [note]), /no foreign client was configured/);
    // A count over the same list is unaffected: it is one maintained row and needs no target.
    const host = c.host(c.holderOf(7n)!);
    assert.equal(await host.store().count(note, ABOUT), 1);
  });

  it("fails loudly if the seam that resolves the alias is skipped", () => {
    // The hazard `targetOf` exists for: a foreign row whose URI was never filled in must not be
    // read as a local id, because one may well exist under that number.
    assert.throws(() => targetOf({ id1: "1", atype: 1, db: 3, id2: "5", time: 0, data: null }), ForeignEdge);
    assert.equal(targetOf({ id1: "1", atype: 1, db: 0, id2: "5", time: 0, data: null }), "5");
    assert.equal(
      targetOf({ id1: "1", atype: 1, db: 3, id2: "5", target: `${OTHER}#5`, time: 0, data: null }),
      `${OTHER}#5`,
    );
  });
});

describe("the ways of writing one that are refused", () => {
  it("refuses an edge type that does not permit a foreign target", async () => {
    const { db, note } = await database();
    await assert.rejects(db.assocAdd(NEXT, note, `${OTHER}#5`), /does not permit a foreign target/);
    await assert.rejects(db.assocRemove(NEXT, note, `${OTHER}#5`), /does not permit a foreign target/);
    await assert.rejects(
      db.assocAddMany([{ atype: NEXT, id1: note, id2: `${OTHER}#5` }]),
      /does not permit a foreign target/,
    );
  });

  it("refuses a batch holding one, before any of it is written", async () => {
    const { c, db, note } = await database();
    const local = await db.create(NOTE, { body: "local" }, { with: note });
    await assert.rejects(
      db.assocAddMany([
        { atype: ABOUT, id1: note, id2: local, time: 1 },
        { atype: NEXT, id1: note, id2: `${OTHER}#5`, time: 2 },
      ]),
      /does not permit a foreign target/,
    );
    const host = c.host(c.holderOf(7n)!);
    assert.equal(await host.store().count(note, ABOUT), 0, "the permitted edge was not written either");
  });

  it("refuses a reference that is not canonical, naming the spelling to send", async () => {
    const { db, note } = await database();
    await assert.rejects(db.assocAdd(ABOUT, note, "https://OTHER.example/db#5"), /canonical form is/);
    await assert.rejects(db.assocAdd(ABOUT, note, "https://other.example/db/#5"), /canonical form is/);
    await assert.rejects(db.assocAdd(ABOUT, note, `${OTHER}#notanid`), /not an id/);
  });

  it("refuses an alias on a format 1 host, which has nowhere to put it", async () => {
    const host = Host.open(nodeSql(), CATALOG);
    assert.equal(host.format(), 1);
    host.adopt("7", 0);
    const from = host.create({ otype: NOTE, data: { body: "x" }, vshard: "7", epoch: 0 });
    assert.ok(from.ok);
    // A throw and not a `Reply`: the refusals in that union are ones a caller can act on by
    // re-routing or re-reading, and neither of these is. A client that sent this is wrong wherever
    // it sends it.
    assert.throws(
      () => host.assocAdd({ atype: ABOUT, id1: from.value, db: 3, id2: "5", epoch: 0 }),
      /needs storage format 2/,
    );
  });

  it("refuses an alias under a non-foreign edge type at the host too, not only at the client", async () => {
    const host = Host.open(nodeSql(), CATALOG, undefined, 2);
    host.adopt("7", 0);
    const from = host.create({ otype: NOTE, data: { body: "x" }, vshard: "7", epoch: 0 });
    assert.ok(from.ok);
    // The client checks this, and so does the host: a stale client is the case the host's own check
    // is for, and the row it would write is one no read can route.
    assert.throws(
      () => host.assocAdd({ atype: NEXT, id1: from.value, db: 1, id2: "5", epoch: 0 }),
      /does not permit a foreign target/,
    );
  });

  it("refuses a foreign edge type with an inverse or a cascade, when the lock is planned", () => {
    assert.throws(
      () =>
        planLock({
          a: {
            objects: { "a.thing": { fields: {} } },
            edges: {
              "a.out": { from: "a.thing", to: "a.thing", foreign: true, inverse: "a.back" },
              "a.back": { from: "a.thing", to: "a.thing", inverse: "a.out", maintained: true },
            },
          },
        }),
      /names an inverse/,
    );
    assert.throws(
      () =>
        planLock({
          a: {
            objects: { "a.thing": { fields: {} } },
            edges: { "a.out": { from: "a.thing", to: "a.thing", foreign: true, onDelete: "cascade" } },
          },
        }),
      CatalogError,
    );
  });

  it("refuses a qualified payload id under a field relationship that does not permit one", async () => {
    const LOCAL_FIELD = planLock({
      notes: {
        objects: { "notes.note": { fields: { body: "string", aboutId: { optional: { id: "notes.note" } } } } },
        edges: { "notes.note_about_field": { from: "notes.note", to: "notes.note", field: "aboutId" } },
      },
    });
    const c = new LocalCluster({ uri: MINE });
    c.directory.applyLock(LOCAL_FIELD);
    c.spreadCatalog();
    await c.publish();
    const db = c.client();
    const otype = Catalog.compile(LOCAL_FIELD).objectNamed("notes.note")!.otype;

    // Field relationships hold ids inside the payload, which is the other place a qualified
    // reference is accepted — but only where something that follows the field permits one.
    await assert.rejects(
      db.create(otype, { body: "x", aboutId: `${OTHER}#5` }, { vshard: "7" }),
      /without permitting a foreign target/,
    );
    const id = await db.create(otype, { body: "x" }, { vshard: "7" });
    await assert.rejects(db.update(id, { body: "x", aboutId: `${OTHER}#5` }), /without permitting a foreign target/);

    // And a value that is not a reference at all is refused on the way in, rather than found later
    // by whatever tries to follow it.
    await assert.rejects(db.create(otype, { body: "x", aboutId: "not an id" }, { vshard: "7" }), /not an id/);
    await assert.rejects(db.create(otype, { body: "x", aboutId: 5 }, { vshard: "7" }), /payload holds a number/);
  });

  it("accepts a qualified payload id where the field relationship permits one", async () => {
    const { db, note } = await database();
    const id = await db.create(NOTE, { body: "x", aboutId: `${OTHER}#5` }, { with: note });
    const got = await db.query({ frames: [{ source: { kind: "ids" }, children: [], counts: [] }] }, [id]);
    assert.equal((got[0] as { aboutId: string }).aboutId, `${OTHER}#5`);
  });
});

// The whole reason format 1 kept its statements byte for byte: the deployed wiki databases are on it
// and must not be touched by code that knows about format 2.
describe("a format 1 database opened by this code", () => {
  it("has a byte-identical schema afterwards", () => {
    const sql = nodeSql();
    // The historical text, as `host/schema.ts` carried it before there were two formats. Written out
    // here rather than imported, so that changing the constant cannot make this test agree with it.
    for (const stmt of [
      `CREATE TABLE IF NOT EXISTS vshards (
     vshard   INTEGER PRIMARY KEY,
     epoch    INTEGER NOT NULL,
     state    TEXT    NOT NULL,      -- 'owned' | 'fenced' | 'moved'
     next_seq INTEGER NOT NULL
   )`,
      `CREATE TABLE IF NOT EXISTS objects (
     id      BLOB    PRIMARY KEY,    -- 8-byte big-endian u64
     otype   INTEGER NOT NULL,
     version INTEGER NOT NULL,
     data    TEXT    NOT NULL
   ) WITHOUT ROWID`,
      `CREATE TABLE IF NOT EXISTS assocs (
     id1   BLOB    NOT NULL,
     atype INTEGER NOT NULL,
     id2   BLOB    NOT NULL,
     time  INTEGER NOT NULL,         -- sort key for range reads
     data  TEXT,
     PRIMARY KEY (id1, atype, id2)
   ) WITHOUT ROWID`,
      `CREATE INDEX IF NOT EXISTS assocs_range ON assocs (id1, atype, time)`,
      `CREATE TABLE IF NOT EXISTS assoc_counts (
     id1   BLOB    NOT NULL,
     atype INTEGER NOT NULL,
     n     INTEGER NOT NULL,
     PRIMARY KEY (id1, atype)
   ) WITHOUT ROWID`,
      `CREATE TABLE IF NOT EXISTS index_entries (
     vshard INTEGER NOT NULL,
     idx    INTEGER NOT NULL,
     key    TEXT    NOT NULL,
     id     BLOB,
     state  TEXT    NOT NULL,
     at     INTEGER NOT NULL,
     PRIMARY KEY (vshard, idx, key)
   ) WITHOUT ROWID`,
      `CREATE TABLE IF NOT EXISTS outbox (
     vshard        INTEGER NOT NULL,
     seq           INTEGER NOT NULL,
     target_vshard INTEGER NOT NULL,
     op           TEXT    NOT NULL,
     PRIMARY KEY (vshard, seq)
   ) WITHOUT ROWID`,
    ]) {
      sql.run(stmt);
    }

    const schema = () =>
      sql
        .all<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master ORDER BY name")
        .map((r) => `${r.name}\n${r.sql ?? ""}`)
        .join("\n");

    const before = schema();
    const host = Host.open(sql, CATALOG);
    assert.equal(host.format(), 1, "detected from the shape of its own assocs");
    assert.equal(schema(), before, "no DDL was issued that would have changed anything");

    // And it still works as a format 1 host: writes, counts and pages, on the old key.
    host.adopt("7", 0);
    const from = host.create({ otype: NOTE, data: { body: "x" }, vshard: "7", epoch: 0 });
    const to = host.create({ otype: NOTE, data: { body: "y" }, vshard: "7", epoch: 0 });
    assert.ok(from.ok && to.ok);
    assert.ok(host.assocAdd({ atype: NEXT, id1: from.value, id2: to.value, time: 1, epoch: 0 }).ok);
    assert.equal(schema(), before);
  });
});
