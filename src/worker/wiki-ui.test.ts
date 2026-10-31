// The editor and the page view ship as one inline string with no build step, which wiki-ui.ts says
// in its own header leaves no module for a test to import. That is true of the *logic* -- what the
// completion popup offers at a caret is still untested, and still says so there.
//
// It is not true of the syntax. The script block can be handed to a parser without running it, and
// at ~500 lines of string-concatenated JS inside a String.raw template that is worth doing: a stray
// backtick or an unbalanced paren is otherwise found by loading the page, and only if someone loads
// it. The template is String.raw, so `${...}` inside the script would be interpolated away by the
// outer literal rather than reaching the browser -- which is why the script concatenates strings
// instead of interpolating, and why a check that the emitted text parses is checking something real.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";

import { WIKI_UI } from "./wiki-ui.ts";

const scripts = [...WIKI_UI.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

describe("the inline UI", () => {
  it("has a script block", () => {
    assert.equal(scripts.length, 1);
    assert.ok(scripts[0]!.length > 1000, "the script should not be empty");
  });

  it("parses as JavaScript", () => {
    // Compiling runs nothing: it only has to be syntactically valid.
    assert.doesNotThrow(() => new vm.Script(scripts[0]!, { filename: "wiki-ui.inline.js" }));
  });

  it("carries no template interpolation the outer String.raw would have eaten", () => {
    // `${` inside the raw literal is interpolated by the *outer* template, so it cannot survive to
    // the browser. Finding one here means a helper was written with a template literal by habit.
    const hit = scripts[0]!.indexOf("${");
    assert.equal(hit, -1, hit === -1 ? "" : `template interpolation near: ${scripts[0]!.slice(Math.max(0, hit - 60), hit + 60)}`);
  });

  it("serves the placement comparison, with a roster for each side", () => {
    // The A/B passes each database's own roster to the grid; without the second argument both sides
    // would be shaded against the primary and a host holding control data would draw as empty.
    assert.match(scripts[0]!, /function clusterGrid\(serving, roster\)/);
    assert.match(scripts[0]!, /clusterGrid\(r\.hosts, roster\)/);
    assert.match(scripts[0]!, /placement=b/);
    assert.match(scripts[0]!, /async function compare\(/);
    // Three sides, not two: the control is the denominator and the other two are what it is
    // quoting. A pane that read only two would be comparing two guesses against each other.
    assert.match(scripts[0]!, /placement=" \+ which|placement=c/);
    assert.match(scripts[0]!, /is-three/);
    assert.match(scripts[0]!, /let CLUSTER_C = null/);
  });

  it("reads the comparison at a limit the whole link set fits inside", () => {
    // A truncated read returns the smallest-id targets, and init lands a contiguous id band on a
    // contiguous host band -- so limit=25 made the comparison partly a measurement of the id
    // layout. The pane says so when a page does not fit even this.
    assert.match(scripts[0]!, /&limit=100/);
    assert.doesNotMatch(scripts[0]!, /placement=b"\) \+ "&limit=25/);
  });

  it("gives the placement tab a pane to show", () => {
    for (const id of ["tab-ab", "pane-ab", "abouts", "abq", "abns", "abf"]) {
      assert.ok(WIKI_UI.includes('id="' + id + '"'), "missing #" + id);
    }
  });

  it("serves the cluster grid the page card depends on", () => {
    // The card calls clusterGrid(); if it were renamed on one side only, the page would throw at
    // render time and the test suite would otherwise never know.
    assert.match(scripts[0]!, /function clusterGrid\(/);
    assert.match(scripts[0]!, /clusterGrid\(r\.hosts\)/);
  });
});
