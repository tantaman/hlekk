import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CURRENT_FORMAT, FormatError, ddl, formatOf, migrate } from "./schema.ts";
import { nodeSql } from "./sql.node.ts";
import { makeId, toKey } from "./ids.ts";
import { Host } from "./host.ts";
import { Catalog, plan as planLock } from "../catalog/catalog.ts";
import { Directory, DDL as DIRECTORY_DDL } from "../directory/directory.ts";

// What the two storage formats owe each other. These were the tests of a DDL nothing applied; now
// something does, and the shape of the thing has to keep being the shape the design rests on.

describe("the two storage formats", () => {
  it("keeps format 1's statements byte for byte, so a loaded database issues what it was loaded with", () => {
    const one = ddl(1);
    // The table and the index sit where they always sat: third and fourth, after vshards and objects.
    assert.match(one[2], /PRIMARY KEY \(id1, atype, id2\)/);
    assert.equal(one[2].includes("db"), false);
    assert.equal(one[3], "CREATE INDEX IF NOT EXISTS assocs_range ON assocs (id1, atype, time)");
    // And the index declaration is the same on both, which is why there is no second index to add.
    assert.equal(ddl(2)[3], one[3]);
  });

  it("puts the target's database in format 2's key, before the target", () => {
    assert.match(ddl(2)[2], /PRIMARY KEY \(id1, atype, db, id2\)/);
    assert.equal(CURRENT_FORMAT, 2);
  });

  it("distinguishes two databases' identical target ids, which format 1 cannot", () => {
    const id1 = toKey(makeId(5n, 1n));
    const id2 = toKey(makeId(9n, 5n)); // the same local id in both target databases

    const two = nodeSql();
    for (const stmt of ddl(2)) two.run(stmt);
    const add = (db: number, time: number) =>
      two.run("INSERT OR REPLACE INTO assocs (id1, atype, db, id2, time, data) VALUES (?, 1, ?, ?, ?, NULL)", id1, db, id2, time);
    add(0, 100);
    add(7, 200);
    add(8, 300);
    assert.deepEqual(
      two.all<{ db: number; time: number }>("SELECT db, time FROM assocs ORDER BY db").map((r) => [r.db, r.time]),
      [[0, 100], [7, 200], [8, 300]],
    );
    // Re-timing one edge still replaces exactly that edge.
    add(7, 250);
    assert.equal(two.all<{ n: number }>("SELECT COUNT(*) AS n FROM assocs")[0].n, 3);

    // On format 1's key these would be one row, and the last write would have dropped the other two
    // along with whatever they pointed at — no error, no count change.
    const one = nodeSql();
    for (const stmt of ddl(1)) one.run(stmt);
    for (const time of [100, 200, 300]) {
      one.run("INSERT OR REPLACE INTO assocs (id1, atype, id2, time, data) VALUES (?, 1, ?, ?, NULL)", id1, id2, time);
    }
    assert.equal(one.all<{ n: number }>("SELECT COUNT(*) AS n FROM assocs")[0].n, 1);
  });

  it("defaults the alias to local, so a write that names no database is a local edge", () => {
    const sql = nodeSql();
    for (const stmt of ddl(2)) sql.run(stmt);
    sql.run(
      "INSERT OR REPLACE INTO assocs (id1, atype, id2, time, data) VALUES (?, 1, ?, ?, NULL)",
      toKey(makeId(5n, 1n)),
      toKey(makeId(5n, 2n)),
      100,
    );
    assert.equal(sql.all<{ db: number }>("SELECT db FROM assocs")[0].db, 0);
  });

  it("detects the format it holds, and tells an empty host from a format 1 one", () => {
    const empty = nodeSql();
    assert.equal(formatOf(empty), null);
    for (const stmt of ddl(1)) empty.run(stmt);
    assert.equal(formatOf(empty), 1);

    const two = nodeSql();
    for (const stmt of ddl(2)) two.run(stmt);
    assert.equal(formatOf(two), 2);
  });

  // The failure this whole mechanism exists to prevent: `CREATE TABLE IF NOT EXISTS` is silent
  // about a table that already exists in another shape, so without this the fleet diverges and
  // nothing fails until a page comes back in the wrong order.
  it("refuses to migrate a host onto a format it does not hold", () => {
    const sql = nodeSql();
    migrate(sql, 1);
    assert.throws(() => migrate(sql, 2), FormatError);
    assert.doesNotThrow(() => migrate(sql, 1)); // idempotent on its own format

    const other = nodeSql();
    migrate(other, 2);
    assert.throws(() => migrate(other, 1), FormatError);
  });

  it("opens a host at the format it holds when it is told none, and at format 1 when it is empty", () => {
    const sql = nodeSql();
    assert.equal(Host.open(sql).format(), 1); // empty: the conservative shape, which refuses a foreign edge
    assert.equal(Host.open(sql).format(), 1); // and keeps it

    const two = nodeSql();
    assert.equal(Host.open(two, Catalog.empty(), undefined, 2).format(), 2);
    assert.equal(Host.open(two).format(), 2); // told none, it keeps what it is
    assert.throws(() => Host.open(two, Catalog.empty(), undefined, 1), FormatError);
  });

  it("reshapes an empty host when it is told its format, and refuses one holding edges", () => {
    const LOCK = planLock({
      a: {
        objects: { "a.thing": { fields: {} } },
        edges: { "a.link": { from: "a.thing", to: "a.thing" } },
      },
    });
    const catalog = Catalog.compile(LOCK);
    const atype = catalog.edgeNamed("a.link")!.atype!;
    const otype = catalog.objectNamed("a.thing")!.otype;

    const host = Host.open(nodeSql(), catalog);
    assert.equal(host.format(), 1);
    // A new host is told its format when it is first adopted, and reshaping an empty `assocs` loses
    // nothing.
    host.setFormat(2);
    assert.equal(host.format(), 2);

    host.adopt("5", 0);
    const from = host.create({ otype, data: {}, vshard: "5", epoch: 0 });
    const to = host.create({ otype, data: {}, vshard: "5", epoch: 0 });
    assert.ok(from.ok && to.ok);
    assert.ok(host.assocAdd({ atype, id1: from.value, id2: to.value, epoch: 0 }).ok);

    // Now it holds an edge, and the two formats key it differently: there is no in-place upgrade,
    // and a cursor already handed out would land in the wrong place under the other order.
    assert.throws(() => host.setFormat(1), FormatError);
  });
});

