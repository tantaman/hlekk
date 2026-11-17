// The machinery the suite tests with, published because an implementation of the protocol other than
// this one may want the oracles rather than only the conformance suite.
//
// `scripts/conformance.mjs` deliberately imports none of this: a suite that shared code with the
// implementation under test would be checking that it agrees with itself. These are for building a
// harness, not for being one.

export { generateGraph, generateQuery, replay } from "./generate.ts";
export type { GraphOptions, Op, QueryOptions, Replayed, Script } from "./generate.ts";
export { generateSchema, generateSchemas, compileSchema } from "./schemas.ts";
export type { SchemaOptions } from "./schemas.ts";
export { assertSound, check as checkInvariants } from "./invariants.ts";
export type { Violation } from "./invariants.ts";
export { federate, pinsOf, replaySplit, splitOf } from "./federation.ts";
export type { Federation, FederationOptions, Member, MemberOptions, SplitReplay } from "./federation.ts";
export { served } from "./served.ts";
export type { ServedFixture, ServedOptions } from "./served.ts";
export { unreliable } from "./unreliable.ts";
export type { Faults, Simulated } from "./unreliable.ts";
export { collapse, probes, simulate } from "./sim.ts";
export type { SimOptions, SimReport } from "./sim.ts";
export type { Comparable, Outgoing, Payload, Shape } from "./shape.ts";
