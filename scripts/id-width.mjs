// What a reference to another database costs, measured on the host's own DDL.
//
// Backs the figures in docs/global-ids.md. Three readings, all on the same synthetic graph so they
// compare: the wiki demo's shape, 12,000 objects at 65 out-edges, targets scattered across the whole
// set, ids sequential within 192 vshards — simplewiki's measured active count.
//
// Measured the way a host measures anything compared against the per-DO limit: page_count *
// page_size, which is what `databaseSize` reports. Summing payload lengths would undercount by
// 1.05x to 4.7x and is the mistake design.md's "Measuring it" paragraph exists to name.
//
// Run: node scripts/id-width.mjs

import { DatabaseSync } from "node:sqlite";

const PAGES = 12_000;
const DEG = 65;
// A fixed stride, so every run builds the same graph. Coprime with PAGES, so targets spread.
const TARGET = (i, d) => (i * 7919 + d * 104729) % PAGES;

const OBJECTS = `CREATE TABLE objects (
  id BLOB PRIMARY KEY, otype INTEGER NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL
) WITHOUT ROWID`;
const COUNTS = `CREATE TABLE assoc_counts (
  id1 BLOB NOT NULL, atype INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (id1, atype)
) WITHOUT ROWID`;

/** An id key. 8 bytes is today's; 16 prepends a database prefix, the only backward-compatible
 *  widening, since the vshard field stays anchored at SEQ_BITS in the low half. */
function key(width, vshard, seq, prefix = 0x0102030405060708n) {
  const b = new Uint8Array(width);
  const v = new DataView(b.buffer);
  if (width === 16) {
    v.setBigUint64(0, prefix);
    v.setBigUint64(8, (BigInt(vshard) << 47n) | BigInt(seq));
  } else {
    v.setBigUint64(0, (BigInt(vshard) << 47n) | BigInt(seq));
  }
  return b;
}

const CONFIGS = {
  // Today's schema, the control.
  "today": {
    width: 8,
    ddl: [
      `CREATE TABLE assocs (id1 BLOB NOT NULL, atype INTEGER NOT NULL, id2 BLOB NOT NULL,
        time INTEGER NOT NULL, data TEXT, PRIMARY KEY (id1, atype, id2)) WITHOUT ROWID`,
      `CREATE INDEX assocs_range ON assocs (id1, atype, time)`,
    ],
    ins: `INSERT OR REPLACE INTO assocs (id1, atype, id2, time, data) VALUES (?, 1, ?, ?, NULL)`,
  },
  // An interned alias, inside the key because two databases' id2 would otherwise collide on it.
  "alias in the key": {
    width: 8,
    ddl: [
      `CREATE TABLE assocs (id1 BLOB NOT NULL, atype INTEGER NOT NULL, db INTEGER NOT NULL DEFAULT 0,
        id2 BLOB NOT NULL, time INTEGER NOT NULL, data TEXT,
        PRIMARY KEY (id1, atype, db, id2)) WITHOUT ROWID`,
      `CREATE INDEX assocs_range ON assocs (id1, atype, time)`,
    ],
    ins: `INSERT OR REPLACE INTO assocs (id1, atype, db, id2, time, data) VALUES (?, 1, 0, ?, ?, NULL)`,
  },
  // Foreign edges in their own table, which stays empty here: this reading is what the option costs
  // a database that never links out.
  "a second table": {
    width: 8,
    ddl: [
      `CREATE TABLE assocs (id1 BLOB NOT NULL, atype INTEGER NOT NULL, id2 BLOB NOT NULL,
        time INTEGER NOT NULL, data TEXT, PRIMARY KEY (id1, atype, id2)) WITHOUT ROWID`,
      `CREATE INDEX assocs_range ON assocs (id1, atype, time)`,
      `CREATE TABLE foreign_assocs (id1 BLOB NOT NULL, atype INTEGER NOT NULL, db INTEGER NOT NULL,
        id2 BLOB NOT NULL, time INTEGER NOT NULL, data TEXT,
        PRIMARY KEY (id1, atype, db, id2)) WITHOUT ROWID`,
      `CREATE INDEX foreign_assocs_range ON foreign_assocs (id1, atype, time)`,
    ],
    ins: `INSERT OR REPLACE INTO assocs (id1, atype, id2, time, data) VALUES (?, 1, ?, ?, NULL)`,
  },
  // 128-bit ids everywhere.
  "128-bit ids": {
    width: 16,
    ddl: [
      `CREATE TABLE assocs (id1 BLOB NOT NULL, atype INTEGER NOT NULL, id2 BLOB NOT NULL,
        time INTEGER NOT NULL, data TEXT, PRIMARY KEY (id1, atype, id2)) WITHOUT ROWID`,
      `CREATE INDEX assocs_range ON assocs (id1, atype, time)`,
    ],
    ins: `INSERT OR REPLACE INTO assocs (id1, atype, id2, time, data) VALUES (?, 1, ?, ?, NULL)`,
  },
};

