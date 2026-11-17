// Who may reach the routes that operate a deployment.
//
// A demo Worker serves two audiences from one hostname. A visitor reads: a page, a relation, a query.
// An operator lays the database out, loads it, measures it and erases it. The second set was reachable
// by the first — `/ingest/pages` and `/ingest/edges` wrote to a loaded database for anyone who could
// reach the Worker, `/admin/cpu` spent CPU on request, and `/admin/where` cost two calls per host per
// visit — because the only thing separating them was that nobody had been told the paths.
//
// The rule is by prefix rather than by route, on purpose. A list of gated routes is open by default:
// the next route someone adds under `/admin/` is public until they remember the list. A prefix is
// closed by default, and a test holds every route in the Worker to being one or the other.
//
// The secret is a bearer token and not an arming flag like `HLEKK_WIPE`. A flag opens a route to
// everyone for as long as it is set, and a load is set for hours. A token opens it to whoever holds
// the token, for exactly as long as they hold it. `/admin/wipe` and `/admin/r2probe` keep their own
// arming as well: this decides who is asking, those decide what a request may name.

/** The paths only an operator may reach. Routes are matched by exact string, so any path that
 *  reaches an operator route is one of these; there is no normalization for a caller to slip past. */
export function isOperatorPath(path: string): boolean {
  return path === "/admin" || path.startsWith("/admin/") || path === "/ingest" || path.startsWith("/ingest/");
}

/** A configured token shorter than this is treated as no token at all. `HLEKK_ADMIN_TOKEN=1` reads
 *  like the arming flags beside it and would be a one-guess secret; refusing it is what keeps a
 *  flag-shaped value from quietly opening everything. `openssl rand -hex 32` is 64. */
export const MIN_TOKEN_LENGTH = 32;

const refusal = (status: number, error: string, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", ...headers } });

/** SHA-256 of a string. Comparing digests rather than the strings themselves is what makes the
 *  comparison below take the same time whatever was sent, its length included. */
async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function same(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/**
 * The refusal for a request to an operator path, or null when it may proceed.
 *
 * Call it before anything else in the handler — before a binding is touched and before a request is
 * forwarded to another deployment — so a refused request costs a hash and nothing more.
 *
 * `configured` is the deployment's `HLEKK_ADMIN_TOKEN`. Absent, which is the committed state, every
 * operator path refuses: a deployment nobody is operating carries no working way to change it. The
 * two refusals differ on purpose. 403 says the deployment is closed and no header will help; 401
 * says a token is expected. That tells a stranger only whether a secret exists, and it tells an
 * operator which of the two things they forgot.
 */
export async function refuseOperator(request: Request, configured: string | undefined): Promise<Response | null> {
  if (configured === undefined || configured.length < MIN_TOKEN_LENGTH) {
    return refusal(403, "operator routes are closed on this deployment");
  }
  const header = request.headers.get("authorization") ?? "";
  const sent = /^Bearer +(.+)$/i.exec(header)?.[1];
  if (sent === undefined || !(await same(sent, configured))) {
    return refusal(401, "operator routes need this deployment's bearer token", { "www-authenticate": "Bearer" });
  }
  return null;
}

/**
 * The headers a driver adds to reach an operator path, and nothing for any other path.
 *
 * Scoped to operator paths so the token is not sent with the reads a driver also makes: a secret
 * that rides on every request is in every log line and every proxy between here and there.
 * `path` may carry a query string.
 */
export function operatorHeaders(path: string, token: string | undefined): Record<string, string> {
  const pathname = path.split("?")[0]!;
  return token !== undefined && token !== "" && isOperatorPath(pathname) ? { authorization: `Bearer ${token}` } : {};
}

/** Why a driver's request was refused, as something to act on, or null if the status is not one of
 *  the guard's. Retrying either is pointless, which is why a driver needs to tell them apart from a
 *  transient failure. */
export function operatorRefusal(path: string, status: number, token: string | undefined): string | null {
  if (!isOperatorPath(path.split("?")[0]!)) return null;
  if (status === 401) {
    return token === undefined || token === ""
      ? "this route needs the deployment's operator token: set HLEKK_ADMIN_TOKEN in this process's environment"
      : "the deployment rejected HLEKK_ADMIN_TOKEN: it is not the token set on that Worker";
  }
  if (status === 403 && (token === undefined || token === "")) {
    return "operator routes are closed on that deployment, and no HLEKK_ADMIN_TOKEN is set here either";
  }
  return null;
}
