// One host DO. It owns some vshards and holds their objects and outbound edges in its own SQLite.
//
// Every mutation commits in one transaction: the ownership check, the data write, the edge counts and
// any outbox row go together or not at all. A caller routes with an epoch; the host compares it with
// its own vshards row and refuses the write if it no longer owns that vshard, having written nothing.

import { Catalog } from "../catalog/catalog.ts";
import { hostExec } from "../query/driver.ts";
import type { HostReply } from "../query/driver.ts";
import { missOwner } from "../query/types.ts";
import type { Fields, Id, Miss, Plan } from "../query/types.ts";
import { MAX_SEQ, fromKey, makeId, toKey, vshardOf, vshardRange } from "./ids.ts";
import { MAX_PAYLOAD, migrate } from "./schema.ts";
import type { Sql } from "./sql.ts";
import { SqlStore } from "./store.ts";
import type { Refusal, Routed, State } from "./store.ts";

export type { Refusal, Routed, State } from "./store.ts";

export class NotOwned extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(`vshard ${refusal.vshard} is ${refusal.state} at epoch ${refusal.epoch}`);
    this.name = "NotOwned";
    this.refusal = refusal;
  }
}

/** A value a unique index already holds. `by` names the object holding it, or null while another
 *  caller's reservation is still live. */
export class Taken extends Error {
  readonly idx: number;
  readonly key: string;
  readonly by: Id | null;
  constructor(idx: number, key: string, by: Id | null) {
    super(`index ${idx} already holds ${JSON.stringify(key)}${by === null ? " under a live reservation" : ` for ${by}`}`);
    this.name = "Taken";
    this.idx = idx;
    this.key = key;
    this.by = by;
  }
}

/** An edge type whose onDelete is restrict, holding a delete back. */
export class Restricted extends Error {
  readonly id: Id;
  readonly edge: string;
  constructor(id: Id, edge: string) {
    super(`${id} still has ${edge} edges, whose onDelete is restrict`);
    this.name = "Restricted";
    this.id = id;
    this.edge = edge;
  }
}

export type Reply<T> =
  | { ok: true; value: T }
  | { ok: false; refused: Refusal }
  | { ok: false; restricted: { id: Id; edge: string } }
  | { ok: false; taken: { idx: number; key: string; by: Id | null } };

export interface IndexReserveOp extends RoutedAt {
  vshard: string;
  idx: number;
  key: string;
  now: number;
  ttlMs: number;
}

export interface IndexConfirmOp extends RoutedAt {
  vshard: string;
  idx: number;
  key: string;
  id: Id;
}

export interface IndexReleaseOp extends RoutedAt {
  vshard: string;
  idx: number;
  key: string;
}

interface IndexRow {
  id: Uint8Array | null;
  state: string;
  at: number;
}

/** The epoch the caller routed with. Every host request carries one. */
export interface RoutedAt {
  epoch: number;
}

export interface CreateOp extends RoutedAt {
  otype: number;
  data: Fields;
  /** Hard colocation: the new object takes this object's vshard, so the two can transact. */
  with?: Id;
  /** Explicit placement, for a root. The allocator chooses this. */
  vshard?: string;
}

export interface UpdateOp extends RoutedAt {
  id: Id;
  data: Fields;
}

export interface DeleteOp extends RoutedAt {
  id: Id;
}

export interface AssocAddOp extends RoutedAt {
  atype: number;
  id1: Id;
  id2: Id;
  time?: number;
  data?: Fields | null;
}

export interface AssocRemoveOp extends RoutedAt {
  atype: number;
  id1: Id;
  id2: Id;
}

/** Work bound for another vshard: an inverse edge, or a cascade that left this one. */
export type OutboxOp =
  | { kind: "add"; atype: number; id1: Id; id2: Id; time: number; data: Fields | null }
  | { kind: "remove"; atype: number; id1: Id; id2: Id }
  | { kind: "delete"; id: Id };

/** The vshard an op is bound for. */
export const opTarget = (op: OutboxOp): bigint => vshardOf(op.kind === "delete" ? op.id : op.id1);

export interface OutboxRow {
  vshard: number;
  seq: number;
  target_vshard: number;
  op: OutboxOp;
}

