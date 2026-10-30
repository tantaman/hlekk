// The demo's two surfaces: a page view, and an editor to author a query with.
//
// They are deliberately different things. The page view runs a fixed query we wrote; the editor runs
// one a stranger wrote, which docs/wikimedia-demo.md is explicit is a different exposure. Everything
// the editor offers comes from `/schema`, and every query it builds is priced by `/price` — the same
// code `/query` guards with — so the editor cannot offer a relation the catalog lacks or a query the
// server would refuse without saying why first.
//
// One self-contained document with no build step and no CDN: the Worker serves it as a string, so
// the demo has nothing to build and no asset host to depend on.
//
// One cost of that, stated rather than left to be discovered: `completionContext` below is a pure
// function of (text, caret) and is deliberately written to be testable, but it is not tested,
// because shipping the editor as one inline string leaves no module for a test to import. The
// grammar it completes against *is* tested, on the server, in wiki-query.test.ts -- and every name
// it offers is read from /schema at runtime rather than listed here, so the popup cannot drift out
// of step with the catalog. What is untested is the caret-context logic: which position offers
// what. Extracting these two functions into a module the UI inlines at build time is the fix, and
// it needs a build step this demo does not otherwise have.
//
// Attribution is not decoration. docs/wikimedia-import.md chose this dataset partly because
// mirroring is its intended use, under CC BY-SA 4.0 and GFDL, and records that a public mirror has
// to identify itself as a mirror of a dated dump. The footer is that identification.

