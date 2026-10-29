// What must be true of a whole cluster, whatever was done to it.
//
// The fuzz suite asked one query and compared the answer. That catches a read that depends on
// placement, and nothing else: a count drifting from its list, a host still serving a vshard it gave
// away, two hosts both claiming one, an inverse edge missing its other half, a sequence that came
// back from a move short — all of those are invisible to a query that happens not to touch them.
//
// These run over the hosts' tables directly, so the only thing a violation can mean is that a write
// path left the database in a state no sequence of operations should be able to reach.

import type { LocalCluster } from "../client/local.ts";
import { MAX_SEQ, fromKey, parseId, vshardOf, vshardRange } from "../host/ids.ts";
import { opTarget } from "../host/host.ts";
import type { OutboxOp, State } from "../host/host.ts";
import { listKey } from "../query/types.ts";
import type { Id } from "../query/types.ts";

export interface Violation {
  /** The invariant, so a failure names the property rather than the row. */
  what: string;
  detail: string;
}

interface Options {
  /** True when the outbox is known to be empty. An inverse edge bound for another vshard is written
   *  on delivery, so its other half is legitimately missing until then. */
  quiesced?: boolean;
}

interface VshardRow {
  vshard: number;
  epoch: number;
  state: State;
  next_seq: number;
}