/** Everything a vshard holds, in domain terms so it survives any transport. One vshard's rows form a
 *  single key range in objects, assocs and assoc_counts, because the vshard sits in the ids' high
 *  bits, so taking this needs no extra column or index. */
export interface Snapshot {
  vshard: string;
  epoch: number;
  nextSeq: number;
  objects: { id: Id; otype: number; version: number; data: string }[];
  assocs: { id1: Id; atype: number; id2: Id; time: number; data: string | null }[];
  counts: { id1: Id; atype: number; n: number }[];
  outbox: { seq: number; target: number; op: string }[];
  index: { idx: number; key: string; id: Id | null; state: string; at: number }[];
}

/** What a vshard costs this host, for the placement controller. Bytes are the stored payloads, which
 *  is what a move has to copy; the page overhead SQLite adds on top of them is not something a DO can
 *  see. Requests are counted since the last read, so the controller polling on a fixed interval reads
 *  a rate. */
export interface VshardStats {
  vshard: string;
  bytes: number;
  objects: number;
  requests: number;
}

export interface ExecReply extends HostReply {
  /** Vshards the caller routed to that this host no longer serves at that epoch. */
  refusals: Refusal[];
}

interface VshardRow {
  vshard: number;
  epoch: number;
  state: State;
  next_seq: number;
}

export class Host {
  readonly sql: Sql;
  #catalog: Catalog;
  /** Requests per vshard since the controller last looked. */
  readonly #requests = new Map<string, number>();

  private constructor(sql: Sql, catalog: Catalog) {
    this.sql = sql;
    this.#catalog = catalog;
  }

  static open(sql: Sql, catalog: Catalog = Catalog.empty()): Host {
    migrate(sql);
    return new Host(sql, catalog);
  }

  catalog(): Catalog {
    return this.#catalog;
  }

  /** A host behind the newest catalog fetches it from the directory before serving. A host ahead of a
   *  request's version still serves, since nothing is hidden while a projection includes it. */
  setCatalog(catalog: Catalog): void {
    this.#catalog = catalog;
  }

  /** Installs a vshard as owned. The directory drives this during a move. */
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
   *  and still serves reads; a retired one is refused outright. */
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

  holds(vshard: bigint): boolean {
    return this.#state(vshard) === "owned";
  }

  /** A fresh store, which serves one batch and records what it read. */
  store(routed: Routed | null = null): SqlStore {
    return new SqlStore(this.sql, routed);
  }

  /** Runs each task over local data, prefetching below every row it is asked for. A vshard the caller
   *  routed to that this host no longer serves comes back as a refusal, never as an empty answer. */
  async exec(plan: Plan, tasks: Miss[], routed: Routed | null = null): Promise<ExecReply> {
    for (const t of tasks) this.#count(vshardOf(missOwner(t)));
    const store = this.store(routed);
    const reply = await hostExec(store, plan, tasks);
    return { ...reply, refusals: [...store.refused.values()] };
  }

  // ---- writes

