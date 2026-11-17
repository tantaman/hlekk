// What crosses the wire, and what comes back off it.
//
// `serve` answers in the engine's own normalized form, which carries the catalog's integers: an
// object's `otype` is a number the responder's lock allocated. Those mean nothing to a caller —
// `atype` 7 in one database is a different edge type in another, and an edge that resolves while
// being uninterpretable is worse than one that fails (`docs/global-ids.md`). So the wire carries
// **type names, never integers**, and the two sides agree by name or decline the type.
//
// **Ids stay relative to the database answering.** A responder's answer is about its own objects, so
// every key in `objects` is a bare decimal and so is every id in a list. That is not a convenience:
// it is what stops a responder supplying objects for a database it does not own. `decodeRead` checks
// it, so an answer naming `https://elsewhere/db#5` is refused rather than cached as if the caller
// had asked `elsewhere` itself. A reference the responder holds into another database appears in a
// list and has no entry in `objects` — step 3 stores those and step 4 follows them.
//
// **A version rides on every body.** A wire format is the one thing a standard cannot renegotiate
// after the fact, and a caller that cannot tell format 1 from format 2 has to guess from the shape.
//
// Decoding is reading a stranger's bytes, so it validates rather than casts. Every refusal is a
// `WireError` naming where, for the same reason `Refused` carries an `at`.

import { parseId } from "../host/ids.ts";
import { parseRef } from "../query/ref.ts";
import type { Cost } from "../query/request.ts";
import type { Cacheability, Served } from "../query/serve.ts";
import type { ListEntry, QueryResult } from "../query/normalize.ts";
import type { Fields, Id, Json } from "../query/types.ts";
import type { Catalog } from "../catalog/catalog.ts";
import type { Surface } from "./surface.ts";

/** The wire format's version. Bumped when a body's shape changes in a way a reader must notice. */
export const WIRE_VERSION = 1;

/** An object as it crosses the wire: its type's NAME, and only the fields the surface exposes. */
export interface WireObject {
  type: string;
  version: number;
  data: Fields;
}

/** The body of a read response. The structure is the engine's normalized form, which is what a
 *  consumer needs to walk a graph answer without holding the plan — see `query/normalize.ts` for
 *  why nesting is not the form that crosses a boundary. */
export interface ReadResponse {
  v: number;
  roots: Id[];
  objects: Record<Id, WireObject>;
  lists: Record<string, ListEntry>;
  counts: Record<string, Record<string, number>>;
  shape: Record<number, Record<string, number>>;
  /** What the request was priced at, so a caller can see what it spent. */
  cost: Cost;
  cache: Cacheability;
}

/** The body of a price response: the same cost, with nothing read. */
export interface PriceResponse {
  v: number;
  cost: Cost;
}

export class WireError extends Error {
  readonly at: string;
  constructor(at: string, message: string) {
    super(`${at}: ${message}`);
    this.name = "WireError";
    this.at = at;
  }
}

/** Encodes a served answer. An object whose type the surface does not expose cannot be named, and
 *  `serve` has already hidden those with the policy, so reaching one here is a fault rather than a
 *  disclosure to paper over. */
export function encodeRead(served: Served, surface: Surface): ReadResponse {
  const objects: Record<Id, WireObject> = {};
  for (const [id, entry] of Object.entries(served.result.objects)) {
    const type = surface.typeName(entry.otype);
    if (type === undefined) {
      throw new WireError(`objects.${id}`, `otype ${entry.otype} is not exposed, so it has no name to send`);
    }
    const exposed = surface.fields(type);
    objects[id] = { type, version: entry.version, data: narrow(entry.data, exposed) };
  }
  return {
    v: WIRE_VERSION,
    roots: served.result.roots,
    objects,
    lists: served.result.lists,
    counts: served.result.counts,
    shape: served.result.shape,
    cost: served.cost,
    cache: served.cache,
  };
}

/** The fields the surface projects, and no others. A narrowed projection that drops a field drops it
 *  from the answer too, or narrowing would be a label rather than a boundary. */
