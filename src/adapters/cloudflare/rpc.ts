// One call, one method, over `fetch`. A DO stub's own RPC would be the production choice; this keeps
// the layer dependency-free and needs no generated types, and it costs nothing on the wire, because
// everything crossing it is already JSON: ids are decimal strings precisely so that nothing is
// coerced through a double, and a payload is JSON before it reaches SQLite.
//
// The two shapes that are not plain JSON are maps keyed by vshard. They are carried as pairs and
// rebuilt on arrival, in this one place, so the two sides cannot disagree about it.

import type { Route } from "../../directory/map.ts";
import type { Routed } from "../../host/host.ts";
import type { Stub } from "./bindings.ts";

/** A method call and its arguments. */
interface Call {
  method: string;
  args: unknown[];
}

export class RemoteError extends Error {
  readonly method: string;
  constructor(method: string, message: string) {
    super(`${method}: ${message}`);
    this.name = "RemoteError";
    this.method = method;
  }
}

/** Calls one method on one Durable Object. A throw on the far side comes back as one here, with its
 *  name kept, so the client's own error handling — a refusal, a conflict — still sees what it expects. */
/**
 * Calls a method on a Durable Object.
 *
 * **An `undefined` argument arrives as `null`.** The wire is JSON, and `JSON.stringify` keeps an
 * array's length while turning its `undefined` entries into `null` — so a handler written with an
 * optional parameter sees `null`, its default does not apply, and a `!== undefined` guard inside it
 * is simply wrong. Pass fewer arguments to mean "absent", or have the handler treat `null` as absent.
 * Found by a probe whose `get(key, { range: { offset: null } })` became a 500 while the same call
 * with a real offset worked.
 */
export async function call<T>(stub: Stub, method: string, ...args: unknown[]): Promise<T> {
  const body: Call = { method, args };
  const res = await stub.fetch(
    new Request("http://do/", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  );
  const text = await res.text();
  if (!res.ok) {
    const failed = text ? (JSON.parse(text) as { name?: string; message?: string }) : {};
    const e = new RemoteError(method, failed.message ?? `${res.status}`);
    if (failed.name) e.name = failed.name;
    throw e;
  }
  return (text ? (JSON.parse(text) as { value: T }).value : undefined) as T;
}

/** The far side of `call`. A handler's return value is sent as it is; a throw is sent with its name,
 *  since the name is what the caller dispatches on. */
export async function serve(
  request: Request,
  handlers: () => Record<string, (...args: never[]) => unknown>,
): Promise<Response> {
  // Building the handler table is inside the try as well. A Durable Object opens its storage on first
  // use, and a throw on the way to a handler — rather than inside one — leaves the platform with
  // nothing to report but an opaque internal error and a reference number.
  let method = "(unparsed)";
  try {
    const call = (await request.json()) as Call;
    method = call.method;
    const handler = handlers()[method];
    if (!handler) return json({ name: "TypeError", message: `no such method: ${method}` }, 404);
    return json({ value: await (handler as (...a: unknown[]) => unknown)(...call.args) });
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    console.error(`${method} failed: ${error.name}: ${error.message}\n${error.stack ?? ""}`);
    return json({ name: error.name, message: error.message }, 500);
  }
}

/** A vshard is a bigint in memory and a decimal string on the wire, as an id is, and for the same
 *  reason: nothing may be coerced through a double. A reply that carries one unconverted would
 *  otherwise fail at `JSON.stringify` with no clue which call it was. */
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "content-type": "application/json" },
  });

// ---- the shapes that are not plain JSON

export const routedToWire = (routed: Routed): [string, number][] => [...routed].map(([v, e]) => [v.toString(), e]);

export const routedFromWire = (wire: [string, number][]): Routed => new Map(wire.map(([v, e]) => [BigInt(v), e]));

export const routesToWire = (routes: Map<bigint, Route>): [string, Route][] =>
  [...routes].map(([v, r]) => [v.toString(), r]);

export const routesFromWire = (wire: [string, Route][]): Map<bigint, Route> =>
  new Map(wire.map(([v, r]) => [BigInt(v), r]));
