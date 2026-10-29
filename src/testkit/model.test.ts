import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonical } from "../catalog/catalog.ts";
import { LocalCluster } from "../client/local.ts";
import { fromKey, toKey, vshardOf, vshardRange } from "../host/ids.ts";
import type { Fields, Id } from "../query/types.ts";
import { listKey } from "../query/types.ts";
import { deterministic, seeded } from "../runtime/runtime.ts";
import { generateGraph, replay } from "./generate.ts";
import type { Script } from "./generate.ts";
import { assertSound, check } from "./invariants.ts";
import { Model } from "./model.ts";
import type { Held, Stored } from "./model.ts";
import { FIXED } from "./schema.ts";
import { generateSchema } from "./schemas.ts";
import type { Shape } from "./shape.ts";

async function cluster(seed: number, shape: Shape, hosts: number): Promise<LocalCluster> {
  const c = new LocalCluster({ batch: 64, runtime: deterministic(seed) });
  c.directory.applyLock(shape.lock);
  if (hosts > 1) c.scatter(hosts);
  c.spreadCatalog();
  await c.publish();
  return c;
}

/** Everything the cluster holds, read from the host the directory names for each vshard. Not through
 *  a query: what is being compared is the state a write path left behind, and a read of it would
 *  apply the read path's own rules on top — a dropped edge to a missing object, a filter, a limit. */
interface Gathered {
  objects: Map<Id, Stored>;
  edges: Map<string, Held[]>;
  counts: Map<string, number>;
}

function gather(c: LocalCluster): Gathered {
  const objects = new Map<Id, Stored>();
  const edges = new Map<string, Held[]>();
  const counts = new Map<string, number>();
  for (const index of c.directory.hostIndexes()) {
    for (const vshard of c.directory.vshardsOn(index)) {
      const host = c.host(index);
      const [lo, hi] = vshardRange(vshard);
      for (const r of host.sql.all<{ id: Uint8Array; otype: number; version: number; data: string }>(
        "SELECT id, otype, version, data FROM objects WHERE id BETWEEN ? AND ?",
        lo,
        hi,
      )) {
        const id = fromKey(r.id);
        objects.set(id, { id, otype: r.otype, version: r.version, data: JSON.parse(r.data) as Fields });
      }
      for (const r of host.sql.all<{ id1: Uint8Array; atype: number; id2: Uint8Array; time: number; data: string | null }>(
        "SELECT id1, atype, id2, time, data FROM assocs WHERE id1 BETWEEN ? AND ? ORDER BY id1, atype, time DESC, id2 DESC",
        lo,
        hi,
      )) {
        const k = listKey(fromKey(r.id1), r.atype);
        edges.set(k, [
          ...(edges.get(k) ?? []),
          { id2: fromKey(r.id2), time: r.time, data: r.data === null ? null : (JSON.parse(r.data) as Fields) },
        ]);
      }
      for (const r of host.sql.all<{ id1: Uint8Array; atype: number; n: number }>(
        "SELECT id1, atype, n FROM assoc_counts WHERE id1 BETWEEN ? AND ?",
        lo,
        hi,
      )) {
        counts.set(listKey(fromKey(r.id1), r.atype), r.n);
      }
    }
  }
  return { objects, edges, counts };
}

/** Replays one script into a cluster and into the model, keeping the cluster at a quiesced point
 *  between operations so the two are comparable: the model writes an inverse edge the instant the
 *  operation that caused it lands, and the cluster does too once its outbox is empty. */
