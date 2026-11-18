// The cross-database protocol: the serving half, the asking half, and what crosses between them.
//
// `spec/protocol.md` is the normative specification and `spec/schemas/` the normative shapes. This
// is one implementation of them.

export { DESCRIPTOR_VERSION, MAX_BODY, descriptorOf, handle, mountOf } from "./http.ts";
export type { Binding, Descriptor, DescriptorKey } from "./http.ts";

export { WIRE_VERSION, WireError, decodePrice, decodeRead, encodeRead } from "./wire.ts";
export type { Decoded, PriceResponse, ReadResponse, WireObject } from "./wire.ts";

export { VOCABULARY_VERSION, surfaceOf } from "./surface.ts";
export type { Surface, VocabularyDoc } from "./surface.ts";

export {
  DEADLINE_MS,
  DEFAULT_BATCH,
  ForeignRefused,
  ForeignUnreachable,
  MAX_RESPONSE_BYTES,
  NotFollowed,
  Repudiated,
  ResponseCache,
  discover,
  discoverPinned,
  foreignClient,
  foreignClients,
} from "./client.ts";
export type { ForeignOptions, Omitted, Pins, TransportOptions } from "./client.ts";

// Backlinks: a hint received, a read that checks it, and an edge of this database's own.
export { Backoff } from "./backoff.ts";
export { HINT_MEMBERS, HintQueue, parseHint } from "./hint.ts";
export type { Hint, HintQueueOptions, HintSink, ReceivedHint } from "./hint.ts";
export { DEFAULT_CHECK_PAGES, checkHint, retryAfterOf, sendHint, settleHint } from "./backlinks.ts";
export type { CheckOptions, HintSent, Reach, Settled, SettleOptions, Verdict } from "./backlinks.ts";

export {
  ALG,
  CALLER_HEADER,
  LABEL,
  MAX_SKEW_SECONDS,
  SignatureRefused,
  contentDigest,
  generateKeyPair,
  keyIdOf,
  keyPairFrom,
  reachable,
  signRequest,
  signRotation,
  signatureBase,
  verifyRequest,
  wellFormed,
} from "./identity.ts";
export type { Caller, KeyPair, PublicKey, SignedHeaders } from "./identity.ts";

// The serving half lives in the query layer, because answering a read is the engine's own work and
// only the boundary around it is this layer's.
export { MAX_IDS, PUBLIC, Refused, enforce, planOf, price, serve, vocabularyOf } from "../query/serve.ts";
export type { Cacheability, Policy, ReadRequest, ReadSource, ServeOptions, Served } from "../query/serve.ts";
export { DEFAULT_LIMITS, check } from "../query/request.ts";
export type { Cost, Hop, Limits, Request, Vocabulary } from "../query/request.ts";
