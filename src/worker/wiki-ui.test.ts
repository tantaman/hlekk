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

import { isOperatorPath } from "./guard.ts";
import { OG_CARD, OG_CARD_ETAG, OG_CARD_HEIGHT, OG_CARD_WIDTH } from "./wiki-og.ts";
import { WIKI_UI, wikiUi } from "./wiki-ui.ts";
import { storedTitle } from "./wiki.ts";

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

  it("seeds the cursor the card was given before the first show-more can run", () => {
    // The server half of this is tested in wiki-app.test.ts: the card hands back a cursor. The
    // client half is that the card writes it into the map the button reads, and that the button is
    // not drawn when the card says the list is already whole. Miss either and "20 total" shows 40
    // chips, each one twice.
    assert.match(scripts[0]!, /cursors\.set\(d\.id \+ ":" \+ rel\.edge, seed\.cursor\)/);
    assert.match(scripts[0]!, /const more = seed \? seed\.more : true/);
    // The map has to exist before show() runs, not merely before the click handler.
    assert.ok(
      scripts[0]!.indexOf("const cursors = new Map()") < scripts[0]!.indexOf("cursors.set(d.id"),
      "cursors is declared after the card that seeds it",
    );
  });

  it("renders the answer as a tree without knowing what a page is", () => {
    // The point of the tree view is that it works on whatever a query returns, so the thing worth
    // asserting is the absence of a wiki vocabulary in it: a renderer that reached for p.title or
    // "links" would draw this demo's own queries and nothing an author writes.
    assert.match(scripts[0]!, /function treeOf\(rows\)/);
    assert.match(scripts[0]!, /function treeNode\(o, depth\)/);
    assert.match(scripts[0]!, /function treeGroup\(name, arr, depth\)/);
    const tree = scripts[0]!
      .slice(scripts[0]!.indexOf("const isScalar"), scripts[0]!.indexOf("async function run()"))
      // Comments out: the section explains itself using this demo's own queries as the example, and
      // prose naming "categories" is not the renderer reaching for a field called categories.
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ");
    for (const wiki of ["page_links", "linkCount", "wiki.", "categories", "page_categories"]) {
      assert.ok(!tree.includes(wiki), "the tree renderer should not know about " + wiki);
    }
    // Both views are built, and the toggle reads the same names it writes.
    assert.match(scripts[0]!, /id="rtree"/);
    assert.match(scripts[0]!, /id="rjson"/);
    assert.match(scripts[0]!, /RESULT_VIEW = btn\.dataset\.view/);
  });

  it("normalizes a typed title exactly as the server does", () => {
    // Two normalizers for one rule is what broke the query editor: the browse pane turned spaces
    // into underscores in the browser and the editor sent what was typed to an exact-key lookup, so
    // page("Computer Science") missed a page the card beside it renders. The server now normalizes
    // at the lookup, which only helps while this copy keeps saying the same thing -- it still exists
    // because the address bar should carry the stored spelling.
    const src = scripts[0]!.match(/const stored = \(t\) => \{[\s\S]*?\n\};/);
    assert.ok(src, "the browse pane should still normalize before it builds a URL");
    const ctx = vm.createContext({});
    vm.runInContext(src![0] + "\nglobalThis.normalize = stored;", ctx);
    for (const typed of [
      "Computer science", "computer science", "Computer_science", "  North Korea  ",
      "NASA", "éclair", "a", "",
    ]) {
      assert.equal(ctx.normalize(typed), storedTitle(typed), JSON.stringify(typed));
    }
  });

  it("serves the cluster grid the page card depends on", () => {
    // The card calls clusterGrid(); if it were renamed on one side only, the page would throw at
    // render time and the test suite would otherwise never know.
    assert.match(scripts[0]!, /function clusterGrid\(/);
    assert.match(scripts[0]!, /clusterGrid\(r\.hosts\)/);
  });

  it("asks for nothing a visitor may not have", () => {
    // The page read its host roster from /admin/where, which is why that route could not simply be
    // closed. Every path the script names has to be one the Worker answers without a token, or the
    // page degrades for everyone and nothing here would say so.
    const asked = [...scripts[0]!.matchAll(/fetch\(\s*["']([^"'?]+)/g)].map((m) => m[1]!);
    assert.ok(asked.includes("/cluster"), "the roster comes from /cluster");
    assert.ok(asked.length >= 4, `found ${asked.length} fetches; the pattern has stopped matching`);
    assert.deepEqual(asked.filter(isOperatorPath), []);
    assert.doesNotMatch(scripts[0]!, /["'\/]admin\/|["'\/]ingest\//, "no operator path is built by concatenation either");
  });
});

describe("the social card", () => {
  const page = wikiUi("https://wiki.example.com");
  const content = (prop: string): string | null => {
    const m = page.match(new RegExp('<meta (?:property|name)="' + prop + '" content="([^"]*)"'));
    return m === null ? null : m[1]!;
  };

  it("fills the origin in everywhere, so nothing ships a literal placeholder", () => {
    // A crawler given "{{origin}}/og.png" fetches nothing and the card is simply absent -- a
    // failure that is invisible until someone shares the link, which is the wrong time to find it.
    assert.ok(WIKI_UI.includes("{{origin}}"), "the template should carry the placeholder");
    assert.equal(page.includes("{{origin}}"), false);
  });

  it("points at this origin's own image and page, absolutely", () => {
    // Three deployments serve this one document. Relative URLs are not allowed here by the
    // protocol, and a hardcoded host would make a card shared from one of them advertise another.
    assert.equal(content("og:image"), "https://wiki.example.com/og.png");
    assert.equal(content("og:url"), "https://wiki.example.com/");
    assert.match(page, /<link rel="canonical" href="https:\/\/wiki\.example\.com\/">/);
  });

  it("declares the image the dimensions the bundled card actually has", () => {
    // These are three separate numbers that have to agree: the card is rendered at one size, the
    // module records what was rendered, and the meta tags tell a crawler what to expect. A re-render
    // at a different size silently breaks the layout of every preview until they are reconciled.
    assert.equal(content("og:image:width"), String(OG_CARD_WIDTH));
    assert.equal(content("og:image:height"), String(OG_CARD_HEIGHT));
    assert.equal(content("twitter:card"), "summary_large_image");
    assert.ok((content("og:image:alt") ?? "").length > 20, "the card needs alt text");
  });

  it("carries a PNG of that size in the bundle", () => {
    // The module is generated, so this is checking the generator's output rather than a hand edit:
    // that the bytes are a PNG at all, and that its IHDR says what the meta tags claim.
    const png = OG_CARD;
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const be = (at: number) => (png[at]! << 24) + (png[at + 1]! << 16) + (png[at + 2]! << 8) + png[at + 3]!;
    assert.equal(be(16), OG_CARD_WIDTH);
    assert.equal(be(20), OG_CARD_HEIGHT);
    assert.match(OG_CARD_ETAG, /^"[0-9a-f]{16}"$/);
  });
});