async function both(seed: number, shape: Shape, hosts: number, script: Script) {
  const c = await cluster(seed, shape, hosts);
  const model = new Model(shape.lock);
  let carried = 0;
  const laid = await replay(c.client(), shape, script, async () => {
    carried += await c.deliverAll();
  });
  assert.equal(c.queued(), 0, `seed ${seed}: the outbox did not drain, so nothing can be compared`);

  // The same script against the model, by position, so a refusal can be compared too.
  const ids: Id[] = [];
  const outcomes: ({ ok: true } | { ok: false; error: string })[] = [];
  const fill = (w: { data: Fields; refs: Record<string, number> }): Fields => {
    const data = { ...w.data };
    for (const [field, at] of Object.entries(w.refs)) data[field] = ids[at];
    return data;
  };
  for (const op of script.ops) {
    try {
      switch (op.kind) {
        case "create":
          ids.push(model.create(shape.types[op.type].otype, fill(op), { vshard: op.vshard }));
          break;
        case "with":
          ids.push(model.create(shape.types[op.type].otype, fill(op), { with: ids[op.parent] }));
          break;
        case "update":
          model.update(ids[op.at], fill(op), op.expect === null ? undefined : op.expect);
          break;
        case "erase":
          model.delete(ids[op.at]);
          break;
        case "assoc":
          model.assocAdd(op.atype, ids[op.from], ids[op.to], op.time, op.data);
          break;
        case "unassoc":
          model.assocRemove(op.atype, ids[op.from], ids[op.to]);
          break;
      }
      outcomes.push({ ok: true });
    } catch (e) {
      outcomes.push({ ok: false, error: e instanceof Error ? e.name : String(e) });
    }
  }
  return { c, model, laid, modelIds: ids, modelOutcomes: outcomes, carried };
}

/** Where the cluster and the model differ. Named by what differs, so a failure reads as a property. */
function differences(got: Gathered, model: Model): string[] {
  const out: string[] = [];
  const ids = new Set([...got.objects.keys(), ...model.objects.keys()]);
  for (const id of ids) {
    const a = got.objects.get(id);
    const b = model.objects.get(id);
    if (!a || !b) {
      out.push(`${id} is ${a ? "stored" : "absent"} in the cluster and ${b ? "stored" : "absent"} in the model`);
      continue;
    }
    if (a.otype !== b.otype || a.version !== b.version || canonical(a.data) !== canonical(b.data)) {
      out.push(`${id} is ${canonical(a)} in the cluster and ${canonical(b)} in the model`);
    }
  }

  const lists = new Set([...got.edges.keys(), ...model.lists().map((l) => listKey(l.id1, l.atype))]);
  for (const k of lists) {
    const cut = k.lastIndexOf(":");
    const held = model.list(k.slice(0, cut), Number(k.slice(cut + 1)));
    const mine = got.edges.get(k) ?? [];
    if (canonical(mine as never) !== canonical(held as never)) {
      out.push(`${k} holds ${canonical(mine as never)} in the cluster and ${canonical(held as never)} in the model`);
    }
  }

  const counted = new Set([...got.counts.keys(), ...model.counted().map((l) => listKey(l.id1, l.atype))]);
  for (const k of counted) {
    const cut = k.lastIndexOf(":");
    const b = model.count(k.slice(0, cut), Number(k.slice(cut + 1)));
    const a = got.counts.get(k) ?? 0;
    if (a !== b) out.push(`${k} counts ${a} in the cluster and ${b} in the model`);
  }
  return out;
}

const workload = (seed: number, shape: Shape): Script => {
  const r = seeded(seed);
  return generateGraph(r, shape, {
    objects: 20 + r.int(12),
    vshards: 3 + r.int(5),
    edges: 24 + r.int(16),
    updates: 4 + r.int(6),
    removes: 2 + r.int(6),
    deletes: 2 + r.int(4),
  });
};

describe("the reference model", () => {
  it("is what a cluster over six hosts ends up holding, over 40 random workloads", async () => {
    let objects = 0;
    let edges = 0;
    let carried = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const shape = FIXED;
      const run = await both(seed, shape, 6, workload(seed, shape));
      assert.deepEqual(run.laid.ids, run.modelIds, `seed ${seed}: the model handed out different ids`);
      assert.deepEqual(
        run.laid.outcomes,
        run.modelOutcomes,
        `seed ${seed}: the cluster and the model disagreed about which operations were refused`,
      );
      const got = gather(run.c);
      assert.deepEqual(differences(got, run.model), [], `seed ${seed}: the cluster and the model hold different data`);
      objects += got.objects.size;
      edges += [...got.edges.values()].reduce((n, l) => n + l.length, 0);
      carried += run.carried;
    }
    // A comparison over an empty database would pass too.
    assert.ok(objects > 600, `expected the workloads to leave objects behind, got ${objects}`);
    assert.ok(edges > 600, `expected edges too, got ${edges}`);
    assert.ok(carried > 100, `expected inverse edges to have crossed hosts, got ${carried}`);
  });

  it("is what a cluster ends up holding under 30 schemas it has never seen", async () => {
    for (let seed = 501; seed <= 530; seed++) {
      const shape = generateSchema(seeded(seed ^ 0x77), { onDelete: ["detach", "cascade"] });
      const run = await both(seed, shape, 4, workload(seed, shape));
      assert.deepEqual(run.laid.ids, run.modelIds, `seed ${seed}: the model handed out different ids`);
      assert.deepEqual(run.laid.outcomes, run.modelOutcomes, `seed ${seed}: they disagreed about refusals`);
      assert.deepEqual(
        differences(gather(run.c), run.model),
        [],
        `seed ${seed}: the cluster and the model hold different data`,
      );
    }
  });

  it("agrees with a cluster on one host, so a difference over six is about placement", async () => {
    for (let seed = 61; seed <= 80; seed++) {
      const run = await both(seed, FIXED, 1, workload(seed, FIXED));
      assert.deepEqual(differences(gather(run.c), run.model), [], `seed ${seed}: one host already disagreed`);
      assert.equal(run.carried, 0, "a database on one host writes every inverse inline");
    }
  });
});