export const WIKI_UI = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hlekk · Wikipedia mirror</title>
<style>
  :root {
    --bg: #fbfaf8; --fg: #1a1a18; --muted: #6b6a66; --line: #e2e0da;
    --card: #ffffff; --accent: #2d5f8a; --chip: #eef2f6; --chipfg: #2d5f8a;
    --ok: #2f6b45; --bad: #a8372c; --raised: #f4f2ee;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg: #16171a; --fg: #e8e6e1; --muted: #9a978f; --line: #2c2e33;
      --card: #1d1f23; --accent: #7fb3dd; --chip: #23303c; --chipfg: #9ccbec;
      --ok: #7fc39a; --bad: #e59489; --raised: #22242a;
    }
  }
  :root[data-theme="dark"] {
    --bg: #16171a; --fg: #e8e6e1; --muted: #9a978f; --line: #2c2e33;
    --card: #1d1f23; --accent: #7fb3dd; --chip: #23303c; --chipfg: #9ccbec;
    --ok: #7fc39a; --bad: #e59489; --raised: #22242a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 980px; margin: 0 auto; padding: 28px 16px 64px; }
  header h1 { font-size: 19px; margin: 0 0 2px; letter-spacing: -0.01em; }
  header p { margin: 0 0 18px; color: var(--muted); font-size: 13.5px; }
  nav { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 22px; }
  nav button {
    background: none; border: none; border-bottom: 2px solid transparent; color: var(--muted);
    padding: 9px 14px; font: inherit; font-weight: 550; cursor: pointer; border-radius: 0;
  }
  nav button[aria-selected=true] { color: var(--fg); border-bottom-color: var(--accent); }
  input, select, button, textarea {
    font: inherit; padding: 8px 11px; border: 1px solid var(--line);
    border-radius: 8px; background: var(--card); color: var(--fg);
  }
  .go { cursor: pointer; background: var(--accent); color: #fff; border-color: transparent; font-weight: 550; }
  .go:hover { filter: brightness(1.08); }
  .go[disabled] { opacity: 0.5; cursor: not-allowed; filter: none; }
  .ghost { cursor: pointer; background: var(--raised); font-size: 13px; padding: 5px 10px; }
  form.entry { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  form.entry input[type=search] { flex: 1 1 240px; min-width: 0; }
  .hint { color: var(--muted); font-size: 12.5px; margin: 0 0 22px; }
  .hint a { color: var(--accent); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .card h2 { margin: 0 0 4px; font-size: 22px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
  .sub code { font-family: var(--mono); font-size: 12px; }
  .counts { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 20px; }
  .count { border: 1px solid var(--line); border-radius: 10px; padding: 9px 13px; min-width: 100px; }
  .count b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; line-height: 1.2; }
  .count span { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }
  h3 { font-size: 12.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 10px; }
  h3 .n { text-transform: none; letter-spacing: 0; font-weight: 400; }
  ul.links { list-style: none; margin: 0 0 8px; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
  ul.links li a {
    display: inline-block; padding: 4px 10px; border: 1px solid var(--line);
    border-radius: 999px; color: var(--accent); text-decoration: none; font-size: 13.5px;
  }
  ul.links li a:hover { border-color: var(--accent); }
  .rel { margin-bottom: 20px; }
  .read { border-top: 1px solid var(--line); padding-top: 15px; }
  .read p { margin: 0 0 9px; font-size: 13.5px; }
  .read .big { font-variant-numeric: tabular-nums; font-weight: 600; }
  .hosts { display: flex; flex-wrap: wrap; gap: 5px; }
  .hosts span, code.id {
    font-family: var(--mono); font-size: 11.5px; padding: 3px 7px;
    background: var(--chip); color: var(--chipfg); border-radius: 6px;
  }
  /* ---- the editor: a highlighted pre behind a transparent-text textarea.
     The two layers must agree on every metric — same font block, same padding, same wrap rule, and
     the pre carries a transparent border where the textarea has a real one — or the caret drifts
     away from the glyph it is sitting on. */
  .qwrap { position: relative; background: var(--raised); border-radius: 9px; margin-bottom: 10px; }
  .qwrap .qedit, .qwrap .qhl {
    font-family: var(--mono); font-size: 13px; line-height: 1.6; padding: 12px 13px;
    border: 1px solid transparent; overflow-wrap: break-word; white-space: pre-wrap; margin: 0;
    tab-size: 2;
  }
  .qwrap .qedit {
    display: block; width: 100%; min-height: 150px; resize: vertical; position: relative; z-index: 1;
    background: transparent; color: transparent; caret-color: var(--fg);
    border-color: var(--line); border-radius: 9px;
  }
  .qwrap .qedit:focus { outline: none; border-color: var(--accent); }
  .qwrap.qbad .qedit { border-color: var(--bad); }
  .qwrap .qedit::selection { background: rgba(120, 170, 220, 0.3); }
  .qwrap .qhl { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
  .qhl i { font-style: normal; }
  .t-str { color: var(--ok); }
  .t-num { color: #b5761f; }
  .t-m { color: var(--accent); }
  .t-fn { color: var(--accent); font-weight: 600; }
  .t-edge { color: #8a5cc4; }
  .t-comment { color: var(--muted); font-style: italic; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) .t-num { color: #d9a85c; }
    :root:not([data-theme="light"]) .t-edge { color: #c3a0ea; }
  }
  :root[data-theme="dark"] .t-num { color: #d9a85c; }
  :root[data-theme="dark"] .t-edge { color: #c3a0ea; }
  /* The completion popup, hung under the caret's line; options wear the highlighter's colours, so
     an option looks like the token it becomes. */
  .qcomp {
    position: absolute; z-index: 20; min-width: 260px; max-height: 190px; overflow-y: auto;
    background: var(--card); border: 1px solid var(--line); border-radius: 8px;
    box-shadow: 0 8px 22px rgba(0,0,0,0.18); font-family: var(--mono); font-size: 12.5px;
  }
  .qcomp .qopt { display: flex; justify-content: space-between; gap: 14px; padding: 4px 10px; cursor: pointer; }
  .qcomp .qopt span { color: var(--muted); font-size: 10.5px; align-self: center; }
  .qcomp .qopt.sel, .qcomp .qopt:hover { background: var(--raised); }
  .qerr { color: var(--bad); font-family: var(--mono); font-size: 12.5px; margin: 0 0 10px; }
  .qbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .qbar .ex { font-family: var(--mono); font-size: 12px; }

  /* ---- the builder */
  .hop { border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 10px; background: var(--raised); }
  .hop .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
  .hop .row label { font-size: 12px; color: var(--muted); }
  .hop input.edge { flex: 1 1 200px; min-width: 0; font-family: var(--mono); font-size: 13px; }
  .hop input.alias { width: 120px; }
  .hop input.lim { width: 72px; }
  .hop input.val { width: 130px; }
  .hop .kids { margin: 8px 0 0 14px; padding-left: 12px; border-left: 2px solid var(--line); }
  .filters { margin-bottom: 8px; }
  .filter { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
  .filter input.field { width: 120px; font-family: var(--mono); font-size: 13px; }
  .filter select { width: 68px; }
  .cbs { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); align-items: center; }
  .cbs label { display: inline-flex; gap: 4px; align-items: center; cursor: pointer; }
  .cbs input { padding: 0; }
  .cost { display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; margin: 14px 0; font-size: 13.5px; }
  .cost b { font-variant-numeric: tabular-nums; }
  .cost .ok { color: var(--ok); }
  .cost .bad { color: var(--bad); }
  pre {
    background: var(--raised); border: 1px solid var(--line); border-radius: 10px;
    padding: 14px; overflow: auto; font-family: var(--mono); font-size: 12.5px; max-height: 60vh; margin: 0;
  }
  .err { color: var(--bad); }
  footer { color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); padding-top: 16px; margin-top: 32px; }
  footer a { color: var(--muted); }
  @media (max-width: 520px) { .count { flex: 1 1 calc(50% - 5px); min-width: 0; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>hlekk · a Wikipedia mirror across many Durable Objects</h1>
    <p>One database spread over host Durable Objects, entered by title and traversed. Every answer
       reports which hosts it was assembled from.</p>
  </header>

  <nav>
    <button id="tab-browse" aria-selected="true">Browse</button>
    <button id="tab-query" aria-selected="false">Query editor</button>
  </nav>

  <section id="pane-browse">
    <form class="entry" id="f">
      <input type="search" id="q" placeholder="Page title, e.g. Country" autocomplete="off" autofocus>
      <select id="ns" aria-label="Namespace"></select>
      <button class="go" type="submit">Look up</button>
    </form>
    <p class="hint">Entry is by exact <code>(namespace, title)</code> — a unique index. There is no
       scan and no prefix search, so there is nothing to suggest titles from.
       Try <a href="#" data-go="Country">Country</a>, <a href="#" data-go="Europe">Europe</a>,
       <a href="#" data-go="Earth">Earth</a> or <a href="#" data-go="Water">Water</a>.</p>
    <div id="out"></div>
  </section>

  <section id="pane-query" hidden>
    <p class="hint" style="margin-top:0">Write a query in hlekk's own builder chain. Edge and field
       names complete from <code>/schema</code>, so the popup cannot offer a name the engine would not
       resolve. <kbd>ctrl</kbd>+<kbd>space</kbd> opens it anywhere, <kbd>tab</kbd> accepts,
       <kbd>⌘</kbd>+<kbd>↩</kbd> runs. The cost below is the product of the limits down each path —
       the thing no storage budget can see — and the server refuses the same number it shows you.</p>

    <div class="qbar">
      <button class="go" id="run" type="button">Run ⌘↩</button>
      <select id="example" class="ex" aria-label="Load an example"></select>
    </div>

    <div class="qwrap" id="qwrap">
      <pre class="qhl" id="qhl" aria-hidden="true"></pre>
      <textarea class="qedit" id="qedit" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
      <div class="qcomp" id="qcomp" hidden></div>
    </div>

    <p class="qerr" id="qerr" hidden></p>
    <div class="cost" id="cost"></div>
    <div id="qout"></div>
  </section>

  <footer>
    Content from a <b>simplewiki</b> database dump, mirrored for a storage-engine demo. Text is
    available under <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a> and
    the <a href="https://www.gnu.org/licenses/fdl-1.3.html">GFDL</a>; see
    <a href="https://simple.wikipedia.org/">simple.wikipedia.org</a> for the live articles and their
    authors. A point-in-time mirror, not affiliated with the Wikimedia Foundation.
  </footer>
</div>


<script>
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
// Displayed with spaces, queried with underscores: the index key is the stored page_title.
const pretty = (t) => String(t).replace(/_/g, " ");
const stored = (t) => String(t).trim().replace(/ /g, "_");
const nf = (n) => Number(n).toLocaleString();

let SCHEMA = null;

// ---------------------------------------------------------------- tabs

const panes = { browse: document.getElementById("pane-browse"), query: document.getElementById("pane-query") };
const tabs = { browse: document.getElementById("tab-browse"), query: document.getElementById("tab-query") };
function tab(which) {
  for (const k of Object.keys(panes)) {
    panes[k].hidden = k !== which;
    tabs[k].setAttribute("aria-selected", String(k === which));
  }
}
tabs.browse.onclick = () => tab("browse");
tabs.query.onclick = () => tab("query");

// ---------------------------------------------------------------- browse

const out = document.getElementById("out");
const qbox = document.getElementById("q");
const nsbox = document.getElementById("ns");

const RELS = [
  { edge: "wiki.page_links", title: "Links from this page", count: "linkCount", key: "links" },
  { edge: "wiki.linked_from", title: "Pages linking here", count: "backlinkCount", key: null },
  { edge: "wiki.page_categories", title: "Categories", count: "categoryCount", key: "categories" },
  { edge: "wiki.category_pages", title: "Pages in this category", count: "memberCount", key: null },
];

async function show(title, ns) {
  if (!title) return;
  out.innerHTML = '<div class="card">Looking up ' + esc(pretty(title)) + '…</div>';
  let d;
  try {
    const res = await fetch("/page?ns=" + encodeURIComponent(ns) + "&title=" + encodeURIComponent(stored(title)) + "&limit=25");
    d = await res.json();
  } catch (e) {
    out.innerHTML = '<div class="card err">Request failed: ' + esc(e.message) + "</div>";
    return;
  }
  if (!d.found) {
    out.innerHTML = '<div class="card"><h2>Not found</h2><p class="sub">No page titled <b>'
      + esc(pretty(title)) + "</b> in namespace " + esc(ns)
      + ". Lookup is exact — there is no search index, only a unique (namespace, title) key.</p></div>";
    return;
  }
  const p = d.page, r = d.read;
  const count = (n, label) => '<div class="count"><b>' + nf(n) + "</b><span>" + label + "</span></div>";

  let html = '<div class="card">'
    + "<h2>" + esc(pretty(p.title)) + "</h2>"
    + '<p class="sub">namespace ' + esc(p.ns) + " · " + nf(p.len) + " bytes"
    + (p.redirect ? " · redirect" : "") + ' · <code class="id">' + esc(d.id) + "</code></p>"
    + '<div class="counts">'
      + count(p.linkCount, "links out") + count(p.backlinkCount, "links in")
      + count(p.categoryCount, "categories") + count(p.memberCount, "members")
    + "</div>";

  // Every relation, each paged on demand. A hub page here has thousands of backlinks, so the card
  // shows the first rows and reads the rest through /relation when asked.
  for (const rel of RELS) {
    const total = p[rel.count] || 0;
    if (total === 0) continue;
    const seeded = rel.key ? (p[rel.key] || []) : [];
    html += '<div class="rel" data-edge="' + rel.edge + '">'
      + "<h3>" + rel.title + ' <span class="n">— ' + nf(total) + " total</span></h3>"
      + '<ul class="links">' + seeded.map(linkLi).join("") + "</ul>"
      + '<button class="ghost more" data-edge="' + rel.edge + '" data-id="' + esc(d.id) + '">'
      + (seeded.length ? "show more" : "load " + nf(Math.min(total, 50))) + "</button>"
      + '<span class="shown" style="font-size:12px;color:var(--muted);margin-left:8px">'
      + (seeded.length ? nf(seeded.length) + " of " + nf(total) : "") + "</span>"
      + "</div>";
  }

  html += '<div class="read">'
    + '<p>Assembled from <span class="big">' + r.hosts.length + "</span> host"
    + (r.hosts.length === 1 ? "" : "s") + ' in <span class="big">' + r.requests
    + "</span> request" + (r.requests === 1 ? "" : "s") + ' over <span class="big">'
    + r.objects + '</span> objects — <span class="big">' + r.ms + "</span> ms, plus "
    + r.lookupMs + " ms to turn the title into an id. Counts come from maintained counters, so a page "
    + "with thousands of backlinks costs no more to count than one with three.</p>"
    + '<div class="hosts">' + r.hosts.map((h) => "<span>host " + h + "</span>").join("") + "</div>"
    + "</div></div>";

  out.innerHTML = html;
  history.replaceState(null, "", "?ns=" + encodeURIComponent(ns) + "&title=" + encodeURIComponent(stored(p.title)));
}

const linkLi = (i) => '<li><a href="#" data-go="' + esc(i.title) + '" data-ns="' + esc(i.ns) + '">'
  + esc(pretty(i.title)) + "</a></li>";

// "show more": read the next page of one relation, carrying the cursor the last page returned.
const cursors = new Map();
out.addEventListener("click", async (e) => {
  const btn = e.target.closest("button.more");
  if (!btn) return;
  const block = btn.closest(".rel");
  const list = block.querySelector("ul.links");
  const shown = block.querySelector(".shown");
  const edge = btn.dataset.edge;
  const key = btn.dataset.id + ":" + edge;
  btn.disabled = true;
  btn.textContent = "loading…";
  try {
    const after = cursors.get(key);
    const url = "/relation?id=" + encodeURIComponent(btn.dataset.id) + "&edge=" + encodeURIComponent(edge)
      + "&limit=50" + (after ? "&after=" + encodeURIComponent(after) : "");
    const page = await (await fetch(url)).json();
    if (page.error) throw new Error(page.error);
    list.insertAdjacentHTML("beforeend", page.items.map(linkLi).join(""));
    cursors.set(key, page.cursor);
    const have = list.querySelectorAll("li").length;
    shown.textContent = nf(have) + " loaded · last read touched " + page.read.hosts.length + " host(s) in "
      + page.read.requests + " request(s), " + page.read.ms + " ms";
    btn.disabled = !page.more;
    btn.textContent = page.more ? "show more" : "that is all";
  } catch (err) {
    shown.textContent = "failed: " + err.message;
    btn.disabled = false;
    btn.textContent = "retry";
  }
});

document.getElementById("f").addEventListener("submit", (e) => {
  e.preventDefault();
  show(qbox.value, nsbox.value);
});
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-go]");
  if (!a) return;
  e.preventDefault();
  const ns = a.dataset.ns !== undefined ? a.dataset.ns : nsbox.value;
  qbox.value = pretty(a.dataset.go);
  nsbox.value = ns;
  tab("browse");
  show(a.dataset.go, ns);
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// ---------------------------------------------------------------- the query editor
//
// The classic overlay: one tokenizer paints a 'pre' sitting behind a transparent-text textarea, so
// the glyphs the author types line up with the glyphs that get coloured. Completions come from a
// pure function of (text, caret) so the popup can be reasoned about without the DOM, and every name
// it offers is read off '/schema' rather than a word list.
//
// Nothing here evaluates the query. The text is parsed on the server into the same description the
// guard checks, which is what keeps a text box from being a wider surface than a form.

const METHODS = ["limit", "where", "countAs", "related"];
const KEYWORDS = new Set(["q", "page", "true", "false"]);
let EDGE_SHORT = [];
let FIELDS = [];

const TOKEN_RE = /\/\/[^\n]*|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|[A-Za-z_$][A-Za-z0-9_$]*|=>/g;

/** Tokenize the RAW text and escape per piece: escaping first would re-tokenize the entities, and
 *  the overlay needs output glyphs to match input glyphs one-for-one or the caret drifts. */
function highlight(code) {
  let out = "";
  let last = 0;
  for (const m of code.matchAll(TOKEN_RE)) {
    out += esc(code.slice(last, m.index));
    const tok = m[0];
    const cls =
      tok.startsWith("//") ? "t-comment"
      : tok.startsWith('"') ? "t-str"
      : /^-?\d/.test(tok) ? "t-num"
      : EDGE_SHORT.includes(tok) ? "t-edge"
      : KEYWORDS.has(tok) ? "t-fn"
      : code[m.index - 1] === "." && METHODS.includes(tok) ? "t-m"
      : "";
    out += cls ? '<i class="' + cls + '">' + esc(tok) + "</i>" : esc(tok);
    last = m.index + tok.length;
  }
  return out + esc(code.slice(last));
}

/**
 * What the text could say next at 'caret', or null when there is nothing useful to offer —
 * including "the prefix already is the only match", so accepting never rewrites nothing. 'force'
 * (ctrl+space) waives the typed-prefix gate, so the whole vocabulary is browsable anywhere.
 */
function completionContext(text, caret, force) {
  const before = text.slice(0, caret);
  const prefix = (/[A-Za-z_$][A-Za-z0-9_$]*$/.exec(before) || [""])[0];
  const head = before.slice(0, before.length - prefix.length);
  const options = optionsFor(head, prefix !== "" || force);
  if (!options) return null;
  // Match through a label's quotes, so a raw 'where(ti' still narrows to '"title"' — and accepting
  // repairs the quoting.
  const matched = options.filter((o) => o.label.replace(/"/g, "").startsWith(prefix));
  if (matched.length === 0 || (matched.length === 1 && matched[0].label === prefix)) return null;
  return { from: caret - prefix.length, options: matched };
}

const opt = (label, kind) => ({ label, kind });
const edgeOpts = () => EDGE_SHORT.map((e) => opt(e, "edge"));
const fieldOpts = (quoted) => FIELDS.map((f) => opt(quoted ? '"' + f.name + '"' : f.name, f.type));

function optionsFor(head, typing) {
  // Inside a string literal only the quoted-argument positions complete; anything else in quotes is
  // the author's own text, such as an alias or a page title.
  if ((head.match(/"/g) || []).length % 2 === 1) {
    if (/\.where\(\s*"[^"]*"\s*,\s*"$/.test(head)) return OPS.map((o) => opt(o, "operator"));
    if (/\.where\(\s*"$/.test(head)) return fieldOpts(false);
    return null;
  }
  if (head.endsWith(".")) {
    const recv = (/[A-Za-z_$][A-Za-z0-9_$]*$/.exec(head.slice(0, -1)) || [])[0];
    if (/\d$/.test(head.slice(0, -1))) return null; // '5.' is a number, not a chain
    if (recv === "q" || recv === ")") return METHODS.map((m) => opt(m, "method"));
    return METHODS.map((m) => opt(m, "method"));
  }
  // An open paren, or a comma inside one, is an unambiguous argument position: offer what that call
  // accepts, unprompted. This is how someone who does not know the vocabulary finds 'page_links'.
  const call = /\.(related|countAs)\(\s*((?:"[^"]*"\s*,\s*)?)$/.exec(head);
  if (call) {
    const [, fn, prior] = call;
    // Both take an alias first, then the edge. With no alias yet, offer one pre-quoted per edge.
    if (prior === "") return EDGE_SHORT.map((e) => opt('"' + e + '"', "alias"));
    return edgeOpts();
  }
  if (/\.where\(\s*$/.test(head)) return fieldOpts(true);
  if (/\.where\(\s*"[^"]*"\s*,\s*$/.test(head)) return OPS.map((o) => opt('"' + o + '"', "operator"));
  if (/,\s*$/.test(head) && /\.related\([^()]*$/.test(head)) return [opt("q => q", "lambda")];
  if (/^\s*$/.test(head)) return [opt('page(0, "Country")', "start here")];
  return typing ? [...METHODS.map((m) => opt(m, "method")), ...edgeOpts(), opt("page", "root"), opt("q", "lambda")] : null;
}

let OPS = ["=", "!=", "<", "<=", ">", ">="];

const EXAMPLES = {
  "A page card — the demo's own query": 'page(0, "Country")\n  .countAs("linkCount", page_links)\n  .countAs("backlinkCount", linked_from)\n  .related("links", page_links, q => q.limit(25))\n  .related("categories", page_categories, q => q.limit(25))',
  "Two hops — links, and who links to them": 'page(0, "Country")\n  .related("links", page_links, q => q\n    .limit(5)\n    .countAs("backlinkCount", linked_from)\n    .related("linkedFrom", linked_from, q => q.limit(3)))',
  "A filter — only long articles": 'page(0, "Country")\n  .related("longLinks", page_links, q => q\n    .limit(10)\n    .where("len", ">", 20000))',
  "Members of a category": 'page(14, "France_geography_stubs")\n  .countAs("memberCount", category_pages)\n  .related("members", category_pages, q => q.limit(20))',
  "Over budget on purpose — refused before any I/O": 'page(0, "Country")\n  .related("a", page_links, q => q.limit(100)\n    .related("b", page_links, q => q.limit(100)\n      .related("c", page_links, q => q.limit(100))))',
};

const wrap = document.getElementById("qwrap");
const ta = document.getElementById("qedit");
const hl = document.getElementById("qhl");
const box = document.getElementById("qcomp");
const costEl = document.getElementById("cost");
const errEl = document.getElementById("qerr");
const qout = document.getElementById("qout");
const runBtn = document.getElementById("run");

let opts = [];
let from = 0;
let sel = 0;

function paint() {
  // The trailing newline keeps a final empty line the same height the textarea gives it.
  hl.innerHTML = highlight(ta.value) + "\n";
  hl.scrollTop = ta.scrollTop;
}

const closeBox = () => {
  box.hidden = true;
  opts = [];
};

function renderBox() {
  box.innerHTML = opts
    .map((o, i) =>
      '<div class="qopt' + (i === sel ? " sel" : "") + '" data-i="' + i + '">' +
      '<i class="' + (o.label.startsWith('"') ? "t-str" : o.kind === "edge" ? "t-edge" : o.kind === "method" ? "t-m" : "t-fn") + '">' +
      esc(o.label) + "</i><span>" + esc(o.kind) + "</span></div>")
    .join("");
  box.hidden = false;
  // Hung under the caret's line: measure by mirroring the text up to the caret in a hidden span.
  const line = ta.value.slice(0, ta.selectionStart).split("\n").length;
  box.style.top = Math.min(line * 20.8 + 16, ta.clientHeight) + "px";
  box.style.left = "13px";
  const chosen = box.querySelector(".sel");
  if (chosen) chosen.scrollIntoView({ block: "nearest" });
}

function refresh(force) {
  const ctx = ta.selectionStart === ta.selectionEnd
    ? completionContext(ta.value, ta.selectionStart, force === true) : null;
  if (!ctx) return closeBox();
  opts = ctx.options;
  from = ctx.from;
  sel = 0;
  renderBox();
}

function accept(i) {
  const o = opts[i];
  if (!o) return;
  const caret = ta.selectionEnd;
  ta.setSelectionRange(from, caret);
  // execCommand keeps the native undo stack; setRangeText is the undo-breaking fallback.
  if (!document.execCommand("insertText", false, o.label)) ta.setRangeText(o.label, from, caret, "end");
  closeBox();
  paint();
  void reprice();
}

ta.addEventListener("input", () => {
  paint();
  refresh(false);
  void reprice();
});
ta.addEventListener("scroll", () => (hl.scrollTop = ta.scrollTop));
ta.addEventListener("blur", () => setTimeout(closeBox, 120));
ta.addEventListener("click", () => {
  if (!box.hidden) refresh(false);
});
ta.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === " ") {
    e.preventDefault();
    refresh(true);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    closeBox();
    void run();
    return;
  }
  if (box.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    sel = (sel + (e.key === "ArrowDown" ? 1 : opts.length - 1)) % opts.length;
    renderBox();
  } else if (e.key === "Tab") {
    e.preventDefault();
    accept(sel);
  } else if (e.key === "Enter") {
    e.preventDefault();
    accept(sel);
  } else if (e.key === "Escape") {
    e.stopPropagation();
    closeBox();
  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    closeBox();
  }
});
box.addEventListener("mousedown", (e) => {
  const o = e.target.closest(".qopt");
  if (!o) return;
  e.preventDefault(); // keep focus, and the blur-close, off until the accept lands
  accept(Number(o.dataset.i));
});

let pricing = 0;
async function reprice() {
  const mine = ++pricing;
  let priced;
  try {
    priced = await (await fetch("/price", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: ta.value }),
    })).json();
  } catch (e) {
    return;
  }
  if (mine !== pricing) return; // a later keystroke already asked
  if (priced.error) {
    wrap.classList.add("qbad");
    errEl.hidden = false;
    errEl.textContent = priced.error.replace(/^text: /, "") + (priced.offset !== undefined ? "  (at character " + priced.offset + ")" : "");
    costEl.innerHTML = "";
    runBtn.disabled = true;
    return;
  }
  wrap.classList.remove("qbad");
  errEl.hidden = true;
  const pct = ((priced.nodes / SCHEMA.limits.maxNodes) * 100).toFixed(1);
  costEl.innerHTML = '<span class="ok">parses, within budget</span>'
    + "<span>answer nodes: <b>" + nf(priced.nodes) + "</b> of " + nf(SCHEMA.limits.maxNodes) + " (" + pct + "%)</span>"
    + "<span>plan frames: <b>" + priced.frames + "</b> of " + SCHEMA.limits.maxFrames + "</span>";
  runBtn.disabled = false;
}

async function run() {
  qout.innerHTML = '<div class="card">Running…</div>';
  let d;
  try {
    const res = await fetch("/query", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: ta.value }),
    });
    d = await res.json();
  } catch (err) {
    qout.innerHTML = '<div class="card err">Request failed: ' + esc(err.message) + "</div>";
    return;
  }
  if (d.refused) {
    qout.innerHTML = '<div class="card"><h3>Refused</h3><p class="err" style="margin:0">'
      + esc(d.refused.replace(/^text: /, "")) + "</p>"
      + (d.offset !== undefined ? '<p class="sub" style="margin-top:8px">at character ' + d.offset + "</p>" : "")
      + "</div>";
    if (d.offset !== undefined) {
      ta.focus();
      ta.setSelectionRange(d.offset, d.offset);
    }
    return;
  }
  if (d.error) {
    qout.innerHTML = '<div class="card err">' + esc(d.name || "error") + ": " + esc(d.error) + "</div>";
    return;
  }
  const r = d.read;
  qout.innerHTML = '<div class="card">'
    + '<div class="read" style="border-top:none;padding-top:0">'
    + '<p>Assembled from <span class="big">' + r.hosts.length + "</span> host"
    + (r.hosts.length === 1 ? "" : "s") + ' in <span class="big">' + r.requests + "</span> request"
    + (r.requests === 1 ? "" : "s") + ' over <span class="big">' + r.objects + '</span> objects — <span class="big">'
    + r.ms + "</span> ms. Priced at " + nf(d.cost.nodes) + " answer nodes across " + d.cost.frames + " frames.</p>"
    + '<div class="hosts">' + r.hosts.map((h) => "<span>host " + h + "</span>").join("") + "</div></div>"
    + '<h3 style="margin-top:16px">Result</h3><pre>' + esc(JSON.stringify(d.rows, null, 2)) + "</pre></div>";
}

runBtn.addEventListener("click", () => void run());

const exSel = document.getElementById("example");
exSel.addEventListener("change", () => {
  ta.value = EXAMPLES[exSel.value];
  paint();
  void reprice();
  ta.focus();
});

// ---------------------------------------------------------------- start

(async () => {
  SCHEMA = await (await fetch("/schema")).json();
  const nsOptions = SCHEMA.entry.namespaces.map((n) =>
    '<option value="' + n.value + '">' + esc(n.label) + "</option>").join("");
  nsbox.innerHTML = nsOptions;
  // The editor's whole vocabulary, read off the schema so the popup cannot offer a name the engine
  // would not resolve — the one property of this editor worth stating.
  EDGE_SHORT = SCHEMA.edges.map((e) => e.name.replace(/^wiki\./, ""));
  FIELDS = SCHEMA.objects[0].fields.map((f) => ({ name: f.name, type: f.type + (f.optional ? "?" : "") }));
  OPS = SCHEMA.limits.ops;
  exSel.innerHTML = Object.keys(EXAMPLES).map((k) => '<option>' + esc(k) + "</option>").join("");
  ta.value = EXAMPLES[Object.keys(EXAMPLES)[0]];
  paint();
  void reprice();

  const params = new URLSearchParams(location.search);
  if (params.get("title")) {
    nsbox.value = params.get("ns") || "0";
    qbox.value = pretty(params.get("title"));
    show(params.get("title"), nsbox.value);
  }
})();
</script>
</body>
</html>
`;
