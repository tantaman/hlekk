import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonical } from "../catalog/catalog.ts";
import type { Json } from "../query/types.ts";
import { seeded } from "../runtime/runtime.ts";
import { assertSound } from "./invariants.ts";
import { FIXED } from "./schema.ts";
import { generateSchema, generateSchemas } from "./schemas.ts";
import type { Shape } from "./shape.ts";
import { EVENTS, collapse, probes, simulate } from "./sim.ts";

/** What a run did, summed, so one test can say the schedule reached everything. */
function tally(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, n] of Object.entries(from)) into[k] = (into[k] ?? 0) + n;
}

const answers = async (sim: Awaited<ReturnType<typeof simulate>>, shape: Shape, seed: number) => {
  const qs = probes(shape, sim.roots, seed);
  const out: string[] = [];
  for (const q of qs) out.push(canonical((await q.run(sim.cluster.client())) as unknown as Json));
  return out;
};

describe("the simulation", () => {
  it("leaves a sound cluster, whatever order it did things in, over 20 schedules", async () => {
    const events: Record<string, number> = {};
    const errors: Record<string, number> = {};
    let checks = 0;
    let hosts = 0;
    let queuedPeak = 0;
    let reads = 0;
    let live = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const sim = await simulate({ shape: FIXED, seed, hosts: 3, steps: 200 });
      assert.equal(sim.cluster.queued(), 0, `seed ${seed}: the outbox never drained after the faults stopped`);
      try {
        assertSound(sim.cluster, { quiesced: true });
      } catch (e) {
        assert.fail(`seed ${seed}: ${(e as Error).message}`);
      }
      tally(events, sim.report.events);
      tally(errors, sim.report.errors);
      checks += sim.report.checks;
      hosts = Math.max(hosts, sim.report.hosts);
      queuedPeak = Math.max(queuedPeak, sim.report.queuedPeak);
      reads += sim.report.reads.ran;
      live += sim.report.live;
    }

    // A schedule that never got round to the interesting things would pass every assertion above.
    assert.deepEqual(
      EVENTS.filter((e) => (events[e] ?? 0) === 0),
      [],
      `some decisions were never made: ${JSON.stringify(events)}`,
    );
    assert.ok(checks > 40, `the invariants should have run mid-flight many times, got ${checks}`);
    assert.ok(hosts >= 5, `the database should have grown past its starting hosts, got ${hosts}`);
    assert.ok(queuedPeak > 0, "an inverse edge should have been waiting in an outbox at some point");
    assert.ok(reads > 100, `reads should have run throughout, got ${reads}`);
    assert.ok(live > 400, `objects should have survived, got ${live}`);

    // The refusals a mutating workload over a moving database has to produce, and nothing else. A
    // name this list has not seen is worth looking at rather than counting.
    assert.ok(errors.VersionConflict > 0, "a read-modify-write should have lost a race");
    assert.ok(errors.ValueTaken > 0, "two callers should have wanted one unique value");
    const known = new Set([
      "VersionConflict",
      "ValueTaken",
      "Error", // no such object: an update or a delete of something a cascade already took
      "MoveFailed", // a step the schedule made fail, or a host it killed
      "StillFenced",
      "TooManyReroutes",
      "Unroutable",
      "NoRoom",
      "Dropped",
      "WriteRefused",
    ]);
    assert.deepEqual(
      Object.keys(errors).filter((name) => !known.has(name)),
      [],
      `unexpected failures: ${JSON.stringify(errors)}`,
    );
  });

  it("answers a read the same once every vshard is on one host, over 10 schedules", async () => {
    for (let seed = 101; seed <= 110; seed++) {
      const sim = await simulate({ shape: FIXED, seed, hosts: 3, steps: 160 });
      const before = await answers(sim, sim.shape, seed);
      assert.ok(before.length > 0, `seed ${seed}: nothing left to read`);
      const spread = new Set(
        sim.cluster.directory.hostIndexes().filter((h) => sim.cluster.directory.vshardsOn(h).length > 0),
      );
      assert.ok(spread.size > 1, `seed ${seed}: the data was on one host already, so collapsing proves nothing`);

      const onto = await collapse(sim.cluster);
      assertSound(sim.cluster, { quiesced: true });
      assert.equal(sim.cluster.directory.vshardsOn(onto).length, totalVshards(sim.cluster), "everything moved");

      const after = await answers(sim, sim.shape, seed);
      for (let i = 0; i < before.length; i++) {
        assert.equal(after[i], before[i], `seed ${seed}: query ${i} answered differently once collapsed onto one host`);
      }
    }
  });

  it("leaves a sound cluster under a network that misbehaves", async () => {
    const errors: Record<string, number> = {};
    for (let seed = 201; seed <= 208; seed++) {
      const sim = await simulate({
        shape: FIXED,
        seed,
        hosts: 3,
        steps: 120,
        faults: { latency: [0, 3], failBefore: 0.03, loseReply: 0.03, staleChunk: 0.2 },
      });
      assert.equal(sim.cluster.queued(), 0, `seed ${seed}: the outbox never drained after the faults stopped`);
      try {
        assertSound(sim.cluster, { quiesced: true });
      } catch (e) {
        assert.fail(`seed ${seed}: ${(e as Error).message}`);
      }
      tally(errors, sim.report.errors);
    }
    assert.ok(errors.Dropped > 0, `the faults have to actually bite, saw ${JSON.stringify(errors)}`);
  });

  it("leaves a sound cluster when the catalog changes under the workload", async () => {
    let migrated = 0;
    let newTypes = 0;
    for (let seed = 401; seed <= 412; seed++) {
      const versions = generateSchemas(seeded(seed ^ 0x3c3c), 3, { onDelete: ["detach", "cascade"] });
      const sim = await simulate({
        shape: versions[0],
        migrations: versions.slice(1),
        seed,
        hosts: 3,
        steps: 160,
      });
      assert.equal(sim.cluster.queued(), 0, `seed ${seed}: the outbox never drained`);
      try {
        assertSound(sim.cluster, { quiesced: true });
      } catch (e) {
        assert.fail(`seed ${seed}: ${(e as Error).message}`);
      }
      assert.equal(sim.report.catalog, 3, `seed ${seed}: the migrations were not all applied`);
      migrated += sim.report.events.migrate ?? 0;
      // Objects of a type that did not exist when the run started: the migration has to have been
      // mid-workload for this to be non-zero.
      newTypes += sim.roots.filter((o) => !(o.type in versions[0].types)).length;

      // And a read still does not depend on placement, over a schema that grew while it was running.
      const before = await answers(sim, sim.shape, seed);
      await collapse(sim.cluster);
      assert.deepEqual(await answers(sim, sim.shape, seed), before, `seed ${seed}: collapsing changed a read`);
    }
    assert.ok(migrated > 0, "the schedule should have applied a migration mid-run");
    assert.ok(newTypes > 0, `objects of the new types should exist, got ${newTypes}`);
  });

  it("leaves a sound cluster under 12 schemas it has never seen", async () => {
    for (let seed = 301; seed <= 312; seed++) {
      const shape = generateSchema(seeded(seed ^ 0x2b2b), { onDelete: ["detach", "cascade"] });
      const sim = await simulate({ shape, seed, hosts: 3, steps: 120 });
      assert.equal(sim.cluster.queued(), 0, `seed ${seed}: the outbox never drained`);
      try {
        assertSound(sim.cluster, { quiesced: true });
      } catch (e) {
        assert.fail(`seed ${seed}: ${(e as Error).message}`);
      }
    }
  });
});

function totalVshards(c: Parameters<typeof collapse>[0]): number {
  return c.directory.hostIndexes().reduce((n, h) => n + c.directory.vshardsOn(h).length, 0);
}
