// What a generator needs to know about the schema it is fuzzing over.
//
// The oracle used to read one hand-written schema directly, so every seed fuzzed the same shape: the
// same five edge kinds, the same two onDelete rules, one namespace. A schema is a value here, so a
// seed can make its own and the generators do not care which one they were handed.

import type { Lock } from "../catalog/catalog.ts";
import type { Fields, Json } from "../query/types.ts";
import type { Random } from "../runtime/runtime.ts";
import type { FieldMap, ObjectType } from "../schema/define.ts";

/** One way out of an object type, under the name a query reads it as. */
export interface Outgoing {
  name: string;
  /** The EdgeType or FieldRel the builder follows. Loosely typed on purpose: a generated schema
   *  cannot be checked statically, and what is under test is the answer, not the types. */
  rel: unknown;
  /** The type it lands on, so a generator can keep walking. */
  to: string;
  /** A stored edge's atype. Absent for a field relationship, which stores nothing and so can be
   *  neither written nor counted. */
  atype?: number;
}

/** A field a filter can compare, with values that actually occur in payloads, so a generated filter
 *  matches some rows rather than always none. */
export interface Comparable {
  field: string;
  values: Json[];
}

/** A payload, and which objects its id fields point at. The script records positions rather than
 *  ids, because the ids are not known until it is replayed. */
export interface Payload {
  data: Fields;
  /** Field name to the position, in the script's own order, of the object it points at. */
  refs: Record<string, number>;
}

/** A schema under test, with everything the generators ask of one. */
export interface Shape {
  /** Applied to the directory, and compiled into the catalog every host reads. */
  lock: Lock;
  /** Object types by the short name a query names them under. */
  types: Record<string, ObjectType<FieldMap>>;
  outgoing: Record<string, Outgoing[]>;
  comparable: Record<string, Comparable[]>;
  /** A payload for a type. `ref` offers the position of an object of a type already made, or nothing
   *  when none has been, in which case the field holds a placeholder id that resolves to nothing. */
  payload(r: Random, type: string, ref: (target: string) => number | undefined): Payload;
}

export const typeNames = (shape: Shape): string[] => Object.keys(shape.types);

/** Every stored edge out of a type: the ones a workload can write. */
export const storedOut = (shape: Shape, type: string): Outgoing[] =>
  shape.outgoing[type].filter((o) => o.atype !== undefined);
