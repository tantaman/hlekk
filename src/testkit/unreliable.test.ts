import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonical } from "../catalog/catalog.ts";
import { Hlekk } from "../client/client.ts";
import { LocalCluster } from "../client/local.ts";
import { Deliverer } from "../host/outbox.ts";
import type { Json } from "../query/types.ts";
import { deterministic, seeded } from "../runtime/runtime.ts";
import { generateGraph, generateQuery, replay } from "./generate.ts";
import { Comment, Issue, LOCK, User, issueComments, issueOwner, userOwned } from "./schema.ts";
import { Dropped, unreliable } from "./unreliable.ts";
import type { Faults } from "./unreliable.ts";

async function cluster(seed: number, hosts = 3): Promise<LocalCluster> {
  const c = new LocalCluster({ batch: 64, runtime: deterministic(seed) });
  c.directory.applyLock(LOCK);
  c.spreadCatalog();
  for (let h = 1; h < hosts; h++) c.directory.addHost(h);
  await c.publish();
  return c;
}

/** The same cluster reached over a network that misbehaves. Faults draw on their own seeded stream,
 *  not the cluster's: sharing one makes which calls fail depend on how much setup happened to consume,
 *  which is how a fault rate silently becomes zero. */
const over = (c: LocalCluster, faults: Faults, faultSeed = 1) => {
  const sim = unreliable(c.transport, { clock: c.runtime.clock, random: seeded(faultSeed) }, faults);
  return { sim, db: Hlekk.from(sim, c.runtime.clock) };
};

/** A graph laid down and spread over the hosts, with the answer to one query recorded. */
async function scene(seed: number) {
  const c = await cluster(seed);
  const script = generateGraph(seeded(seed), { objects: 20, vshards: 5, edges: 24 });
  const laid = await replay(c.client(), script);
  await c.deliverAll();
  const r = seeded(seed ^ 0x33);
  for (const vshard of script.vshards) {
    const to = 1 + r.int(2);
    c.mover.begin(BigInt(vshard), to);
    await c.mover.run(BigInt(vshard));
  }
  c.spreadCatalog();
  await c.publish();

  const root = laid.ids[laid.types.findIndex((t) => t === "Issue")] ?? laid.ids[0];
  const build = () => generateQuery(seeded(seed ^ 0x77), "Issue", Issue.gen(root) as never, { depth: 3 });
  const truth = canonical((await build().run(c.client())) as unknown as Json);
  return { c, root, build, truth };
}

describe("reads over a network", () => {
  it("answer the same under latency and reordered replies", async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { c, build, truth } = await scene(seed);
      // Unequal latencies, so replies from different hosts arrive in a different order each time.
      const { sim, db } = over(c, { latency: [1, 40] }, seed);
      const got = canonical((await build().run(db)) as unknown as Json);
      assert.equal(got, truth, `seed ${seed}: latency changed the answer`);
      assert.ok(sim.counts.calls > 1, "the query really did cross the network");
    }
  });

  it("either answer correctly or fail, and never answer wrongly", async () => {
    let answered = 0;
    let failed = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const { c, build, truth } = await scene(seed);
      const { sim, db } = over(c, { latency: [1, 20], failBefore: 0.2 }, seed);
      try {
        const got = canonical((await build().run(db)) as unknown as Json);
        // A short answer is not a fact: if it came back, it has to be the whole answer.
        assert.equal(got, truth, `seed ${seed}: a dropped request turned into a wrong answer`);
        answered++;
      } catch (e) {
        assert.ok(e instanceof Dropped || e instanceof Error, `seed ${seed}: unexpected ${String(e)}`);
        failed++;
      }
      void sim;
    }
    assert.ok(failed > 0, "the faults have to actually bite");
    assert.ok(answered > 0, "and not every time, or this proves nothing");
  });

  it("answer correctly through a stale published chunk, by being refused and re-routing", async () => {
    const { c, build, truth } = await scene(31);
    const { sim, db } = over(c, { latency: [1, 10], staleChunk: 1 });
    await build().run(db); // fills the chunk cache, so there is a previous version to serve

    // Move everything again, publish, and let the map read keep handing back the old bytes.
    for (const vshard of c.directory.vshardsOn(1)) {
      c.mover.begin(vshard, 2);
      await c.mover.run(vshard);
    }
    c.spreadCatalog();
    await c.publish();

    const fresh = Hlekk.from(unreliable(c.transport, c.runtime, { staleChunk: 1 }), c.runtime.clock);
    const got = canonical((await build().run(fresh)) as unknown as Json);
    assert.equal(got, truth, "a stale map cost a round, not the answer");
    void sim;
  });
});

describe("the outbox over a network", () => {
  it("converges under randomly dropped acknowledgements, counting each inverse once", async () => {
    const c = await cluster(7);
    const db = c.client();
    // Issues on one vshard, owners on another, moved apart so every inverse is remote.
    c.mover.begin(40n, 1);
    await c.mover.run(40n);
    c.spreadCatalog();
    await c.publish();

    const users: string[] = [];
    for (let i = 0; i < 12; i++) users.push(await db.create(User.otype, { name: `u${i}`, rank: i }, { vshard: "40" }));
    const issues: string[] = [];
    for (let i = 0; i < 12; i++) {
      const issue = await db.create(Issue.otype, { title: `t${i}`, status: "open" }, { vshard: "5" });
      await db.assocAdd(issueOwner.atype, issue, users[i], i);
      issues.push(issue);
    }
    assert.ok(c.queued() >= 12, "every inverse is bound for the other host");

    // Delivery over a transport that loses half its replies after the write landed, so the alarm
    // redelivers ops the target has already applied.
    const { sim, db: lossy } = over(c, { latency: [1, 5], loseReply: 0.5 });
    for (let pass = 0; pass < 40 && c.queued() > 0; pass++) {
      await new Deliverer(c.host(0), lossy).drain().catch(() => {});
    }
    assert.equal(c.queued(), 0, "it got there");
    assert.ok(sim.counts.lostReplies > 0, "and some acks really were lost");

    const owned = c.directory.resolve(40n)!.host;
    for (const user of users) {
      assert.equal(
        await c.host(owned).store().count(user, userOwned.atype),
        1,
        "each inverse counted once, however many times it was delivered",
      );
    }
    void issues;
  });
});

describe("a write whose reply is lost", () => {
  it("surfaces rather than being retried, because a create cannot be repeated safely", async () => {
    const c = await cluster(11, 1);
    const { db } = over(c, { loseReply: 1 });
    await assert.rejects(() => db.create(Issue.otype, { title: "t", status: "open" }, { vshard: "5" }), Dropped);

    // The object is there: the write landed and only the reply went missing. The client does not
    // retry, because retrying a create makes a second object; there is no idempotency key for one.
    const rows = c.host(0).sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM objects");
    assert.equal(rows[0].n, 1, "exactly one object, not none and not two");
  });

  it("is safe to retry for an edge write, which is an upsert", async () => {
    const c = await cluster(13, 1);
    const db = c.client();
    const issue = await db.create(Issue.otype, { title: "t", status: "open" }, { vshard: "5" });
    const comment = await db.create(Comment.otype, { body: "b", score: 1, authorId: issue }, { with: issue });

    const { db: lossy } = over(c, { loseReply: 1 });
    await assert.rejects(() => lossy.assocAdd(issueComments.atype, issue, comment, 1), Dropped);
    // The caller retries, which is sound here: add is an upsert and the count moves once.
    await db.assocAdd(issueComments.atype, issue, comment, 1);
    assert.equal(await c.host(0).store().count(issue, issueComments.atype), 1);
  });
});
