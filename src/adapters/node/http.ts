// The protocol over `node:http`.
//
// The handler in `protocol/http.ts` is a function from a WHATWG `Request` to a `Response` and imports
// nothing from any platform, so this file is only the translation: a Node request in, a Node response
// out. That is the point of the split. Step 4's tests need two databases talking over real HTTP
// rather than a `fetch` stub, and the only way for that to prove anything about a deployment is for
// the code under test to be the deployed code with a different socket in front of it.
//
// It is also the start of step 7's Node adapter — "spin up your own, with no account anywhere" — and
// the proof that the protocol is implementable off the platform it was designed on. What is missing
// for that is storage: this serves whatever `ReadSource` it is handed, which today is a
// `LocalCluster` holding its hosts in memory. File-backed SQLite per host is step 7.

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { MAX_BODY, handle } from "../../protocol/http.ts";
import type { Binding } from "../../protocol/http.ts";
import { canonicalDb } from "../../query/ref.ts";

export interface ListenOptions {
  /** The path the database is served at: `/db`, or `""` for the origin root. */
  path?: string;
  /** 0, the default, takes whatever port is free — which is what a test wants, since the database
   *  URI cannot be spelled until the port is known. */
  port?: number;
  host?: string;
  /** Canonical public identity, including its public path. */
  database?: string;
}

export interface ListenBinding extends Omit<Binding, "database"> {
  database?: string;
  /** A file-backed database records its development URI when the port becomes known. */
  bindUri?: (socketUri: string, configured?: string) => string;
}

export interface NodeDatabase {
  /** What the socket is listening on, e.g. `http://127.0.0.1:38213`. */
  origin: string;
  /** The database's canonical URI: the origin plus the path. */
  database: string;
  /** The binding as resolved, with `database` filled in. */
  binding: Binding;
  close(): Promise<void>;
}

/**
 * Serves one database, and resolves once it is listening.
 *
 * Supply a public URI on the binding or in the options for a deployment behind a
 * proxy. Without one, a loopback server derives its identity after the port is known.
 */
export function listen(parts: ListenBinding, opts: ListenOptions = {}): Promise<NodeDatabase> {
  const host = opts.host ?? "127.0.0.1";
  const identity = opts.database ?? parts.database;
  const publicUri = identity === undefined ? undefined : canonicalDb(identity);
  const path = opts.path ?? parts.prefix ?? (publicUri ? new URL(publicUri).pathname.replace(/\/$/, "") : "");
  const maxBody = parts.maxBody ?? MAX_BODY;

  // Resolved on `listening`, so the binding the handler sees is the one the descriptor advertises.
  let binding: Binding | null = null;

  const server = createServer((req, res) => {
    void answer(req, res, () => binding, maxBody);
  });

  return new Promise<NodeDatabase>((done, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 0, host, () => {
      const address = server.address() as AddressInfo;
      // A loopback host is the one place `canonicalDb` allows http, for exactly this.
      const origin = `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`;
      let database: string;
      try {
        const socketUri = origin + path;
        database = parts.bindUri?.(socketUri, opts.database) ?? publicUri ?? canonicalDb(socketUri);
      } catch (error) {
        server.close();
        fail(error);
        return;
      }
      binding = { ...parts, database, prefix: path };
      done({ origin, database, binding, close: () => close(server) });
    });
  });
}

const close = (server: Server): Promise<void> =>
  new Promise((done, fail) => {
    server.closeAllConnections();
    server.close((e) => (e ? fail(e) : done()));
  });

async function answer(
  req: IncomingMessage,
  res: ServerResponse,
  binding: () => Binding | null,
  maxBody: number,
): Promise<void> {
  const bound = binding();
  if (bound === null) {
    // Unreachable: the server answers nothing before `listening` resolves it.
    res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "not ready" }));
    return;
  }

  try {
    const body = await collect(req, maxBody);
    if (body === OVER) {
      // Refused at the socket, before a `Request` is built: the handler caps the body too, but
      // reading it all into one in order to tell it so is the work a 413 exists to refuse.
      res.writeHead(413, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `body over ${maxBody} bytes` }));
      return;
    }

    const response = await handle(request(req, bound, body), bound);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    // Says nothing, for the reason `protocol/http.ts` gives: a stranger learns that this database
    // broke, not how.
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "internal error" }));
  }
}

function request(req: IncomingMessage, binding: Binding, body: Buffer): Request {
  // The handler routes on the path alone, so the origin here only has to be a well-formed one. The
  // database's own is used, which keeps a `Request` built here indistinguishable from one a test
  // constructs by hand.
  const origin = new URL(binding.database).origin;
  const url = new URL(req.url ?? "/", origin);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  // An `ArrayBuffer` rather than the Buffer itself: both are BufferSource at runtime, but only one
  // of them is one to `BodyInit`. A copy, which a body capped at 64 KiB can afford.
  const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
  return new Request(url, { method, headers, body: hasBody ? bytes : undefined });
}

const OVER: unique symbol = Symbol("over");

/**
 * The body, or `OVER` as soon as it passes the cap.
 *
 * Past the cap the chunks are discarded rather than kept, so nothing unbounded is held — but the
 * request is drained rather than destroyed. Destroying it tears the socket down before the 413 has
 * flushed, and a caller that gets a connection reset where it should have got a refusal cannot tell
 * "too large" from "this database is down".
 */
function collect(req: IncomingMessage, maxBody: number): Promise<Buffer | typeof OVER> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBody) {
        chunks.length = 0;
        if (!over) {
          over = true;
          done(OVER);
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!over) done(Buffer.concat(chunks));
    });
    req.on("error", (e) => {
      if (!over) fail(e);
    });
  });
}
