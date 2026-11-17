// A projection is a named selection of the catalog, declared for the product that uses it. It decides
// what that product's generated code contains and changes no data.
//
// Selection, not imports, is what keeps any type from becoming a god class: the issues app's User has
// no listing purchases because its projection does not include them.

import { CatalogError, canonical, fnv } from "./catalog.ts";
import type { Catalog, EdgeType, FieldSpec, ObjectType } from "./catalog.ts";

export interface Projection {
  name: string;
  /** Names or globs. `issues.*` takes a whole domain; a single entry can come from another. */
  include: string[];
  /** Narrows what a type exposes, per type name. */
  fields?: Record<string, string[]>;
}

/** What a projection resolves to against a catalog. */
export interface Resolved {
  name: string;
  catalog: number;
  hash: string;
  objects: ProjectedObject[];
  edges: EdgeType[];
}

export interface ProjectedObject {
  type: ObjectType;
  /** The fields this projection exposes, which may be fewer than the type has. */
  fields: Record<string, FieldSpec>;
  /** True when the projection holds every field a create needs, so one can be generated. */
  creatable: boolean;
  /** An endpoint of an included edge whose own type was not selected: an id you can hold and link to,
   *  with no fields. */
  ref: boolean;
}

const matches = (patterns: readonly string[], name: string): boolean =>
  patterns.some((p) => (p.endsWith(".*") ? name.startsWith(p.slice(0, -1)) : p === name));

/** Resolves a projection against a catalog, turning unselected edge endpoints into references. */
export function resolve(catalog: Catalog, projection: Projection): Resolved {
  for (const p of projection.include) {
    if (p.endsWith(".*")) continue;
    if (!catalog.objectNamed(p) && !catalog.edgeNamed(p)) {
      throw new CatalogError(`projection ${projection.name} includes ${p}, which is not in the catalog`);
    }
  }
  for (const name of Object.keys(projection.fields ?? {})) {
    const type = catalog.objectNamed(name);
    if (!type) throw new CatalogError(`projection ${projection.name} narrows ${name}, which is not a type`);
    for (const field of projection.fields![name]) {
      if (!(field in type.fields)) {
        throw new CatalogError(`projection ${projection.name} narrows ${name} to ${field}, which it has no field for`);
      }
    }
  }

  const selected = new Set(catalog.objectTypes().filter((t) => matches(projection.include, t.name)).map((t) => t.name));
  const edges = catalog.edgeTypes().filter((e) => matches(projection.include, e.name));

  // An included edge pulls its endpoints in. One that was not selected becomes a reference.
  const referenced = new Set<string>();
  for (const e of edges) for (const end of [e.from, e.to]) if (!selected.has(end)) referenced.add(end);

  const objects: ProjectedObject[] = [];
  for (const name of [...selected, ...referenced].sort()) {
    const type = catalog.objectNamed(name)!;
    const ref = !selected.has(name);
    const narrow = projection.fields?.[name];
    const fields = ref
      ? {}
      : narrow
        ? Object.fromEntries(narrow.map((f) => [f, type.fields[f]]))
        : type.fields;
    // A create needs every field the type requires. A narrowed projection that drops one can still
    // read and link, but not create.
    const required = Object.entries(type.fields).filter(([, spec]) => !optional(spec)).map(([f]) => f);
    const creatable = !ref && required.every((f) => f in fields);
    objects.push({ type, fields, creatable, ref });
  }

  const resolved: Omit<Resolved, "hash"> = { name: projection.name, catalog: catalog.version, objects, edges };
  return { ...resolved, hash: hashOf(resolved) };
}

const optional = (spec: FieldSpec): boolean => typeof spec === "object" && "optional" in spec;

/** A hash over what the projection resolved to, and deliberately not over the catalog version. A
 *  change since that version that touches none of the projection's entries leaves this the same, so it
 *  never invalidates that client; a request carries the version separately. */
function hashOf(r: Omit<Resolved, "hash">): string {
  return fnv(
    canonical({
      objects: Object.fromEntries(r.objects.map((o) => [o.type.name, { otype: o.type.otype, fields: o.fields, ref: o.ref }])),
      edges: Object.fromEntries(
        // `foreign` only when it is true, so adding the flag leaves every existing projection's hash
        // alone — the hash is stamped into generated code, and `canonical` drops undefined.
        r.edges.map((e) => [
          e.name,
          {
            from: e.from,
            to: e.to,
            atype: e.atype,
            inverse: e.inverse,
            field: e.field,
            unique: e.unique,
            foreign: e.foreign ? true : undefined,
          },
        ]),
      ),
    }),
  );
}

