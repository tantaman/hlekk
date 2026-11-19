// Copying a vshard a chunk at a time: `Host.chunk`, `install`, `discard` and `purge`, below the mover.
// Run under both storage formats explicitly, since the edge key and so the cursor differ between them.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog } from "../catalog/catalog.ts";
import { COPY_START, Host, NotOwned, Unfenced } from "./host.ts";
import type { Chunk, ChunkBudget, Snapshot } from "./host.ts";
import { makeId } from "./ids.ts";
import type { StorageFormat } from "./schema.ts";
import { nodeSql } from "./sql.node.ts";

const V = 5n;
const id = (seq: number) => makeId(V, BigInt(seq));

/** A vshard with something in every table: objects, a high-degree edge list (so the composite cursor
 *  has to page within one id1), a few short ones, counts, outbox rows and index entries. */
function fixture(format: StorageFormat): Snapshot {
  const objects = Array.from({ length: 12 }, (_, i) => ({ id: id(i + 1), otype: 1 + (i % 2), version: 1, data: JSON.stringify({ n: i }) }));
  const assocs: Snapshot["assocs"] = [];
  for (let i = 2; i <= 12; i++) assocs.push({ id1: id(1), atype: 1, db: 0, id2: id(i), time: 100 + i, data: null });
  for (let i = 2; i <= 4; i++) assocs.push({ id1: id(i), atype: 2, db: 0, id2: id(1), time: 200 + i, data: JSON.stringify({ w: i }) });
  if (format === 2) assocs.push({ id1: id(2), atype: 3, db: 7, id2: makeId(9n, 4n), time: 300, data: null });
  const counts = [{ id1: id(1), atype: 1, n: 11 }, ...[2, 3, 4].map((i) => ({ id1: id(i), atype: 2, n: 1 }))];
  const outbox = [1, 2, 3].map((seq) => ({ seq, target: 9, op: JSON.stringify({ kind: "add", atype: 4, id1: makeId(9n, BigInt(seq)), id2: id(seq), time: seq, data: null }) }));
  const index = ["a", "b", "c", "d"].map((key, i) => ({ idx: 1 + (i % 2), key, id: id(i + 1), state: "confirmed", at: 10 }));
  return { vshard: "5", epoch: 0, nextSeq: 13, objects, assocs, counts, outbox, index };
}

const open = (format: StorageFormat) => Host.open(nodeSql(), Catalog.empty(), undefined, format);

/** A host holding the fixture in vshard 5, fenced as a move would leave it. */
function source(format: StorageFormat): Host {
  const h = open(format);
  h.install(fixture(format), 0);
  h.setState("5", "fenced");
  return h;
}

function chunks(h: Host, budget: ChunkBudget): Chunk[] {
  const out: Chunk[] = [];
  for (let at = COPY_START; ; ) {
    const c = h.chunk("5", at, budget);
    out.push(c);
    if (c.next === null) return out;
    at = c.next;
  }
}

const merged = (cs: Chunk[]): Omit<Snapshot, "epoch" | "nextSeq" | "vshard"> => ({
  objects: cs.flatMap((c) => c.objects),
  assocs: cs.flatMap((c) => c.assocs),
  counts: cs.flatMap((c) => c.counts),
  outbox: cs.flatMap((c) => c.outbox),
  index: cs.flatMap((c) => c.index),
});

/** Rows of any vshard left in each table, straight from SQLite rather than through a read that would
 *  first ask whether the vshard is served. */
const left = (h: Host) =>
  ["objects", "assocs", "assoc_counts", "outbox", "index_entries"].reduce(
    (n, table) => n + h.sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0].n,
    0,
  );

const rowsIn = (c: Chunk) => c.objects.length + c.assocs.length + c.counts.length + c.outbox.length + c.index.length;

