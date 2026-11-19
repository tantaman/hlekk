// One host DO. It owns some vshards and holds their objects and outbound edges in its own SQLite.
//
// Every mutation commits in one transaction: the ownership check, the data write, the edge counts and
// any outbox row go together or not at all. A caller routes with an epoch; the host compares it with
// its own vshards row and refuses the write if it no longer owns that vshard, having written nothing.

import { Catalog, isIdSpec } from "../catalog/catalog.ts";
import { systemClock } from "../runtime/runtime.ts";
import type { Clock } from "../runtime/runtime.ts";
import { hostExec } from "../query/driver.ts";
import type { HostReply } from "../query/driver.ts";
import { missOwner } from "../query/types.ts";
import type { Fields, Id, Miss, Plan } from "../query/types.ts";
import { MAX_SEQ, fromKey, makeId, toKey, vshardOf, vshardRange } from "./ids.ts";
import { parseRef } from "../query/ref.ts";
import { CURRENT_FORMAT, FormatError, MAX_PAYLOAD, ddl, formatOf, migrate } from "./schema.ts";
import type { StorageFormat } from "./schema.ts";
import type { Param, Sql } from "./sql.ts";
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

/** An update whose expected version no longer matches. */
export class Conflict extends Error {
  readonly id: Id;
  readonly expected: number;
  readonly actual: number;
  constructor(id: Id, expected: number, actual: number) {
    super(`${id} is at version ${actual}, not the ${expected} this write expected`);
    this.name = "Conflict";
    this.id = id;
    this.expected = expected;
    this.actual = actual;
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

/** A direct write to the derived half of a pair. Its rows are its inverse's to write: one writer per
 *  row is what lets the outbox's per-source ordering mean anything. */
export class Maintained extends Error {
  readonly edge: string;
  readonly by: string;
  constructor(edge: string, by: string) {
    super(`${edge} is maintained by ${by}; write ${by} instead`);
    this.name = "Maintained";
    this.edge = edge;
    this.by = by;
  }
}

export type Reply<T> =
  | { ok: true; value: T }
  | { ok: false; refused: Refusal }
  | { ok: false; maintained: { edge: string; by: string } }
  | { ok: false; restricted: { id: Id; edge: string } }
  | { ok: false; taken: { idx: number; key: string; by: Id | null } }
  | { ok: false; conflict: { id: Id; expected: number; actual: number } };

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
  /** The version the caller read. Given one, the write lands only if the object is still at it, so a
   *  read-modify-write cannot silently lose someone else's. */
  expect?: number;
}

export interface DeleteOp extends RoutedAt {
  id: Id;
}

export interface AssocAddOp extends RoutedAt {
  atype: number;
  id1: Id;
  /** The target's database, as this database's interned alias. 0, the default, is local; anything
   *  else is a foreign edge and needs a format 2 host and an edge type that permits one. The client
   *  interns the URI and sends the number — a host stores an alias and never resolves one. */
  db?: number;
  id2: Id;
  time?: number;
  data?: Fields | null;
}

/** One edge in a batched add. Identical to `AssocAddOp` minus the epoch, which the batch carries
 *  once for all of them because they are routed and fenced together. */
export interface AssocAddManyEdge {
  atype: number;
  id1: Id;
  db?: number;
  id2: Id;
  time?: number;
  data?: Fields | null;
}

export interface AssocAddManyOp extends RoutedAt {
  edges: readonly AssocAddManyEdge[];
}

export interface AssocRemoveOp extends RoutedAt {
  atype: number;
  id1: Id;
  db?: number;
  id2: Id;
}

/** Work bound for another vshard: an inverse edge, or a cascade that left this one. */
export type OutboxOp =
  | { kind: "add"; atype: number; id1: Id; id2: Id; time: number; data: Fields | null }
  | { kind: "remove"; atype: number; id1: Id; id2: Id }
  | { kind: "delete"; id: Id };

/**
 * The vshard an op is bound for.
 *
 * `vshardOf` must never see a foreign target: an alias plus a local id is a 128-bit reference, and
 * routing by its low half would send the op to whichever of THIS database's vshards happens to share
 * those bits — a write landing on an unrelated object rather than failing. The catalog's refusals
 * keep foreign targets out of the two places that take one (an inverse and a cascade both need an
 * edge type that permits neither), so this is the assumption written down as code at the sites that
 * rest on it, rather than left as a comment that a later change can quietly break.
 */
export const opTarget = (op: OutboxOp): bigint => vshardOf(op.kind === "delete" ? op.id : op.id1);

/** Throws unless the alias is local. Called wherever an edge's target is about to be treated as one
 *  of this database's ids. */
export function localTarget(db: number, id: Id): Id {
  if (db !== 0) {
    throw new FormatError(
      `${id} is in database ${db}, and this is a local id's place: a foreign reference cannot be routed,` +
        " cascaded to or given an inverse. The catalog refuses `inverse` and `onDelete: cascade` on a foreign" +
        " edge type so that this is unreachable; reaching it means that rule was bypassed.",
    );
  }
  return id;
}

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
  assocs: { id1: Id; atype: number; db: number; id2: Id; time: number; data: string | null }[];
  counts: { id1: Id; atype: number; n: number }[];
  outbox: { seq: number; target: number; op: string }[];
  index: { idx: number; key: string; id: Id | null; state: string; at: number }[];
}

/** The tables a vshard's copy walks, in the order it walks them. */
export const COPY_TABLES = ["objects", "assocs", "counts", "outbox", "index"] as const;
export type CopyTable = (typeof COPY_TABLES)[number];

/** One column of a primary key, as it crosses the wire: ids as decimal strings, never as numbers. */
export type KeyPart = string | number;

/** Where a chunked copy has got to: a table, and the primary key of the last row taken from it, or
 *  null at the table's start. Plain JSON, so the directory can record it and any transport can carry
 *  it, and opaque to everything but the `Host.chunk` that wrote it. */
export interface CopyCursor {
  table: CopyTable;
  after: KeyPart[] | null;
}

export const COPY_START: CopyCursor = { table: "objects", after: null };