describe("the registry of databases this one references", () => {
  const directory = (opts: Parameters<typeof Directory.open>[1]) => Directory.open(nodeSql(), opts);

  it("is only an added table, so it is safe on a directory that already exists", () => {
    const sql = nodeSql();
    // An older directory: every statement but the registry's two.
    for (const stmt of DIRECTORY_DDL.slice(0, -2)) sql.run(stmt);
    sql.run("INSERT INTO assignments (vshard, host, epoch) VALUES (0, 0, 0)");
    const d = Directory.open(sql, { database: "db" });
    // It kept its assignments, which is what says the open was a migration and not a fresh create.
    assert.equal(d.size(), 1);
    // And it is format 1, by the absence of the row rather than by anything written now.
    assert.equal(d.storageFormat(), 1);
    assert.deepEqual(d.aliases(), []);
  });

  it("records a new database's format, and never changes it", () => {
    assert.equal(directory({ database: "new" }).storageFormat(), 2);
    assert.equal(directory({ database: "old", format: 1 }).storageFormat(), 1);
  });

  it("interns a URI once, numbers from a counter, and never repoints an alias", () => {
    const d = directory({ database: "db", uri: "https://mine.example/db" });
    assert.equal(d.intern("https://a.example/db"), 1);
    assert.equal(d.intern("https://b.example/db"), 2);
    assert.equal(d.intern("https://a.example/db"), 1); // the same database, the same alias
    assert.equal(d.uriOf(2), "https://b.example/db");
    assert.deepEqual(d.aliases().map((a) => [a.alias, a.uri, a.state]), [
      [1, "https://a.example/db", "live"],
      [2, "https://b.example/db", "live"],
    ]);

    // From the counter, not from MAX(alias) + 1: the two agree only while nothing is purged, and a
    // number that came back would silently repoint every edge still naming it.
    d.sql.run("DELETE FROM foreign_dbs WHERE alias = 2");
    assert.equal(d.intern("https://c.example/db"), 3);
  });

  it("refuses a spelling that is not canonical rather than repairing it", () => {
    const d = directory({ database: "db" });
    // Two spellings of one database would be two aliases, and the unique index would not notice.
    assert.throws(() => d.intern("https://A.example/db"), /canonical/);
    assert.throws(() => d.intern("https://a.example/db/"), /canonical/);
    assert.throws(() => d.intern("http://a.example/db"), /loopback/);
    assert.equal(d.intern("https://a.example/db"), 1);
  });

  it("refuses to intern this database itself, since an edge into yourself is a local edge", () => {
    const d = directory({ database: "db", uri: "https://mine.example/db" });
    assert.throws(() => d.intern("https://mine.example/db"), FormatError);
    // And refuses to be renamed, because the URI is the identity: to everyone holding an edge into
    // it, a database that answers at another name is another database.
    assert.throws(() => d.setDatabaseUri("https://other.example/db"), FormatError);
    assert.doesNotThrow(() => d.setDatabaseUri("https://mine.example/db"));
  });

  it("will not name itself something it has already interned", () => {
    const d = directory({ database: "db" });
    d.intern("https://a.example/db");
    assert.throws(() => d.setDatabaseUri("https://a.example/db"), FormatError);
  });

  it("refuses a lock holding a foreign edge type on a format 1 database", () => {
    const LOCK = planLock({
      a: {
        objects: { "a.thing": { fields: {} } },
        edges: { "a.out": { from: "a.thing", to: "a.thing", foreign: true } },
      },
    });
    // The alias would be dropped on a format 1 host and the edge would read back as a local one, so
    // this is refused at the last point where nothing has been written against the lock.
    assert.throws(() => directory({ database: "old", format: 1 }).applyLock(LOCK), FormatError);
    assert.doesNotThrow(() => directory({ database: "new" }).applyLock(LOCK));
  });
});