/** Generates the one module a product imports from. The lock is the source of truth; this is a mirror,
 *  never a second source, which is why it says so and why nothing hand-written belongs in it. */
export interface GenerateOptions {
  /** Where the generated module imports its runtime from. A relative path inside this repo, the
   *  package elsewhere. */
  importFrom?: string;
}

export function generate(resolved: Resolved, opts: GenerateOptions = {}): string {
  const out: string[] = [];
  const ident = (name: string) => {
    const bare = name.slice(name.indexOf(".") + 1);
    return bare.replace(/[_.-](\w)/g, (_, c: string) => c.toUpperCase()).replace(/^\w/, (c) => c.toUpperCase());
  };
  const camel = (name: string) => {
    const pascal = ident(name);
    return pascal.charAt(0).toLowerCase() + pascal.slice(1);
  };

  // Two domains can hold the same bare name, and both would render to one identifier. Better to refuse
  // than to emit a module whose second definition silently shadows its first.
  const taken = new Map<string, string>();
  for (const o of resolved.objects) claim(taken, ident(o.type.name), o.type.name);
  for (const e of resolved.edges) claim(taken, camel(e.name), e.name);

  out.push(`// Generated from catalog v${resolved.catalog} for projection ${resolved.name}. Do not edit.`);
  const from = opts.importFrom ?? "hlekk/schema";
  out.push(`import { bool, defineObject, edge, fieldRel, id, json, num, oneOf, ref, str } from ${JSON.stringify(from)};`);
  out.push("");
  out.push(
    `export const projection = { name: ${JSON.stringify(resolved.name)}, catalog: ${resolved.catalog},` +
      ` hash: ${JSON.stringify(resolved.hash)} } as const;`,
  );
  out.push("");

  for (const o of resolved.objects) {
    if (o.ref) {
      out.push(`// ${o.type.name} is an endpoint this projection does not select: an id to hold and link to.`);
      out.push(`export const ${ident(o.type.name)} = ref(${JSON.stringify(o.type.name)}, ${o.type.otype});`);
      continue;
    }
    const fields = Object.entries(o.fields).map(([f, spec]) => `${f}: ${render(spec)}`);
    const note = o.creatable ? "" : " // narrowed past a required field, so no create is generated";
    out.push(
      `export const ${ident(o.type.name)} = defineObject(${JSON.stringify(o.type.name)}, ${o.type.otype},` +
        ` { ${fields.join(", ")} }, { create: ${o.creatable} });${note}`,
    );
  }
  if (resolved.edges.length > 0) out.push("");
  for (const e of resolved.edges) {
    const from = ident(e.from);
    const to = ident(e.to);
    if (e.field !== undefined) {
      out.push(
        `export const ${camel(e.name)} = fieldRel(${JSON.stringify(e.name)}, ${from}, ${to}, ${JSON.stringify(e.field)});`,
      );
      continue;
    }
    const opts = e.unique ? ", { unique: true }" : "";
    out.push(`export const ${camel(e.name)} = edge(${JSON.stringify(e.name)}, ${e.atype}, ${from}, ${to}${opts});`);
  }
  return out.join("\n") + "\n";
}

function render(spec: FieldSpec): string {
  if (typeof spec === "string") {
    return { string: "str()", number: "num()", boolean: "bool()", json: "json()" }[spec];
  }
  if ("optional" in spec) return `${render(spec.optional)}.optional()`;
  if ("enum" in spec) return `oneOf(${spec.enum.map((v) => JSON.stringify(v)).join(", ")})`;
  return `id(${JSON.stringify(spec.id)})`;
}

/** What a request carries, so a host can tell whether the client was built against something it has.
 *  A change since that version that touches none of the projection's entries never invalidates it. */
export function stamp(resolved: Resolved): { catalog: number; hash: string } {
  return { catalog: resolved.catalog, hash: resolved.hash };
}

export { canonical };

function claim(taken: Map<string, string>, ident: string, name: string): void {
  const held = taken.get(ident);
  if (held !== undefined) {
    throw new CatalogError(
      `${name} and ${held} both generate as ${ident}. Rename one, or narrow the projection to exclude it.`,
    );
  }
  taken.set(ident, name);
}