export function check(c: LocalCluster, opts: Options = {}): Violation[] {
  const bad: Violation[] = [];
  const say = (what: string, detail: string) => bad.push({ what, detail });

  /** Every host's vshards row, by host. */
  const held = new Map<number, VshardRow[]>();
  for (const [index, host] of c.hosts) {
    held.set(index, host.sql.all<VshardRow>("SELECT vshard, epoch, state, next_seq FROM vshards"));
  }

  // ---- one owner, and the directory agrees with it

  const assigned = c.directory.hostIndexes().flatMap((h) => c.directory.vshardsOn(h));
  for (const vshard of assigned) {
    // A move is a deliberate window where both hosts hold the rows: the source fenced, the target
    // owned at the next epoch and nothing routed to it yet.
    if (c.mover.pending(vshard)) continue;
    const route = c.directory.resolve(vshard)!;
    const owners: number[] = [];
    for (const [index, rows] of held) {
      const row = rows.find((r) => BigInt(r.vshard) === vshard);
      if (!row || row.state === "moved") continue;
      owners.push(index);
      if (index === route.host && (row.state !== "owned" || row.epoch !== route.epoch)) {
        say(
          "the host the directory names owns the vshard at the epoch it names",
          `vshard ${vshard} is routed to host ${index} at epoch ${route.epoch}, which holds it ${row.state} at ${row.epoch}`,
        );
      }
    }
    if (owners.length !== 1 || owners[0] !== route.host) {
      say(
        "exactly one host serves a vshard",
        `vshard ${vshard} is routed to host ${route.host} and served by [${owners.join(", ")}]`,
      );
    }
  }

  // ---- a host holds nothing outside its own vshards, and hands out ids past the ones it holds

  for (const [index, host] of c.hosts) {
    const mine = new Set(held.get(index)!.map((r) => BigInt(r.vshard)));
    const outside = (what: string, v: bigint, detail: string) => {
      if (!mine.has(v)) say("a host holds rows only for vshards it has", `host ${index} holds ${what} for vshard ${v}: ${detail}`);
    };
    for (const row of host.sql.all<{ id: Uint8Array }>("SELECT id FROM objects")) {
      outside("an object", vshardOf(fromKey(row.id)), fromKey(row.id));
    }
    for (const row of host.sql.all<{ id1: Uint8Array }>("SELECT DISTINCT id1 FROM assocs")) {
      outside("an edge", vshardOf(fromKey(row.id1)), fromKey(row.id1));
    }
    for (const row of host.sql.all<{ id1: Uint8Array }>("SELECT DISTINCT id1 FROM assoc_counts")) {
      outside("a count", vshardOf(fromKey(row.id1)), fromKey(row.id1));
    }
    for (const row of host.sql.all<{ vshard: number }>("SELECT DISTINCT vshard FROM outbox")) {
      outside("an outbox row", BigInt(row.vshard), "queued work");
    }
    for (const row of host.sql.all<{ vshard: number }>("SELECT DISTINCT vshard FROM index_entries")) {
      outside("an index entry", BigInt(row.vshard), "an index entry");
    }

    for (const row of held.get(index)!) {
      // A move carries next_seq with it; one that did not would hand out an id already in use.
      const top = host.sql.all<{ id: Uint8Array }>(
        "SELECT id FROM objects WHERE id BETWEEN ? AND ? ORDER BY id DESC LIMIT 1",
        ...vshardRange(BigInt(row.vshard)),
      )[0];
      if (!top) continue;
      const seq = parseId(fromKey(top.id)) & MAX_SEQ;
      if (BigInt(row.next_seq) <= seq) {
        say(
          "a vshard's sequence is past every id it holds",
          `host ${index} vshard ${row.vshard} is at next_seq ${row.next_seq} and holds sequence ${seq}`,
        );
      }
    }
  }

  // ---- counts are the length of the list they count

  for (const [index, host] of c.hosts) {
    const rows = new Map<string, number>();
    for (const r of host.sql.all<{ id1: Uint8Array; atype: number; n: number }>(
      "SELECT id1, atype, COUNT(*) AS n FROM assocs GROUP BY id1, atype",
    )) {
      rows.set(listKey(fromKey(r.id1), r.atype), r.n);
    }
    const counted = new Map<string, number>();
    for (const r of host.sql.all<{ id1: Uint8Array; atype: number; n: number }>("SELECT id1, atype, n FROM assoc_counts")) {
      const k = listKey(fromKey(r.id1), r.atype);
      counted.set(k, r.n);
      if (r.n < 0) say("a count is never negative", `host ${index} ${k} is at ${r.n}`);
    }
    for (const k of new Set([...rows.keys(), ...counted.keys()])) {
      const n = counted.get(k) ?? 0;
      const actual = rows.get(k) ?? 0;
      if (n !== actual) {
        say("a maintained count is the length of the list it counts", `host ${index} ${k} counts ${n} and holds ${actual}`);
      }
    }
  }

  // ---- queued work says where it is bound, and an index entry says what it holds

  for (const [index, host] of c.hosts) {
    for (const r of host.sql.all<{ vshard: number; seq: number; target_vshard: number; op: string }>(
      "SELECT vshard, seq, target_vshard, op FROM outbox",
    )) {
      const op = JSON.parse(r.op) as OutboxOp;
      if (opTarget(op) !== BigInt(r.target_vshard)) {
        say(
          "an outbox row is bound for the vshard its op names",
          `host ${index} row ${r.vshard}/${r.seq} is bound for ${r.target_vshard} and its op targets ${opTarget(op)}`,
        );
      }
    }
    for (const r of host.sql.all<{ idx: number; key: string; id: Uint8Array | null; state: string }>(
      "SELECT idx, key, id, state FROM index_entries",
    )) {
      const confirmed = r.state === "confirmed";
      if (confirmed === (r.id === null)) {
        say(
          "a confirmed index entry points at an object and a reservation points at nothing",
          `host ${index} index ${r.idx} ${JSON.stringify(r.key)} is ${r.state} with id ${r.id === null ? "null" : fromKey(r.id)}`,
        );
      }
    }
  }

  // ---- every inverse edge has its other half

  if (opts.quiesced) {
    const all = new Map<string, Set<Id>>();
    for (const host of c.hosts.values()) {
      for (const r of host.sql.all<{ id1: Uint8Array; atype: number; id2: Uint8Array }>("SELECT id1, atype, id2 FROM assocs")) {
        const k = listKey(fromKey(r.id1), r.atype);
        (all.get(k) ?? all.set(k, new Set()).get(k)!).add(fromKey(r.id2));
      }
    }
    const catalog = c.directory.catalog();
    for (const [k, targets] of all) {
      const cut = k.lastIndexOf(":");
      const id1 = k.slice(0, cut);
      const atype = Number(k.slice(cut + 1));
      const inverse = catalog.inverseOf(atype);
      if (inverse === undefined) continue;
      for (const id2 of targets) {
        if (!all.get(listKey(id2, inverse))?.has(id1)) {
          say(
            "a paired edge type has both halves once the outbox is empty",
            `${id1} -${atype}-> ${id2} has no ${id2} -${inverse}-> ${id1}`,
          );
        }
      }
    }
  }

  return bad;
}

/** Throws naming the property that broke, and the first few rows that broke it. */
export function assertSound(c: LocalCluster, opts: Options = {}): void {
  const bad = check(c, opts);
  if (bad.length === 0) return;
  const by = new Map<string, string[]>();
  for (const v of bad) by.set(v.what, [...(by.get(v.what) ?? []), v.detail]);
  const lines = [...by].map(([what, details]) => `${what}\n    ${details.slice(0, 4).join("\n    ")}${details.length > 4 ? `\n    ... and ${details.length - 4} more` : ""}`);
  throw new Error(`${bad.length} violation(s):\n  ${lines.join("\n  ")}`);
}
