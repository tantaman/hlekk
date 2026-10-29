// What a client needs from the outside world: hosts, the published map, and the directory behind it.
// In production these are DO stubs and a KV binding; in tests they are the objects themselves.

import type { Catalog } from "../catalog/catalog.ts";
import type { ExecReply, OutboxOp, Reply, Routed } from "../host/host.ts";
import type { Route } from "../directory/map.ts";
import type { Fields, Id, Miss, Plan } from "../query/types.ts";

/** A mutation as the caller states it. The client fills in the epoch it routed with. */
export type Mutation =
  | { kind: "create"; otype: number; data: Fields; with?: Id; vshard?: string }
  | { kind: "update"; id: Id; data: Fields }
  | { kind: "delete"; id: Id }
  | { kind: "assocAdd"; atype: number; id1: Id; id2: Id; time?: number; data?: Fields | null }
  | { kind: "assocRemove"; atype: number; id1: Id; id2: Id }
  | { kind: "apply"; op: OutboxOp };

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
    case "apply":
      return { kind: "id", id: m.op.kind === "delete" ? m.op.id : m.op.id1 };
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
}
