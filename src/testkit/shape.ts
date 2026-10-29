// What a generator needs to know about the schema it is fuzzing over.
//
// The oracle used to read one hand-written schema directly, so every seed fuzzed the same shape: the
// same five edge kinds, the same two onDelete rules, one namespace. A schema is a value here, so a
// seed can make its own and the generators do not care which one they were handed.

import type { Lock } from "../catalog/catalog.ts";
import { cmpId } from "../query/types.ts";
import type { Fields, Id, Json } from "../query/types.ts";
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
  /** The atype of the edge type paired with this one, where it has one. */
  inverse?: number;
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

/** Every stored edge out of a type. A field relationship stores nothing, so it cannot be written. */
export const storedOut = (shape: Shape, type: string): Outgoing[] =>
  shape.outgoing[type].filter((o) => o.atype !== undefined);

/** Which side of a paired edge type is already maintaining a pair of objects.
 *
 *  Both halves of a pair are writable through the API, and writing both between the same two objects
 *  puts two vshards in charge of the same two rows: `assocAdd(A, x, y)` maintains the B half from x's
 *  vshard and `assocAdd(B, y, x)` maintains the A half from y's, and the outbox orders each source
 *  against itself and not against the other. A remove through one side and an add through the other
 *  then land in whichever order delivery takes, and the pair is left holding one half. That is a
 *  question about the design, recorded as one.
 *
 *  A workload not asking it keeps to whichever side wrote first. Which costs nothing: every edge type
 *  is still written, from both ends, just never between one pair of objects from both at once. */
export class Sides {
  readonly #claimed = new Map<string, Id>();

  /** The pair of rows a write would maintain, named the same way from either end. */
  #key(rel: Outgoing, id1: Id, id2: Id): string {
    const pair = Math.min(rel.atype!, rel.inverse!);
    const [lo, hi] = cmpId(id1, id2) <= 0 ? [id1, id2] : [id2, id1];
    return `${pair}:${lo}:${hi}`;
  }

  allows(rel: Outgoing, id1: Id, id2: Id): boolean {
    if (rel.inverse === undefined) return true;
    const held = this.#claimed.get(this.#key(rel, id1, id2));
    return held === undefined || held === id1;
  }

  claim(rel: Outgoing, id1: Id, id2: Id): void {
    if (rel.inverse !== undefined) this.#claimed.set(this.#key(rel, id1, id2), id1);
  }
}