function narrow(data: Fields, exposed: Record<string, unknown> | undefined): Fields {
  if (exposed === undefined) return {};
  const out: Fields = {};
  for (const name of Object.keys(exposed)) {
    if (name in data) out[name] = data[name];
  }
  return out;
}

/** What a decoded answer is, plus what of it could not be understood. */
export interface Decoded {
  result: QueryResult;
  cost: Cost;
  cache: Cacheability;
  /** Type names the reading catalog does not declare. Their objects are left out of `result`, so a
   *  caller sees the reference and no object — the same thing it sees for one the responder chose
   *  not to follow. `docs/protocol.md` calls this declining a type you do not understand, and it is
   *  a report rather than a throw because one unknown type in an answer should not lose the rest. */
  declined: string[];
}

/**
 * Decodes a read response against the READING catalog, which is the one that has to understand the
 * names. Throws `WireError` on anything malformed, because a caller cannot tell a truncated answer
 * from a complete one and guessing is how a federated read returns a quietly wrong graph.
 */
export function decodeRead(body: unknown, catalog: Catalog): Decoded {
  const root = object(body, "body");
  const v = root.v;
  if (v !== WIRE_VERSION) {
    throw new WireError("v", `wire version ${JSON.stringify(v)}, this reader speaks ${WIRE_VERSION}`);
  }

  const roots = idList(root.roots, "roots");

  const declined = new Set<string>();
  const objects: QueryResult["objects"] = {};
  for (const [id, raw] of Object.entries(object(root.objects, "objects"))) {
    const at = `objects.${id}`;
    // The one check that is about trust rather than shape: a key that is not a bare decimal is a
    // responder answering for a database it does not own.
    try {
      parseId(id);
    } catch {
      throw new WireError(at, "an object key must be a bare decimal id of the database answering");
    }
    const entry = object(raw, at);
    const type = string(entry.type, `${at}.type`);
    const otype = catalog.objectNamed(type)?.otype;
    if (otype === undefined) {
      declined.add(type);
      continue;
    }
    objects[id] = { otype, version: integer(entry.version, `${at}.version`), data: fields(entry.data, `${at}.data`) };
  }

  const lists: QueryResult["lists"] = {};
  for (const [key, raw] of Object.entries(object(root.lists, "lists"))) {
    lists[key] = list(raw, `lists.${JSON.stringify(key)}`);
  }

  const counts: QueryResult["counts"] = {};
  for (const [key, raw] of Object.entries(object(root.counts, "counts"))) {
    const at = `counts.${JSON.stringify(key)}`;
    const byAlias: Record<string, number> = {};
    for (const [alias, n] of Object.entries(object(raw, at))) byAlias[alias] = integer(n, `${at}.${alias}`);
    counts[key] = byAlias;
  }

  const shape: QueryResult["shape"] = {};
  for (const [frame, raw] of Object.entries(object(root.shape, "shape"))) {
    const at = `shape.${frame}`;
    if (!/^(0|[1-9][0-9]*)$/.test(frame)) throw new WireError(at, "a frame is a non-negative integer");
    const aliases: Record<string, number> = {};
    for (const [alias, to] of Object.entries(object(raw, at))) aliases[alias] = integer(to, `${at}.${alias}`);
    shape[Number(frame)] = aliases;
  }

  return {
    result: { roots, objects, lists, counts, shape },
    cost: cost(root.cost, "cost"),
    cache: cache(root.cache, "cache"),
    declined: [...declined],
  };
}

/** Decodes a price response, which is the same cost with nothing read. */
export function decodePrice(body: unknown, at = "body"): Cost {
  const root = object(body, at);
  if (root.v !== WIRE_VERSION) {
    throw new WireError("v", `wire version ${JSON.stringify(root.v)}, this reader speaks ${WIRE_VERSION}`);
  }
  return cost(root.cost, "cost");
}

// ---- the validators. Narrow, named, and throwing rather than coercing.

function object(v: unknown, at: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new WireError(at, "expected an object");
  return v as Record<string, unknown>;
}

