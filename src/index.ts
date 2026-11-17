// The engine, as one entry point. An application reaches a database through `Hlekk` and builds its
// queries with the generated module that imports from `hlekk/schema`.

export { Hlekk, MaintainedEdge, StillFenced, TooManyReroutes, Unroutable, UnknownAlias, ValueTaken, VersionConflict, WriteRefused } from "./client/client.ts";
export { BudgetSpent, DEFAULT_BUDGET, MAX_REROUTES, WRITE_DEADLINE_MS } from "./client/client.ts";
export type { Budget, QueryOptions, WriteOptions } from "./client/client.ts";
export { LocalCluster } from "./client/local.ts";
export type { LocalOptions } from "./client/local.ts";
export type { Mutation, Transport, DatabaseIdentity } from "./client/transport.ts";

export { Catalog, CatalogError, plan } from "./catalog/catalog.ts";
export type { Domain, EdgeDecl, EdgeType, FieldSpec, Lock, ObjectType, OnDelete } from "./catalog/catalog.ts";
export { resolve as resolveProjection, generate as generateProjection } from "./catalog/projection.ts";
export type { Projection, Resolved } from "./catalog/projection.ts";

export { canonicalDb, formatRef, isQualified, parseRef, RefError } from "./query/ref.ts";
export type { ParsedRef, Ref } from "./query/ref.ts";
export { UNKNOWN, cmpId, edgeOrder } from "./query/types.ts";
export type { Cursor, Edge, EdgePage, Fields, Id, Json, Obj, Plan } from "./query/types.ts";

export { CURRENT_FORMAT, FormatError } from "./host/schema.ts";
export type { StorageFormat } from "./host/schema.ts";
export { makeId, parseId, vshardOf } from "./host/ids.ts";
