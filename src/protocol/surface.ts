// What a database exposes, as one object.
//
// Three things needed a narrowing and each had its own: `check` needs the names a request may use,
// the encoder needs the name to put on an object's type and the fields to send with it, and
// `/vocabulary` needs to state both to a caller that has never seen this database. Left separate,
// they drift — and a surface that is narrower in the vocabulary than in the encoder is a disclosure,
// while the other way round is a refusal a caller cannot explain.
//
// So the narrowing is a projection (`catalog/projection.ts`), which already names a selection of the
// catalog with a hash and narrowed fields for code generation. This is the same idea pointed
// outward: the product's projection decides what its generated client contains, and a database's
// projection decides what it serves. With no projection every type and edge is exposed, which is the
// right default only for a database whose whole graph is public — the deployed wiki, in step 2.
//
// **Static narrowing only.** A projection is the same for every caller. A policy that varies fields
// per caller is a different mechanism, and `docs/protocol.md` leaves it open; `Policy` already
// decides objects and counts per request, which is the part that has to be dynamic.

import { describe } from "../query/request.ts";
import type { Vocabulary } from "../query/request.ts";
import { resolve } from "../catalog/projection.ts";
import type { Projection, Resolved } from "../catalog/projection.ts";
import type { Catalog, FieldSpec } from "../catalog/catalog.ts";

/** The document `GET {db}/vocabulary` returns: every exposed type with its fields, and every edge a
 *  request may traverse. A caller compares this with its own declaration of the same names, which is
 *  the type agreement `docs/protocol.md` asks for — a globally unique name says nothing about
 *  whether the reader knows the shape behind it. */
export interface VocabularyDoc {
  v: number;
  /** The responder's catalog version. Not a compatibility token: see `Resolved.hash`. */
  catalog: number;
  projection?: { name: string; hash: string };
  types: Record<string, { fields: Record<string, { type: string; optional: boolean }> }>;
  edges: Record<string, { from: string; to: string; counted: boolean }>;
}

export interface Surface {
  /** The names a request may use, for `check`. */
  vocabulary: Vocabulary;
  /** The name an object type is exposed under, or undefined when it is not exposed at all. An answer
   *  carries names and never the catalog's integers, which are allocated per database and so mean
   *  nothing to a caller. */
  typeName(otype: number): string | undefined;
  /** The integer a name resolves to in THIS catalog. Used when decoding another database's answer. */
  otypeOf(name: string): number | undefined;
  /** The fields exposed for a type, which may be fewer than it has. */
  fields(name: string): Record<string, FieldSpec> | undefined;
  document(): VocabularyDoc;
}

export const VOCABULARY_VERSION = 1;

/** The surface of a whole catalog, or of the projection of one. */
export function surfaceOf(catalog: Catalog, projection?: Projection): Surface {
  const resolved = projection === undefined ? undefined : resolve(catalog, projection);
  return resolved === undefined ? wholeCatalog(catalog) : projected(catalog, resolved);
}

function wholeCatalog(catalog: Catalog): Surface {
  const vocabulary: Vocabulary = {
    edge(name) {
      const e = catalog.edgeNamed(name);
      return e === undefined ? undefined : { to: e.to, counted: e.atype !== undefined };
    },
    edges: () => catalog.edgeTypes().map((e) => e.name),
    fields: (name) => catalog.objectNamed(name)?.fields,
  };
  return {
    vocabulary,
    typeName: (otype) => catalog.object(otype)?.name,
    otypeOf: (name) => catalog.objectNamed(name)?.otype,
    fields: (name) => catalog.objectNamed(name)?.fields,
    document: () => ({
      v: VOCABULARY_VERSION,
      catalog: catalog.version,
      types: Object.fromEntries(catalog.objectTypes().map((t) => [t.name, { fields: specs(t.fields) }])),
      edges: Object.fromEntries(
        catalog.edgeTypes().map((e) => [e.name, { from: e.from, to: e.to, counted: e.atype !== undefined }]),
      ),
    }),
  };
}

function projected(catalog: Catalog, resolved: Resolved): Surface {
  // A projection's endpoints come back as `ref` objects with no fields: an id a caller can hold and
  // link to, with nothing to read. Those are exposed — an answer may land on one — so they are in
  // both maps, with an empty field set.
  const byName = new Map(resolved.objects.map((o) => [o.type.name, o]));
  const byType = new Map(resolved.objects.map((o) => [o.type.otype, o]));
  const edges = new Map(resolved.edges.map((e) => [e.name, e]));

  const vocabulary: Vocabulary = {
    edge(name) {
      const e = edges.get(name);
      return e === undefined ? undefined : { to: e.to, counted: e.atype !== undefined };
    },
    edges: () => [...edges.keys()],
    // The projected fields, not the type's: a filter on a field the projection drops has to be
    // refused, or narrowing would hide a field from the answer while still answering questions
    // about it. "Does this object's secret field equal X" is the field, one bit at a time.
    fields: (name) => byName.get(name)?.fields,
  };

  return {
    vocabulary,
    typeName: (otype) => byType.get(otype)?.type.name,
    otypeOf: (name) => byName.get(name)?.type.otype,
    fields: (name) => byName.get(name)?.fields,
    document: () => ({
      v: VOCABULARY_VERSION,
      catalog: catalog.version,
      projection: { name: resolved.name, hash: resolved.hash },
      types: Object.fromEntries(resolved.objects.map((o) => [o.type.name, { fields: specs(o.fields) }])),
      edges: Object.fromEntries(
        resolved.edges.map((e) => [e.name, { from: e.from, to: e.to, counted: e.atype !== undefined }]),
      ),
    }),
  };
}

const specs = (fields: Record<string, FieldSpec>): Record<string, { type: string; optional: boolean }> =>
  Object.fromEntries(Object.entries(fields).map(([name, spec]) => [name, describe(spec)]));