for (const format of [1, 2] as const) {
  describe(`copying a vshard in chunks, storage format ${format}`, () => {
    it("reads exactly the whole vshard, once, at any budget", () => {
      const h = source(format);
      const whole = h.snapshot("5");
      for (const rows of [1, 2, 3, 7, 512, 100_000]) {
        const cs = chunks(h, { rows, bytes: Infinity });
        assert.deepEqual(merged(cs), merged([{ ...whole, from: COPY_START, next: null }]), `${rows} rows a chunk`);
        for (const c of cs) assert.ok(rowsIn(c) <= rows, `a chunk of ${rowsIn(c)} rows against a bound of ${rows}`);
        assert.equal(cs.at(-1)!.nextSeq, 13, "the last chunk carries the sequence");
      }
    });

    it("bounds a chunk by bytes, and still moves a row larger than the bound, alone", () => {
      const h = open(format);
      const big = "x".repeat(20_000);
      h.install(
        { ...fixture(format), objects: [1, 2, 3].map((i) => ({ id: id(i), otype: 1, version: 1, data: JSON.stringify({ big }) })) },
        0,
      );
      h.setState("5", "fenced");
      const cs = chunks(h, { rows: 1_000, bytes: 5_000 });
      const withObjects = cs.filter((c) => c.objects.length > 0);
      assert.equal(withObjects.length, 3, "three oversized objects, three chunks");
      for (const c of withObjects) assert.equal(rowsIn(c), 1, "an oversized row travels alone");
    });

    it("installs chunk by chunk into a host that ends up equal to the source", () => {
      const from = source(format);
      const to = open(format);
      for (const c of chunks(from, { rows: 2, bytes: Infinity })) to.install(c, 1);
      const a = from.snapshot("5");
      const b = to.snapshot("5");
      assert.deepEqual({ ...b, epoch: 0 }, a, "the same rows and the same sequence");
      assert.equal(to.stateOf(V), "owned");
      assert.equal(to.vshards()[0].epoch, 1);
    });

    it("refuses to read a vshard that still takes writes, or one it does not hold", () => {
      const h = open(format);
      h.install(fixture(format), 0);
      assert.throws(() => h.chunk("5"), Unfenced, "owned is not fenced");
      assert.throws(() => h.chunk("6"), NotOwned);
      h.setState("5", "moved");
      assert.throws(() => h.chunk("5"), NotOwned);
    });

    it("serves nothing it is part way through copying, and does not deliver its outbox", () => {
      const from = source(format);
      const to = open(format);
      const cs = chunks(from, { rows: 4, bytes: Infinity });
      for (const c of cs.slice(0, -1)) to.install(c, 1);

      assert.equal(to.stateOf(V), "absent");
      assert.equal(to.vshards().length, 0);
      assert.equal(to.pending().length, 0, "a staged outbox row is not this host's to deliver");
      assert.ok(left(to) > 0, "precondition: rows are staged");
      assert.equal(to.store().owns(id(1)), false, "and they are not served");

      to.install(cs.at(-1)!, 1);
      assert.equal(to.stateOf(V), "owned");
      assert.equal(to.pending().length, 3, "the last chunk hands the outbox over with the vshard");
    });

    it("installs the same chunk twice as once", () => {
      const from = source(format);
      const to = open(format);
      const cs = chunks(from, { rows: 3, bytes: Infinity });
      for (const c of cs) {
        to.install(c, 1);
        to.install(c, 1); // a reply lost, and the chunk re-sent
      }
      assert.deepEqual({ ...to.snapshot("5"), epoch: 0 }, from.snapshot("5"));
    });

    it("refuses to install into a vshard the host already holds", () => {
      const from = source(format);
      const to = open(format);
      to.adopt("5", 0);
      const [first] = chunks(from, { rows: 3, bytes: Infinity });
      assert.throws(() => to.install(first, 1), /would write into rows this host already holds/);
    });

    it("discards what a copy left behind in bounded steps, and never a vshard the host serves", () => {
      const from = source(format);
      const to = open(format);
      const cs = chunks(from, { rows: 3, bytes: Infinity });
      for (const c of cs.slice(0, 4)) to.install(c, 1);

      let calls = 0;
      while (!to.discard("5", 1, 2)) calls++;
      assert.ok(calls >= 5, `twelve staged rows at two a call took ${calls + 1} calls`);
      assert.equal(left(to), 0);

      // Its own finished copy, at the move's epoch, is discarded too: that is a rewound copy.
      for (const c of cs) to.install(c, 1);
      assert.equal(to.stateOf(V), "owned");
      assert.equal(to.discard("5", 1, 1), false);
      assert.equal(to.stateOf(V), "absent", "the vshards row goes first, so a half-cleared vshard is never served");
      while (!to.discard("5", 1, 1000));

      // A vshard held at any other epoch is a vshard a host serves.
      to.adopt("5", 0);
      assert.throws(() => to.discard("5", 1), /never a vshard a host holds/);
    });

    it("purges a bounded number of rows a call, and reads as moved until the last", () => {
      const h = source(format);
      h.setState("5", "moved");
      let calls = 0;
      while (!h.purge("5", 4)) {
        calls++;
        assert.equal(h.stateOf(V), "moved", "still refusing reads as moved, not half deleted");
      }
      assert.ok(calls >= 5, `${calls + 1} calls`);
      assert.equal(h.stateOf(V), "absent");
      assert.equal(left(h), 0, "every table is empty");
    });
  });
}

describe("copying a vshard across storage formats", () => {
  it("carries a format 1 vshard into a format 2 host, every edge at alias 0", () => {
    const from = source(1);
    const to = open(2);
    for (const c of chunks(from, { rows: 2, bytes: Infinity })) to.install(c, 1);
    const a = from.snapshot("5");
    const b = to.snapshot("5");
    assert.deepEqual({ ...b, epoch: 0 }, a);
    assert.ok(b.assocs.every((e) => e.db === 0));
  });

  it("refuses a format 2 edge into another database on a format 1 host, rather than dropping its alias", () => {
    const from = source(2);
    const to = open(1);
    assert.throws(() => {
      for (const c of chunks(from, { rows: 1_000, bytes: Infinity })) to.install(c, 1);
    }, /no column for it/);
    assert.equal(to.stateOf(V), "absent", "and nothing was handed over");
  });
});

