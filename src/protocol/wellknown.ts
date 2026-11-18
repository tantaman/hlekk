// Being found from an origin, by something that has never heard of this database.
//
// A database is mounted wherever its operator put it — `/db`, `/wiki`, the root — so a caller holding
// only a host name has no way to guess its URI, and guessing is not how any of this is supposed to
// work. RFC 9727 is the standard answer to exactly that: one well-known path per origin,
// `/.well-known/api-catalog`, listing the APIs the origin publishes as a Linkset (RFC 9264). So this
// invents nothing. An origin that serves a hlekk database lists it there, and anything that already
// knows how to read an API catalog finds it.
//
// **Not a directory of databases.** `PLAN.md` leaves a global directory out on purpose: a URI is the
// name and DNS arbitrates it. This is the other end of that sentence — the origin DNS already
// arbitrated, saying what is on it. It names nothing the origin does not itself serve, it is not
// consulted to follow a reference, and a database that is not listed is exactly as reachable as one
// that is. Discovery is not identity, and nothing here makes it so.
//
// **Outside the handler, on purpose.** `protocol/http.ts` serves one database under its own prefix,
// and a well-known path belongs to the origin, which may serve other things. So this is a function a
// deployment mounts at the origin, and `adapters/node/http.ts` — which owns its whole origin — does.

import { canonicalDb } from "../query/ref.ts";

export const WELL_KNOWN = "/.well-known/api-catalog";

/** The profile RFC 9727 §4.2 asks a catalog's Linkset to carry. */
export const CATALOG_PROFILE = "https://www.rfc-editor.org/info/rfc9727";

export const CATALOG_TYPE = `application/linkset+json; profile="${CATALOG_PROFILE}"`;

export interface CatalogEntry {
  /** The database URI: the API this entry is about, and the only address a caller needs. */
  anchor: string;
  /** What can be asked of it, for a machine: the vocabulary. */
  "service-desc": { href: string; type: string }[];
  /** What it is, for a machine: the descriptor, which is served at the database URI itself. */
  "service-meta": { href: string; type: string }[];
}

/**
 * The catalog for an origin that serves these databases.
 *
 * Two links an entry, both to documents the protocol already serves. The descriptor is the one that
 * says `"protocol": "hlekk"`, so that is where a reader learns this entry is one of these and not
 * some other API the origin lists beside it.
 */
export function apiCatalog(databases: readonly string[]): { linkset: CatalogEntry[] } {
  return {
    linkset: databases.map((uri) => {
      const db = canonicalDb(uri);
      return {
        anchor: db,
        "service-desc": [{ href: `${db}/vocabulary`, type: "application/json" }],
        "service-meta": [{ href: db, type: "application/json" }],
      };
    }),
  };
}

/**
 * Answers a request for the catalog, or returns null for any other path so that the caller can go
 * on to whatever else its origin serves.
 *
 * `HEAD` answers with the `Link` the RFC asks for and no body, which is how a client asks "is there
 * a catalog here" for the price of headers.
 */
export function serveCatalog(request: Request, databases: readonly string[], opts: { cors?: boolean } = {}): Response | null {
  if (new URL(request.url).pathname !== WELL_KNOWN) return null;
  const headers: Record<string, string> = {
    link: `<${WELL_KNOWN}>; rel="api-catalog"`,
    ...(opts.cors === true ? { "access-control-allow-origin": "*", "access-control-expose-headers": "link" } : {}),
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
  }
  return new Response(request.method === "HEAD" ? null : JSON.stringify(apiCatalog(databases)), {
    status: 200,
    headers: { ...headers, "content-type": CATALOG_TYPE, "cache-control": "public, max-age=300" },
  });
}