  create(op: CreateOp): Reply<Id> {
    return this.#write(() => {
      if ((op.with === undefined) === (op.vshard === undefined)) {
        throw new TypeError("create takes exactly one of with and vshard");
      }
      const vshard = op.with !== undefined ? vshardOf(op.with) : BigInt(op.vshard!);
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

  /** Applies every edge type's onDelete, from the whole catalog and not just the caller's projection.
   *  A cascade follows colocated targets in this transaction and leaves the vshard through the outbox
   *  otherwise, since a transaction cannot span vshards. */
  delete(op: DeleteOp): Reply<void> {
    return this.#write(() => {
      this.#claim(vshardOf(op.id), op.epoch);
      this.#erase(op.id, new Set());
    });
  }

  assocAdd(op: AssocAddOp): Reply<void> {
    const time = op.time ?? Date.now();
    const data = op.data ?? null;
    return this.#write(() => {
      this.#claim(vshardOf(op.id1), op.epoch);
      this.#putEdge(op.atype, op.id1, op.id2, time, data);
      const inverse = this.#catalog.inverseOf(op.atype);
      // The inverse runs the other way, so it lives on id2's vshard.
      if (inverse !== undefined) {
        this.#dispatch(vshardOf(op.id1), { kind: "add", atype: inverse, id1: op.id2, id2: op.id1, time, data });
      }
    });
  }

  assocRemove(op: AssocRemoveOp): Reply<void> {
    return this.#write(() => {
      this.#claim(vshardOf(op.id1), op.epoch);
      this.#dropEdge(op.atype, op.id1, op.id2);
      const inverse = this.#catalog.inverseOf(op.atype);
      if (inverse !== undefined) {
        this.#dispatch(vshardOf(op.id1), { kind: "remove", atype: inverse, id1: op.id2, id2: op.id1 });
      }
    });
  }

  /** Applies an op delivered from another host. Add is an upsert, remove is delete-if-present and so is
   *  delete, so redelivering after a lost ack is a no-op and a cascade cycle terminates. */
  apply(op: OutboxOp): Reply<void> {
    return this.#write(() => {
      const vshard = opTarget(op);
      this.#row(vshard); // must still be ours, at whatever epoch
      if (op.kind === "add") this.#putEdge(op.atype, op.id1, op.id2, op.time, op.data);
      else if (op.kind === "remove") this.#dropEdge(op.atype, op.id1, op.id2);
      else this.#erase(op.id, new Set());
    });
  }

  // ---- what it holds, for the placement controller

  /** Per-vshard size and request rate. Reading it resets the request counters, so two readers would
   *  each see part of the traffic; one controller polls it. */
  stats(): VshardStats[] {
    return this.vshards().map((row) => {
      const vshard = row.vshard.toString();
      const [lo, hi] = vshardRange(BigInt(row.vshard));
      const objects = this.sql.all<{ n: number; bytes: number }>(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM objects WHERE id BETWEEN ? AND ?",
        lo,
        hi,
      )[0] ?? { n: 0, bytes: 0 };
      const assocs = this.sql.all<{ bytes: number }>(
        "SELECT COALESCE(SUM(LENGTH(COALESCE(data, '')) + 24), 0) AS bytes FROM assocs WHERE id1 BETWEEN ? AND ?",
        lo,
        hi,
      )[0] ?? { bytes: 0 };
      const requests = this.#requests.get(vshard) ?? 0;
      this.#requests.delete(vshard);
      return { vshard, bytes: objects.bytes + assocs.bytes, objects: objects.n, requests };
    });
  }

  #count(vshard: bigint): void {
    const k = vshard.toString();
    this.#requests.set(k, (this.#requests.get(k) ?? 0) + 1);
  }

  // ---- moves

  /** Everything this vshard holds. Taken while the vshard is fenced, so the rows cannot change under
   *  it; a snapshot of a vshard still taking writes would be torn. */
  snapshot(vshard: string): Snapshot {
    const v = BigInt(vshard);
    const [lo, hi] = vshardRange(v);
    const row = this.sql.all<VshardRow>("SELECT epoch, state, next_seq FROM vshards WHERE vshard = ?", Number(v))[0];
    if (!row) throw new NotOwned({ vshard, state: "absent", epoch: -1 });
    return {
      vshard,
      epoch: row.epoch,
      nextSeq: row.next_seq,
      objects: this.sql
        .all<{ id: Uint8Array; otype: number; version: number; data: string }>(
          "SELECT id, otype, version, data FROM objects WHERE id BETWEEN ? AND ?",
          lo,
          hi,
        )
        .map((r) => ({ ...r, id: fromKey(r.id) })),
      assocs: this.sql
        .all<{ id1: Uint8Array; atype: number; id2: Uint8Array; time: number; data: string | null }>(
          "SELECT id1, atype, id2, time, data FROM assocs WHERE id1 BETWEEN ? AND ?",
          lo,
          hi,
        )
        .map((r) => ({ ...r, id1: fromKey(r.id1), id2: fromKey(r.id2) })),
      counts: this.sql
        .all<{ id1: Uint8Array; atype: number; n: number }>(
          "SELECT id1, atype, n FROM assoc_counts WHERE id1 BETWEEN ? AND ?",
          lo,
          hi,
        )
        .map((r) => ({ ...r, id1: fromKey(r.id1) })),
      // Outbox rows belong to their source vshard and move with it.
      outbox: this.sql
        .all<{ seq: number; target_vshard: number; op: string }>(
          "SELECT seq, target_vshard, op FROM outbox WHERE vshard = ? ORDER BY seq",
          Number(v),
        )
        .map((r) => ({ seq: r.seq, target: r.target_vshard, op: r.op })),
      // Index entries live in an index vshard, so they travel when it moves.
      index: this.sql
        .all<{ idx: number; key: string; id: Uint8Array | null; state: string; at: number }>(
          "SELECT idx, key, id, state, at FROM index_entries WHERE vshard = ?",
          Number(v),
        )
        .map((r) => ({ idx: r.idx, key: r.key, id: r.id === null ? null : fromKey(r.id), state: r.state, at: r.at })),
    };
  }

  /** Takes ownership of a snapshotted vshard at the next epoch, in one transaction. Idempotent, so a
   *  move that crashed after copying can simply copy again. */
  install(snap: Snapshot, epoch: number): void {
    const v = BigInt(snap.vshard);
    this.sql.txn(() => {
      for (const o of snap.objects) {
        this.sql.run("INSERT OR REPLACE INTO objects (id, otype, version, data) VALUES (?, ?, ?, ?)", toKey(o.id), o.otype, o.version, o.data);
      }
      for (const a of snap.assocs) {
        this.sql.run(
          "INSERT OR REPLACE INTO assocs (id1, atype, id2, time, data) VALUES (?, ?, ?, ?, ?)",
          toKey(a.id1),
          a.atype,
          toKey(a.id2),
          a.time,
          a.data,
        );
      }
      for (const c of snap.counts) {
        this.sql.run("INSERT OR REPLACE INTO assoc_counts (id1, atype, n) VALUES (?, ?, ?)", toKey(c.id1), c.atype, c.n);
      }
      for (const o of snap.outbox) {
        this.sql.run(
          "INSERT OR REPLACE INTO outbox (vshard, seq, target_vshard, op) VALUES (?, ?, ?, ?)",
          Number(v),
          o.seq,
          o.target,
          o.op,
        );
      }
      for (const e of snap.index ?? []) {
        this.sql.run(
          "INSERT OR REPLACE INTO index_entries (vshard, idx, key, id, state, at) VALUES (?, ?, ?, ?, ?, ?)",
          Number(v),
          e.idx,
          e.key,
          e.id === null ? null : toKey(e.id),
          e.state,
          e.at,
        );
      }
      // next_seq comes with it, or the new owner would hand out ids the old one already used.
      this.sql.run(
        "INSERT INTO vshards (vshard, epoch, state, next_seq) VALUES (?, ?, 'owned', ?)" +
          " ON CONFLICT (vshard) DO UPDATE SET epoch = excluded.epoch, state = 'owned', next_seq = excluded.next_seq",
        Number(v),
        epoch,
        snap.nextSeq,
      );
    });
  }

  /** Drops a retired vshard's rows, after the grace period that lets stale readers find out. */
  purge(vshard: string): void {
    const v = BigInt(vshard);
    const [lo, hi] = vshardRange(v);
    this.sql.txn(() => {
      this.sql.run("DELETE FROM objects WHERE id BETWEEN ? AND ?", lo, hi);
      this.sql.run("DELETE FROM assocs WHERE id1 BETWEEN ? AND ?", lo, hi);
      this.sql.run("DELETE FROM assoc_counts WHERE id1 BETWEEN ? AND ?", lo, hi);
      this.sql.run("DELETE FROM outbox WHERE vshard = ?", Number(v));
      this.sql.run("DELETE FROM index_entries WHERE vshard = ?", Number(v));
      this.sql.run("DELETE FROM vshards WHERE vshard = ?", Number(v));
    });
  }

  // ---- global unique index

  /** Claims a value before the object that will hold it exists. Fails if a confirmed entry holds it,
   *  or a reservation that has not yet expired. The entry and the check are one transaction on one
   *  host, which is what makes the constraint real. */
  indexReserve(op: IndexReserveOp): Reply<void> {
    return this.#write(() => {
      this.#claim(BigInt(op.vshard), op.epoch);
      const held = this.#entry(op.vshard, op.idx, op.key);
      if (held) {
        const stale = held.state === "reserved" && op.now - held.at >= op.ttlMs;
        if (!stale) throw new Taken(op.idx, op.key, held.state === "confirmed" ? fromKeyOf(held.id!) : null);
      }
      this.sql.run(
        "INSERT INTO index_entries (vshard, idx, key, id, state, at) VALUES (?, ?, ?, NULL, 'reserved', ?)" +
          " ON CONFLICT (vshard, idx, key) DO UPDATE SET id = NULL, state = 'reserved', at = excluded.at",
        Number(op.vshard),
        op.idx,
        op.key,
        op.now,
      );
    });
  }

  /** Points a reservation at the object that was created for it. */
  indexConfirm(op: IndexConfirmOp): Reply<void> {
    return this.#write(() => {
      this.#claim(BigInt(op.vshard), op.epoch);
      const held = this.#entry(op.vshard, op.idx, op.key);
      if (!held) throw new Error(`no reservation for ${op.idx}/${op.key}`);
      if (held.state === "confirmed" && fromKeyOf(held.id!) !== op.id) {
        throw new Taken(op.idx, op.key, fromKeyOf(held.id!));
      }
      this.sql.run(
        "UPDATE index_entries SET id = ?, state = 'confirmed' WHERE vshard = ? AND idx = ? AND key = ?",
        toKey(op.id),
        Number(op.vshard),
        op.idx,
        op.key,
      );
    });
  }

  /** Drops an entry: a reservation whose create failed, or a confirmed one whose object is gone. */
  indexRelease(op: IndexReleaseOp): Reply<void> {
    return this.#write(() => {
      this.#claim(BigInt(op.vshard), op.epoch);
      this.sql.run(
        "DELETE FROM index_entries WHERE vshard = ? AND idx = ? AND key = ?",
        Number(op.vshard),
        op.idx,
        op.key,
      );
    });
  }

  /** The object a value points at, or null. A reservation is not an answer: the object does not exist
   *  yet, and the reserving caller may never confirm it. */
  indexLookup(vshard: string, idx: number, key: string): Id | null {
    const held = this.#entry(vshard, idx, key);
    return held && held.state === "confirmed" && held.id ? fromKeyOf(held.id) : null;
  }

  /** Reclaims reservations nobody confirmed, which is what keeps a crashed create from holding a value
   *  forever. An alarm calls this. */
  indexSweep(vshard: string, now: number, ttlMs: number): number {
    const stale = this.sql.all<{ n: number }>(
      "SELECT COUNT(*) AS n FROM index_entries WHERE vshard = ? AND state = 'reserved' AND ? - at >= ?",
      Number(BigInt(vshard)),
      now,
      ttlMs,
    )[0]?.n ?? 0;
    this.sql.run(
      "DELETE FROM index_entries WHERE vshard = ? AND state = 'reserved' AND ? - at >= ?",
      Number(BigInt(vshard)),
      now,
      ttlMs,
    );
    return stale;
  }

  #entry(vshard: string, idx: number, key: string): IndexRow | undefined {
    return this.sql.all<IndexRow>(
      "SELECT id, state, at FROM index_entries WHERE vshard = ? AND idx = ? AND key = ?",
      Number(BigInt(vshard)),
      idx,
      key,
    )[0];
  }

  // ---- outbox

  /** Rows waiting for delivery, oldest first per source vshard. */
  pending(limit = 64): OutboxRow[] {
    const rows = this.sql.all<{ vshard: number; seq: number; target_vshard: number; op: string }>(
      "SELECT vshard, seq, target_vshard, op FROM outbox ORDER BY vshard, seq LIMIT ?",
      limit,
    );
    return rows.map((r) => ({ ...r, op: JSON.parse(r.op) as OutboxOp }));
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
      if (e instanceof NotOwned) return { ok: false, refused: e.refusal };
      if (e instanceof Restricted) return { ok: false, restricted: { id: e.id, edge: e.edge } };
      if (e instanceof Taken) return { ok: false, taken: { idx: e.idx, key: e.key, by: e.by } };
      throw e;
    }
  }

  /** State must be owned and the routed epoch must match. Checked before anything is written. */
  #claim(vshard: bigint, epoch: number): VshardRow {
    const row = this.#row(vshard);
    if (row.epoch !== epoch) throw new NotOwned({ vshard: vshard.toString(), state: row.state, epoch: row.epoch });
    return row;
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

  #state(vshard: bigint): State | "absent" {
    return this.sql.all<{ state: State }>("SELECT state FROM vshards WHERE vshard = ?", Number(vshard))[0]?.state ?? "absent";
  }

  /** Deletes an object, applying each of its edge types' onDelete. `seen` stops a cascade cycle inside
   *  this vshard; across vshards, delete-if-present does. */
  #erase(id: Id, seen: Set<Id>): void {
    if (seen.has(id)) return;
    seen.add(id);
    const key = toKey(id);
    const row = this.sql.all<{ otype: number }>("SELECT otype FROM objects WHERE id = ?", key)[0];
    if (!row) return; // already gone
    const source = vshardOf(id);
    const types = this.#catalog.edgesFrom(row.otype);

    // Every restrict is checked before anything is written, so a held-back delete leaves no trace.
    const lists = types.map((e) => ({
      edge: e,
      targets: this.sql
        .all<{ id2: Uint8Array }>("SELECT id2 FROM assocs WHERE id1 = ? AND atype = ?", key, e.atype!)
        .map((r) => fromKeyOf(r.id2)),
    }));
    for (const { edge, targets } of lists) {
      if (edge.onDelete === "restrict" && targets.length > 0) throw new Restricted(id, edge.name);
    }

    for (const { edge, targets } of lists) {
      const inverse = this.#catalog.inverseOf(edge.atype!);
      for (const t of targets) {
        // Withdraw the inverse this object's edge put on the other side.
        if (inverse !== undefined) this.#dispatch(source, { kind: "remove", atype: inverse, id1: t, id2: id });
        if (edge.onDelete !== "cascade") continue;
        if (vshardOf(t) === source) this.#erase(t, seen);
        else this.#dispatch(source, { kind: "delete", id: t });
      }
    }

    this.sql.run("DELETE FROM objects WHERE id = ?", key);
    this.sql.run("DELETE FROM assocs WHERE id1 = ?", key);
    this.sql.run("DELETE FROM assoc_counts WHERE id1 = ?", key);
  }

  /** Applies an op inline when its vshard is on this host, so a colocated pair is atomic for free, and
   *  queues it otherwise. Outbox rows belong to the source vshard and move with it. */
  #dispatch(source: bigint, op: OutboxOp): void {
    const target = opTarget(op);
    if (this.#state(target) === "owned") {
      if (op.kind === "add") this.#putEdge(op.atype, op.id1, op.id2, op.time, op.data);
      else if (op.kind === "remove") this.#dropEdge(op.atype, op.id1, op.id2);
      else this.#erase(op.id, new Set());
      return;
    }
    const next = this.sql.all<{ seq: number }>(
      "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM outbox WHERE vshard = ?",
      Number(source),
    )[0];
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
    const existed = this.#hasEdge(k1, atype, k2);
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
    if (!this.#hasEdge(k1, atype, k2)) return;
    this.sql.run("DELETE FROM assocs WHERE id1 = ? AND atype = ? AND id2 = ?", k1, atype, k2);
    this.#bump(k1, atype, -1);
  }

  #hasEdge(k1: Uint8Array, atype: number, k2: Uint8Array): boolean {
    return this.sql.all("SELECT 1 AS one FROM assocs WHERE id1 = ? AND atype = ? AND id2 = ?", k1, atype, k2).length > 0;
  }

  /** Counts are maintained in the same transaction as the edge write. An add may need the row created;
   *  a remove never does, since the edge it just deleted had one. */
  #bump(id1: Uint8Array, atype: number, by: 1 | -1): void {
    if (by === 1) {
      this.sql.run(
        "INSERT INTO assoc_counts (id1, atype, n) VALUES (?, ?, 1) ON CONFLICT (id1, atype) DO UPDATE SET n = n + 1",
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

function fromKeyOf(b: Uint8Array): Id {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0).toString();
}
