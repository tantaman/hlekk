import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FOREIGN_ASSOCS_DDL, FOREIGN_DBS_DDL } from "./schema.foreign.ts";
import { nodeSql } from "./sql.node.ts";
import { makeId, toKey } from "./ids.ts";

// Nothing applies this DDL, so nothing else would notice it rotting. These tests are what keep the
// proposal in `docs/global-ids.md` executable rather than merely written down: that it is valid SQL,
// and that the two constraints the design leans on actually bite.

describe("the proposed foreign-reference DDL", () => {
  it("applies, and distinguishes two databases' identical target ids", () => {
    const sql = nodeSql();
    for (const stmt of FOREIGN_ASSOCS_DDL) sql.run(stmt);

    const id1 = toKey(makeId(5n, 1n));
    const id2 = toKey(makeId(9n, 5n)); // the same local id in both target databases
    const add = (db: number, time: number) =>
      sql.run("INSERT OR REPLACE INTO assocs (id1, atype, db, id2, time, data) VALUES (?, 1, ?, ?, ?, NULL)", id1, db, id2, time);

    add(0, 100); // local
    add(7, 200); // database 7
    add(8, 300); // database 8

    // On `(id1, atype, id2)` alone these would be one row, and the last write would have silently
    // dropped the other two along with whatever they pointed at.
    const rows = sql.all<{ db: number; time: number }>("SELECT db, time FROM assocs ORDER BY db");
    assert.deepEqual(rows.map((r) => [r.db, r.time]), [[0, 100], [7, 200], [8, 300]]);

    // And re-timing one edge still replaces exactly that edge.
    add(7, 250);
    assert.equal(sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM assocs")[0].n, 3);
    assert.equal(sql.all<{ time: number }>("SELECT time FROM assocs WHERE db = 7")[0].time, 250);
  });

  it("defaults the alias to local, so an unqualified write is a local edge", () => {
    const sql = nodeSql();
    for (const stmt of FOREIGN_ASSOCS_DDL) sql.run(stmt);
    sql.run(
      "INSERT OR REPLACE INTO assocs (id1, atype, id2, time, data) VALUES (?, 1, ?, ?, NULL)",
      toKey(makeId(5n, 1n)),
      toKey(makeId(5n, 2n)),
      100,
    );
    assert.equal(sql.all<{ db: number }>("SELECT db FROM assocs")[0].db, 0);
  });

  it("refuses alias 0 and a second alias for one database", () => {
    const sql = nodeSql();
    for (const stmt of FOREIGN_DBS_DDL) sql.run(stmt);
    const add = (alias: number, dbId: string, uri: string) =>
      sql.run("INSERT INTO foreign_dbs (alias, db_id, uri, state, added) VALUES (?, ?, ?, 'live', 0)", alias, dbId, uri);

    add(1, "acme/app", "https://acme.example/hlekk");

    // 0 means local, so allocating it would make every local edge name a foreign database.
    assert.throws(() => add(0, "acme/other", "https://other.example"), /CHECK/i);

    // One database interns once: a second alias for it would leave two names for one place, and
    // nothing to say which of them an edge meant.
    assert.throws(() => add(2, "acme/app", "https://acme.example/hlekk"), /UNIQUE/i);

    // Re-addressing is not re-interning: the alias is bound to the identity, not the URI.
    sql.run("UPDATE foreign_dbs SET uri = ? WHERE db_id = ?", "https://acme.example/v2", "acme/app");
    const rows = sql.all<{ alias: number; uri: string }>("SELECT alias, uri FROM foreign_dbs");
    assert.deepEqual(rows.map((r) => [r.alias, r.uri]), [[1, "https://acme.example/v2"]]);
  });
});
