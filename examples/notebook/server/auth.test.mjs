import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { allowedHost, authConfig, githubAuth } from "./auth.mjs";

const env = {
  GITHUB_CLIENT_ID: "test-client",
  GITHUB_CLIENT_SECRET: "test-secret",
  GITHUB_OWNER_ID: "42",
  PUBLIC_ORIGIN: "https://notes.example.test",
};
const config = authConfig(env, false);

test("hosted notebooks require complete credentials, an owner and a canonical HTTPS origin", () => {
  assert.equal(authConfig({}, true), null);
  assert.throws(() => authConfig({}, false), /GitHub sign-in requires/);
  assert.throws(() => authConfig({ GITHUB_CLIENT_ID: "test" }, true), /GitHub sign-in requires/);
  assert.throws(() => authConfig(env, true), /production build/);
  assert.throws(() => authConfig({ ...env, GITHUB_OWNER_ID: "alice" }, false), /numeric/);
  for (const origin of [
    "http://notes.example.test",
    "https://notes.example.test/path",
    "https://user@notes.example.test",
  ])
    assert.throws(() => authConfig({ ...env, PUBLIC_ORIGIN: origin }, false), /PUBLIC_ORIGIN/);
  assert.equal(allowedHost({ headers: { host: "notes.example.test" } }, config), true);
  assert.equal(
    allowedHost({ headers: { host: "localhost", "x-forwarded-host": "notes.example.test" } }, config),
    false,
  );
  assert.equal(allowedHost({ headers: { host: "localhost:5173" } }, null), true);
  assert.equal(
    allowedHost({ headers: { host: "localhost", forwarded: "host=notes.example.test" } }, null),
    false,
  );
});

function response() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    writeHead(status, headers) {
      this.status = status;
      Object.assign(this.headers, headers);
      return this;
    },
    end() {},
  };
}

function flow() {
  const requests = [];
  let time = Date.now();
  let profile = { id: 42, login: "owner" };
  const auth = githubAuth(config, {
    now: () => time,
    fetchImpl: async (url, options) => {
      requests.push({ url, ...options });
      if (url === "https://github.com/login/oauth/access_token")
        return Response.json({ access_token: "github-access" });
      assert.equal(url, "https://api.github.com/user");
      assert.equal(options.headers.Authorization, "Bearer github-access");
      return Response.json(profile);
    },
  });
  async function visit(path, cookie, method = "GET", origin = env.PUBLIC_ORIGIN) {
    const res = response();
    await auth.handle({ headers: { cookie, origin }, method }, res, new URL(path, config.origin));
    return res;
  }
  async function start() {
    const res = await visit("/auth/github?node=17&return=https://other.example");
    assert.equal(res.status, 303);
    const authorize = new URL(res.headers.location);
    assert.equal(authorize.origin + authorize.pathname, "https://github.com/login/oauth/authorize");
    const params = authorize.searchParams;
    assert.equal(params.get("scope"), "");
    assert.equal(params.get("redirect_uri"), env.PUBLIC_ORIGIN + "/auth/github/callback");
    assert.equal(params.get("code_challenge_method"), "S256");
    const cookie = res.headers["set-cookie"].split(";")[0];
    return { params, cookie, path: "/auth/github/callback?code=one&state=" + params.get("state") };
  }
  return {
    auth,
    requests,
    visit,
    start,
    advance: (ms) => {
      time += ms;
    },
    profile: (next) => {
      profile = next;
    },
  };
}

test("the owner gets a revocable private session and returns to the bookmarked document", async () => {
  const f = flow();
  const { params, cookie, path } = await f.start();
  const result = await f.visit(path, cookie);
  assert.equal(result.headers.location, "/?node=17");
  const exchange = f.requests[0].body;
  assert.equal(exchange.get("redirect_uri"), params.get("redirect_uri"));
  assert.equal(exchange.get("client_secret"), env.GITHUB_CLIENT_SECRET);
  assert.equal(
    createHash("sha256").update(exchange.get("code_verifier")).digest("base64url"),
    params.get("code_challenge"),
  );
  const signed = result.headers["set-cookie"][1];
  for (const attr of ["__Host-folio-session=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/"])
    assert.ok(signed.includes(attr));
  assert.ok(!signed.includes("github-access"));
  const sessionCookie = signed.split(";")[0];
  const browser = { headers: { cookie: sessionCookie } };
  assert.equal(f.auth.session(browser).login, "owner");
  assert.equal((await f.visit(path, cookie)).headers.location, "/?signin=expired");
  assert.equal((await f.visit("/auth/logout", sessionCookie, "POST", "https://other.example")).status, 403);
  assert.equal(f.auth.session(browser).id, "42");
  assert.equal((await f.visit("/auth/logout", sessionCookie, "POST")).status, 204);
  assert.equal(f.auth.session(browser), undefined);
});

test("expired or unbound flows and a different GitHub ID cannot open the notebook", async () => {
  const f = flow();
  const { cookie, path } = await f.start();
  assert.equal((await f.visit(path)).headers.location, "/?signin=expired");
  assert.equal((await f.visit(path + "mismatch", cookie)).headers.location, "/?signin=expired");
  f.advance(600001);
  assert.equal((await f.visit(path, cookie)).headers.location, "/?signin=expired");
  assert.equal(f.requests.length, 0);
  const next = await f.start();
  f.profile({ id: 43, login: "owner" });
  const denied = await f.visit(next.path, next.cookie);
  assert.equal(denied.headers.location, "/?signin=denied");
  assert.doesNotMatch(denied.headers["set-cookie"], /folio-session=/);
  const retry = await f.start();
  f.profile({ id: 42, login: "new-handle" });
  const accepted = await f.visit(retry.path, retry.cookie);
  const browser = { headers: { cookie: accepted.headers["set-cookie"][1].split(";")[0] } };
  assert.equal(f.auth.session(browser).login, "new-handle");
  f.advance(7 * 86400 * 1000);
  assert.equal(f.auth.session(browser), undefined);
});
