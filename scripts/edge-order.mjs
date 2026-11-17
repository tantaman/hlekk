// What putting the target's database in the edge key does to the order an edge list is read in.
//
// PLAN.md step 3 cites these readings, and they decided two things that are now shipped: that a host
// on the new key cannot keep format 1's page query, and that a host on the old key cannot be given
// the new one by adding a column — which together is why there are two storage formats and no
// in-place upgrade (src/host/schema.ts).
//
//   node scripts/edge-order.mjs
//
// Reads SQLite's own query plans through node:sqlite, the engine the suite runs on. A Durable
// Object's SQLite is the same engine; `npm run smoke` is where that is confirmed, not here.

import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(":memory:");
const plan = (q) =>
  db
    .prepare(`EXPLAIN QUERY PLAN ${q}`)
    .all()
    .map((r) => r.detail)
    .join(" | ");
const key = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
};

// ---- the new key, as src/host/schema.ts declares it for storage format 2

db.exec(`CREATE TABLE assocs (
  id1 BLOB NOT NULL, atype INTEGER NOT NULL, db INTEGER NOT NULL DEFAULT 0, id2 BLOB NOT NULL,
  time INTEGER NOT NULL, data TEXT,
  PRIMARY KEY (id1, atype, db, id2)
) WITHOUT ROWID`);
db.exec(`CREATE INDEX assocs_range ON assocs (id1, atype, time)`);

const WHERE = "WHERE id1 = x'01' AND atype = 1";
const AFTER = "AND (time < 5 OR (time = 5 AND (db < 2 OR (db = 2 AND id2 < x'09'))))";

console.log("new key");
console.log("  head, ordered (time, db, id2):   ", plan(`SELECT db, id2, time, data FROM assocs ${WHERE} ORDER BY time DESC, db DESC, id2 DESC LIMIT 26`));
console.log("  after a cursor, same order:      ", plan(`SELECT db, id2, time, data FROM assocs ${WHERE} ${AFTER} ORDER BY time DESC, db DESC, id2 DESC LIMIT 26`));
console.log("  today's order, (time, id2):      ", plan(`SELECT db, id2, time FROM assocs ${WHERE} ORDER BY time DESC, id2 DESC LIMIT 26`));

// Five edges at one time, so only the tie-break orders them.
const add = db.prepare("INSERT INTO assocs (id1, atype, db, id2, time) VALUES (?, 1, ?, ?, 5)");
for (const [alias, id] of [[0, 9], [2, 3], [0, 4], [1, 7], [2, 8]]) add.run(key(1), alias, key(id));
const tied = db
  .prepare(`SELECT db, id2 FROM assocs WHERE id1 = ? AND atype = 1 ORDER BY time DESC, db DESC, id2 DESC`)
  .all(key(1))
  .map((r) => `${r.db}:${new DataView(r.id2.buffer, r.id2.byteOffset).getBigUint64(0)}`);
console.log("  ties, as alias:id:               ", tied.join("  "));

// ---- today's key, given the column afterwards

db.exec(`CREATE TABLE old (
  id1 BLOB NOT NULL, atype INTEGER NOT NULL, id2 BLOB NOT NULL, time INTEGER NOT NULL, data TEXT,
  PRIMARY KEY (id1, atype, id2)
) WITHOUT ROWID`);
db.exec(`CREATE INDEX old_range ON old (id1, atype, time)`);
console.log("\ntoday's key");
console.log("  today's order:                   ", plan(`SELECT id2, time FROM old ${WHERE} ORDER BY time DESC, id2 DESC LIMIT 26`));
db.exec(`ALTER TABLE old ADD COLUMN db INTEGER NOT NULL DEFAULT 0`);
console.log("  ADD COLUMN, then the new order:  ", plan(`SELECT db, id2, time FROM old ${WHERE} ORDER BY time DESC, db DESC, id2 DESC LIMIT 26`));

// ---- the signature scheme step 5 assumes, with no dependency

const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
const message = new TextEncoder().encode("hlekk");
const signature = await crypto.subtle.sign("Ed25519", pair.privateKey, message);
const ok = await crypto.subtle.verify("Ed25519", pair.publicKey, signature, message);
console.log(`\nEd25519 through WebCrypto: ${signature.byteLength}-byte signature, verifies: ${ok} (node ${process.version})`);
