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

  it("gives every tab a pane to show, and nothing else", () => {
    // The panes and tabs maps are keyed in lockstep and tab() walks one to set the other, so a
    // button without a section -- or a section left behind by a removed tab -- throws on the first
    // click. The placement A/B was removed; this is what keeps a stray reference to it from
    // reaching the browser.
    for (const id of ["tab-browse", "pane-browse", "tab-query", "pane-query"]) {
      assert.ok(WIKI_UI.includes('id="' + id + '"'), "missing #" + id);
    }
    assert.doesNotMatch(WIKI_UI, /placement/);
    assert.doesNotMatch(WIKI_UI, /pane-ab|tab-ab/);
  });

  it("enters at articles only, in one argument", () => {
    // The namespace picker is gone, so the entry form has nothing to read a namespace from and the
    // editor should not be teaching a first argument the form no longer has. show() keeps its ns
    // parameter regardless: a category chip is ns 14 and carries its own data-ns, which is the one
    // way a non-article card is still reachable.
    assert.doesNotMatch(WIKI_UI, /id="ns"/);
    assert.doesNotMatch(scripts[0]!, /page\(0, /);
    assert.match(scripts[0]!, /data-ns="/);
  });

  it("serves the cluster grid the page card depends on", () => {
    // The card calls clusterGrid(); if it were renamed on one side only, the page would throw at
    // render time and the test suite would otherwise never know.
    assert.match(scripts[0]!, /function clusterGrid\(/);
    assert.match(scripts[0]!, /clusterGrid\(r\.hosts\)/);
  });
});
