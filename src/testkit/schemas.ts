// Random schemas, from a seed.
//
// A fixed schema fuzzes one shape: the edges someone thought to write down, and the onDelete rules
// they happened to pick. The catalog's own rules are what make a schema worth varying — an inverse
// has to be a genuine mirror, a field relationship has no inverse and no atype, a delete applies
// every edge type's onDelete whether or not the caller's projection knows about it — and none of
// those is exercised by one example.
//
// Names, not integers: a generated schema goes through `plan` like a hand-written one, so what the
// oracle runs against is a lock that a real database would accept.

import { plan } from "../catalog/catalog.ts";
import type { FieldSpec, Lock, OnDelete } from "../catalog/catalog.ts";
import type { Fields, Json } from "../query/types.ts";
import type { Random } from "../runtime/runtime.ts";
import { defineObject, edge, fieldRel, id, num, oneOf, str } from "../schema/define.ts";
import type { Field, FieldMap, ObjectType } from "../schema/define.ts";
import type { Comparable, Outgoing, Payload, Shape } from "./shape.ts";

export interface SchemaOptions {
  /** How many object types. */
  types?: number;
  /** How many stored edge types to attempt. Inverse pairs count as one attempt and make two. */
  edges?: number;
  /** How many namespaces to spread them over, which is what makes one team's delete apply another's
   *  onDelete. */
  namespaces?: number;
  /** Which onDelete rules may be generated. Restrict is left out by default: a cascade that crosses
   *  a vshard travels as an outbox op, and a restrict in its path stalls that op instead of refusing
   *  the delete, which is the design's open question on cross-vshard cascades rather than something a
   *  convergence test should trip over. */
  onDelete?: readonly OnDelete[];
}

/** A field as both a lock spec and a runtime Field, with the values a payload draws from. */
interface Planned {
  name: string;
  spec: FieldSpec;
  field: Field<unknown>;
  /** Absent for an id field: a filter on one would compare ids, which say nothing about the data. */
  values?: Json[];
  /** The type an id field points at. */
  target?: string;
}

const WORDS = ["a", "b", "c", "d"];

function scalar(r: Random, index: number): Planned {
  const name = `f${index}`;
  switch (r.int(3)) {
    case 0: {
      const values = WORDS.slice(0, 2 + r.int(3));
      return { name, spec: "string", field: str(), values };
    }
    case 1: {
      const values = [...Array(2 + r.int(3))].map((_, i) => i);
      return { name, spec: "number", field: num(), values };
    }
    default: {
      const values = WORDS.slice(0, 2 + r.int(2));
      return { name, spec: { enum: [...values] }, field: oneOf(...values), values };
    }
  }
}

/** The schema before it is turned into a lock: names, fields and edges, with no integers in it. Kept
 *  as a value so a later version can be grown from it, which is what a migration is. */
export interface Blueprint {
  /** The short name a query reads a type under. */
  short: string[];
  /** The namespace that owns each type. */
  space: string[];
  /** Its name in the lock, which carries the namespace. */
  full: string[];
  fields: Planned[][];
  edges: PlannedEdge[];
  rels: PlannedRel[];
}

interface PlannedEdge {
  /** Index into `short` of the type it runs from. */
  from: number;
  to: number;
  name: string;
  alias: string;
  onDelete: OnDelete;
  unique: boolean;
  inverse?: string;
  /** The mirror of a pair is the derived half: the catalog refuses direct writes to it. */
  maintained?: boolean;
}

interface PlannedRel {
  from: number;
  name: string;
  alias: string;
  field: string;
  to: string;
}

/** Adds `types` object types and attempts `edges` edge types, on top of whatever is there already. */
function grow(r: Random, bp: Blueprint, opts: { types: number; edges: number; spaces: number; rules: readonly OnDelete[] }): void {
  const first = bp.short.length;
  for (let i = first; i < first + opts.types; i++) {
    bp.short.push(`T${i}`);
    bp.space.push(`d${i % opts.spaces}`);
    bp.full.push(`d${i % opts.spaces}.t${i}`);
    bp.fields.push([]);
    for (let f = 0; f < 1 + r.int(3); f++) bp.fields[i].push(scalar(r, f));
  }
  const count = bp.short.length;
  // An id field is what a field relationship follows, so it goes in before the edges.
  for (let i = first; i < count; i++) {
    if (!r.chance(0.5)) continue;
    const target = r.int(count);
    bp.fields[i].push({ name: "ref", spec: { id: bp.full[target] }, field: id(bp.full[target]), target: bp.short[target] });
  }

  const declare = (from: number, to: number): PlannedEdge => {
    const n = bp.edges.length;
    const e: PlannedEdge = {
      from,
      to,
      name: `${bp.space[from]}.e${n}`,
      alias: `r${n}`,
      onDelete: r.pick(opts.rules),
      unique: r.chance(0.25),
    };
    bp.edges.push(e);
    return e;
  };
  for (let i = 0; i < opts.edges; i++) {
    // At least one end in the types just added, so a migration's edges reach the new data.
    const from = first === 0 ? r.int(count) : first + r.int(count - first);
    const to = r.int(count);
    const forward = declare(from, to);
    // A pair, so the outbox has an inverse to carry. Its mirror runs the other way and names it back,
    // which is the only form the catalog accepts.
    if (r.chance(0.5)) {
      const back = declare(to, from);
      forward.inverse = back.name;
      back.inverse = forward.name;
      back.maintained = true;
    }
  }
  for (let i = first; i < count; i++) {
    const ref = bp.fields[i].find((f) => f.target !== undefined);
    if (!ref || !r.chance(0.7)) continue;
    bp.rels.push({ from: i, name: `${bp.space[i]}.fr${i}`, alias: `fr${i}`, field: ref.name, to: ref.target! });
  }
}

