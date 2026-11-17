import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { Catalog, plan as planLock } from "../../catalog/catalog.ts";
import { open } from "./database.ts";
import { parse } from "./serve.ts";

// A whole database over files, in one process. What this has to show is that the two platform seams
// are the only things the Node adapter replaces: everything above them is the code a deployment
// runs, so a database written here, closed and reopened is the same database.

const LOCK = planLock({
  notes: {
    objects: { "notes.note": { fields: { body: "string" } } },
    edges: { "notes.note_next": { from: "notes.note", to: "notes.note" } },
  },
});
const CATALOG = Catalog.compile(LOCK);
const NOTE = CATALOG.objectNamed("notes.note")!.otype;
const NEXT = CATALOG.edgeNamed("notes.note_next")!.atype!;

describe("a database in a directory", () => {
  const dirs: string[] = [];
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "hlekk-"));
    dirs.push(d);
    return d;
  };
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("writes to files, and is the same database when it is reopened", async () => {
    const d = dir();
    // The format is stated rather than inherited: this test is about a database created at format 2
    // coming back as one, and the suite also runs with the environment forcing format 1.
    const first = await open({ dir: d, uri: "https://notes.example/db", lock: LOCK, format: 2 });
    const a = await first.db.create(NOTE, { body: "first" }, { vshard: "7" });
    const b = await first.db.create(NOTE, { body: "second" }, { with: a });
    await first.db.assocAdd(NEXT, a, b, 1);
    assert.equal(first.cluster.directory.storageFormat(), 2);
    first.close();

    // Files, not memory: the directory and one host, plus the roster that says which hosts exist.
    assert.deepEqual(readdirSync(d).sort(), ["directory.sqlite", "h-0.sqlite", "hosts.json"]);

    const again = await open({ dir: d });
    const rows = (await again.db.query(
      {
        frames: [
          { source: { kind: "ids" }, children: [{ alias: "next", frame: 1 }], counts: [] },
          { source: { kind: "edge", atype: NEXT }, children: [], counts: [] },
        ],
      },
      [a],
    )) as { body: string; next: { body: string }[] }[];
    assert.equal(rows[0].body, "first");
    assert.deepEqual(rows[0].next.map((n) => n.body), ["second"]);

    // The catalog, the URI and the signing key came back too, which are the three things that are
    // not rows of a vshard.
    assert.equal(again.catalog.version, LOCK.version);
    assert.equal(again.cluster.directory.databaseUri(), "https://notes.example/db");
    const key = (await again.cluster.directory.identity(0)).public.id;
    again.close();

    const third = await open({ dir: d });
    assert.equal((await third.cluster.directory.identity(0)).public.id, key, "the key is generated once");
    third.close();
  });

  it("grows past one host and keeps reading across them", async () => {
    const d = dir();
    // Spread over three hosts before anything is written, so the writes land across them — the
    // mover is what gets a loaded database from one host to three, and that is the oracle's ground.
    const database = await open({ dir: d, lock: LOCK, batch: 8 });
    database.cluster.scatter(3);
    database.cluster.spreadCatalog();
    await database.cluster.publish();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) ids.push(await database.db.create(NOTE, { body: `n${i}` }, { vshard: String(i % 8) }));
    assert.ok(database.cluster.hosts.size >= 3, `expected several hosts, got ${database.cluster.hosts.size}`);
    database.close();

    const again = await open({ dir: d });
    // Every host's file was found and reopened, which is what the roster is for: a host that is not
    // open owns nothing as far as this process can see.
    assert.equal(again.cluster.hosts.size, database.cluster.hosts.size);
    const rows = (await again.db.query({ frames: [{ source: { kind: "ids" }, children: [], counts: [] }] }, ids)) as {
      body: string;
    }[];
    assert.deepEqual(rows.map((r) => r.body).sort(), ids.map((_, i) => `n${i}`).sort());
    again.close();
  });

  it("refuses to be renamed, because the URI is the identity", async () => {
    const d = dir();
    const first = await open({ dir: d, uri: "https://one.example/db" });
    first.close();
    // To everyone holding an edge into it, a database that answers at another name is another
    // database.
    await assert.rejects(open({ dir: d, uri: "https://two.example/db" }), /cannot be renamed/);
  });

  it("applies a lock that is ahead and leaves one that is not", async () => {
    const d = dir();
    const first = await open({ dir: d, lock: LOCK });
    assert.equal(first.catalog.version, 1);
    first.close();

    const next = planLock(
      {
        notes: {
          objects: { "notes.note": { fields: { body: "string" } }, "notes.tag": { fields: { name: "string" } } },
          edges: { "notes.note_next": { from: "notes.note", to: "notes.note" } },
        },
      },
      LOCK,
    );
    const second = await open({ dir: d, lock: next });
    assert.equal(second.catalog.version, 2);
    second.close();

    // The same lock again is not a change, and re-applying it would be refused by the directory's
    // own compare-and-set.
    const third = await open({ dir: d, lock: next });
    assert.equal(third.catalog.version, 2);
    third.close();
  });
});

describe("the serve command's arguments", () => {
  it("takes the flags it documents, in either spelling", () => {
    assert.deepEqual(parse(["--dir", "./x", "--port", "8080", "--path", "/db"]), {
      dir: "./x",
      port: 8080,
      host: "127.0.0.1",
      path: "/db",
      identity: true,
      allowLoopback: false,
    });
    assert.deepEqual(parse(["--dir=./y", "--port=0", "--no-identity", "--allow-loopback", "--uri=https://a.example/db"]), {
      dir: "./y",
      port: 0,
      host: "127.0.0.1",
      path: "",
      uri: "https://a.example/db",
      identity: false,
      allowLoopback: true,
    });
  });

  it("refuses what it cannot act on, rather than defaulting past it", () => {
    assert.throws(() => parse(["--nope"]), /unknown argument/);
    assert.throws(() => parse(["--port"]), /needs a value/);
    assert.throws(() => parse(["--port", "99999"]), /must be a port/);
    assert.throws(() => parse(["--port", "eight"]), /must be a port/);
  });
});
