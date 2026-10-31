// The query plane at the shape and the width a read-only demo puts it under: many vshards over many
// hosts, and a link graph whose edges go anywhere rather than staying inside a colocation group.
//
// This is the Wikimedia shape. A page's outbound links point at arbitrary pages, so affinity buys
// nothing and almost every hop leaves its host — which makes cross-host assembly the ordinary case
// here, not the exception the issue-tracker fixtures exercise. What it is testing is that the answer
// is right anyway, and that the cost is one request per host rather than one per object.
//
// "Affinity buys nothing" is a property of the key, not a law, and the last test here is the other
// half of the claim: given a graph that has structure and a key that matches it, the same fan-out
// collapses. Which one of those a real wiki gets is a measurement rather than an argument — see
// docs/wikimedia-demo.md, where a page's first category buys 1.27x and a key derived from the link
// graph buys 3.2x on the same 950,421 pages.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan } from "../catalog/catalog.ts";
import { vshardOf } from "../host/ids.ts";
import type { Id, Plan } from "../query/types.ts";
import { deterministic, seeded } from "../runtime/runtime.ts";
import { LocalCluster } from "./local.ts";

const LOCK = plan({
  wiki: {
    objects: { "wiki.page": { fields: { title: "string" } } },
    // Links are directional and the backlink is the maintained half, which is how "what links here"
    // is answered without a scan.
    edges: {
      "wiki.page_links": { from: "wiki.page", to: "wiki.page", inverse: "wiki.page_linked" },
      "wiki.page_linked": { from: "wiki.page", to: "wiki.page", inverse: "wiki.page_links", maintained: true },
    },
  },
});
const CATALOG = Catalog.compile(LOCK);
const PAGE = CATALOG.objectNamed("wiki.page")!.otype;
const LINKS = CATALOG.edgeNamed("wiki.page_links")!.atype!;
const LINKED = CATALOG.edgeNamed("wiki.page_linked")!.atype!;

const VSHARDS = 128;
const HOSTS = 50;

/** Two levels of outbound links, plus a backlink count: a page view. */
const PAGE_VIEW: Plan = {
  frames: [
    {
      source: { kind: "ids" },
      children: [{ alias: "links", frame: 1 }],
      counts: [{ alias: "backlinks", atype: LINKED }],
    },
    {
      source: { kind: "edge", atype: LINKS },
      limit: 25,
      children: [{ alias: "links", frame: 2 }],
      counts: [],
    },
    { source: { kind: "edge", atype: LINKS }, limit: 25, children: [], counts: [] },
  ],
};

interface Built {
  cluster: LocalCluster;
  pages: Id[];
  /** The link structure as the test laid it down, which is what the answers are checked against. */
  links: Map<Id, Id[]>;
}

async function build(pageCount: number, degree: number): Promise<Built> {
  const c = new LocalCluster({ batch: VSHARDS, runtime: deterministic(7) });
  c.directory.applyLock(LOCK);
  c.scatter(HOSTS);
  c.spreadCatalog();
  await c.publish();

  const db = c.client();
  const r = seeded(11);
  // Spread by affinity, as a real import would: the title is the affinity key, so placement is a
  // hash and not a choice the test makes.
  const pages: Id[] = [];
  for (let i = 0; i < pageCount; i++) {
    pages.push(await db.create(PAGE, { title: `Page ${i}` }, { affinity: `Page ${i}` }));
  }

  const links = new Map<Id, Id[]>();
  for (const [i, from] of pages.entries()) {
    const targets: Id[] = [];
    const seen = new Set<Id>([from]);
    for (let d = 0; d < degree; d++) {
      const to = pages[r.int(pages.length)];
      if (seen.has(to)) continue;
      seen.add(to);
      targets.push(to);
    }
    // time ascending with i so the newest-first order is deterministic per list
    for (const [d, to] of targets.entries()) await db.assocAdd(LINKS, from, to, i * 1000 + d);
    links.set(from, targets);
  }
  // The backlink half of a cross-vshard link travels by outbox, and a read-only demo is loaded, not
  // written: drain it so the counts below are the settled ones.
  await c.deliverAll();
  return { cluster: c, pages, links };
}