describe("the invariants", () => {
  it("hold after a mutating workload, however many hosts it was spread over", async () => {
    for (let seed = 1; seed <= 25; seed++) {
      for (const hosts of [1, 3, 6]) {
        const run = await both(seed, FIXED, hosts, workload(seed, FIXED));
        try {
          assertSound(run.c, { quiesced: true });
        } catch (e) {
          assert.fail(`seed ${seed} over ${hosts} hosts: ${(e as Error).message}`);
        }
      }
    }
  });

  it("hold under 30 schemas it has never seen", async () => {
    for (let seed = 601; seed <= 630; seed++) {
      const shape = generateSchema(seeded(seed ^ 0x99), { onDelete: ["detach", "cascade"] });
      const run = await both(seed, shape, 4, workload(seed, shape));
      try {
        assertSound(run.c, { quiesced: true });
      } catch (e) {
        assert.fail(`seed ${seed}: ${(e as Error).message}`);
      }
    }
  });

  it("catch a count that has drifted from its list", async () => {
    const run = await both(3, FIXED, 3, workload(3, FIXED));
    const [k] = [...gather(run.c).counts.keys()];
    const cut = k.lastIndexOf(":");
    const id1 = k.slice(0, cut);
    const host = run.c.host(run.c.directory.resolve(vshardOf(id1))!.host);
    host.sql.run("UPDATE assoc_counts SET n = n + 7 WHERE id1 = ? AND atype = ?", toKey(id1), Number(k.slice(cut + 1)));
    const bad = check(run.c, { quiesced: true });
    assert.ok(
      bad.some((v) => v.what.startsWith("a maintained count")),
      `expected the count invariant to fire, got ${JSON.stringify(bad)}`,
    );
  });

  it("catch a vshard two hosts both serve", async () => {
    const run = await both(4, FIXED, 3, workload(4, FIXED));
    const vshard = run.c.directory.vshardsOn(1)[0];
    const other = run.c.host(2);
    other.adopt(vshard.toString(), run.c.directory.resolve(vshard)!.epoch);
    const bad = check(run.c, { quiesced: true });
    assert.ok(
      bad.some((v) => v.what.startsWith("exactly one host")),
      `expected the ownership invariant to fire, got ${JSON.stringify(bad)}`,
    );
  });

  it("catch an inverse edge whose other half never arrived", async () => {
    const run = await both(5, FIXED, 3, workload(5, FIXED));
    // Drop one half directly, as a lost outbox row would have.
    for (const host of run.c.hosts.values()) {
      const row = host.sql.all<{ id1: Uint8Array; atype: number; id2: Uint8Array }>(
        "SELECT id1, atype, id2 FROM assocs LIMIT 1",
      )[0];
      if (!row || run.c.directory.catalog().inverseOf(row.atype) === undefined) continue;
      host.sql.run("DELETE FROM assocs WHERE id1 = ? AND atype = ? AND id2 = ?", row.id1, row.atype, row.id2);
      host.sql.run("UPDATE assoc_counts SET n = n - 1 WHERE id1 = ? AND atype = ?", row.id1, row.atype);
      const bad = check(run.c, { quiesced: true });
      assert.ok(
        bad.some((v) => v.what.startsWith("a paired edge type")),
        `expected the inverse invariant to fire, got ${JSON.stringify(bad)}`,
      );
      return;
    }
    assert.fail("the workload held no paired edge to break");
  });
});
