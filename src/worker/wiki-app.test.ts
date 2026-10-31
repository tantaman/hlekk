// How the wiki Worker decides that a request is not its to answer.
//
// The demo's claim is a comparison between two placements, and a placement is a property of a whole
// database: one deployment holds exactly one. So `?placement=b` is a forward, not a lookup, and the
// two things worth testing are that only that one value forwards, and that the parameter does not
// survive the trip -- the control deployment runs this same code, so a forward that kept it would
// ask to be forwarded again, and the loop would be a Worker calling itself until it ran out.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { altTarget } from "./wiki-app.ts";

const at = (query: string) => altTarget(new URL("https://wiki.example.com/page" + query));

describe("altTarget", () => {
  it("forwards the control placement", () => {
    const to = at("?ns=0&title=Country&placement=b");
    assert.ok(to !== null);
    assert.equal(to.pathname, "/page");
  });

  it("strips the parameter, so the forward cannot bounce back", () => {
    const to = at("?title=Country&placement=b");
    assert.ok(to !== null);
    assert.equal(to.searchParams.get("placement"), null);
    assert.equal(altTarget(to), null, "the forwarded URL must be one the other side answers itself");
  });

  it("carries everything else across unchanged", () => {
    const to = at("?ns=14&title=Cancer_deaths_in_Canada&limit=25&placement=b&driver=rounds");
    assert.ok(to !== null);
    assert.equal(to.searchParams.get("ns"), "14");
    assert.equal(to.searchParams.get("title"), "Cancer_deaths_in_Canada");
    assert.equal(to.searchParams.get("limit"), "25");
    assert.equal(to.searchParams.get("driver"), "rounds");
  });

  it("answers everything else itself", () => {
    // Including the names an earlier design accepted as aliases. One spelling, so there is one
    // answer to "did this request go to the other database".
    for (const q of ["", "?placement=a", "?placement=alt", "?placement=hash", "?placement=", "?placement=B"]) {
      assert.equal(at(q), null, q === "" ? "(no parameter)" : q);
    }
  });
});