/** How much one chunk may carry. Both bounds apply. */
export interface ChunkBudget {
  rows: number;
  /** Payload bytes plus a per-row allowance for keys, as `stats` estimates them. */
  bytes: number;
}

/** Sized for one request on a Durable Object: a few megabytes of JSON across one RPC and one
 *  transaction of ten thousand inserts, far inside 128 MB of isolate and 30 s of CPU. A 9 GB vshard
 *  is a little over two thousand of these. */
export const DEFAULT_CHUNK: ChunkBudget = { rows: 10_000, bytes: 4 * 1024 * 1024 };

const UNBOUNDED: ChunkBudget = { rows: Infinity, bytes: Infinity };

/** Rows read per statement while a chunk fills. Small enough that the rows read past a full chunk
 *  are cheap, large enough that statement overhead is not the cost. */
const PAGE_ROWS = 512;

/** One slice of a vshard's copy: the rows from `from` up to `next`, and the vshard's row as the source
 *  held it. `next` is null on the last chunk, which is the one that hands ownership over. */
export interface Chunk extends Snapshot {
  from: CopyCursor;
  next: CopyCursor | null;
}

interface CopyRow {
  key: KeyPart[];
  size: number;
  put(chunk: Chunk): void;
}

/** A chunk asked for while the vshard still takes writes. Rows read in several requests from a
 *  vshard that is not fenced would be torn — a write between two chunks lands in one and not the
 *  other — so this is refused rather than served. The mover answers it by fencing again and copying
 *  from the top. */
export class Unfenced extends Error {
  readonly vshard: string;
  constructor(vshard: string) {
    super(`vshard ${vshard} is owned, not fenced: a copy of a vshard that still takes writes would be torn`);
    this.name = "Unfenced";
    this.vshard = vshard;
  }
}

/** What a vshard costs this host, for the placement controller. Requests are counted since the last
 *  read, so the controller polling on a fixed interval reads a rate.
 *
 *  `bytes` is what this vshard's own rows weigh: payloads as bytes and not characters, plus the keys
 *  and index entries around them. It is deliberately an estimate of the rows and NOT of the storage
 *  they occupy, which runs 1.05x to 4.7x higher once page overhead is counted — a WITHOUT ROWID row
 *  whose payload passes the max-local threshold spills to an overflow page and costs a whole one, so
 *  a 1,000-byte object can cost 4.7 KB where a 980-byte one costs 1.03 KB. Use it to compare vshards
 *  with each other; use `Host.size()` for anything measured against the per-DO limit. */
export interface VshardStats {
  vshard: string;
  bytes: number;
  objects: number;
  requests: number;
}

/** Per-row costs beyond the payload: keys, the fixed columns and the cell overhead around them. Only
 *  the ratios between these matter, since the shares they build are scaled to the engine's own size.
 *  An edge is charged for its index entry as well as its row — `assocs_range` carries the whole
 *  primary key, this table being WITHOUT ROWID, so it costs more than the row it points at and a flat
 *  per-edge constant left the larger half of an edge-heavy vshard uncharged. */
