// A reference model of the write path, in one process and with no placement in it at all.
//
// The differential oracle compares a cluster against itself laid out differently, so a semantics bug
// that both layouts share — a count that drifts, an inverse withdrawn twice, a cascade that stops one
// hop short — passes it. This is the other oracle: what the data should be, derived from the script
// and the catalog's rules rather than from the system under test.
//
// It is deliberately dumb. Maps and arrays, no vshards, no epochs, no outbox: every inverse edge and
// every cascade lands the instant the operation that caused it does. Which is also what the cluster
// converges to, once its outbox is empty — so it is only a fair comparison at a quiesced point, and
// `replay`'s settle hook is what gets the cluster to one.

import { Catalog } from "../catalog/catalog.ts";
import type { Lock } from "../catalog/catalog.ts";
import { MAX_SEQ, makeId, vshardOf } from "../host/ids.ts";
import { cmpId } from "../query/types.ts";
import type { Fields, Id } from "../query/types.ts";

/** An object as the model holds it. */
export interface Stored {
  id: Id;
  otype: number;
  version: number;
  data: Fields;
}

export interface Held {
  id2: Id;
  time: number;
  data: Fields | null;
}

/** Refused for the same reason the host would refuse it. The name matches the error the client
 *  raises, so a model outcome and a replay outcome compare directly. */
export class ModelRefusal extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

const key = (id1: Id, atype: number) => `${id1}:${atype}`;

export class Model {
  readonly catalog: Catalog;
  readonly objects = new Map<Id, Stored>();
  /** id1:atype to its edges, by id2. Insertion order is not the read order; `list` sorts. */
  readonly edges = new Map<string, Map<Id, Held>>();
  /** Maintained alongside the edge write, as the host does. A count can outlive what a read of the
   *  same list yields: a delete leaves edges pointing at nothing, and only a read drops those. */
  readonly counts = new Map<string, number>();
  readonly #next = new Map<string, bigint>();

  constructor(lock: Lock) {
    this.catalog = Catalog.compile(lock);
  }

  // ---- mutations

  /** `at` is a vshard, or an object whose vshard the new object takes. */
  create(otype: number, data: Fields, at: { vshard: string } | { with: Id }): Id {
    const vshard = "with" in at ? vshardOf(at.with) : BigInt(at.vshard);
    const seq = this.#next.get(vshard.toString()) ?? 0n;
    if (seq > MAX_SEQ) throw new ModelRefusal("Error", `vshard ${vshard} has no sequence left`);
    this.#next.set(vshard.toString(), seq + 1n);
    const id = makeId(vshard, seq);
    this.objects.set(id, { id, otype, version: 1, data: { ...data } });
    return id;
  }

  update(id: Id, data: Fields, expect?: number): number {
    const o = this.objects.get(id);
    if (!o) throw new ModelRefusal("Error", `no such object: ${id}`);
    if (expect !== undefined && o.version !== expect) {
      throw new ModelRefusal("VersionConflict", `${id} is at version ${o.version}, not the ${expect} this write expected`);
    }
    o.version += 1;
    o.data = { ...data };
    return o.version;
  }

  delete(id: Id): void {
    this.#erase(id, new Set());
  }

  assocAdd(atype: number, id1: Id, id2: Id, time: number, data: Fields | null = null): void {
    // No existence check, as the host has none: an edge may be written from or to an object that is
    // not there, and a read is what drops it.
    this.#put(atype, id1, id2, time, data);
    const inverse = this.catalog.inverseOf(atype);
    if (inverse !== undefined) this.#put(inverse, id2, id1, time, data);
  }

  assocRemove(atype: number, id1: Id, id2: Id): void {
    this.#drop(atype, id1, id2);
    const inverse = this.catalog.inverseOf(atype);
    if (inverse !== undefined) this.#drop(inverse, id2, id1);
  }

  // ---- reads

  object(id: Id): Stored | undefined {
    return this.objects.get(id);
  }

  /** An edge list in the order a host serves it: newest first, id2 breaking ties. */
  list(id1: Id, atype: number): Held[] {
    const held = this.edges.get(key(id1, atype));
    return held === undefined
      ? []
      : [...held.values()].sort((a, b) => (a.time !== b.time ? b.time - a.time : -cmpId(a.id2, b.id2)));
  }

  count(id1: Id, atype: number): number {
    return this.counts.get(key(id1, atype)) ?? 0;
  }

  /** Every list the model holds, for comparing a whole cluster against it. */
  lists(): { id1: Id; atype: number }[] {
    return [...this.edges.keys()].map((k) => {
      const cut = k.lastIndexOf(":");
      return { id1: k.slice(0, cut), atype: Number(k.slice(cut + 1)) };
    });
  }

  /** Every maintained count, including ones whose list is empty. */
  counted(): { id1: Id; atype: number; n: number }[] {
    return [...this.counts].map(([k, n]) => {
      const cut = k.lastIndexOf(":");
      return { id1: k.slice(0, cut), atype: Number(k.slice(cut + 1)), n };
    });
  }

  // ---- internals

  /** Applies each of the object's edge types' onDelete. Every restrict is checked before anything is
   *  written, so a held-back delete leaves no trace. */
  #erase(id: Id, seen: Set<Id>): void {
    if (seen.has(id)) return;
    seen.add(id);
    const o = this.objects.get(id);
    if (!o) return;
    const types = this.catalog.edgesFrom(o.otype);
    const lists = types.map((e) => ({ edge: e, targets: this.list(id, e.atype!).map((h) => h.id2) }));
    for (const { edge, targets } of lists) {
      if (edge.onDelete === "restrict" && targets.length > 0) {
        throw new ModelRefusal("WriteRefused", `delete refused: ${id} still has ${edge.name} edges`);
      }
    }
    for (const { edge, targets } of lists) {
      const inverse = this.catalog.inverseOf(edge.atype!);
      for (const t of targets) {
        // Withdraw the inverse this object's edge put on the other side.
        if (inverse !== undefined) this.#drop(inverse, t, id);
        if (edge.onDelete === "cascade") this.#erase(t, seen);
      }
    }
    this.objects.delete(id);
    // Every list this object held, not only the types the catalog declares from it: the host drops
    // its whole key range, and nothing stops an edge being written under an atype declared from
    // somewhere else.
    for (const k of [...this.edges.keys()]) if (k.slice(0, k.lastIndexOf(":")) === id) this.edges.delete(k);
    for (const k of [...this.counts.keys()]) if (k.slice(0, k.lastIndexOf(":")) === id) this.counts.delete(k);
  }

  #put(atype: number, id1: Id, id2: Id, time: number, data: Fields | null): void {
    const k = key(id1, atype);
    const held = this.edges.get(k) ?? new Map<Id, Held>();
    this.edges.set(k, held);
    const existed = held.has(id2);
    held.set(id2, { id2, time, data: data === null ? null : { ...data } });
    if (!existed) this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }

  #drop(atype: number, id1: Id, id2: Id): void {
    const k = key(id1, atype);
    const held = this.edges.get(k);
    if (!held?.has(id2)) return;
    held.delete(id2);
    if (held.size === 0) this.edges.delete(k);
    this.counts.set(k, Math.max(0, (this.counts.get(k) ?? 0) - 1));
  }
}
