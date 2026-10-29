// Random graphs and random queries, from a seed.
//
// A graph is generated as a script of operations rather than written straight into a cluster, so the
// same script can be replayed against two clusters whose data sits in different places. Ids come from
// a vshard's own sequence, so replaying the same script in the same order produces the same ids
// wherever the vshards happen to live — which is what lets two runs be compared at all.

import type { Hlekk } from "../client/client.ts";
import type { Fields, Id, Json } from "../query/types.ts";
import type { Random } from "../runtime/runtime.ts";
import type { Query } from "../schema/query.ts";
import { Comment, Issue, Label, User, comparable, outgoing, types } from "./schema.ts";
import type { Outgoing } from "./schema.ts";

export type Op =
  | { kind: "create"; type: TypeName; vshard: string; data: Fields }
  /** Hard colocation: the new object takes the vshard of an object already made. */
  | { kind: "with"; type: TypeName; parent: number; data: Fields }
  | { kind: "assoc"; rel: string; from: number; to: number; time: number; data: Fields | null };

export type TypeName = keyof typeof types;

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
}

const TYPE_NAMES: TypeName[] = ["Issue", "Comment", "User", "Label"];

/** A payload for a type, from a small pool of values so filters actually match some rows. */
function payload(r: Random, type: TypeName, authors: number[], ids: Id[]): Fields {
  switch (type) {
    case "Issue":
      return { title: r.pick(["t0", "t1", "t2"]), status: r.pick(["open", "closed"]) };
    case "Comment": {
      // authorId points at a user already made, so the field relationship has somewhere to land.
      const author = authors.length > 0 ? ids[r.pick(authors)] : "0";
      return { body: r.pick(["b0", "b1", "b2"]), score: r.int(4), authorId: author };
    }
    case "User":
      return { name: r.pick(["u0", "u1", "u2"]), rank: r.int(3) };
    case "Label":
      return { name: r.pick(["l0", "l1"]) };
  }
}

export function generateGraph(r: Random, opts: GraphOptions = {}): Script {
  const count = opts.objects ?? 24;
  const spread = opts.vshards ?? 6;
  const edges = opts.edges ?? 32;
  // Vshards picked from the batch a new database starts with.
  const vshards = [...new Set([...Array(spread)].map(() => String(r.int(64))))];

  const ops: Op[] = [];
  const made: TypeName[] = [];
  const authors: number[] = [];
  const placeholderIds: Id[] = [];

  // Users first, so a comment's authorId can point at one.
  for (let i = 0; i < count; i++) {
    const type: TypeName = i < 3 ? "User" : r.pick(TYPE_NAMES);
    const data = payload(r, type, authors, placeholderIds);
    // A third of objects are colocated with something already made, which is how a colocation group
    // forms and the only way two objects are guaranteed to share a host.
    const parents = made.map((_, j) => j).filter((j) => made[j] === type || type === "Comment");
    if (parents.length > 0 && r.chance(0.3)) {
      ops.push({ kind: "with", type, parent: r.pick(parents), data });
    } else {
      ops.push({ kind: "create", type, vshard: r.pick(vshards), data });
    }
    if (type === "User") authors.push(i);
    made.push(type);
    placeholderIds.push("0"); // filled in on replay
  }

  for (let i = 0; i < edges; i++) {
    const from = r.int(made.length);
    const out = outgoing[made[from]].filter((o) => o.countable); // stored edges only
    if (out.length === 0) continue;
    const rel = r.pick(out);
    const candidates = made.map((_, j) => j).filter((j) => made[j] === rel.to);
    if (candidates.length === 0) continue;
    ops.push({
      kind: "assoc",
      rel: rel.name,
      from,
      to: r.pick(candidates),
      // A small pool of times, so ties happen and the id tie-break is exercised.
      time: r.int(8),
      data: r.chance(0.3) ? { tag: r.pick(["x", "y"]) } : null,
    });
  }
  return { ops, vshards };
}

const relByName = new Map<string, Outgoing>(
  Object.values(outgoing)
    .flat()
    .map((o) => [o.name, o]),
);

const otypeOf: Record<TypeName, number> = {
  Issue: Issue.otype,
  Comment: Comment.otype,
  User: User.otype,
  Label: Label.otype,
};

/** Replays a script, returning the ids it made, in order. Sequential, so two replays of one script
 *  hand out the same ids. */
export async function replay(db: Hlekk, script: Script): Promise<{ ids: Id[]; types: TypeName[] }> {
  const ids: Id[] = [];
  const kinds: TypeName[] = [];
  for (const op of script.ops) {
    if (op.kind === "assoc") {
      const rel = relByName.get(op.rel)!;
      const atype = (rel.rel as { atype: number }).atype;
      await db.assocAdd(atype, ids[op.from], ids[op.to], op.time, op.data as Record<string, Json> | null);
      continue;
    }
    // authorId was a placeholder in the script; point it at the user that index actually became.
    const data = { ...op.data };
    if (op.type === "Comment" && typeof data.authorId === "string") {
      const user = kinds.findIndex((k) => k === "User");
      data.authorId = user >= 0 ? ids[user] : "0";
    }
    const at = op.kind === "with" ? { with: ids[op.parent] } : { vshard: op.vshard };
    ids.push(await db.create(otypeOf[op.type], data as Record<string, Json>, at));
    kinds.push(op.type);
  }
  return { ids, types: kinds };
}

export interface QueryOptions {
  /** How deep the tree may go. */
  depth?: number;
  /** How many relations one level may follow. */
  width?: number;
}

/** A random query from a root type. Loosely typed on purpose: a generated tree cannot be checked
 *  statically, and what is under test is the answer, not the types. */
export function generateQuery(
  r: Random,
  root: TypeName,
  start: Query<never, unknown>,
  opts: QueryOptions = {},
): Query<never, unknown> {
  const depth = opts.depth ?? 3;
  const width = opts.width ?? 2;

  const build = (q: unknown, type: TypeName, left: number): unknown => {
    let out = q as Record<string, (...a: unknown[]) => unknown>;
    const options = outgoing[type];

    // Every level carries a limit. A small one, so a filter's read-ahead window matters.
    out = out.limit(1 + r.int(6)) as typeof out;

    if (r.chance(0.5)) {
      const countable = options.filter((o) => o.countable);
      if (countable.length > 0) {
        const c = r.pick(countable);
        out = out.countAs(`n_${c.name}`, c.rel) as typeof out;
      }
    }
    if (r.chance(0.4)) {
      const fields = comparable[type];
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