const ROW_COST = { object: 18, assoc: 28 + 38, count: 20, outbox: 18, index: 34 } as const;

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
  readonly clock: Clock;
  #catalog: Catalog;
  #format: StorageFormat;
  /** Requests per vshard since the controller last looked. */
  readonly #requests = new Map<string, number>();

  private constructor(sql: Sql, catalog: Catalog, clock: Clock, format: StorageFormat) {
    this.sql = sql;
    this.#catalog = catalog;
    this.clock = clock;
    this.#format = format;
  }

  /**
   * Opens a host, at the storage format it is told or the one it already holds.
   *
   * Told a format, it refuses when that disagrees with the shape of its own `assocs` — see
   * `schema.ts` for why silence there is the failure worth preventing. Told none, it keeps whatever
   * it is, and a host with no `assocs` at all defaults to format 1. That default is deliberately the
   * OLD format: a host is told its format when it is first adopted, and until it has been, the
   * conservative shape is the one that refuses a foreign edge outright rather than the one that
   * accepts one the directory may not know about.
   */
  static open(
    sql: Sql,
    catalog: Catalog = Catalog.empty(),
    clock: Clock = systemClock,
    format?: StorageFormat,
  ): Host {
    const held = format ?? formatOf(sql) ?? 1;
    migrate(sql, held);
    return new Host(sql, catalog, clock, held);
  }

  /** Which storage format this host's `assocs` is in. */
  format(): StorageFormat {
    return this.#format;
  }

  /**
   * Tells a host its storage format, which is what a new one is told when it is first adopted.
   *
   * It will reshape `assocs` only while the table is empty, because the two formats key it
   * differently and there is no in-place upgrade: a row written under one key cannot be reinterpreted
   * under the other, and the order a page is read in would change underneath any cursor already
   * handed out. A host holding edges is therefore refused, and a vshard move is its migration.
   */
  setFormat(format: StorageFormat): void {
    if (this.#format === format) return;
    const rows = this.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM assocs LIMIT 1")[0]?.n ?? 0;
    if (rows > 0) {
      throw new FormatError(
        `this host holds ${rows} edges in storage format ${this.#format} and cannot be reshaped to format ${format}.` +
          " A vshard move is the migration: a format 1 snapshot installs into a format 2 host with every alias 0.",
      );
    }
    this.sql.txn(() => {
      this.sql.run("DROP INDEX IF EXISTS assocs_range");
      this.sql.run("DROP TABLE IF EXISTS assocs");
      for (const stmt of ddl(format)) this.sql.run(stmt);
    });
    this.#format = format;
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
    return new SqlStore(this.sql, routed, this.#format);
  }

  /** Runs each task over local data, prefetching below every row it is asked for. A vshard the caller
   *  routed to that this host no longer serves comes back as a refusal, never as an empty answer. */
  async exec(plan: Plan, tasks: Miss[], routed: Routed | null = null): Promise<ExecReply> {
    for (const t of tasks) this.#count(vshardOf(missOwner(t)));
    const store = this.store(routed);
    const reply = await hostExec(store, plan, tasks);
    // Every task the caller asked for is answered or refused. Returning nothing for one it routed
    // here, because this host happens not to hold the vshard, would read as an empty answer: the
    // coordinator cannot tell "no such object" from "not mine" unless the host says which.
    for (const t of tasks) {
      const verdict = store.serves(vshardOf(missOwner(t)));
      if (verdict !== true) store.refuse(verdict);
    }
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
      this.#checkRefs(op.otype, op.data);
      this.sql.run("INSERT INTO objects (id, otype, version, data) VALUES (?, ?, 1, ?)", toKey(id), op.otype, payload(op.data));
      this.sql.run("UPDATE vshards SET next_seq = next_seq + 1 WHERE vshard = ?", Number(vshard));
      return id;
    });
  }

  /** Bumps version. */
  update(op: UpdateOp): Reply<number> {
    return this.#write(() => {
      this.#claim(vshardOf(op.id), op.epoch);
      const before = this.sql.all<{ otype: number; version: number }>(
        "SELECT otype, version FROM objects WHERE id = ?",
        toKey(op.id),
      )[0];
      if (!before) throw new Error(`no such object: ${op.id}`);
      // Checked in the same transaction as the write, so nothing can land between them.
      if (op.expect !== undefined && before.version !== op.expect) {
        throw new Conflict(op.id, op.expect, before.version);
      }
      // The otype comes off the row rather than from the caller, which is why this check lives here
      // and not in the client: an update names an id and an id does not carry its type.
      this.#checkRefs(before.otype, op.data);
      this.sql.run("UPDATE objects SET data = ?, version = version + 1 WHERE id = ?", payload(op.data), toKey(op.id));
      return before.version + 1;
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
    const time = op.time ?? this.clock.now();
    const data = op.data ?? null;
    const db = op.db ?? 0;
    return this.#write(() => {
      this.#own(op.atype);
      this.#claim(vshardOf(op.id1), op.epoch);
      this.#putEdge(op.atype, op.id1, db, op.id2, time, data);
      const inverse = this.#catalog.inverseOf(op.atype);
      // The inverse runs the other way, so it lives on id2's vshard. `localTarget` is the audit: an
      // edge type with an inverse cannot be foreign, so this is unreachable rather than handled.
      if (inverse !== undefined) {
        const target = localTarget(db, op.id2);
        this.#dispatch(vshardOf(op.id1), { kind: "add", atype: inverse, id1: target, id2: op.id1, time, data });
      }
    });
  }

  /** Many edge adds in one transaction. This is the primitive a bulk load needs, and the one thing
   *  batching the *request* cannot provide.
   *
   *  `assocAdd` is one mutation, and every mutation commits in one transaction (the note at the top
   *  of this file), so a thousand edges are a thousand durable commits. That is what the ~6,300
   *  edges/s ceiling in `wikimedia-import.md` measures, and it is a property of the commit rather
   *  than of SQLite: the statements inside a transaction are cheap and the durability round trip at
   *  the end of one is not. `/ingest/edges` already accepted a thousand edges per request and then
   *  spent them one `assocAdd` at a time, so the batching stopped at the HTTP boundary and bought
   *  only concurrency against a single-threaded Durable Object. Here N edges cost one commit.
   *
   *  Every invariant `assocAdd` holds is held here, in the same order and through the same helpers:
   *  the maintained-edge refusal, the ownership fence, the idempotent upsert, a count bumped only
   *  when the edge is new, and an inverse handed to the outbox. What the batch adds is that it is one
   *  unit — a throw writes nothing — and since `#putEdge` is an upsert whose count moves only for a
   *  new edge, retrying a whole batch cannot double-count. That is what makes a resumable load safe
   *  to retry coarsely, which `wikimedia-demo.md` puts above throughput.
   *
   *  The fence is claimed once per distinct vshard, not once per edge: `#claim` is a `SELECT`, and a
   *  thousand edges over two or three vshards should pay three reads rather than a thousand. The
   *  caller routes a batch by its first edge, so in practice every edge here shares one vshard; the
   *  set is what keeps that an optimization rather than an assumption. */
  assocAddMany(op: AssocAddManyOp): Reply<number> {
    return this.#write(() => {
      const claimed = new Set<bigint>();
      for (const e of op.edges) {
        this.#own(e.atype);
        const vshard = vshardOf(e.id1);
        if (!claimed.has(vshard)) {
          this.#claim(vshard, op.epoch);
          claimed.add(vshard);
        }
        const time = e.time ?? this.clock.now();
        const data = e.data ?? null;
        const db = e.db ?? 0;
        this.#putEdge(e.atype, e.id1, db, e.id2, time, data);
        const inverse = this.#catalog.inverseOf(e.atype);
        if (inverse !== undefined) {
          this.#dispatch(vshard, { kind: "add", atype: inverse, id1: localTarget(db, e.id2), id2: e.id1, time, data });
        }
      }
      return op.edges.length;
    });
  }

  assocRemove(op: AssocRemoveOp): Reply<void> {
    return this.#write(() => {
      this.#own(op.atype);
      this.#claim(vshardOf(op.id1), op.epoch);
      this.#dropEdge(op.atype, op.id1, op.db ?? 0, op.id2);
      const inverse = this.#catalog.inverseOf(op.atype);
      if (inverse !== undefined) {
        const target = localTarget(op.db ?? 0, op.id2);
        this.#dispatch(vshardOf(op.id1), { kind: "remove", atype: inverse, id1: target, id2: op.id1 });
      }
    });
  }

  /** Applies an op delivered from another host. Add is an upsert, remove is delete-if-present and so is
   *  delete, so redelivering after a lost ack is a no-op and a cascade cycle terminates. */
  apply(op: OutboxOp): Reply<void> {
    return this.#write(() => {
      const vshard = opTarget(op);
      this.#row(vshard); // must still be ours, at whatever epoch
      // An outbox op is always local: it is an inverse or a cascade, and the catalog refuses both on
      // an edge type that permits a foreign target, so alias 0 is not a default but the only value.
      if (op.kind === "add") this.#putEdge(op.atype, op.id1, 0, op.id2, op.time, op.data);
      else if (op.kind === "remove") this.#dropEdge(op.atype, op.id1, 0, op.id2);
      else this.#erase(op.id, new Set());
    });
  }

  // ---- what it holds, for the placement controller

  /** Per-vshard size and request rate. Reading it resets the request counters, so two readers would
   *  each see part of the traffic; one controller polls it. */
  stats(): VshardStats[] {
    // Two passes: a share per vshard, then the engine's real size split across them. Lengths are
    // taken as blobs, since LENGTH() on TEXT counts characters and a UTF-8 payload is wider than it
    // reads — the same distinction #payload already makes against the row-size cap.
    const raw = this.vshards().map((row) => {
      const vshard = row.vshard.toString();
      const v = Number(row.vshard);
      const [lo, hi] = vshardRange(BigInt(row.vshard));
      const sum = (query: string, ...params: Param[]) =>
        this.sql.all<{ n: number; bytes: number }>(query, ...params)[0] ?? { n: 0, bytes: 0 };

      const objects = sum(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(data AS BLOB))), 0) AS bytes" +
          " FROM objects WHERE id BETWEEN ? AND ?",
        lo,
        hi,
      );
      const assocs = sum(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(COALESCE(data, '') AS BLOB))), 0) AS bytes" +
          " FROM assocs WHERE id1 BETWEEN ? AND ?",
        lo,
        hi,
      );
      // Counted too, because they are rows the vshard owns and a move carries: an edge-heavy vshard
      // holds a count per (id1, atype), and a vshard whose outbox is backed up holds that as well.
      const counts = sum("SELECT COUNT(*) AS n, 0 AS bytes FROM assoc_counts WHERE id1 BETWEEN ? AND ?", lo, hi);
      const outbox = sum(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(op AS BLOB))), 0) AS bytes FROM outbox WHERE vshard = ?",
        v,
      );
      const index = sum(
        "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(key AS BLOB))), 0) AS bytes" +
          " FROM index_entries WHERE vshard = ?",
        v,
      );

      const share =
        objects.bytes + objects.n * ROW_COST.object +
        assocs.bytes + assocs.n * ROW_COST.assoc +
        counts.n * ROW_COST.count +
        outbox.bytes + outbox.n * ROW_COST.outbox +
        index.bytes + index.n * ROW_COST.index;

      const requests = this.#requests.get(vshard) ?? 0;
      this.#requests.delete(vshard);
      return { vshard, share, objects: objects.n, requests };
    });

    return raw.map((r) => ({ vshard: r.vshard, bytes: r.share, objects: r.objects, requests: r.requests }));
  }

  /** What this host's database really occupies, as the engine reports it. The per-vshard figures above
   *  cannot be made to sum to this: the difference is keys, indexes, page overhead and the freelist,
   *  and part of it belongs to no vshard at all. Attributing it pro rata was tried and rejected — it
   *  made a vshard's figure depend on what its neighbours hold, and charged the whole fixed cost of a
   *  database to its first vshard.
   *
   *  So the two measurements answer two questions and the controller uses each for its own: this one
   *  decides whether the DO is near the 10 GB limit, where being exact is what averts SQLITE_FULL,
   *  and the shares decide which vshard to shed, where only the ratios between them matter. That also
   *  leaves the soft cap free to stay an estimate, since this is the figure the limit is enforced on
   *  and it is what the controller acts before. */
  size(): number {
    return this.sql.size();
  }

  #count(vshard: bigint): void {
    const k = vshard.toString();
    this.#requests.set(k, (this.#requests.get(k) ?? 0) + 1);
  }

  // ---- moves
  //
  // A vshard is copied a chunk at a time. It is one contiguous key range in objects, assocs and
  // assoc_counts, and one `vshard` prefix in outbox and index_entries, so a cursor over each table's
  // primary key paginates it with a seek rather than a scan. The copy is correct for three reasons,
  // each enforced here rather than assumed:
  //
  //   - The source is fenced throughout. `chunk` refuses a vshard that still takes writes, since a
  //     write landing between two chunks would be in one and not the other.
  //   - Nothing on the target serves a half-copied vshard. Rows are staged with no `vshards` row,
  //     so reads see UNKNOWN and the outbox does not deliver them; the row is written by the last
  //     chunk, in that chunk's transaction, and only then is the vshard the target's.
  //   - A chunk is idempotent. Every row is INSERT OR REPLACE, so a chunk sent twice after a lost
  //     reply lands once, and a copy resumes from the last cursor the directory recorded.
  //
  // What staging cannot make safe is rows left over from an earlier, abandoned copy of the same
  // vshard: if the source changed in between, a leftover the source has since deleted would come
  // back. `discard` clears them, and the mover runs it before every copy that starts from the top.

  /** A whole vshard in one read. One synchronous call, so it is consistent whatever the vshard's
   *  state; a move uses `chunk` instead, because a whole vshard does not fit in one request. */
  snapshot(vshard: string): Snapshot {
    const v = BigInt(vshard);
    const row = this.#vshardRow(v);
    if (!row) throw new NotOwned({ vshard, state: "absent", epoch: -1 });
    const c = this.#read(v, row, COPY_START, UNBOUNDED);
    return { vshard: c.vshard, epoch: c.epoch, nextSeq: c.nextSeq, objects: c.objects, assocs: c.assocs, counts: c.counts, outbox: c.outbox, index: c.index };
  }

  /** One slice of a fenced vshard, starting at `from` and bounded by `budget`: at most `budget.rows`
   *  rows and `budget.bytes` of payload, except that a chunk always carries at least one row, so a row
   *  larger than the byte bound still moves, alone. `next` is where the following chunk starts, or
   *  null when this is the last.
   *
   *  Refuses a vshard that is not fenced. It names `Unfenced` when the vshard is owned, which the
   *  mover answers by fencing again and copying from the top, and `NotOwned` otherwise. */
  chunk(vshard: string, from: CopyCursor = COPY_START, budget: ChunkBudget = DEFAULT_CHUNK): Chunk {
    const v = BigInt(vshard);
    const row = this.#vshardRow(v);
    if (!row) throw new NotOwned({ vshard, state: "absent", epoch: -1 });
    if (row.state === "owned") throw new Unfenced(vshard);
    if (row.state !== "fenced") throw new NotOwned({ vshard, state: row.state, epoch: row.epoch });
    if (!COPY_TABLES.includes(from.table)) throw new RangeError(`no copy table ${JSON.stringify(from.table)}`);
    return this.#read(v, row, from, budget);
  }

  /** Installs one chunk of a vshard, or a whole snapshot, at `epoch`. Each call is one transaction.
   *
   *  Rows land staged: nothing serves them until the last chunk (`next` null, or absent on a whole
   *  snapshot) writes the `vshards` row, which takes ownership in the same transaction as the last
   *  rows. Idempotent, so a chunk re-sent after a lost reply, or a copy resumed from a recorded
   *  cursor, lands each row once.
   *
   *  Refuses a vshard this host already holds in any other way than as this copy's own result —
   *  owned at exactly `epoch` — because a copy writing into a vshard a host serves would merge two
   *  vshards' rows with nothing to say which were whose. */
  install(snap: Snapshot & { next?: CopyCursor | null }, epoch: number): void {
    const v = BigInt(snap.vshard);
    const last = snap.next === undefined || snap.next === null;
    this.sql.txn(() => {
      const held = this.#vshardRow(v);
      if (held && !(held.state === "owned" && held.epoch === epoch)) {
        throw new Error(
          `vshard ${snap.vshard} is ${held.state} at epoch ${held.epoch} on this host, so a copy installing it at` +
            ` epoch ${epoch} would write into rows this host already holds`,
        );
      }
      for (const o of snap.objects) {
        this.sql.run("INSERT OR REPLACE INTO objects (id, otype, version, data) VALUES (?, ?, ?, ?)", toKey(o.id), o.otype, o.version, o.data);
      }
      for (const a of snap.assocs) {
        // The one direction that cannot work: a format 2 snapshot holding a foreign edge installed
        // into a format 1 host would drop the alias and leave an edge into this database instead of
        // the one it named. Refused rather than narrowed.
        if (this.#format === 2) {
          this.sql.run(
            "INSERT OR REPLACE INTO assocs (id1, atype, db, id2, time, data) VALUES (?, ?, ?, ?, ?, ?)",
            toKey(a.id1),
            a.atype,
            a.db,
            toKey(a.id2),
            a.time,
            a.data,
          );
        } else {
          if (a.db !== 0) {
            throw new FormatError(
              `the snapshot of vshard ${snap.vshard} holds an edge into database ${a.db}, and this host is storage` +
                " format 1, which has no column for it. The alias would be dropped and the edge would read back as" +
                " one into this database.",
            );
          }
          this.sql.run(
            "INSERT OR REPLACE INTO assocs (id1, atype, id2, time, data) VALUES (?, ?, ?, ?, ?)",
            toKey(a.id1),
            a.atype,
            toKey(a.id2),
            a.time,
            a.data,
          );
        }
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
      if (!last) return;
      // next_seq comes with it, or the new owner would hand out ids the old one already used. It is
      // the last chunk's figure, read from the source after every other row: the source is fenced, so
      // it cannot have moved, but this is the reading that would see it if it had.
      this.sql.run(
        "INSERT INTO vshards (vshard, epoch, state, next_seq) VALUES (?, ?, 'owned', ?)" +
          " ON CONFLICT (vshard) DO UPDATE SET epoch = excluded.epoch, state = 'owned', next_seq = excluded.next_seq",
        Number(v),
        epoch,
        snap.nextSeq,
      );
    });
  }

  /** Clears what an earlier copy of this vshard left on this host, before a copy that starts from the
   *  top. Deletes at most `limit` rows and returns true once none are left.
   *
   *  Refuses a vshard this host holds unless it is this copy's own finished result, owned at exactly
   *  `epoch`: that is a copy the mover rewound before its route flipped, and nothing routes to it.
   *  Its `vshards` row goes first, in the first call, so a half-cleared vshard is never served. */
  discard(vshard: string, epoch: number, limit = Infinity): boolean {
    const v = BigInt(vshard);
    return this.sql.txn(() => {
      const held = this.#vshardRow(v);
      if (held) {
        if (!(held.state === "owned" && held.epoch === epoch)) {
          throw new Error(
            `vshard ${vshard} is ${held.state} at epoch ${held.epoch} on this host, and a copy at epoch ${epoch}` +
              " clears only what a copy left behind, never a vshard a host holds",
          );
        }
        this.sql.run("DELETE FROM vshards WHERE vshard = ?", Number(v));
      }
      return this.#drop(v, limit);
    });
  }

  /** Drops a retired vshard's rows, after the grace period that lets stale readers find out. Deletes
   *  at most `limit` rows per call and returns true once the vshard is gone. The `vshards` row goes
   *  last, so until then the vshard reads as moved rather than as something partly deleted. */
  purge(vshard: string, limit = Infinity): boolean {
    const v = BigInt(vshard);
    return this.sql.txn(() => {
      const done = this.#drop(v, limit);
      if (done) this.sql.run("DELETE FROM vshards WHERE vshard = ?", Number(v));
      return done;
    });
  }

  /** What a host has recorded about a vshard, if anything. */
  stateOf(vshard: bigint): State | "absent" {
    return this.#state(vshard);
  }

  /** Deletes up to `limit` of a vshard's rows across every table, inside the caller's transaction.
   *  True when none are left. Each delete is bounded through a subquery, since `DELETE … LIMIT` is a
   *  compile-time option SQLite builds do not all have. */
  #drop(v: bigint, limit: number): boolean {
    const [lo, hi] = vshardRange(v);
    const n = Number(v);
    const tables: [string, string, Param[]][] = [
      ["objects", "id FROM objects WHERE id BETWEEN ? AND ?", [lo, hi]],
      ["assocs", `${this.#format === 2 ? "id1, atype, db, id2" : "id1, atype, id2"} FROM assocs WHERE id1 BETWEEN ? AND ?`, [lo, hi]],
      ["assoc_counts", "id1, atype FROM assoc_counts WHERE id1 BETWEEN ? AND ?", [lo, hi]],
      ["outbox", "vshard, seq FROM outbox WHERE vshard = ?", [n]],
      ["index_entries", "vshard, idx, key FROM index_entries WHERE vshard = ?", [n]],
    ];
    let left = limit;
    for (const [table, keys, params] of tables) {
      if (left <= 0) break;
      const bound = Number.isFinite(left) ? left : -1; // a negative LIMIT is no limit
      const taken = this.sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT ${keys} LIMIT ?)`, ...params, bound)[0]?.n ?? 0;
      if (taken === 0) continue;
      const columns = keys.slice(0, keys.indexOf(" FROM "));
      this.sql.run(`DELETE FROM ${table} WHERE (${columns}) IN (SELECT ${keys} LIMIT ?)`, ...params, bound);
      left -= taken;
    }
    if (left > 0) return true;
    return !tables.some(
      ([, keys, params]) => (this.sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT ${keys} LIMIT 1)`, ...params)[0]?.n ?? 0) > 0,
    );
  }

  #vshardRow(v: bigint): VshardRow | undefined {
    return this.sql.all<VshardRow>("SELECT vshard, epoch, state, next_seq FROM vshards WHERE vshard = ?", Number(v))[0];
  }

  /** Reads rows of one vshard from `from` until `budget` is spent or the vshard is exhausted. */
  #read(v: bigint, row: VshardRow, from: CopyCursor, budget: ChunkBudget): Chunk {
    const chunk: Chunk = {
      vshard: v.toString(),
      epoch: row.epoch,
      nextSeq: row.next_seq,
      from,
      next: null,
      objects: [],
      assocs: [],
      counts: [],
      outbox: [],
      index: [],
    };
    let rows = 0;
    let bytes = 0;
    for (let t = COPY_TABLES.indexOf(from.table); t < COPY_TABLES.length; t++) {
      const table = COPY_TABLES[t];
      let after = table === from.table ? from.after : null;
      for (;;) {
        const want = Math.min(PAGE_ROWS, Math.max(1, budget.rows - rows));
        const page = this.#page(table, v, after, want);
        for (const r of page) {
          // At least one row per chunk; past that, a row joins only if it fits both bounds.
          if (rows > 0 && (rows + 1 > budget.rows || bytes + r.size > budget.bytes)) {
            chunk.next = { table, after };
            return chunk;
          }
          r.put(chunk);
          rows++;
          bytes += r.size;
          after = r.key;
        }
        if (page.length < want) break; // this table is done
        if (rows >= budget.rows) {
          chunk.next = { table, after };
          return chunk;
        }
      }
    }
    // Read after every other row. The source is fenced, so this cannot have moved since the first
    // chunk; reading it last is what would show it if it had.
    const now = this.#vshardRow(v);
    if (now) chunk.nextSeq = now.next_seq;
    return chunk;
  }

  /** One page of one table, after a key or from its start. Every query seeks on the primary key: the
   *  row-value comparison is what lets SQLite start at the cursor, where a BETWEEN on the leading
   *  column alone would rescan from the vshard's start on every page and make a high-degree object
   *  quadratic to copy. */
  #page(table: CopyTable, v: bigint, after: KeyPart[] | null, n: number): CopyRow[] {
    const [lo, hi] = vshardRange(v);
    const id = (k: KeyPart) => toKey(String(k));
    switch (table) {
      case "objects": {
        const rows = this.sql.all<{ id: Uint8Array; otype: number; version: number; data: string; size: number }>(
          "SELECT id, otype, version, data, LENGTH(CAST(data AS BLOB)) AS size FROM objects" +
            (after ? " WHERE id > ? AND id <= ?" : " WHERE id BETWEEN ? AND ?") +
            " ORDER BY id LIMIT ?",
          after ? id(after[0]) : lo,
          hi,
          n,
        );
        return rows.map((r) => {
          const o = { id: fromKey(r.id), otype: r.otype, version: r.version, data: r.data };
          return { key: [o.id], size: ROW_COST.object + r.size, put: (c: Chunk) => void c.objects.push(o) };
        });
      }
      case "assocs": {
        // Format 1 has no `db` column, so its rows read as alias 0 — which is what makes a format 1
        // vshard installable into a format 2 host, and so makes a move the migration between the two.
        const two = this.#format === 2;
        const cols = two ? "id1, atype, db, id2" : "id1, atype, id2";
        const marks = two ? "?, ?, ?, ?" : "?, ?, ?";
        const params: Param[] = after
          ? two
            ? [id(after[0]), Number(after[1]), Number(after[2]), id(after[3]), hi, n]
            : [id(after[0]), Number(after[1]), id(after[2]), hi, n]
          : [lo, hi, n];
        const rows = this.sql.all<{
          id1: Uint8Array;
          atype: number;
          db?: number;
          id2: Uint8Array;
          time: number;
          data: string | null;
          size: number;
        }>(
          `SELECT ${cols}, time, data, COALESCE(LENGTH(CAST(data AS BLOB)), 0) AS size FROM assocs` +
            (after ? ` WHERE (${cols}) > (${marks}) AND id1 <= ?` : " WHERE id1 BETWEEN ? AND ?") +
            ` ORDER BY ${cols} LIMIT ?`,
          ...params,
        );
        return rows.map((r) => {
          const a = { id1: fromKey(r.id1), atype: r.atype, db: r.db ?? 0, id2: fromKey(r.id2), time: r.time, data: r.data };
          const key = two ? [a.id1, a.atype, a.db, a.id2] : [a.id1, a.atype, a.id2];
          return { key, size: ROW_COST.assoc + r.size, put: (c: Chunk) => void c.assocs.push(a) };
        });
      }
      case "counts": {
        const rows = this.sql.all<{ id1: Uint8Array; atype: number; n: number }>(
          "SELECT id1, atype, n FROM assoc_counts" +
            (after ? " WHERE (id1, atype) > (?, ?) AND id1 <= ?" : " WHERE id1 BETWEEN ? AND ?") +
            " ORDER BY id1, atype LIMIT ?",
          ...(after ? [id(after[0]), Number(after[1]), hi, n] : [lo, hi, n]),
        );
        return rows.map((r) => {
          const k = { id1: fromKey(r.id1), atype: r.atype, n: r.n };
          return { key: [k.id1, k.atype], size: ROW_COST.count, put: (c: Chunk) => void c.counts.push(k) };
        });
      }
      case "outbox": {
        // Outbox rows belong to their source vshard and move with it, in sequence order.
        const rows = this.sql.all<{ seq: number; target_vshard: number; op: string; size: number }>(
          "SELECT seq, target_vshard, op, LENGTH(CAST(op AS BLOB)) AS size FROM outbox WHERE vshard = ?" +
            (after ? " AND seq > ?" : "") +
            " ORDER BY seq LIMIT ?",
          ...(after ? [Number(v), Number(after[0]), n] : [Number(v), n]),
        );
        return rows.map((r) => {
          const o = { seq: r.seq, target: r.target_vshard, op: r.op };
          return { key: [o.seq], size: ROW_COST.outbox + r.size, put: (c: Chunk) => void c.outbox.push(o) };
        });
      }
      case "index": {
        // Index entries live in an index vshard, so they travel when it moves.
        const rows = this.sql.all<{ idx: number; key: string; id: Uint8Array | null; state: string; at: number }>(
          "SELECT idx, key, id, state, at FROM index_entries WHERE vshard = ?" +
            (after ? " AND (idx, key) > (?, ?)" : "") +
            " ORDER BY idx, key LIMIT ?",
          ...(after ? [Number(v), Number(after[0]), String(after[1]), n] : [Number(v), n]),
        );
        return rows.map((r) => {
          const e = { idx: r.idx, key: r.key, id: r.id === null ? null : fromKey(r.id), state: r.state, at: r.at };
          return { key: [e.idx, e.key], size: ROW_COST.index + e.key.length, put: (c: Chunk) => void c.index.push(e) };
        });
      }
    }
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
      // A copy's staged rows have no `vshards` row yet, and are not this host's to deliver: delivering
      // a staged op from an abandoned copy would replay it after the source had moved on.
      "SELECT vshard, seq, target_vshard, op FROM outbox WHERE vshard IN (SELECT vshard FROM vshards)" +
        " ORDER BY vshard, seq LIMIT ?",
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
      if (e instanceof Maintained) return { ok: false, maintained: { edge: e.edge, by: e.by } };
      if (e instanceof Restricted) return { ok: false, restricted: { id: e.id, edge: e.edge } };
      if (e instanceof Taken) return { ok: false, taken: { idx: e.idx, key: e.key, by: e.by } };
      if (e instanceof Conflict) return { ok: false, conflict: { id: e.id, expected: e.expected, actual: e.actual } };
      throw e;
    }
  }

  /** Refuses a direct write to the derived half of a pair. Checked before ownership, because the
   *  request is wrong wherever it is sent and re-routing it would cost a round trip for nothing.
   *
   *  Only direct writes. `apply` is how the maintaining side's rows arrive, and a cascade's
   *  withdrawal goes the same way, so neither comes through here. */
  #own(atype: number): void {
    const by = this.#catalog.maintainedBy(atype);
    if (by) throw new Maintained(this.#catalog.edge(atype)!.name, by.name);
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
    // The alias comes with the target: an inverse withdrawal and a cascade both route by it, and
    // `localTarget` below is what makes reaching one with a foreign target a loud failure rather
    // than a write landing on an unrelated local object.
    const lists = types.map((e) => ({
      edge: e,
      targets: this.sql
        .all<{ db?: number; id2: Uint8Array }>(
          this.#format === 2
            ? "SELECT db, id2 FROM assocs WHERE id1 = ? AND atype = ?"
            : "SELECT id2 FROM assocs WHERE id1 = ? AND atype = ?",
          key,
          e.atype!,
        )
        .map((r) => ({ db: r.db ?? 0, id: fromKeyOf(r.id2) })),
    }));
    for (const { edge, targets } of lists) {
      if (edge.onDelete === "restrict" && targets.length > 0) throw new Restricted(id, edge.name);
    }

    for (const { edge, targets } of lists) {
      const inverse = this.#catalog.inverseOf(edge.atype!);
      for (const { db, id: target } of targets) {
        // Withdraw the inverse this object's edge put on the other side.
        if (inverse !== undefined) {
          this.#dispatch(source, { kind: "remove", atype: inverse, id1: localTarget(db, target), id2: id });
        }
        if (edge.onDelete !== "cascade") continue;
        const t = localTarget(db, target);
        if (vshardOf(t) === source) this.#erase(t, seen);
        // `seen` travels with it: another vshard on this host is another key range in the same
        // database, so the cascade runs inline, and a cycle through it has nothing else to stop it.
        else this.#dispatch(source, { kind: "delete", id: t }, seen);
      }
    }

    this.sql.run("DELETE FROM objects WHERE id = ?", key);
    this.sql.run("DELETE FROM assocs WHERE id1 = ?", key);
    this.sql.run("DELETE FROM assoc_counts WHERE id1 = ?", key);
  }

  /** Applies an op inline when its vshard is on this host, so a colocated pair is atomic for free, and
   *  queues it otherwise. Outbox rows belong to the source vshard and move with it.
   *
   *  Inline only while nothing for this pair is already waiting. Delivery is ordered per (source
   *  vshard, target vshard), and an op applied inline ahead of a queued one overtakes it: a move that
   *  brings two vshards onto one host, with a row for that pair still in flight, is exactly when that
   *  happens, and an add delivered after the remove that was meant to undo it leaves an edge nothing
   *  asked for.
   *
   *  `seen` is the cascade this op is part of, where it has one. A delete delivered from elsewhere
   *  starts its own, and terminates because the object that sent it is already gone. */
  #dispatch(source: bigint, op: OutboxOp, seen?: Set<Id>): void {
    const target = opTarget(op);
    if (this.#state(target) === "owned" && !this.#waiting(source, target)) {
      if (op.kind === "add") this.#putEdge(op.atype, op.id1, 0, op.id2, op.time, op.data);
      else if (op.kind === "remove") this.#dropEdge(op.atype, op.id1, 0, op.id2);
      else this.#erase(op.id, seen ?? new Set());
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

  /** Whether anything is already queued for this (source, target) pair, and so whether an inline
   *  apply would arrive out of order. */
  #waiting(source: bigint, target: bigint): boolean {
    return (
      this.sql.all("SELECT 1 AS one FROM outbox WHERE vshard = ? AND target_vshard = ? LIMIT 1", Number(source), Number(target))
        .length > 0
    );
  }

  /** Refuses an alias this host cannot hold, or one under an edge type that does not permit a
   *  foreign target. Both before anything is written, so a refused edge leaves no trace.
   *
   *  The second check is the catalog's rule enforced where the row lands. A host cannot resolve an
   *  alias — it stores the number and never looks it up — but it does know whether the edge type was
   *  declared foreign, and an alias under one that was not is an edge nothing can read back
   *  correctly: step 4's coordinator routes a foreign hop on the static flag. */
  #checkAlias(atype: number, db: number): void {
    if (db === 0) return;
    if (this.#format !== 2) {
      throw new FormatError(
        `an edge into database ${db} needs storage format 2, and this host is format ${this.#format}.` +
          " Format 1 has no column for the target's database, so the alias would be dropped and the edge would" +
          " read back as one into this database.",
      );
    }
    const edge = this.#catalog.edge(atype);
    if (edge !== undefined && !edge.foreign) {
      throw new FormatError(`${edge.name} does not permit a foreign target, so it cannot hold an edge into database ${db}`);
    }
  }

  #putEdge(atype: number, id1: Id, db: number, id2: Id, time: number, data: Fields | null): void {
    this.#checkAlias(atype, db);
    const k1 = toKey(id1);
    const k2 = toKey(id2);
    const existed = this.#hasEdge(k1, atype, db, k2);
    const json = data === null ? null : JSON.stringify(data);
    if (this.#format === 2) {
      this.sql.run(
        "INSERT INTO assocs (id1, atype, db, id2, time, data) VALUES (?, ?, ?, ?, ?, ?)" +
          " ON CONFLICT (id1, atype, db, id2) DO UPDATE SET time = excluded.time, data = excluded.data",
        k1,
        atype,
        db,
        k2,
        time,
        json,
      );
    } else {
      // Format 1's statement, byte for byte what it has always been. A host that was loaded on this
      // format issues exactly the SQL it was loaded with.
      this.sql.run(
        "INSERT INTO assocs (id1, atype, id2, time, data) VALUES (?, ?, ?, ?, ?)" +
          " ON CONFLICT (id1, atype, id2) DO UPDATE SET time = excluded.time, data = excluded.data",
        k1,
        atype,
        k2,
        time,
        json,
      );
    }
    if (!existed) this.#bump(k1, atype, 1);
  }

  #dropEdge(atype: number, id1: Id, db: number, id2: Id): void {
    this.#checkAlias(atype, db);
    const k1 = toKey(id1);
    const k2 = toKey(id2);
    if (!this.#hasEdge(k1, atype, db, k2)) return;
    if (this.#format === 2) {
      this.sql.run("DELETE FROM assocs WHERE id1 = ? AND atype = ? AND db = ? AND id2 = ?", k1, atype, db, k2);
    } else {
      this.sql.run("DELETE FROM assocs WHERE id1 = ? AND atype = ? AND id2 = ?", k1, atype, k2);
    }
    this.#bump(k1, atype, -1);
  }

  #hasEdge(k1: Uint8Array, atype: number, db: number, k2: Uint8Array): boolean {
    return this.#format === 2
      ? this.sql.all("SELECT 1 AS one FROM assocs WHERE id1 = ? AND atype = ? AND db = ? AND id2 = ?", k1, atype, db, k2)
          .length > 0
      : this.sql.all("SELECT 1 AS one FROM assocs WHERE id1 = ? AND atype = ? AND id2 = ?", k1, atype, k2).length > 0;
  }

  /**
   * Validates every payload field the catalog declares as an id.
   *
   * Field relationships hold ids INSIDE the JSON payload, which is why `query/ref.ts` exists at all,
   * and it is the other place a qualified reference is accepted. Two things are checked:
   *
   * - That the value is a reference at all. A payload is opaque to storage, so a malformed id in one
   *   is found later by whatever tries to follow it, as a read that throws or an object that is
   *   quietly absent. Checking it on the way in turns that into a refused write.
   * - That a qualified one sits under a field relationship declared `foreign`, where one follows the
   *   field. The flag is the planner's static signal that a hop can leave this database, and a
   *   qualified reference under a type that does not declare one is a reference no read will route.
   *
   * A qualified reference in an id field that NOTHING follows is left alone: the catalog says the
   * field holds an id, nothing traverses it, and refusing it would be refusing a value no part of
   * this engine will ever read.
   */
  #checkRefs(otype: number, data: Fields): void {
    const type = this.#catalog.object(otype);
    if (type === undefined) return; // an otype this host's catalog does not know; nothing to check against
    for (const [field, spec] of Object.entries(type.fields)) {
      if (!isIdSpec(spec)) continue;
      const value = data[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string") {
        throw new TypeError(`${type.name}.${field} is an id, but the payload holds a ${typeof value}`);
      }
      const { db } = parseRef(value); // throws, naming the canonical spelling where there is one
      if (db === null) continue;
      const follows = this.#catalog.edgeTypes().find((e) => e.from === type.name && e.field === field);
      if (follows !== undefined && !follows.foreign) {
        throw new TypeError(
          `${type.name}.${field} holds ${value}, which is in another database, and ${follows.name} follows that field` +
            ' without permitting a foreign target. Declare that edge type with `"foreign": true`.',
        );
      }
    }
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