/** Plans the blueprint into a lock and the runtime values a query is built from. `previous` keeps
 *  every integer already assigned, which is what makes the result a migration rather than a new
 *  database. */
export function compileSchema(bp: Blueprint, previous?: Lock): Shape {
  // By namespace: a domain owns every name that starts with it, so each entry goes to the namespace
  // of the type it is declared from.
  const domains: Record<string, { objects: Record<string, { fields: Record<string, FieldSpec> }>; edges: Record<string, unknown> }> = {};
  const domain = (name: string) => (domains[name] ??= { objects: {}, edges: {} });
  for (let i = 0; i < bp.short.length; i++) {
    domain(bp.space[i]).objects[bp.full[i]] = { fields: Object.fromEntries(bp.fields[i].map((f) => [f.name, f.spec])) };
  }
  for (const e of bp.edges) {
    domain(bp.space[e.from]).edges[e.name] = {
      from: bp.full[e.from],
      to: bp.full[e.to],
      onDelete: e.onDelete,
      ...(e.unique ? { unique: true } : {}),
      ...(e.inverse ? { inverse: e.inverse } : {}),
      ...(e.maintained ? { maintained: true } : {}),
    };
  }
  for (const rel of bp.rels) {
    domain(bp.space[rel.from]).edges[rel.name] = {
      from: bp.full[rel.from],
      to: bp.full[bp.short.indexOf(rel.to)],
      field: rel.field,
    };
  }

  const lock = plan(domains as Parameters<typeof plan>[0], previous);

  // Runtime values, carrying the integers the lock just assigned.
  const types: Record<string, ObjectType<FieldMap>> = {};
  for (let i = 0; i < bp.short.length; i++) {
    const map: FieldMap = Object.fromEntries(bp.fields[i].map((f) => [f.name, f.field]));
    types[bp.short[i]] = defineObject(bp.full[i], lock.objects[bp.full[i]].otype, map);
  }

  const outgoing: Record<string, Outgoing[]> = Object.fromEntries(bp.short.map((s) => [s, [] as Outgoing[]]));
  for (const e of bp.edges) {
    const atype = lock.edges[e.name].atype!;
    const rel = edge(e.name, atype, types[bp.short[e.from]], types[bp.short[e.to]], e.unique ? { unique: true } : undefined);
    const inverse = e.inverse === undefined ? undefined : lock.edges[e.inverse].atype;
    outgoing[bp.short[e.from]].push({ name: e.alias, rel, to: bp.short[e.to], atype, inverse, maintained: e.maintained });
  }
  for (const rel of bp.rels) {
    outgoing[bp.short[rel.from]].push({
      name: rel.alias,
      rel: fieldRel(rel.name, types[bp.short[rel.from]], types[rel.to], rel.field),
      to: rel.to,
    });
  }

  const comparable: Record<string, Comparable[]> = Object.fromEntries(
    bp.short.map((s, i) => [s, bp.fields[i].filter((f) => f.values).map((f) => ({ field: f.name, values: f.values! }))]),
  );

  const payload = (rand: Random, type: string, ref: (target: string) => number | undefined): Payload => {
    const i = bp.short.indexOf(type);
    const data: Fields = {};
    const refs: Record<string, number> = {};
    for (const f of bp.fields[i]) {
      if (f.target === undefined) {
        data[f.name] = rand.pick(f.values!);
        continue;
      }
      // A placeholder until replay: an id field points at an object the script has already made, and
      // the script does not know what ids it will get.
      data[f.name] = "0";
      const at = ref(f.target);
      if (at !== undefined) refs[f.name] = at;
    }
    return { data, refs };
  };

  return { lock, types, outgoing, comparable, payload };
}

function blueprint(r: Random, opts: SchemaOptions): Blueprint {
  const bp: Blueprint = { short: [], space: [], full: [], fields: [], edges: [], rels: [] };
  const types = opts.types ?? 3 + r.int(3);
  grow(r, bp, {
    types,
    edges: opts.edges ?? 4 + r.int(5),
    spaces: Math.min(opts.namespaces ?? 1 + r.int(3), types),
    rules: opts.onDelete ?? ["detach", "cascade"],
  });
  return bp;
}

export function generateSchema(r: Random, opts: SchemaOptions = {}): Shape {
  return compileSchema(blueprint(r, opts));
}

/** A schema and the versions it is migrated to, each planned on top of the last so every integer
 *  already assigned is kept. Each adds object types and edge types; what it does not do is remove
 *  one, which tombstones its name and is its own question. */
export function generateSchemas(r: Random, versions: number, opts: SchemaOptions = {}): Shape[] {
  const bp = blueprint(r, opts);
  const out = [compileSchema(bp)];
  for (let v = 1; v < versions; v++) {
    grow(r, bp, {
      types: 1 + r.int(2),
      edges: 1 + r.int(3),
      spaces: Math.max(...bp.space.map((s) => Number(s.slice(1)))) + 1,
      rules: opts.onDelete ?? ["detach", "cascade"],
    });
    out.push(compileSchema(bp, out[out.length - 1].lock));
  }
  return out;
}
