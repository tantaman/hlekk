// What a client needs from the outside world: hosts, the published map, and the directory behind it.
// In production these are DO stubs and a KV binding; in tests they are the objects themselves.

import type { Catalog } from "../catalog/catalog.ts";
// Type-only, and erased, so naming the host here makes no runtime cycle with it.
import type { AssocAddManyEdge, ExecReply, Host, OutboxOp, Reply, Routed } from "../host/host.ts";
import type { Route } from "../directory/map.ts";
import type { Fields, Id, Miss, Plan } from "../query/types.ts";

/** A mutation as the caller states it. The client fills in the epoch it routed with. */
export type Mutation =
  | { kind: "create"; otype: number; data: Fields; with?: Id; vshard?: string }
  | { kind: "update"; id: Id; data: Fields; expect?: number }
  | { kind: "delete"; id: Id }
  | { kind: "assocAdd"; atype: number; id1: Id; db?: number; id2: Id; time?: number; data?: Fields | null }
  // Many adds, one transaction, one durable commit. Every edge must share a vshard, because the
  // batch is routed and fenced by the first of them; `Client.assocAddMany` is what groups them.
  | { kind: "assocAddMany"; edges: readonly AssocAddManyEdge[] }
  | { kind: "assocRemove"; atype: number; id1: Id; db?: number; id2: Id }
  | { kind: "apply"; op: OutboxOp }
  | { kind: "indexReserve"; vshard: string; idx: number; key: string; now: number; ttlMs: number }
  | { kind: "indexConfirm"; vshard: string; idx: number; key: string; id: Id }
  | { kind: "indexRelease"; vshard: string; idx: number; key: string };

/** Which vshard a mutation is routed by: the one whose host must own it to accept the write. */
export function anchorOf(m: Mutation): { kind: "vshard"; vshard: string } | { kind: "id"; id: Id } {
  switch (m.kind) {
    case "create":
      return m.with !== undefined ? { kind: "id", id: m.with } : { kind: "vshard", vshard: m.vshard! };
    case "update":
    case "delete":
      return { kind: "id", id: m.id };
    case "assocAdd":
    case "assocRemove":
      return { kind: "id", id: m.id1 };
    case "assocAddMany": {
      const first = m.edges[0];
      // An empty batch has no anchor, so it cannot be routed. Refusing beats picking a host.
      if (first === undefined) throw new TypeError("assocAddMany needs at least one edge to route by");
      return { kind: "id", id: first.id1 };
    }
    case "apply":
      return { kind: "id", id: m.op.kind === "delete" ? m.op.id : m.op.id1 };
    case "indexReserve":
    case "indexConfirm":
    case "indexRelease":
      return { kind: "vshard", vshard: m.vshard };
  }
}

/** Applies a mutation to a host, at the epoch the caller routed with.
 *
 *  Shared by every transport. A mutation names an operation and a host exposes one method per
 *  operation, so the two have to be matched up somewhere; doing it twice is how an in-process test
 *  ends up proving something the deployment does not do. */
export function applyTo(host: Host, m: Mutation, epoch: number): Reply<unknown> {
  switch (m.kind) {
    case "create":
      return host.create({ otype: m.otype, data: m.data, with: m.with, vshard: m.vshard, epoch });
    case "update":
      return host.update({ id: m.id, data: m.data, expect: m.expect, epoch });
    case "delete":
      return host.delete({ id: m.id, epoch });
    case "assocAdd":
      return host.assocAdd({ atype: m.atype, id1: m.id1, db: m.db, id2: m.id2, time: m.time, data: m.data, epoch });
    case "assocAddMany":
      return host.assocAddMany({ edges: m.edges, epoch });
    case "assocRemove":
      return host.assocRemove({ atype: m.atype, id1: m.id1, db: m.db, id2: m.id2, epoch });
    case "apply":
      return host.apply(m.op);
    case "indexReserve":
      return host.indexReserve({ vshard: m.vshard, idx: m.idx, key: m.key, now: m.now, ttlMs: m.ttlMs, epoch });
    case "indexConfirm":
      return host.indexConfirm({ vshard: m.vshard, idx: m.idx, key: m.key, id: m.id, epoch });
    case "indexRelease":
      return host.indexRelease({ vshard: m.vshard, idx: m.idx, key: m.key, epoch });
  }
}

export interface Transport {
  /** Runs a batch of read tasks on one host, at the epochs the client routed with. */
  exec(host: number, plan: Plan, tasks: Miss[], routed: Routed): Promise<ExecReply>;
  /** Applies one mutation on one host, at the epoch the client routed with. */
  write(host: number, m: Mutation, epoch: number): Promise<Reply<unknown>>;
  /** A published chunk of the shard map, or null when none has been published for it. */
  chunk(index: number): Promise<Uint8Array | null>;
  /** The directory, for a chunk that is absent or that a host says is stale. */
  resolve(vshards: readonly bigint[]): Promise<Map<bigint, Route>>;
  /** The catalog, which a client carries the version of on every request. */
  catalog(): Promise<Catalog>;
  /** Where a new root should go. The allocator decides; the caller never sizes or picks a vshard. */
  place(affinity?: string): Promise<string>;
  /** Which index vshard holds a value's entry. */
  indexVshardFor(key: string): Promise<string>;
  /**
   * The alias for a foreign database's URI, allocating one on first sight.
   *
   * On the write path, so a client turns a `Ref` into the number a host stores. Canonicalization and
   * the never-repoint rule live in the directory; this is only the seam.
   */
  intern(uri: string): Promise<number>;
  /**
   * Every alias this database has allocated, and this database's own URI.
   *
   * One call rather than one per alias: the set is small, changes only when an edge into a new
   * database is first written, and an isolate caches it for life — which is what makes a foreign hop
   * cost no directory round trip at read time. The own URI rides along because the coordinator needs
   * it to collapse a reference to this database back to a bare id.
   */
  aliases(): Promise<{ database: string | null; aliases: { alias: number; uri: string; state: string }[] }>;
  /** Reads a global index entry from the host that holds it. */
  indexLookup(host: number, vshard: string, idx: number, key: string): Promise<Id | null>;
}