function string(v: unknown, at: string): string {
  if (typeof v !== "string") throw new WireError(at, "expected a string");
  return v;
}

function integer(v: unknown, at: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new WireError(at, "expected an integer");
  return v;
}

function boolean(v: unknown, at: string): boolean {
  if (typeof v !== "boolean") throw new WireError(at, "expected a boolean");
  return v;
}

function idList(v: unknown, at: string): Id[] {
  if (!Array.isArray(v)) throw new WireError(at, "expected an array");
  return v.map((id, i) => {
    const s = string(id, `${at}[${i}]`);
    try {
      parseId(s);
    } catch {
      throw new WireError(`${at}[${i}]`, "expected a bare decimal id of the database answering");
    }
    return s;
  });
}

/**
 * A list's members, which may be references.
 *
 * Unlike `objects`, whose keys must be bare — that is the check that stops a responder answering for
 * a database it does not own — a list legitimately holds references out of the answering database.
 * Those are the ones it did not follow, and they are the whole of how a read continues past it: the
 * coordinator reads the reference and asks that database itself. A reference must be canonical, for
 * the same reason every other one must.
 */
function refList(v: unknown, at: string): Id[] {
  if (!Array.isArray(v)) throw new WireError(at, "expected an array");
  return v.map((id, i) => {
    const s = string(id, `${at}[${i}]`);
    try {
      parseRef(s);
    } catch (e) {
      throw new WireError(`${at}[${i}]`, `expected a bare id or a canonical reference: ${(e as Error).message}`);
    }
    return s;
  });
}

function fields(v: unknown, at: string): Fields {
  return object(v, at) as Fields;
}

function list(v: unknown, at: string): ListEntry {
  const entry = object(v, at);
  const ids = refList(entry.ids, `${at}.ids`);
  const out: ListEntry = {
    ids,
    cursor: entry.cursor === null || entry.cursor === undefined ? null : string(entry.cursor, `${at}.cursor`),
    more: boolean(entry.more, `${at}.more`),
  };
  if (entry.edges !== undefined) {
    if (!Array.isArray(entry.edges)) throw new WireError(`${at}.edges`, "expected an array");
    // Positional against `ids`: the edge that reached each one. A length that disagrees would pair
    // an edge with the wrong target, which is silent and wrong rather than loud and wrong.
    if (entry.edges.length !== ids.length) {
      throw new WireError(`${at}.edges`, `${entry.edges.length} edges for ${ids.length} ids`);
    }
    out.edges = entry.edges.map((e, i) => {
      if (e === null || e === undefined) return null;
      const edge = object(e, `${at}.edges[${i}]`);
      const data = edge.data;
      return {
        time: integer(edge.time, `${at}.edges[${i}].time`),
        data: data === null || data === undefined ? null : fields(data, `${at}.edges[${i}].data`),
      };
    });
  }
  return out;
}

function cost(v: unknown, at: string): Cost {
  const c = object(v, at);
  return { frames: integer(c.frames, `${at}.frames`), nodes: integer(c.nodes, `${at}.nodes`) };
}

function cache(v: unknown, at: string): Cacheability {
  const c = object(v, at);
  const reuse = string(c.reuse, `${at}.reuse`);
  if (reuse === "never") return { reuse: "never" };
  if (reuse === "caller" || reuse === "public") {
    const seconds = integer(c.seconds, `${at}.seconds`);
    if (seconds < 0) throw new WireError(`${at}.seconds`, "expected a non-negative integer");
    return { reuse, seconds };
  }
  // A reuse mode this reader does not know could mean anything, and the safe reading of "anything"
  // is "do not keep it".
  throw new WireError(`${at}.reuse`, `unknown reuse ${JSON.stringify(reuse)}`);
}

/** Round-trips the structure for a test or an in-process caller: JSON is the transport, so anything
 *  that does not survive it does not exist. */
export const roundTrip = (body: unknown): Json => JSON.parse(JSON.stringify(body)) as Json;
