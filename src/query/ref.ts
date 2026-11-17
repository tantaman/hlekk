// References, local and qualified. A `Ref` is what an application writes down when it names an
// object: a bare decimal id for one in this database, or `<database URI>#<decimal id>` for one in
// another.
//
// This is the one piece of the cross-database design that is expensive to defer, and it is the
// reason this module exists before any of the storage does. Field relationships hold ids *inside
// JSON payloads* (`"authorId": { "id": "core.user" }`), so whichever spelling ships first is in
// stored payloads permanently, and changing it later means rewriting payloads — which the move and
// snapshot path does not cover and no fence makes safe (`docs/global-ids.md`, "What to do now").
// Deciding the string form costs nothing today and cannot be bought back tomorrow.
//
// **Why one `#`.** A URI has at most one fragment, and a canonical database URI below has none, so
// the first `#` in a `Ref` is unambiguously the separator and the prefix before it is exactly the
// database's identity. No escaping, no second delimiter to agree on, and `parseRef` needs no
// knowledge of what a database URI may contain to find the split.
//
// **`ids.ts` does not change.** `parseId` and `toKey` keep refusing anything that is not a bare
// decimal, so a qualified reference that reaches a key conversion throws loudly instead of being
// truncated to a local id that happens to exist. Qualification lives outside the integer; a local
// id's 16/47/1 layout is untouched by all of this. `docs/global-ids.md` asks for `parseId` itself to
// round-trip a qualified id; a separate `parseRef` is the same decision with that 8-byte guard left
// strict, which the same document also asks for, and strict is the half that catches mistakes.
//
// **Where a qualified reference is accepted** (recorded here, enforced by step 3's write path):
// an edge's target, and a payload field the catalog declares as an id.
//
// **Where it is refused:** an edge's source, `with` (colocation is one host of one database), the
// target of an update or delete (writes are local, as `docs/protocol.md` decides), and a global
// index entry (uniqueness is enforced over this database's objects).

import { parseId } from "../host/ids.ts";
import type { Id } from "./types.ts";

/** A local `Id`, or a canonical database URI, `#`, and that database's own local id. */
export type Ref = string;

/** `db` is null for a reference into this database, which is what the ids in storage already are. */
export interface ParsedRef {
  db: string | null;
  id: Id;
}

// A cap on the database URI, because it is a prefix of every reference stored in a payload and the
// registry's unique index keys on it. 512 bytes holds the longest legal DNS name (253) plus `https://`
// and a 251-byte path, so nothing a real deployment would mint is near it. Raising it later is
// additive — a URI refused today would simply start being accepted — while lowering it would orphan
// references already stored, so it is set generously once and left alone.
export const MAX_DB_URI_LENGTH = 512;

// RFC 3986's unreserved set. §6.2.2.2: a percent-escape of one of these is *not required*, and
// decoding it does not change what the URI identifies, so the canonical form spells it raw. The
// converse half of that rule matters more than it looks: an escape of anything else is left exactly
// as given, because decoding a reserved character can change the URI's structure — which is what
// stops `%2E%2E` from arriving as a path that climbs out of its prefix.
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

// What a canonical path may hold unescaped: `pchar` minus `pct-encoded`, plus the `/` separator.
// WHATWG `URL` does not escape `|` or `^` in a path, so this is the check that keeps them out
// rather than letting them through into a stored reference.
const CANONICAL_PATH = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-F]{2})*$/;

const LOOPBACK = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

/** Thrown by `canonicalDb` and the two functions that call it. `canonical` is set when the URI names
 *  one database in a spelling this implementation will not store; it is absent when there is nothing
 *  to name, because repairing the input would have changed which resource it identifies. */
export class RefError extends TypeError {
  readonly canonical?: string;
  constructor(message: string, canonical?: string) {
    super(canonical === undefined ? message : `${message}; canonical form is ${canonical}`);
    this.name = "RefError";
    if (canonical !== undefined) this.canonical = canonical;
  }
}

/** Returns `uri` unchanged when it is already the canonical spelling of a database URI, and throws
 *  otherwise — naming the canonical spelling when one exists.
 *
 *  **Refused rather than repaired.** Once the URI is the database's identity, two spellings of one
 *  database are two aliases in the registry and its unique index does not notice
 *  (`docs/global-ids.md`, "Canonicalization becomes load-bearing"). Quietly repairing the input
 *  would hide that, and a reference that was stored under the repaired form would not match the
 *  caller's own spelling of it. So the swamp is drained in one direction only: a caller is told what
 *  to send and sends it. */
