// Random graphs and random queries, from a seed.
//
// A graph is generated as a script of operations rather than written straight into a cluster, so the
// same script can be replayed against two clusters whose data sits in different places. Ids come from
// a vshard's own sequence, so replaying the same script in the same order produces the same ids
// wherever the vshards happen to live — which is what lets two runs be compared at all. A delete does
// not give its sequence number back, so a script that deletes replays to the same ids too.
//
// Every operation names objects by their position in the script, not by id: the script is written
// before any id exists.

import type { Hlekk } from "../client/client.ts";
import type { Fields, Id, Json } from "../query/types.ts";
import type { Random } from "../runtime/runtime.ts";
import type { Query } from "../schema/query.ts";
import type { EdgeType, FieldMap } from "../schema/define.ts";
import type { Shape } from "./shape.ts";
import { writableOut } from "./shape.ts";

/** A payload, and which of the script's objects its id fields point at. */
interface Written {
  data: Fields;
  refs: Record<string, number>;
}

export type Op =
  | ({ kind: "create"; type: string; vshard: string } & Written)
  /** Hard colocation: the new object takes the vshard of an object already made. */
  | ({ kind: "with"; type: string; parent: number } & Written)
  | ({ kind: "update"; at: number; /** The version to require, or null to write unconditionally. */ expect: number | null } & Written)
  | { kind: "erase"; at: number }
  | { kind: "assoc"; atype: number; from: number; to: number; time: number; data: Fields | null }
  | { kind: "unassoc"; atype: number; from: number; to: number };

export interface Script {
  ops: Op[];
  /** Which vshards the script writes into. */
  vshards: string[];
}

export interface GraphOptions {
  /** How many objects to make. */
  objects?: number;
  /** How many vshards to spread them over. */
  vshards?: number;
  /** How many edges to write. */
  edges?: number;
  /** How many objects to update. */
  updates?: number;
  /** How many objects to delete. A delete applies every edge type's onDelete, so it reaches further
   *  than the one object and is the only operation that can leave an edge pointing at nothing. */
  deletes?: number;
  /** How many edges to take back out. */
  removes?: number;
  /**
   * How edge times are drawn. `"pool"`, the default, draws from eight values so ties happen and the
   * id tie-break is exercised.
   *
   * `"distinct"` gives every edge its own time, which the FEDERATION oracle needs: the order an edge
   * list is read in is `(time, db, id2)`, so at a tie a list with foreign rows in it orders them
   * ahead of local ones while the same list in one database orders purely by id. That is a stated
   * property of storage format 2, not a bug — but it means a limit cutting a list mid-tie keeps
   * different rows on the two layouts, and no normalization of the answers can undo that. Distinct
   * times make the order total, so the comparison is about what crossing a database boundary does
   * and not about which of two tied rows a limit kept.
   */
  times?: "pool" | "distinct";
}

