// The standalone client: queries across databases, from a process that runs none.
//
// One entry point, so a program that only reads imports one thing. It runs wherever `fetch` does; a
// Node process should take `reader()` from `hlekk/adapters/node` instead, which adds the check that
// keeps a stranger's reference from reaching a private network.

export { Database, NoSuchEdge, Reader, VOCABULARY_TTL_MS, connect, memoryPins } from "./reader.ts";
export type { Page, ReadOptions, ReaderOptions, Row } from "./reader.ts";

// What a read can fail with, so a caller can tell them apart without a second import.
export { BudgetSpent, DEFAULT_BUDGET } from "../client/budget.ts";
export type { Budget } from "../client/budget.ts";
export { ForeignRefused, ForeignUnreachable, NotFollowed, Repudiated, ResponseCache } from "../protocol/client.ts";
export type { Omitted, Pins } from "../protocol/client.ts";
export { Refused } from "../query/request.ts";
export type { Cmp, Cost, CountSpec, Hop, Request } from "../query/request.ts";
export { RefError, canonicalDb, formatRef, isQualified, parseRef } from "../query/ref.ts";
export type { Ref } from "../query/ref.ts";
export type { Descriptor } from "../protocol/http.ts";
export type { VocabularyDoc } from "../protocol/surface.ts";