export function canonicalDb(uri: string): string {
  if (typeof uri !== "string") throw new RefError(`not a database URI: ${JSON.stringify(uri)}`);
  // Measured in UTF-16 code units, which for a canonical URI is bytes: it is ASCII by construction.
  if (uri.length > MAX_DB_URI_LENGTH) {
    throw new RangeError(`database URI longer than ${MAX_DB_URI_LENGTH} characters: ${uri.length}`);
  }

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new RefError(`not a database URI: ${JSON.stringify(uri)}`);
  }

  // The refusals with no canonical form, because dropping the offending part would change which
  // resource the URI names.
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RefError(`a database URI is https: ${JSON.stringify(uri)}`);
  }
  if (url.hostname === "") throw new RefError(`a database URI has a host: ${JSON.stringify(uri)}`);
  const host = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  if (url.protocol === "http:" && !LOOPBACK.test(host)) {
    throw new RefError(`http is only for a loopback host, for development: ${JSON.stringify(uri)}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new RefError(`a database URI carries no userinfo: ${JSON.stringify(uri)}`);
  }
  if (url.search !== "") throw new RefError(`a database URI carries no query: ${JSON.stringify(uri)}`);
  // A fragment is where the id goes, so a database URI holding one would make `Ref` ambiguous.
  if (url.hash !== "") throw new RefError(`a database URI carries no fragment: ${JSON.stringify(uri)}`);

  const path = canonicalPath(url.pathname, uri);
  if (uri.includes("^") || !CANONICAL_PATH.test(path)) {
    throw new RefError(`a database URI's path holds a character that must be escaped: ${JSON.stringify(uri)}`);
  }

  const port = url.port === "" ? "" : `:${url.port}`; // URL has already dropped the scheme's default
  const canonical = `${url.protocol}//${host}${port}${path}`;
  if (canonical !== uri) throw new RefError(`not the canonical spelling: ${JSON.stringify(uri)}`, canonical);
  return uri;
}

/** The path half of the canonical form. `URL` has already resolved `.` and `..` and escaped what its
 *  own path set requires; what is left is the escape normalization RFC 3986 §6.2.2.2 specifies, the
 *  trailing slash, and the segments that have no canonical spelling at all. */
function canonicalPath(pathname: string, uri: string): string {
  let out = "";
  for (let i = 0; i < pathname.length; i++) {
    const c = pathname[i];
    if (c !== "%") {
      out += c;
      continue;
    }
    const hex = pathname.slice(i + 1, i + 3);
    if (!/^[0-9A-Fa-f]{2}$/.test(hex)) {
      throw new RefError(`a database URI's path holds an incomplete percent-escape: ${JSON.stringify(uri)}`);
    }
    const ch = String.fromCharCode(parseInt(hex, 16));
    out += UNRESERVED.test(ch) ? ch : `%${hex.toUpperCase()}`;
    i += 2;
  }

  if (out.endsWith("/")) out = out.slice(0, -1); // `/wiki/` and `/` both lose it; `/` becomes empty

  // An empty segment has no canonical form to name: removing it would change the path, and keeping
  // it would leave two spellings of one database.
  //
  // The dot-segment check is defence rather than the mechanism. The URL parser's own definitions of
  // "single-dot" and "double-dot path segment" already include the `%2e` spellings, so `/a/%2E%2E/b`
  // arrives here as `/b` and the escaped form cannot be smuggled past as an opaque segment. This
  // catches it anyway, because the check is two lines and the failure it prevents is a reference
  // that means a different database than it reads as. Checked after unescaping for the same reason.
  for (const segment of out.split("/").slice(1)) {
    if (segment === "") throw new RefError(`a database URI's path has no empty segment: ${JSON.stringify(uri)}`);
    if (segment === "." || segment === "..") {
      throw new RefError(`a database URI's path has no . or .. segment: ${JSON.stringify(uri)}`);
    }
  }
  return out;
}

/** Splits a reference into the database that holds the object and that database's own id. Throws on
 *  anything that is not one, including a local id that is not a bare decimal. */
export function parseRef(ref: Ref): ParsedRef {
  if (typeof ref !== "string") throw new RefError(`not a reference: ${JSON.stringify(ref)}`);
  const hash = ref.indexOf("#");
  if (hash === -1) {
    parseId(ref); // the 8-byte guard, left strict
    return { db: null, id: ref };
  }
  const db = canonicalDb(ref.slice(0, hash));
  const id = ref.slice(hash + 1);
  parseId(id);
  return { db, id };
}

/** Writes a reference. `db` null, or this database's own URI collapsed to null by the caller, gives
 *  the bare decimal that storage already holds. */
export function formatRef(db: string | null, id: Id): Ref {
  parseId(id);
  if (db === null) return id;
  return `${canonicalDb(db)}#${id}`;
}

/** Whether a reference names another database. Cheap enough to call before parsing, and the only
 *  thing most call sites need to know. */
export const isQualified = (ref: Ref): boolean => ref.includes("#");
