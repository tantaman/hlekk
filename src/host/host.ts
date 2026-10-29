// One host DO. It owns some vshards and holds their objects and outbound edges in its own SQLite.
//
// Every mutation commits in one transaction: the ownership check, the data write, the edge counts and
// any outbox row go together or not at all. A caller routes with an epoch; the host compares it with
// its own vshards row and refuses the write if it no longer owns that vshard, having written nothing.

import { hostExec } from "../query/driver.ts";
import type { HostReply } from "../query/driver.ts";
import type { Fields, Id, Miss, Plan } from "../query/types.ts";
import { MAX_SEQ, makeId, toKey, vshardOf } from "./ids.ts";
import { MAX_PAYLOAD, migrate } from "./schema.ts";
import type { Sql } from "./sql.ts";
import { SqlStore } from "./store.ts";

export type State = "owned" | "fenced" | "moved";

/** Why a write was refused. The host knows it no longer owns the vshard, but not who does: its
 *  vshards row carries no target, so the caller re-reads the directory. */
export interface Refusal {
  vshard: string;
  state: State | "absent";
  epoch: number;
}

export class NotOwned extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(`vshard ${refusal.vshard} is ${refusal.state} at epoch ${refusal.epoch}`);
    this.name = "NotOwned";
    this.refusal = refusal;
  }
}

export type Reply<T> = { ok: true; value: T } | { ok: false; moved: Refusal };

/** The epoch the caller routed with. Every host request carries one. */
export interface Routed {
  epoch: number;
}

export interface CreateOp extends Routed {
  otype: number;
  data: Fields;
  /** Hard colocation: the new object takes this object's vshard, so the two can transact. */
  with?: Id;
  /** Explicit placement, for a root. The allocator chooses this once it exists (build plan step 5). */
  vshard?: string;
}

export interface UpdateOp extends Routed {
  id: Id;
  data: Fields;
}

export interface DeleteOp extends Routed {
  id: Id;
}

export interface AssocAddOp extends Routed {
  atype: number;
  id1: Id;
  id2: Id;
  time?: number;
  data?: Fields | null;
  /** The paired inverse edge type, when this one has an inverse. The catalog supplies it from step 2;
   *  until then the caller does. */
  inverse?: number;
}

export interface AssocRemoveOp extends Routed {
  atype: number;
  id1: Id;
  id2: Id;
  inverse?: number;
}

/** An inverse edge waiting for its target's host. */
export type InverseOp =
  | { kind: "add"; atype: number; id1: Id; id2: Id; time: number; data: Fields | null }
  | { kind: "remove"; atype: number; id1: Id; id2: Id };

export interface OutboxRow {
  vshard: number;
  seq: number;
  target_vshard: number;
  op: InverseOp;
}

interface VshardRow {
  vshard: number;
  epoch: number;
  state: State;
  next_seq: number;
}

export class Host {
  readonly sql: Sql;

  private constructor(sql: Sql) {
    this.sql = sql;
  }

  static open(sql: Sql): Host {
    migrate(sql);
    return new Host(sql);
  }

  /** Installs a vshard as owned. The directory drives this during a move (build plan step 3); for now
   *  a test or the local harness calls it directly. */
  adopt(vshard: string, epoch = 0, nextSeq = 0): void {
    this.sql.run(
      "INSERT INTO vshards (vshard, epoch, state, next_seq) VALUES (?, ?, 'owned', ?)" +
        " ON CONFLICT (vshard) DO UPDATE SET epoch = excluded.epoch, state = 'owned'",
      Number(BigInt(vshard)),
      epoch,
      nextSeq,
    );
  }

  /** Fences a vshard, or retires it once a move has flipped the route. A fenced vshard refuses writes
   *  and still serves reads; a moved one answers moved. */
  setState(vshard: string, state: State, epoch?: number): void {
    this.sql.run(
      "UPDATE vshards SET state = ?, epoch = COALESCE(?, epoch) WHERE vshard = ?",
      state,
      epoch ?? null,
      Number(BigInt(vshard)),
    );
  }

  vshards(): VshardRow[] {
    return this.sql.all<VshardRow>("SELECT vshard, epoch, state, next_seq FROM vshards ORDER BY vshard");
  }

  /** A fresh store, which serves one batch and records what it read. */
  store(): SqlStore {
    return new SqlStore(this.sql);
  }

  /** Runs each task over local data, prefetching below every row it is asked for. */
  exec(plan: Plan, tasks: Miss[]): Promise<HostReply> {
    return hostExec(this.store(), plan, tasks);
  }