export function generateGraph(r: Random, shape: Shape, opts: GraphOptions = {}): Script {
  const count = opts.objects ?? 24;
  const spread = opts.vshards ?? 6;
  const edges = opts.edges ?? 32;
  const names = Object.keys(shape.types);
  // Vshards picked from the batch a new database starts with.
  const vshards = [...new Set([...Array(spread)].map(() => String(r.int(64))))];

  const ops: Op[] = [];
  /** The type of the object each position made. */
  const made: string[] = [];
  const byType = new Map<string, number[]>();
  const ref = (target: string) => {
    const positions = byType.get(target);
    return positions && positions.length > 0 ? r.pick(positions) : undefined;
  };

  for (let i = 0; i < count; i++) {
    // The first few cover every type, so an id field and an edge both have somewhere to land.
    const type = i < names.length ? names[i] : r.pick(names);
    const { data, refs } = shape.payload(r, type, ref);
    // A third of objects are colocated with something already made, which is how a colocation group
    // forms and the only way two objects are guaranteed to share a host.
    if (made.length > 0 && r.chance(0.3)) {
      ops.push({ kind: "with", type, parent: r.int(made.length), data, refs });
    } else {
      ops.push({ kind: "create", type, vshard: r.pick(vshards), data, refs });
    }
    byType.set(type, [...(byType.get(type) ?? []), i]);
    made.push(type);
  }

  /** Edges the script has written, so a remove mostly lands on one rather than on nothing. */
  const written: { atype: number; from: number; to: number }[] = [];
  const positionsOf = (type: string) => byType.get(type) ?? [];
  // Only from a type that has an edge to write. Picking uniformly spends most attempts on types that
  // originate nothing — every pair is written from one side, so the other side's type may have no
  // writable edge at all — and the graph comes out thin.
  const origins = made.map((_, j) => j).filter((j) => writableOut(shape, made[j]).length > 0);
  const timeOf = (i: number) => (opts.times === "distinct" ? edges - i : r.int(8));
  for (let i = 0; i < edges && origins.length > 0; i++) {
    const from = r.pick(origins);
    const out = writableOut(shape, made[from]);
    const rel = r.pick(out);
    const candidates = positionsOf(rel.to);
    if (candidates.length === 0) continue;
    const to = r.pick(candidates);
    ops.push({
      kind: "assoc",
      atype: rel.atype!,
      from,
      to,
      // A small pool by default, so ties happen and the id tie-break is exercised. See
      // `GraphOptions.times` for the one oracle that needs them distinct instead.
      time: timeOf(i),
      data: r.chance(0.3) ? { tag: r.pick(["x", "y"]) } : null,
    });
    written.push({ atype: rel.atype!, from, to });
  }

  // Updates, removes and deletes are shuffled into the tail rather than each run as a block, so a
  // delete can land on an object a later edge write still names.
  const tail: Op[] = [];
  for (let i = 0; i < (opts.updates ?? 0); i++) {
    const at = r.int(made.length);
    const { data, refs } = shape.payload(r, made[at], ref);
    // An absolute version rather than one that was read: a guess conflicts about as often as it
    // holds, which is what puts a conflict on the path at all.
    tail.push({ kind: "update", at, expect: r.chance(0.3) ? 1 + r.int(3) : null, data, refs });
  }
  for (let i = 0; i < (opts.removes ?? 0); i++) {
    if (written.length === 0) break;
    // Mostly an edge that exists; sometimes one that never did, which must be a no-op and not an
    // error.
    const e = r.chance(0.85) ? r.pick(written) : { ...r.pick(written), to: r.int(made.length) };
    tail.push({ kind: "unassoc", atype: e.atype, from: e.from, to: e.to });
  }
  for (let i = 0; i < (opts.deletes ?? 0); i++) {
    tail.push({ kind: "erase", at: r.int(made.length) });
  }
  ops.push(...r.shuffle(tail));

  return { ops, vshards };
}

/** What one operation did. A replay compares these between two clusters: an operation that was
 *  refused on one and accepted on the other is a difference, however the data ends up. */
export type Outcome = { ok: true } | { ok: false; error: string };

export interface Replayed {
  /** The id each create made, in the script's order. */
  ids: Id[];
  /** The type at each position. */
  types: string[];
  /** One per operation, in the script's order. */
  outcomes: Outcome[];
}

const failed = (e: unknown): Outcome => ({ ok: false, error: e instanceof Error ? e.name : String(e) });

/** Replays a script. Sequential, so two replays of one script hand out the same ids.
 *
 *  `settle` runs between operations where one is given: an inverse that crosses a vshard is queued
 *  rather than written, and an operation that reads what an earlier one queued would otherwise see
 *  the cluster at a point the script cannot describe. */
