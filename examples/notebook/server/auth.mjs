import { createHash, randomBytes } from "node:crypto";

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const flowSeconds = 600;
const sessionSeconds = 7 * 24 * 60 * 60;
const nonce = () => randomBytes(32).toString("base64url");

export function authConfig(env, local) {
  const keys = ["PUBLIC_ORIGIN", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_OWNER_ID"];
  if (local && keys.every((key) => env[key] === undefined)) return null;
  const missing = keys.filter((key) => !env[key]?.trim());
  if (missing.length) throw new Error("GitHub sign-in requires " + missing.join(", "));
  if (local) throw new Error("Use npm start with a production build for GitHub sign-in.");
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (
    origin.origin !== env.PUBLIC_ORIGIN.replace(/\/$/, "") ||
    !(origin.protocol === "https:" || (origin.protocol === "http:" && loopback.has(origin.hostname)))
  ) {
    throw new Error("PUBLIC_ORIGIN must be an HTTPS origin, or HTTP on localhost for testing.");
  }
  if (!/^[1-9]\d*$/.test(env.GITHUB_OWNER_ID))
    throw new Error("GITHUB_OWNER_ID must be a numeric GitHub account ID.");
  return {
    origin,
    clientId: env.GITHUB_CLIENT_ID,
    secret: env.GITHUB_CLIENT_SECRET,
    ownerId: env.GITHUB_OWNER_ID,
  };
}

export function allowedHost(req, config) {
  if (config) return req.headers.host?.toLowerCase() === config.origin.host;
  return (
    /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(req.headers.host ?? "") &&
    !Object.keys(req.headers).some((key) => key === "forwarded" || key.startsWith("x-forwarded-"))
  );
}

function cookieValue(req, name) {
  return (req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + "="))
    ?.slice(name.length + 1);
}

function redirect(res, location) {
  res.writeHead(303, { location });
  res.end();
}

export function githubAuth(config, { fetchImpl = fetch, now = Date.now } = {}) {
  const secure = config.origin.protocol === "https:";
  const prefix = secure ? "__Host-folio-" : "folio-";
  const callback = new URL("/auth/github/callback", config.origin).href;
  const pending = new Map();
  const sessions = new Map();

  function cookie(name, value, age) {
    return (
      prefix +
      name +
      "=" +
      value +
      "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
      age +
      (secure ? "; Secure" : "")
    );
  }
  function getLive(map, key) {
    const entry = map.get(key);
    if (entry?.expiresAt > now()) return entry;
    map.delete(key);
  }
  function insert(map, key, entry, limit) {
    for (const [id, value] of map) {
      if (value.expiresAt > now()) break;
      map.delete(id);
    }
    if (map.size >= limit) map.delete(map.keys().next().value);
    map.set(key, entry);
  }
  function session(req) {
    return getLive(sessions, cookieValue(req, prefix + "session"));
  }
  async function handle(req, res, url) {
    if (req.method === "GET" && url.pathname === "/auth/github") {
      const state = nonce();
      const verifier = nonce();
      const destination = new URLSearchParams();
      for (const key of ["node", "block", "view"]) {
        if (url.searchParams.has(key)) destination.set(key, url.searchParams.get(key));
      }
      insert(
        pending,
        state,
        {
          verifier,
          destination: destination.size ? "/?" + destination : "/",
          expiresAt: now() + flowSeconds * 1000,
        },
        1024,
      );
      res.setHeader("set-cookie", cookie("state", state, flowSeconds));
      const authorize = new URL("https://github.com/login/oauth/authorize");
      authorize.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: callback,
        state,
        scope: "",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      });
      return redirect(res, authorize.href);
    }
    if (req.method === "GET" && url.pathname === "/auth/github/callback") {
      const state = cookieValue(req, prefix + "state");
      const flow = getLive(pending, state);
      res.setHeader("set-cookie", cookie("state", "", 0));
      if (!flow || !state || state !== url.searchParams.get("state"))
        return redirect(res, "/?signin=expired");
      pending.delete(state);
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.has("error")) return redirect(res, "/?signin=cancelled");
      try {
        const token = await fetchImpl("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15000),
          redirect: "error",
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.secret,
            redirect_uri: callback,
            code,
            code_verifier: flow.verifier,
          }),
        });
        const access = token.ok && (await token.json()).access_token;
        if (typeof access !== "string" || !access) return redirect(res, "/?signin=failed");
        const profile = await fetchImpl("https://api.github.com/user", {
          headers: {
            Authorization: "Bearer " + access,
            Accept: "application/vnd.github+json",
            "User-Agent": "Folio-Notebook",
          },
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        });
        if (!profile.ok) return redirect(res, "/?signin=failed");
        const { id, login } = await profile.json();
        if (!Number.isSafeInteger(id) || String(id) !== config.ownerId)
          return redirect(res, "/?signin=denied");
        const key = nonce();
        sessions.delete(cookieValue(req, prefix + "session"));
        insert(sessions, key, { id: config.ownerId, login, expiresAt: now() + sessionSeconds * 1000 }, 256);
        res.setHeader("set-cookie", [cookie("state", "", 0), cookie("session", key, sessionSeconds)]);
        return redirect(res, flow.destination);
      } catch {
        return redirect(res, "/?signin=failed");
      }
    }
    if (req.method === "POST" && url.pathname === "/auth/logout") {
      if (req.headers.origin !== config.origin.origin) {
        res.writeHead(403).end();
        return;
      }
      sessions.delete(cookieValue(req, prefix + "session"));
      res.setHeader("set-cookie", [cookie("session", "", 0), cookie("state", "", 0)]);
      res.writeHead(204, { "Clear-Site-Data": '"cache", "storage"' }).end();
      return;
    }
    res.writeHead(404).end();
  }
  return { handle, session };
}