  // ---- writes

  create(op: CreateOp): Reply<Id> {
    return this.#write(() => {
      const vshard = op.with !== undefined ? vshardOf(op.with) : BigInt(this.#required(op.vshard, "vshard or with"));
      const row = this.#claim(vshard, op.epoch);
      const seq = BigInt(row.next_seq);
      if (seq > MAX_SEQ) throw new Error(`vshard ${vshard} has no sequence left`);
      const id = makeId(vshard, seq);
      this.sql.run("INSERT INTO objects (id, otype, version, data) VALUES (?, ?, 1, ?)", toKey(id), op.otype, payload(op.data));
      this.sql.run("UPDATE vshards SET next_seq = next_seq + 1 WHERE vshard = ?", Number(vshard));
      return id;
    });
  }

  /** Bumps version. */
  update(op: UpdateOp): Reply<number> {
    return this.#write(() => {
      this.#claim(vshardOf(op.id), op.epoch);
      this.sql.run("UPDATE objects SET data = ?, version = version + 1 WHERE id = ?", payload(op.data), toKey(op.id));
      const row = this.sql.all<{ version: number }>("SELECT version FROM objects WHERE id = ?", toKey(op.id))[0];
      if (!row) throw new Error(`no such object: ${op.id}`);
      return row.version;
    });
  }

  /** Deletes the object and the edges it owns. Cascading to other types, and withdrawing inverses held
   *  on other vshards, needs each edge type's onDelete from the catalog (build plan steps 2 and 4). */
  delete(op: DeleteOp): Reply<void> {
    return this.#write(() => {
      this.#claim(vshardOf(op.id), op.epoch);
      const key = toKey(op.id);
      this.sql.run("DELETE FROM objects WHERE id = ?", key);
      this.sql.run("DELETE FROM assocs WHERE id1 = ?", key);
      this.sql.run("DELETE FROM assoc_counts WHERE id1 = ?", key);
    });
  }

  assocAdd(op: AssocAddOp): Reply<void> {
    const time = op.time ?? Date.now();
    const data = op.data ?? null;
    return this.#write(() => {
      this.#claim(vshardOf(op.id1), op.epoch);
      this.#putEdge(op.atype, op.id1, op.id2, time, data);
      if (op.inverse !== undefined) {
        // The inverse lives on id2's vshard.
        this.#inverse(vshardOf(op.id2), { kind: "add", atype: op.inverse, id1: op.id2, id2: op.id1, time, data });
      }
    });
  }

  assocRemove(op: AssocRemoveOp): Reply<void> {
    return this.#write(() => {
      this.#claim(vshardOf(op.id1), op.epoch);
      this.#dropEdge(op.atype, op.id1, op.id2);
      if (op.inverse !== undefined) {
        this.#inverse(vshardOf(op.id2), { kind: "remove", atype: op.inverse, id1: op.id2, id2: op.id1 });
      }
    });
  }

  /** Applies an inverse delivered from another host. Add is an upsert and remove is delete-if-present,
   *  so redelivering after a lost ack is a no-op. */
  applyInverse(op: InverseOp): Reply<void> {
    return this.#write(() => {
      this.#claimOwned(vshardOf(op.id1));
      if (op.kind === "add") this.#putEdge(op.atype, op.id1, op.id2, op.time, op.data);
      else this.#dropEdge(op.atype, op.id1, op.id2);
    });
  }

  // ---- outbox

  /** Rows waiting for delivery, oldest first per source vshard. */
  pending(limit = 64): OutboxRow[] {
    const rows = this.sql.all<{ vshard: number; seq: number; target_vshard: number; op: string }>(
      "SELECT vshard, seq, target_vshard, op FROM outbox ORDER BY vshard, seq LIMIT ?",
      limit,
    );
    return rows.map((r) => ({ ...r, op: JSON.parse(r.op) as InverseOp }));
  }

  /** Drops a row once the target has acknowledged it. A crash before this redelivers, which is why
   *  apply is idempotent. */
  ack(vshard: number, seq: number): void {
    this.sql.run("DELETE FROM outbox WHERE vshard = ? AND seq = ?", vshard, seq);
  }

  // ---- internals

  #write<T>(f: () => T): Reply<T> {
    try {
      return { ok: true, value: this.sql.txn(f) };
    } catch (e) {
      if (e instanceof NotOwned) return { ok: false, moved: e.refusal };
      throw e;
    }
  }

  #required<T>(v: T | undefined, what: string): T {
    if (v === undefined) throw new TypeError(`create needs ${what}`);
    return v;
  }

  /** State must be owned and the routed epoch must match. Checked before anything is written. */
  #claim(vshard: bigint, epoch: number): VshardRow {
    const row = this.#row(vshard);
    if (row.epoch !== epoch) throw new NotOwned({ vshard: vshard.toString(), state: row.state, epoch: row.epoch });
    return row;
  }

  /** The same check without an epoch, for a vshard the caller did not route to: the inverse side of a
   *  colocated edge pair, and a delivered inverse, which the directory routed by vshard alone. */
  #claimOwned(vshard: bigint): VshardRow {
    return this.#row(vshard);
  }

  #row(vshard: bigint): VshardRow {
    const row = this.sql.all<VshardRow>(
      "SELECT vshard, epoch, state, next_seq FROM vshards WHERE vshard = ?",
      Number(vshard),
    )[0];
    if (!row) throw new NotOwned({ vshard: vshard.toString(), state: "absent", epoch: -1 });
    if (row.state !== "owned") throw new NotOwned({ vshard: vshard.toString(), state: row.state, epoch: row.epoch });
    return row;
  }

  /** Writes the inverse inline when its vshard is on this host, so a colocated pair is atomic for
   *  free, and otherwise queues it. */
  #inverse(target: bigint, op: InverseOp): void {
    const here = this.sql.all<{ state: State }>("SELECT state FROM vshards WHERE vshard = ?", Number(target))[0];
    if (here?.state === "owned") {
      if (op.kind === "add") this.#putEdge(op.atype, op.id1, op.id2, op.time, op.data);
      else this.#dropEdge(op.atype, op.id1, op.id2);
      return;
    }
    const source = vshardOf(op.id2); // the forward edge's vshard, which these rows move with
    const next = this.sql.all<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM outbox WHERE vshard = ?", Number(source))[0];
    this.sql.run(
      "INSERT INTO outbox (vshard, seq, target_vshard, op) VALUES (?, ?, ?, ?)",
      Number(source),
      next?.seq ?? 1,
      Number(target),
      JSON.stringify(op),
    );
  }

  #putEdge(atype: number, id1: Id, id2: Id, time: number, data: Fields | null): void {
    const k1 = toKey(id1);
    const k2 = toKey(id2);
    const existed = this.sql.all<{ one: number }>(
      "SELECT 1 AS one FROM assocs WHERE id1 = ? AND atype = ? AND id2 = ?",
      k1,
      atype,
      k2,
    ).length > 0;
    this.sql.run(
      "INSERT INTO assocs (id1, atype, id2, time, data) VALUES (?, ?, ?, ?, ?)" +
        " ON CONFLICT (id1, atype, id2) DO UPDATE SET time = excluded.time, data = excluded.data",
      k1,
      atype,
      k2,
      time,
      data === null ? null : JSON.stringify(data),
    );
    if (!existed) this.#bump(k1, atype, 1);
  }

  #dropEdge(atype: number, id1: Id, id2: Id): void {
    const k1 = toKey(id1);
    const k2 = toKey(id2);
    const existed = this.sql.all<{ one: number }>(
      "SELECT 1 AS one FROM assocs WHERE id1 = ? AND atype = ? AND id2 = ?",
      k1,
      atype,
      k2,
    ).length > 0;
    if (!existed) return;
    this.sql.run("DELETE FROM assocs WHERE id1 = ? AND atype = ? AND id2 = ?", k1, atype, k2);
    this.#bump(k1, atype, -1);
  }

  /** Counts are maintained in the same transaction as the edge write. An add may need the row created;
   *  a remove never does, since the edge it just deleted had one. */
  #bump(id1: Uint8Array, atype: number, by: 1 | -1): void {
    if (by === 1) {
      this.sql.run(
        "INSERT INTO assoc_counts (id1, atype, n) VALUES (?, ?, 1)" +
          " ON CONFLICT (id1, atype) DO UPDATE SET n = n + 1",
        id1,
        atype,
      );
    } else {
      this.sql.run("UPDATE assoc_counts SET n = MAX(0, n - 1) WHERE id1 = ? AND atype = ?", id1, atype);
    }
  }
}

function payload(data: Fields): string {
  const json = JSON.stringify(data);
  // The cap is bytes, and a UTF-16 code unit can take three of them. Only measure when it could matter.
  if (json.length * 3 > MAX_PAYLOAD) {
    const bytes = new TextEncoder().encode(json).length;
    if (bytes > MAX_PAYLOAD) throw new RangeError(`payload is ${bytes} bytes, over the ${MAX_PAYLOAD} cap`);
  }
  return json;
}
