// How the wiki Worker decides that a request is not its to answer.
//
// The demo's claim is a comparison between three placements, and a placement is a property of a
// whole database: one deployment holds exactly one. So `?placement=b` and `?placement=c` are
// forwards, not lookups, and the things worth testing are that only those two values forward, that
// each names its own binding, and that the parameter does not survive the trip -- the other
// deployments run this same code, so a forward that kept it would ask to be forwarded again, and
// the loop would be a Worker calling itself until it ran out.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { altTarget, wipeTarget } from "./wiki-app.ts";
import type { Env } from "../do/bindings.ts";

const at = (query: string) => altTarget(new URL("https://wiki.example.com/page" + query));

describe("altTarget", () => {
  it("forwards the control placement", () => {
    const alt = at("?ns=0&title=Country&placement=b");
    assert.ok(alt !== null);
    assert.equal(alt.to.pathname, "/page");
    assert.equal(alt.which, "b");
  });

  it("forwards the graph placement to its own binding", () => {
    // Which binding, not just that it forwards: the control and the placement under test are not
    // interchangeable, and sending one to the other would quote a ratio of a database against
    // itself.
    const alt = at("?ns=0&title=Country&placement=c");
    assert.ok(alt !== null);
    assert.equal(alt.to.pathname, "/page");
    assert.equal(alt.which, "c");
  });

  it("strips the parameter, so the forward cannot bounce back", () => {
    for (const which of ["b", "c"]) {
      const alt = at("?title=Country&placement=" + which);
      assert.ok(alt !== null);
      assert.equal(alt.to.searchParams.get("placement"), null);
      assert.equal(altTarget(alt.to), null, "the forwarded URL must be one the other side answers itself");
    }
  });

  it("carries everything else across unchanged", () => {
    const alt = at("?ns=14&title=Cancer_deaths_in_Canada&limit=25&placement=b&driver=rounds");
    assert.ok(alt !== null);
    assert.equal(alt.to.searchParams.get("ns"), "14");
    assert.equal(alt.to.searchParams.get("title"), "Cancer_deaths_in_Canada");
    assert.equal(alt.to.searchParams.get("limit"), "25");
    assert.equal(alt.to.searchParams.get("driver"), "rounds");
  });

  it("answers everything else itself", () => {
    // Including the names an earlier design accepted as aliases. One spelling per placement, so
    // there is one answer to "did this request go to another database".
    for (const q of ["", "?placement=a", "?placement=alt", "?placement=hash", "?placement=", "?placement=B", "?placement=C", "?placement=graph", "?placement=d"]) {
      assert.equal(at(q), null, q === "" ? "(no parameter)" : q);
    }
  });
});

// Erasing a database is the one irreversible thing this Worker can do, and the only way to reclaim a
// Durable Object's storage -- so the guard in front of it is worth more tests than the operation.
// Two independent facts have to agree: the deployment names a victim in configuration, and the
// request names the same one. Neither alone does anything.
describe("wipeTarget", () => {
  const armed = { HLEKK_WIPE: "wiki-pilot2" } as unknown as Env;
  const url = (q: string) => new URL("https://wiki.example.com/admin/wipe" + q);

  it("wipes the armed database when the request names it", () => {
    assert.equal(wipeTarget(armed, url("?database=wiki-pilot2")), "wiki-pilot2");
  });

  it("arms several databases from one list, since abandoned ones accumulate", () => {
    const many = { HLEKK_WIPE: "wiki, wiki-pilot ,wiki-pilot2" } as unknown as Env;
    for (const name of ["wiki", "wiki-pilot", "wiki-pilot2"]) {
      assert.equal(wipeTarget(many, url("?database=" + name)), name, name);
    }
    // And nothing beyond the list, including the live database and a prefix of a listed name.
    for (const name of ["wiki-simple-cat", "wiki-pilot3", "wiki-", "pilot"]) {
      assert.equal(wipeTarget(many, url("?database=" + name)), null, name);
    }
  });

  it("refuses when nothing is armed, which is the committed state", () => {
    for (const env of [{}, { HLEKK_WIPE: "" }, { HLEKK_DATABASE: "wiki-simple-cat" }]) {
      assert.equal(wipeTarget(env as unknown as Env, url("?database=wiki-simple-cat")), null);
      assert.equal(wipeTarget(env as unknown as Env, url("?database=wiki-pilot2")), null);
    }
  });

  it("refuses a request that names any other database", () => {
    // Including the live one, a near-miss, and the shapes that would reach another tenant's objects
    // if the name were ever taken from the request rather than merely matched against it.
    for (const asked of [
      "wiki-simple-cat", "wiki-pilot", "wiki-pilot2 ", "WIKI-PILOT2", "", "demo",
      "../wiki-simple-cat", "wiki-pilot2/h-0", "*",
    ]) {
      assert.equal(wipeTarget(armed, url("?database=" + encodeURIComponent(asked))), null, asked);
    }
  });

  it("refuses a request that names nothing at all", () => {
    assert.equal(wipeTarget(armed, url("")), null);
    assert.equal(wipeTarget(armed, url("?confirm=wiki-pilot2")), null);
  });
});
