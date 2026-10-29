// What a generated module is made of. The lock is the source of truth; these are the runtime values
// code imports, carrying the integers that go on the wire and the types that make a query checkable.

import type { FieldSpec } from "../catalog/catalog.ts";
import type { Id, Json } from "../query/types.ts";
import { gen } from "./query.ts";
import type { Query } from "./query.ts";

/** A field, with the type it reads as. `value` exists only for inference and is never set. */
export class Field<T> {
  readonly spec: FieldSpec;
  readonly value!: T;

  constructor(spec: FieldSpec) {
    this.spec = spec;
  }

  optional(): Field<T | null> {
    return new Field<T | null>({ optional: this.spec });
  }
}

export const str = (): Field<string> => new Field<string>("string");
export const num = (): Field<number> => new Field<number>("number");
export const bool = (): Field<boolean> => new Field<boolean>("boolean");
export const json = (): Field<Json> => new Field<Json>("json");
export const oneOf = <const V extends string>(...values: V[]): Field<V> => new Field<V>({ enum: [...values] });
/** An id stored in a payload. `target` names the type it points at, for the catalog and for people. */
export const id = (target: string): Field<Id> => new Field<Id>({ id: target });

export interface FieldMap {
  [name: string]: Field<unknown>;
}

/** The edge that reached a row. Absent on a root and on a field hop, since no edge reached those. */
export interface EdgeInfo {
  time: number;
  data: Json | null;
}

/** What one object reads as: the payload's fields, plus what the result carries alongside them. A
 *  field under one of these names is refused by the catalog rather than shadowed here. */
export type RowOf<F extends FieldMap> = {
  id: Id;
  $version: number;
  $edge?: EdgeInfo;
} & { [K in keyof F]: F[K]["value"] };

export interface ObjectOptions {
  /** False where the projection cannot supply every required field, so no create is generated. */
  create?: boolean;
}

export class ObjectType<F extends FieldMap> {
  readonly name: string;
  readonly otype: number;
  readonly fields: F;
  readonly creatable: boolean;
  /** True for an endpoint the projection did not select: an id to hold and link to, with no fields. */
  readonly isRef: boolean;

  constructor(name: string, otype: number, fields: F, opts: ObjectOptions & { ref?: boolean } = {}) {
    this.name = name;
    this.otype = otype;
    this.fields = fields;
    this.creatable = opts.create ?? true;
    this.isRef = opts.ref ?? false;
  }

  /** Starts a query from ids the caller already holds. */
  gen(...ids: Id[]): Query<F, RowOf<F>> {
    return gen(this, ...ids);
  }
}

export function defineObject<F extends FieldMap>(name: string, otype: number, fields: F, opts: ObjectOptions = {}): ObjectType<F> {
  return new ObjectType(name, otype, fields, opts);
}

/** An endpoint this projection does not select. It has no fields, so nothing can be read through it;
 *  it exists to be held, passed on and linked to. */
export function ref(name: string, otype: number): ObjectType<Record<never, never>> {
  return new ObjectType(name, otype, {}, { ref: true, create: false });
}

/** A stored edge: ordered by time, counted, and optionally paired with an inverse. `Single` records
 *  whether it is to-one, so a result holds one object rather than a list. */
export class EdgeType<From extends FieldMap, To extends FieldMap, Single extends boolean = false> {
  readonly name: string;
  readonly atype: number;
  readonly from: ObjectType<From>;
  readonly to: ObjectType<To>;
  readonly unique: Single;

  constructor(name: string, atype: number, from: ObjectType<From>, to: ObjectType<To>, unique: Single) {
    this.name = name;
    this.atype = atype;
    this.from = from;
    this.to = to;
    this.unique = unique;
  }
}

export function edge<From extends FieldMap, To extends FieldMap, const O extends { unique?: true } = Record<never, never>>(
  name: string,
  atype: number,
  from: ObjectType<From>,
  to: ObjectType<To>,
  opts?: O,
): EdgeType<From, To, O extends { unique: true } ? true : false> {
  return new EdgeType(name, atype, from, to, (opts?.unique ?? false) as O extends { unique: true } ? true : false);
}

/** A field relationship: follows an id in the source object's payload. Nothing is stored, so it has
 *  no atype, and no inverse, count or ordering either. Always to-one. */
export class FieldRel<From extends FieldMap, To extends FieldMap> {
  readonly name: string;
  readonly from: ObjectType<From>;
  readonly to: ObjectType<To>;
  readonly field: string;

  constructor(name: string, from: ObjectType<From>, to: ObjectType<To>, field: string) {
    this.name = name;
    this.from = from;
    this.to = to;
    this.field = field;
  }
}

export function fieldRel<From extends FieldMap, To extends FieldMap>(
  name: string,
  from: ObjectType<From>,
  to: ObjectType<To>,
  field: keyof From & string,
): FieldRel<From, To> {
  return new FieldRel(name, from, to, field);
}

/** Either way of reaching a related object. */
export type Relation<From extends FieldMap, To extends FieldMap> =
  | EdgeType<From, To, boolean>
  | FieldRel<From, To>;

/** Whether a relation yields one object or a list. */
export type IsSingle<R> = R extends FieldRel<FieldMap, FieldMap>
  ? true
  : R extends EdgeType<FieldMap, FieldMap, true>
    ? true
    : false;

export type TargetOf<R> = R extends Relation<FieldMap, infer To> ? To : never;

