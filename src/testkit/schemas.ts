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
import type { FieldSpec, OnDelete } from "../catalog/catalog.ts";
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

export function generateSchema(r: Random, opts: SchemaOptions = {}): Shape {
  const count = opts.types ?? 3 + r.int(3);
  const attempts = opts.edges ?? 4 + r.int(5);
  const spaces = Math.min(opts.namespaces ?? 1 + r.int(3), count);
  const rules = opts.onDelete ?? (["detach", "cascade"] as const);

  // A type's short name is what a query names it under; its lock name carries the namespace that owns
  // it, which is what `plan` checks.
  const short = [...Array(count)].map((_, i) => `T${i}`);
  const space = short.map((_, i) => `d${i % spaces}`);
  const full = short.map((_, i) => `${space[i]}.t${i}`);
  const fields: Planned[][] = short.map(() => []);

  for (let i = 0; i < count; i++) {
    for (let f = 0; f < 1 + r.int(3); f++) fields[i].push(scalar(r, f));
  }
  // An id field is what a field relationship follows. Added before the edges, so one can be declared
  // over it.
  for (let i = 0; i < count; i++) {
    if (!r.chance(0.5)) continue;
    const target = r.int(count);
    fields[i].push({ name: "ref", spec: { id: full[target] }, field: id(full[target]), target: short[target] });
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
  }
  const edges: PlannedEdge[] = [];
  const declare = (from: number, to: number, onDelete: OnDelete, unique: boolean): PlannedEdge => {
    const n = edges.length;
    const e: PlannedEdge = { from, to, name: `${space[from]}.e${n}`, alias: `r${n}`, onDelete, unique };
    edges.push(e);
    return e;
  };

  for (let i = 0; i < attempts; i++) {
    const from = r.int(count);
    const to = r.int(count);
    const forward = declare(from, to, r.pick(rules), r.chance(0.25));
    // A pair, so the outbox has an inverse to carry. Its mirror runs the other way and names it back,
    // which is the only form the catalog accepts.
    if (r.chance(0.5)) {
      const back = declare(to, from, r.pick(rules), r.chance(0.25));
      forward.inverse = back.name;
      back.inverse = forward.name;
    }
  }

  // Lock, by namespace. A domain owns every name that starts with it, so each entry goes to the
  // namespace of the type it is declared from.
  const domains: Record<string, { objects: Record<string, { fields: Record<string, FieldSpec> }>; edges: Record<string, unknown> }> = {};
  const domain = (name: string) => (domains[name] ??= { objects: {}, edges: {} });
  for (let i = 0; i < count; i++) {
    domain(space[i]).objects[full[i]] = { fields: Object.fromEntries(fields[i].map((f) => [f.name, f.spec])) };
  }
  for (const e of edges) {
    domain(space[e.from]).edges[e.name] = {
      from: full[e.from],
      to: full[e.to],
      onDelete: e.onDelete,
      ...(e.unique ? { unique: true } : {}),
      ...(e.inverse ? { inverse: e.inverse } : {}),
    };
  }
  // A field relationship over each id field, named in the namespace that declared the field.
  const rels: { from: number; name: string; alias: string; field: string; to: string }[] = [];
  for (let i = 0; i < count; i++) {
    const ref = fields[i].find((f) => f.target !== undefined);
    if (!ref || !r.chance(0.7)) continue;
    const name = `${space[i]}.fr${i}`;
    domain(space[i]).edges[name] = { from: full[i], to: full[short.indexOf(ref.target!)], field: ref.name };
    rels.push({ from: i, name, alias: `fr${i}`, field: ref.name, to: ref.target! });
  }

  const lock = plan(domains as Parameters<typeof plan>[0]);

  // Runtime values, carrying the integers the lock just assigned.
  const types: Record<string, ObjectType<FieldMap>> = {};
  for (let i = 0; i < count; i++) {
    const map: FieldMap = Object.fromEntries(fields[i].map((f) => [f.name, f.field]));
    types[short[i]] = defineObject(full[i], lock.objects[full[i]].otype, map);
  }

  const outgoing: Record<string, Outgoing[]> = Object.fromEntries(short.map((s) => [s, [] as Outgoing[]]));
  for (const e of edges) {
    const atype = lock.edges[e.name].atype!;
    const rel = edge(e.name, atype, types[short[e.from]], types[short[e.to]], e.unique ? { unique: true } : undefined);
    const inverse = e.inverse === undefined ? undefined : lock.edges[e.inverse].atype;
    outgoing[short[e.from]].push({ name: e.alias, rel, to: short[e.to], atype, inverse });
  }
  for (const rel of rels) {
    outgoing[short[rel.from]].push({
      name: rel.alias,
      rel: fieldRel(rel.name, types[short[rel.from]], types[rel.to], rel.field),
      to: rel.to,
    });
  }

  const comparable: Record<string, Comparable[]> = Object.fromEntries(
    short.map((s, i) => [s, fields[i].filter((f) => f.values).map((f) => ({ field: f.name, values: f.values! }))]),
  );

  const payload = (rand: Random, type: string, ref: (target: string) => number | undefined): Payload => {
    const i = short.indexOf(type);
    const data: Fields = {};
    const refs: Record<string, number> = {};
    for (const f of fields[i]) {
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