const size = (db) =>
  Number(Object.values(db.prepare("PRAGMA page_count").get())[0]) *
  Number(Object.values(db.prepare("PRAGMA page_size").get())[0]);

function build(cfg) {
  const db = new DatabaseSync(":memory:");
  db.exec(OBJECTS);
  for (const d of cfg.ddl) db.exec(d);
  db.exec(COUNTS);

  const ids = [];
  const insObj = db.prepare("INSERT INTO objects (id, otype, version, data) VALUES (?, 1, 1, ?)");
  db.exec("BEGIN");
  for (let i = 0; i < PAGES; i++) {
    const k = key(cfg.width, i % 192, i);
    ids.push(k);
    insObj.run(k, JSON.stringify({ ns: 0, title: `Article about subject number ${i}` }));
  }
  db.exec("COMMIT");
  const objects = size(db);

  const insA = db.prepare(cfg.ins);
  const insC = db.prepare("INSERT OR REPLACE INTO assoc_counts (id1, atype, n) VALUES (?, 1, ?)");
  db.exec("BEGIN");
  let edges = 0;
  for (let i = 0; i < PAGES; i++) {
    for (let d = 0; d < DEG; d++) {
      insA.run(ids[i], ids[TARGET(i, d)], 1_760_000_000 + i * 31 + d);
      edges++;
    }
    insC.run(ids[i], DEG);
  }
  db.exec("COMMIT");
  const total = size(db);
  db.close();
  return { objects, assocs: total - objects, total, edges };
}

/** Why a zero alias is nearly free: SQLite's record format spends a header byte on the serial type
 *  and no payload byte on integer 0, so a local edge pays the header and nothing else. Read off a
 *  column added to a table that is otherwise identical, rather than taken from the format's spec. */
function zeroColumnCost(rows = 200_000) {
  const one = (extra) => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE t (a BLOB NOT NULL${extra ? ", z INTEGER NOT NULL" : ""}, b INTEGER NOT NULL,
             PRIMARY KEY (a${extra ? ", z" : ""})) WITHOUT ROWID`);
    const ins = db.prepare(`INSERT INTO t VALUES (?${extra ? ", 0" : ""}, ?)`);
    db.exec("BEGIN");
    for (let i = 0; i < rows; i++) ins.run(key(8, i % 192, i), i);
    db.exec("COMMIT");
    const n = size(db);
    db.close();
    return n;
  };
  const without = one(false);
  const with_ = one(true);
  return { without, with_, perRow: (with_ - without) / rows };
}

const out = Object.entries(CONFIGS).map(([name, cfg]) => ({ name, ...build(cfg) }));
const base = out[0];
const f = (n) => n.toLocaleString();

console.log(`${f(PAGES)} objects, ${f(base.edges)} local edges, no foreign edges written.`);
console.log(`Projection columns assume PLAN.md's enwiki figures: 35M pages, 2.6B edges.\n`);
console.log("| where the reference lives | total bytes | bytes/edge-row | vs today | enwiki |");
console.log("| --- | --- | --- | --- | --- |");
for (const r of out) {
  const gb = (35e6 * (r.objects / PAGES) + 2.6e9 * (r.assocs / r.edges)) / 1e9;
  console.log(
    `| ${r.name} | ${f(r.total)} | ${(r.assocs / r.edges).toFixed(1)} | ` +
      `${(r.total / base.total).toFixed(3)}x | ${gb.toFixed(0)} GB |`,
  );
}

const z = zeroColumnCost();
console.log(`\nA zero integer column added to the key: ${z.perRow.toFixed(2)} bytes/row`);
console.log(`(${f(z.without)} -> ${f(z.with_)} bytes over 200,000 rows, table and index together)`);