export async function replay(db: Hlekk, shape: Shape, script: Script, settle?: () => Promise<unknown>): Promise<Replayed> {
  const ids: Id[] = [];
  const kinds: string[] = [];
  const outcomes: Outcome[] = [];
  const otypeOf = (type: string) => shape.types[type].otype;
  /** An id field's placeholder, resolved to whatever the position it names actually became. */
  const fill = (w: { data: Fields; refs: Record<string, number> }): Record<string, Json> => {
    const data = { ...w.data };
    for (const [field, at] of Object.entries(w.refs)) data[field] = ids[at];
    return data;
  };

  for (const op of script.ops) {
    try {
      switch (op.kind) {
        case "create":
          ids.push(await db.create(otypeOf(op.type), fill(op), { vshard: op.vshard }));
          kinds.push(op.type);
          break;
        case "with":
          ids.push(await db.create(otypeOf(op.type), fill(op), { with: ids[op.parent] }));
          kinds.push(op.type);
          break;
        case "update":
          await db.update(ids[op.at], fill(op), op.expect === null ? {} : { expect: op.expect });
          break;
        case "erase":
          await db.delete(ids[op.at]);
          break;
        case "assoc":
          await db.assocAdd(op.atype, ids[op.from], ids[op.to], op.time, op.data as Record<string, Json> | null);
          break;
        case "unassoc":
          await db.assocRemove(op.atype, ids[op.from], ids[op.to]);
          break;
      }
      outcomes.push({ ok: true });
    } catch (e) {
      // A create that cannot land would shift every later position, so it is not survivable; every
      // other refusal is part of what the script is testing.
      if (op.kind === "create" || op.kind === "with") throw e;
      outcomes.push(failed(e));
    }
    if (settle) await settle();
  }
  return { ids, types: kinds, outcomes };
}

export interface QueryOptions {
  /** How deep the tree may go. */
  depth?: number;
  /** How many relations one level may follow. */
  width?: number;
  /**
   * How many levels down a count may be asked for. Unbounded by default; 0 keeps counts on the root
   * alone.
   *
   * For an oracle that wants every count to be a local one: a count below the root is a count of an
   * object's edges, and that object may be in another database, which makes it a request with
   * `counts` rather than a read of a maintained row. The root is always the asking database's own.
   * The federation oracle no longer needs it — those requests are built — and it is kept because the
   * distinction is the one a reader of that oracle has to make to understand what it covers.
   */
  countsBelow?: number;
}

/** A random query from a root type. Loosely typed on purpose: a generated tree cannot be checked
 *  statically, and what is under test is the answer, not the types. */
export function generateQuery(
  r: Random,
  shape: Shape,
  root: string,
  start: Query<never, unknown>,
  opts: QueryOptions = {},
): Query<never, unknown> {
  const depth = opts.depth ?? 3;
  const width = opts.width ?? 2;
  const countsBelow = opts.countsBelow ?? Infinity;

  const build = (q: unknown, type: string, left: number): unknown => {
    let out = q as Record<string, (...a: unknown[]) => unknown>;
    const options = shape.outgoing[type];

    // Every level carries a limit. A small one, so a filter's read-ahead window matters.
    out = out.limit(1 + r.int(6)) as typeof out;

    if (r.chance(0.5) && depth - left <= countsBelow) {
      const countable = options.filter((o) => o.atype !== undefined);
      if (countable.length > 0) {
        const c = r.pick(countable);
        out = out.countAs(`n_${c.name}`, c.rel as EdgeType<FieldMap, FieldMap, boolean>) as typeof out;
      }
    }
    if (r.chance(0.4)) {
      const fields = shape.comparable[type];
      if (fields.length > 0) {
        const f = r.pick(fields);
        out = out.where(f.field, r.pick(["=", "!=", ">", "<", ">=", "<="]), r.pick(f.values)) as typeof out;
      }
    }
    if (left <= 0) return out;

    for (const rel of r.shuffle(options).slice(0, 1 + r.int(width))) {
      if (!r.chance(0.75)) continue;
      const paged = r.chance(0.2);
      const method = paged ? "relatedPage" : "related";
      out = out[method](rel.name, rel.rel, (sub: unknown) => build(sub, rel.to, left - 1)) as typeof out;
    }
    return out;
  };

  return build(start, root, depth) as Query<never, unknown>;
}