describe("the query plane over many hosts", () => {
  it("spreads a link graph across hosts, with links leaving their host as the ordinary case", async () => {
    const { cluster: c, pages, links } = await build(400, 12);

    const occupied = new Set(pages.map((p) => c.directory.resolve(vshardOf(p))!.host));
    assert.ok(occupied.size > 20, `pages should land on many hosts, got ${occupied.size}`);

    let crossing = 0;
    let total = 0;
    for (const [from, targets] of links) {
      for (const to of targets) {
        total++;
        if (c.directory.resolve(vshardOf(from))!.host !== c.directory.resolve(vshardOf(to))!.host) crossing++;
      }
    }
    assert.ok(crossing / total > 0.9, `most links should cross a host, got ${((crossing / total) * 100).toFixed(1)}%`);
  });

  it("answers a two-level link query correctly when every hop leaves its host", async () => {
    const { cluster: c, pages, links } = await build(400, 12);
    const db = c.client();

    // A page whose links fan out widely, so the query touches many hosts in one go.
    const root = pages[3];
    const out = (await db.query(PAGE_VIEW, [root])) as {
      title: string;
      backlinks: number;
      links: { title: string; links: { title: string }[] }[];
    }[];

    assert.equal(out.length, 1);
    const titleOf = new Map(pages.map((p, i) => [p, `Page ${i}`]));
    // Newest first, which for this graph is the last link added.
    const expected = [...links.get(root)!].reverse().slice(0, 25).map((id) => titleOf.get(id));
    assert.deepEqual(out[0].links.map((l) => l.title), expected, "first level, newest first");

    // Each second level is that page's own links, under the same ordering and limit.
    for (const level1 of out[0].links) {
      const id = pages[Number(level1.title.slice("Page ".length))];
      const want = [...links.get(id)!].reverse().slice(0, 25).map((t) => titleOf.get(t));
      assert.deepEqual(level1.links.map((l) => l.title), want, `second level under ${level1.title}`);
    }
  });

  it("maintains a backlink count that matches what points at the page", async () => {
    const { cluster: c, pages, links } = await build(400, 12);
    const db = c.client();

    const inbound = new Map<Id, number>();
    for (const targets of links.values()) {
      for (const to of targets) inbound.set(to, (inbound.get(to) ?? 0) + 1);
    }
    // The most-linked page, which is where a high-degree list would first hurt.
    const hottest = [...inbound].sort((a, b) => b[1] - a[1])[0];
    const out = (await db.query(PAGE_VIEW, [hottest[0]])) as { backlinks: number }[];
    assert.equal(out[0].backlinks, hottest[1], "the maintained count equals the inbound links");
  });

  it("costs one request per host touched, not one per object", async () => {
    const { cluster: c, pages } = await build(400, 12);
    const db = c.client();

    const before = c.calls.exec;
    const answer = await db.answer(PAGE_VIEW, [pages[3]], {});
    const requests = c.calls.exec - before;

    // Two levels at a limit of 25 reaches up to 650 objects. What bounds the requests is the number
    // of hosts those objects sit on, which is what batching per host is for.
    const objects = answer.graph.objects.size;
    assert.ok(objects > 80, `the query should have read a real graph, got ${objects} objects`);
    assert.ok(
      requests <= HOSTS * 3,
      `${requests} requests for ${objects} objects should be bounded by hosts, not objects`,
    );
    assert.ok(requests < objects / 2, `${requests} requests for ${objects} objects is not batching`);
  });

  /**
   * Cross-host links under a planted community structure, placed by whichever key is passed.
   *
   * Nine links in ten stay inside a page's group, which is the structure a graph partitioner looks
   * for and the thing a *metadata* key may or may not happen to line up with. Returns the share of
   * links whose two ends sit on different hosts — the number a read pays for.
   */
  async function crossingShare(groups: number, per: number, degree: number, key: (i: number) => string) {
    const c = new LocalCluster({ batch: VSHARDS, runtime: deterministic(7) });
    c.directory.applyLock(LOCK);
    c.scatter(HOSTS);
    c.spreadCatalog();
    await c.publish();

    const db = c.client();
    const n = groups * per;
    const pages: Id[] = [];
    for (let i = 0; i < n; i++) pages.push(await db.create(PAGE, { title: `Page ${i}` }, { affinity: key(i) }));

    const hostOf = (id: Id) => c.directory.resolve(vshardOf(id))!.host;
    const r = seeded(11);
    let crossing = 0;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const group = Math.floor(i / per);
      for (let d = 0; d < degree; d++) {
        const to = r.int(10) < 9 ? group * per + r.int(per) : r.int(n);
        if (to === i) continue;
        total++;
        if (hostOf(pages[i]) !== hostOf(pages[to])) crossing++;
      }
    }
    return crossing / total;
  }

  it("collapses cross-host links when the key matches the graph, and not when it only describes it", async () => {
    // Same graph, same hosts, same code: only the affinity key differs.
    const byTitle = await crossingShare(40, 20, 12, (i) => `Page ${i}`);
    const byGroup = await crossingShare(40, 20, 12, (i) => `g${Math.floor(i / 20)}`);

    // A title spreads perfectly, which is exactly what makes it a control and not a placement.
    assert.ok(byTitle > 0.9, `a title hash should scatter a clustered graph too, got ${(byTitle * 100).toFixed(1)}%`);
    // The group key is the graph's own structure, so only the 10% of links that leave a group can
    // leave a host.
    assert.ok(byGroup < 0.2, `the group key should keep intra-group links local, got ${(byGroup * 100).toFixed(1)}%`);
    assert.ok(
      byTitle / byGroup > 4,
      `placement should be worth a multiple here, got ${(byTitle / byGroup).toFixed(1)}x`,
    );
  });

  it("reads the same answer through both drivers", async () => {
    const { cluster: c, pages } = await build(200, 10);
    const db = c.client();
    const root = pages[7];
    const rounds = await db.query(PAGE_VIEW, [root], { driver: "rounds" });
    const async_ = await db.query(PAGE_VIEW, [root], { driver: "async" });
    assert.deepEqual(rounds, async_, "the two drivers must agree at this width too");
  });
});
