import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Cache } from "./stores.ts";
import type { EdgeSegment } from "./stores.ts";
import { UNKNOWN } from "./types.ts";
import type { Cursor, Edge } from "./types.ts";

const ID1 = "100";
const ATYPE = 1;
// Newest first, as an edge list is read.
const edges: Edge[] = [50, 40, 30, 20, 10].map((time) => ({
  id1: ID1,
  atype: ATYPE,
  id2: String(time),
  time,
  data: null,
}));
const at = (i: number): Cursor => ({ time: edges[i].time, id2: edges[i].id2 });
const segment = (after: Cursor | null, rows: Edge[], complete: boolean): EdgeSegment => ({
  id1: ID1,
  atype: ATYPE,
  after,
  rows,
  complete,
});
const read = (c: Cache, after: Cursor | null, n: number) => c.page(ID1, ATYPE, after, n);
const ids = (p: ReturnType<Cache["page"]>) => (p === UNKNOWN ? UNKNOWN : p.rows.map((e) => e.id2));

describe("the gathered graph's edge runs", () => {
  it("serves a read of the head from a run read at the head", () => {
    const c = new Cache();
    c.merge({ objects: [], counts: [], lists: [segment(null, edges.slice(0, 2), false)] });
    assert.deepEqual(ids(read(c, null, 2)), ["50", "40"]);
  });

  it("keeps a run read from the middle, which a plan's starting cursor produces", () => {
    const c = new Cache();
    // The first read of this list is a continuation: nothing precedes it in the cache.
    c.merge({ objects: [], counts: [], lists: [segment(at(1), edges.slice(2, 4), false)] });
    assert.deepEqual(ids(read(c, at(1), 2)), ["30", "20"], "it answers the read it was fetched for");
  });

  it("will not answer a read of the head from a run that began mid-list", () => {
    const c = new Cache();
    c.merge({ objects: [], counts: [], lists: [segment(at(1), edges.slice(2, 4), false)] });
    // Answering this from rows that start at 30 would silently drop 50 and 40.
    assert.equal(read(c, null, 2), UNKNOWN);
  });

  it("will not answer from a run that does not reach the cursor asked for", () => {
    const c = new Cache();
    c.merge({ objects: [], counts: [], lists: [segment(at(3), edges.slice(4), true)] });
    assert.equal(read(c, at(0), 2), UNKNOWN, "the run says nothing about what follows 50");
  });

  it("joins a continuation onto the run it continues", () => {
    const c = new Cache();
    c.merge({ objects: [], counts: [], lists: [segment(null, edges.slice(0, 2), false)] });
    c.merge({ objects: [], counts: [], lists: [segment(at(1), edges.slice(2, 4), false)] });
    assert.deepEqual(ids(read(c, null, 4)), ["50", "40", "30", "20"], "one run, start to finish");
  });

  it("lets a read of the head supersede a run that began mid-list", () => {
    const c = new Cache();
    c.merge({ objects: [], counts: [], lists: [segment(at(1), edges.slice(2, 4), false)] });
    c.merge({ objects: [], counts: [], lists: [segment(null, edges, true)] });
    assert.deepEqual(ids(read(c, null, 5)), ["50", "40", "30", "20", "10"]);
  });

  it("leaves disjoint runs alone rather than inventing adjacency between them", () => {
    const c = new Cache();
    c.merge({ objects: [], counts: [], lists: [segment(null, edges.slice(0, 2), false)] });
    // A run starting after 20, which does not touch the first two rows.
    c.merge({ objects: [], counts: [], lists: [segment(at(3), edges.slice(4), true)] });
    assert.deepEqual(ids(read(c, null, 2)), ["50", "40"], "the first run is intact");
    assert.notDeepEqual(ids(read(c, null, 5)), ["50", "40", "10"], "and 10 was not glued onto it");
  });

  it("reports a read past the end of a complete list as complete and empty", () => {
    const c = new Cache();
    c.merge({ objects: [], counts: [], lists: [segment(null, edges, true)] });
    const page = read(c, at(4), 2);
    assert.notEqual(page, UNKNOWN);
    assert.deepEqual(page === UNKNOWN ? null : { rows: page.rows.length, complete: page.complete }, {
      rows: 0,
      complete: true,
    });
  });
});
