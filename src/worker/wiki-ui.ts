// The demo's two surfaces: a page view, and an editor to author a query with.
//
// They are deliberately different things. The page view runs a fixed query we wrote; the editor runs
// one a stranger wrote, which docs/wikimedia-demo.md is explicit is a different exposure. Everything
// the editor offers comes from /schema, and every query it builds is priced by /price -- the same
// code /query guards with -- so the editor cannot offer a relation the catalog lacks or a query the
// server would refuse without saying why first.
//
// THE LOOK is Rindle Cloud's, taken from its own source rather than approximated from the rendered
// page: /Users/mlaw/workspace/rindle/main/headwaters/src/storefront/ui.ts. Same tokens, same
// dot-grid paper, same sticky header and brand mark, the same hw- class names, and the same five
// code-token colours. Two things follow from borrowing a design wholesale. It is light-only, as that
// one is -- there is no prefers-color-scheme here, because inventing a dark half of someone else's
// system is not using their aesthetic. And the editor is painted on that design's dark .hw-code
// surface, which is the one place a warm-paper page already goes dark, so a query reads as the code
// block it is.
//
// One self-contained document, served by the Worker as a string. The fonts are the exception, and a
// deliberate one: Hanken Grotesk and DM Mono come from Google Fonts, as they do on Rindle Cloud,
// because the typography is most of the aesthetic. The stacks fall back to system sans and mono, so
// the page still reads if they never load -- it just stops looking like the thing it was asked to
// look like.
//
// One cost of shipping as an inline string, stated rather than left to be discovered:
// completionContext below is a pure function of (text, caret) and is deliberately written to be
// testable, but it is not tested, because there is no module for a test to import. The grammar it
// completes against IS tested, on the server, in wiki-query.test.ts -- and every name it offers is
// read from /schema at runtime rather than listed here, so the popup cannot drift out of step with
// the catalog. What is untested is the caret-context logic: which position offers what.
//
// Attribution is not decoration. docs/wikimedia-import.md chose this dataset partly because
// mirroring is its intended use, under CC BY-SA 4.0 and GFDL, and records that a public mirror has
// to identify itself as a mirror of a dated dump. The footer is that identification.

export const WIKI_UI = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hlekk — a Wikipedia mirror across many Durable Objects</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@300;400;500;600;700;800&family=DM+Mono:ital,wght@0,300;0,400;0,500;1,400&display=swap">
<style>
:root{
  --paper:#f2eee7;--panel:#fcfaf5;--white:#fff;
  --ink:#171411;--ink-d:#5f564b;--ink-f:#746a5d;
  --line:#d8cebc;--line2:#c7baa3;--dot:#d8d0bd;
  --orange:#ff4d00;--cobalt:#2a4ddb;--teal:#04756b;
  --font-sans:'Hanken Grotesk',sans-serif;--font-mono:'DM Mono',ui-monospace,monospace;
  --code-bg:#17140f;--code-edge:#2a251d;--code-fg:#e9e2d2;
}
*{box-sizing:border-box}
html,body{min-height:100%}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--font-sans);
  -webkit-font-smoothing:antialiased;
  background-image:radial-gradient(var(--dot) .9px,transparent .9px);background-size:26px 26px}
.hw-wrap{max-width:1040px;margin:0 auto;padding:0 clamp(18px,4vw,48px)}

.hw-header{position:sticky;top:0;z-index:50;background:color-mix(in srgb,var(--paper) 86%,transparent);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.hw-header .hw-wrap{display:flex;align-items:center;justify-content:space-between;gap:20px;padding-top:13px;padding-bottom:13px}
.hw-brand{display:inline-flex;align-items:center;gap:10px;text-decoration:none;color:var(--ink)}
.hw-mark{width:18px;height:18px;border-radius:5px;border:1.5px solid var(--ink);position:relative;flex:none}
.hw-mark::after{content:"";position:absolute;right:-3px;bottom:-3px;width:6px;height:6px;border-radius:50%;background:var(--orange)}
.hw-name{font-family:var(--font-mono);font-size:15px;font-weight:500;letter-spacing:-.01em}
.hw-name b{font-weight:500;color:var(--ink-f)}
.hw-nav{display:flex;align-items:center;gap:clamp(12px,2vw,22px);font-family:var(--font-mono)}
.hw-nav button{display:inline-flex;align-items:center;line-height:1;font-size:12px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--ink-d);background:none;border:0;padding:0;cursor:pointer;font-family:inherit}
.hw-nav button:hover{color:var(--ink)}
.hw-nav button[aria-selected=true]{color:var(--orange)}

main.hw-wrap{padding-bottom:6vh}
.hw-hero{padding-top:5vh;padding-bottom:2.4vh}
.hw-ey{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:var(--orange);margin:0 0 18px}
.hw-h1{font-weight:800;font-size:clamp(28px,4.4vw,48px);line-height:1.03;letter-spacing:-.02em;margin:0 0 20px;max-width:22ch}
.hw-lead{font-size:clamp(15px,1.6vw,18px);line-height:1.6;color:var(--ink-d);max-width:62ch;margin:0}
.hw-sh{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-f);margin:3.4vh 0 16px}
.hw-panel{background:var(--panel);border:1px solid var(--line2);border-radius:18px;padding:clamp(20px,3vw,30px);
  box-shadow:0 30px 70px -56px rgba(40,30,10,.5)}

.hw-entry{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:2.4vh 0 10px}
.hw-input{font-family:var(--font-sans);font-size:15px;padding:11px 13px;
  border:1px solid var(--line2);border-radius:10px;background:var(--white);color:var(--ink)}
.hw-input:focus{outline:none;border-color:var(--ink)}
.hw-entry .hw-input[type=search]{flex:1 1 240px;min-width:0}
select.hw-input{font-family:var(--font-mono);font-size:13px}
.hw-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;font-family:var(--font-mono);
  font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#1a0f06;font-weight:600;background:var(--orange);
  padding:13px 22px;border-radius:10px;border:0;text-decoration:none;cursor:pointer}
.hw-btn:hover{box-shadow:0 12px 30px -14px color-mix(in srgb,var(--orange) 70%,transparent)}
.hw-btn[disabled]{opacity:.45;cursor:not-allowed;box-shadow:none}
.hw-mini{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;
  color:var(--ink-d);background:var(--panel);border:1px solid var(--line2);border-radius:8px;
  padding:6px 10px;cursor:pointer}
.hw-mini:hover{border-color:var(--ink);color:var(--ink)}
.hw-mini[disabled]{opacity:.5;cursor:default}
.hw-note{font-size:13.5px;line-height:1.55;color:var(--ink-d);margin:0}
.hw-note code,.hw-note kbd{font-family:var(--font-mono);font-size:12.5px}
.hw-note kbd{border:1px solid var(--line2);border-radius:5px;padding:1px 5px;background:var(--white)}
.hw-note a{color:var(--cobalt);text-decoration:none}
.hw-err{background:color-mix(in srgb,var(--orange) 8%,var(--panel));border:1px solid color-mix(in srgb,var(--orange) 40%,var(--line2));
  border-radius:10px;padding:11px 14px;font-size:13.5px;color:var(--ink);margin:0 0 2vh}

.hw-titlerow{display:flex;align-items:center;flex-wrap:wrap;gap:14px}
.hw-title{font-weight:800;font-size:clamp(24px,3.2vw,36px);letter-spacing:-.02em;margin:0}
.hw-sub{font-family:var(--font-mono);font-size:12.5px;color:var(--ink-f);margin:8px 0 0;word-break:break-all}
.hw-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:18px 26px;margin:2.4vh 0 0}
.hw-k{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-f);margin:0 0 4px}
.hw-v{font-family:var(--font-mono);font-size:21px;color:var(--ink);margin:0;font-weight:500}
.hw-pill{display:inline-flex;align-items:center;gap:7px;font-family:var(--font-mono);font-size:12px;letter-spacing:.04em;
  padding:5px 12px;border-radius:999px;border:1px solid var(--line2);color:var(--ink-d)}
.hw-pill::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--ink-f)}
.hw-pill.is-active{color:var(--teal);border-color:color-mix(in srgb,var(--teal) 40%,var(--line2))}
.hw-pill.is-active::before{background:var(--teal)}
.hw-host{font-family:var(--font-mono);font-size:11px;letter-spacing:.04em;color:var(--ink-d);
  background:var(--white);border:1px solid var(--line2);border-radius:6px;padding:3px 7px}
.hw-hosts{display:flex;flex-wrap:wrap;gap:5px;margin-top:10px}

.hw-rel{margin:3.4vh 0 0}
.hw-rel .hw-sh{margin:0 0 12px}
.hw-rel .hw-sh em{font-style:normal;text-transform:none;letter-spacing:0;color:var(--ink-d);font-family:var(--font-mono);font-size:11.5px}
.hw-chips{list-style:none;margin:0 0 10px;padding:0;display:flex;flex-wrap:wrap;gap:6px}
.hw-chips a{display:inline-block;font-size:13.5px;color:var(--ink);text-decoration:none;
  background:var(--white);border:1px solid var(--line2);border-radius:999px;padding:4px 11px}
.hw-chips a:hover{border-color:var(--orange);color:var(--orange)}
.hw-shown{font-family:var(--font-mono);font-size:11px;color:var(--ink-f);margin-left:9px}
.hw-read{border-top:1px solid var(--line);margin-top:3.4vh;padding-top:16px}
.hw-read p{margin:0;font-size:13.5px;line-height:1.55;color:var(--ink-d)}
.hw-read b{font-family:var(--font-mono);font-weight:500;color:var(--ink)}

/* ---- the editor, painted on this design's own dark code surface.
   The overlay: a highlighted pre behind a transparent-text textarea. The two layers must agree on
   every metric -- same font block, same padding, same wrap rule -- or the caret drifts away from the
   glyph it is sitting on. */
.hw-codecap{font-family:var(--font-mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
  color:var(--ink-f);margin:0 0 7px}
.qwrap{position:relative;background:var(--code-bg);border:1px solid var(--code-edge);border-radius:12px;
  box-shadow:0 24px 50px -42px rgba(20,14,4,.7);margin:0 0 12px}
.qwrap.qbad{border-color:color-mix(in srgb,var(--orange) 60%,var(--code-edge))}
.qedit,.qhl{font-family:var(--font-mono);font-size:12.5px;line-height:1.7;padding:16px;margin:0;
  border:0;white-space:pre-wrap;overflow-wrap:break-word;tab-size:2}
.qedit{display:block;width:100%;min-height:168px;resize:vertical;position:relative;z-index:1;
  background:transparent;color:transparent;caret-color:var(--code-fg);border-radius:12px}
.qedit:focus{outline:none}
.qedit::selection{background:rgba(232,160,106,.3)}
.qhl{position:absolute;inset:0;overflow:hidden;pointer-events:none;color:var(--code-fg)}
.qhl i{font-style:normal}
.hw-t-k{color:#e8a06a}
.hw-t-s{color:#a9c585}
.hw-t-c{color:#7e7361;font-style:italic}
.hw-t-y{color:#e6c17a}
.hw-t-n{color:#d49bce}
/* The completion popup lives on the dark surface, so it is the dark surface's menu -- and an option
   wears the token colour it will become. */
.qcomp{position:absolute;z-index:20;min-width:270px;max-height:198px;overflow-y:auto;
  background:#221d16;border:1px solid #3a3328;border-radius:10px;padding:5px;
  box-shadow:0 24px 50px -28px rgba(20,14,4,.8);font-family:var(--font-mono);font-size:12px}
.qopt{display:flex;justify-content:space-between;gap:16px;padding:5px 9px;border-radius:7px;cursor:pointer;color:#cabfa8}
.qopt span{color:#7e7361;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;align-self:center}
.qopt.sel,.qopt:hover{background:#2e2820}
.qbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 12px}
.qcost{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:0 0 1.4vh}
.qcost .hw-note{font-family:var(--font-mono);font-size:11.5px}
pre.hw-code{position:relative;background:var(--code-bg);border:1px solid var(--code-edge);border-radius:12px;
  margin:0;padding:14px 16px;overflow:auto;max-height:58vh;box-shadow:0 24px 50px -42px rgba(20,14,4,.7)}
pre.hw-code code{font-family:var(--font-mono);font-size:12px;line-height:1.65;color:var(--code-fg);white-space:pre;display:block}

.hw-foot{margin-top:7vh;padding:4vh 0;text-align:center;font-family:var(--font-mono);font-size:11px;
  color:var(--ink-f);letter-spacing:.06em;line-height:1.9}
.hw-foot a{color:var(--ink-f)}
@media (max-width:620px){.hw-kv{grid-template-columns:repeat(auto-fit,minmax(104px,1fr))}}
</style>
</head>
<body>
<header class="hw-header"><div class="hw-wrap">
  <a class="hw-brand" href="/"><span class="hw-mark"></span><span class="hw-name">hlekk <b>wiki</b></span></a>
  <nav class="hw-nav">
    <button id="tab-browse" aria-selected="true">browse</button>
    <button id="tab-query" aria-selected="false">query</button>
  </nav>
</div></header>

<main class="hw-wrap">
  <section id="pane-browse">
    <div class="hw-hero">
      <p class="hw-ey">read-only · 43 host durable objects</p>
      <h1 class="hw-h1">A Wikipedia mirror spread across many Durable Objects.</h1>
      <p class="hw-lead">One database, laid out over host Durable Objects in advance, entered by title
        and traversed. No single object holds it. Every answer reports which hosts it was assembled
        from, and how many requests that took.</p>
    </div>

    <form class="hw-entry" id="f">
      <input class="hw-input" type="search" id="q" placeholder="Page title, e.g. Country" autocomplete="off" autofocus>
      <select class="hw-input" id="ns" aria-label="Namespace"></select>
      <button class="hw-btn" type="submit">look up</button>
    </form>
    <p class="hw-note">Entry is exact <code>(namespace, title)</code> against a unique index. There is
      no scan and no prefix search, so there is nothing to suggest titles from. Try
      <a href="#" data-go="Country">Country</a>, <a href="#" data-go="Europe">Europe</a>,
      <a href="#" data-go="Earth">Earth</a> or <a href="#" data-go="Water">Water</a>.</p>

    <div id="out"></div>
  </section>

  <section id="pane-query" hidden>
    <div class="hw-hero">
      <p class="hw-ey">query editor</p>
      <h1 class="hw-h1">Author a traversal, and watch what it costs.</h1>
      <p class="hw-lead">Written in hlekk's own builder chain. Edge and field names complete from the
        catalog, so the popup cannot offer a name the engine would not resolve. The cost below is the
        product of the limits down each path — the thing no storage budget can see — and the server
        refuses the same number it shows you.</p>
    </div>

    <div class="qbar">
      <button class="hw-btn" id="run" type="button">run ⌘↩</button>
      <select class="hw-input" id="example" aria-label="Load an example"></select>
    </div>

    <p class="hw-codecap">query</p>
    <div class="qwrap" id="qwrap">
      <pre class="qhl" id="qhl" aria-hidden="true"></pre>
      <textarea class="qedit" id="qedit" spellcheck="false" autocapitalize="off" autocomplete="off"></textarea>
      <div class="qcomp" id="qcomp" hidden></div>
    </div>

    <p class="hw-err" id="qerr" hidden></p>
    <div class="qcost" id="cost"></div>
    <p class="hw-note" style="margin-bottom:2vh"><kbd>ctrl</kbd>+<kbd>space</kbd> opens the popup
      anywhere · <kbd>tab</kbd> accepts · <kbd>⌘</kbd>+<kbd>↩</kbd> runs</p>
    <div id="qout"></div>
  </section>
</main>

<footer class="hw-foot">
  mirror of a simplewiki database dump · not affiliated with the Wikimedia Foundation<br>
  text under <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a> and the
  <a href="https://www.gnu.org/licenses/fdl-1.3.html">GFDL</a> ·
  live articles and their authors at <a href="https://simple.wikipedia.org/">simple.wikipedia.org</a>
</footer>

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
  { edge: "wiki.page_links", title: "links from this page", count: "linkCount", key: "links" },
  { edge: "wiki.linked_from", title: "pages linking here", count: "backlinkCount", key: null },
  { edge: "wiki.page_categories", title: "categories", count: "categoryCount", key: "categories" },
  { edge: "wiki.category_pages", title: "pages in this category", count: "memberCount", key: null },
];

const chip = (i) => '<li><a href="#" data-go="' + esc(i.title) + '" data-ns="' + esc(i.ns) + '">'
  + esc(pretty(i.title)) + "</a></li>";

async function show(title, ns) {
  if (!title) return;
  out.innerHTML = '<div class="hw-panel"><p class="hw-note">Looking up ' + esc(pretty(title)) + "…</p></div>";
  let d;
  try {
    const res = await fetch("/page?ns=" + encodeURIComponent(ns) + "&title=" + encodeURIComponent(stored(title)) + "&limit=25");
    d = await res.json();
  } catch (e) {
    out.innerHTML = '<p class="hw-err">Request failed: ' + esc(e.message) + "</p>";
    return;
  }
  if (!d.found) {
    out.innerHTML = '<div class="hw-panel"><h2 class="hw-title">Not found</h2>'
      + '<p class="hw-note" style="margin-top:12px">No page titled <b>' + esc(pretty(title))
      + "</b> in namespace " + esc(ns) + ". Lookup is exact — there is no search index, only a unique "
      + "(namespace, title) key.</p></div>";
    return;
  }
  const p = d.page, r = d.read;
  const kv = (n, label) => '<div><p class="hw-k">' + label + '</p><p class="hw-v">' + nf(n) + "</p></div>";

  let html = '<div class="hw-panel">'
    + '<div class="hw-titlerow"><h2 class="hw-title">' + esc(pretty(p.title)) + "</h2>"
    + (p.redirect ? '<span class="hw-pill">redirect</span>' : "") + "</div>"
    + '<p class="hw-sub">namespace ' + esc(p.ns) + " · " + nf(p.len) + " bytes · id " + esc(d.id) + "</p>"
    + '<div class="hw-kv">'
      + kv(p.linkCount, "links out") + kv(p.backlinkCount, "links in")
      + kv(p.categoryCount, "categories") + kv(p.memberCount, "members")
    + "</div>";

  // Every relation, each paged on demand. A hub page here has thousands of backlinks, so the card
  // shows the first rows and reads the rest through /relation when asked.
  for (const rel of RELS) {
    const total = p[rel.count] || 0;
    if (total === 0) continue;
    const seeded = rel.key ? (p[rel.key] || []) : [];
    html += '<div class="hw-rel" data-edge="' + rel.edge + '">'
      + '<p class="hw-sh">' + rel.title + " <em>" + nf(total) + " total</em></p>"
      + '<ul class="hw-chips">' + seeded.map(chip).join("") + "</ul>"
      + '<button class="hw-mini more" data-edge="' + rel.edge + '" data-id="' + esc(d.id) + '">'
      + (seeded.length ? "show more" : "load " + nf(Math.min(total, 50))) + "</button>"
      + '<span class="hw-shown">' + (seeded.length ? nf(seeded.length) + " of " + nf(total) : "") + "</span>"
      + "</div>";
  }

  html += '<div class="hw-read">'
    + "<p>Assembled from <b>" + r.hosts.length + "</b> host" + (r.hosts.length === 1 ? "" : "s")
    + " in <b>" + r.requests + "</b> request" + (r.requests === 1 ? "" : "s")
    + " over <b>" + r.objects + "</b> objects — <b>" + r.ms + " ms</b>, plus " + r.lookupMs
    + " ms to turn the title into an id. The counts above come from maintained counters, so a page "
    + "with thousands of backlinks costs no more to count than one with three.</p>"
    + '<div class="hw-hosts">' + r.hosts.map((h) => '<span class="hw-host">host ' + h + "</span>").join("") + "</div>"
    + "</div></div>";

  out.innerHTML = html;
  history.replaceState(null, "", "?ns=" + encodeURIComponent(ns) + "&title=" + encodeURIComponent(stored(p.title)));
}

// "show more": read the next page of one relation, carrying the cursor the last page returned.
const cursors = new Map();
out.addEventListener("click", async (e) => {
  const btn = e.target.closest("button.more");
  if (!btn) return;
  const block = btn.closest(".hw-rel");
  const list = block.querySelector("ul.hw-chips");
  const shown = block.querySelector(".hw-shown");
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
    list.insertAdjacentHTML("beforeend", page.items.map(chip).join(""));
    cursors.set(key, page.cursor);
    const have = list.querySelectorAll("li").length;
    shown.textContent = nf(have) + " loaded · last read touched " + page.read.hosts.length
      + " host(s) in " + page.read.requests + " request(s), " + page.read.ms + " ms";
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
// The classic overlay: one tokenizer paints a pre sitting behind a transparent-text textarea, so the
// glyphs the author types line up with the glyphs that get coloured. Completions come from a pure
// function of (text, caret) so the popup can be reasoned about without the DOM, and every name it
// offers is read off /schema rather than a word list.
//
// Nothing here evaluates the query. The text is parsed on the server into the same description the
// guard checks, which is what keeps a text box from being a wider surface than a form.

const METHODS = ["limit", "where", "countAs", "related"];
const ROOTS = new Set(["q", "page"]);
const LITERALS = new Set(["true", "false"]);
let EDGE_SHORT = [];
let FIELDS = [];
let OPS = ["=", "!=", "<", "<=", ">", ">="];

const TOKEN_RE = /\/\/[^\n]*|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|[A-Za-z_$][A-Za-z0-9_$]*|=>/g;

/** Tokenize the RAW text and escape per piece: escaping first would re-tokenize the entities, and
 *  the overlay needs output glyphs to match input glyphs one-for-one or the caret drifts. The five
 *  token classes are Rindle Cloud's own, so a query here reads as a snippet there. */
function highlight(code) {
  let out = "";
  let last = 0;
  for (const m of code.matchAll(TOKEN_RE)) {
    out += esc(code.slice(last, m.index));
    const tok = m[0];
    const cls =
      tok.startsWith("//") ? "hw-t-c"
      : tok.startsWith('"') ? "hw-t-s"
      : /^-?\d/.test(tok) ? "hw-t-n"
      : EDGE_SHORT.includes(tok) ? "hw-t-y"
      : ROOTS.has(tok) || LITERALS.has(tok) ? "hw-t-k"
      : code[m.index - 1] === "." && METHODS.includes(tok) ? "hw-t-k"
      : "";
    out += cls ? '<i class="' + cls + '">' + esc(tok) + "</i>" : esc(tok);
    last = m.index + tok.length;
  }
  return out + esc(code.slice(last));
}

/**
 * What the text could say next at caret, or null when there is nothing useful to offer -- including
 * "the prefix already is the only match", so accepting never rewrites nothing. force (ctrl+space)
 * waives the typed-prefix gate, so the whole vocabulary is browsable anywhere.
 */
function completionContext(text, caret, force) {
  const before = text.slice(0, caret);
  const prefix = (/[A-Za-z_$][A-Za-z0-9_$]*$/.exec(before) || [""])[0];
  const head = before.slice(0, before.length - prefix.length);
  const options = optionsFor(head, prefix !== "" || force);
  if (!options) return null;
  // Match through a label's quotes, so a raw where(ti still narrows to "title" -- and accepting
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
    if (/\d$/.test(head.slice(0, -1))) return null; // a trailing digit means a number, not a chain
    return METHODS.map((m) => opt(m, "method"));
  }
  // An open paren, or a comma inside one, is an unambiguous argument position: offer what that call
  // accepts, unprompted. This is how someone who does not know the vocabulary finds page_links.
  const call = /\.(related|countAs)\(\s*((?:"[^"]*"\s*,\s*)?)$/.exec(head);
  if (call) {
    // Both take an alias first, then the edge. With no alias yet, offer one pre-quoted per edge.
    if (call[2] === "") return EDGE_SHORT.map((e) => opt('"' + e + '"', "alias"));
    return edgeOpts();
  }
  if (/\.where\(\s*$/.test(head)) return fieldOpts(true);
  if (/\.where\(\s*"[^"]*"\s*,\s*$/.test(head)) return OPS.map((o) => opt('"' + o + '"', "operator"));
  if (/,\s*$/.test(head) && /\.related\([^()]*$/.test(head)) return [opt("q => q", "lambda")];
  if (/^\s*$/.test(head)) return [opt('page(0, "Country")', "start here")];
  return typing
    ? [...METHODS.map((m) => opt(m, "method")), ...edgeOpts(), opt("page", "root"), opt("q", "lambda")]
    : null;
}

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
const exSel = document.getElementById("example");

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
      '<i class="' + (o.label.startsWith('"') ? "hw-t-s" : o.kind === "edge" ? "hw-t-y" : "hw-t-k") + '">' +
      esc(o.label) + "</i><span>" + esc(o.kind) + "</span></div>")
    .join("");
  box.hidden = false;
  // Hung under the caret's line, measured from the line count rather than a mirror element.
  const line = ta.value.slice(0, ta.selectionStart).split("\n").length;
  box.style.top = Math.min(line * 21.25 + 20, ta.clientHeight) + "px";
  box.style.left = "16px";
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
  } else if (e.key === "Tab" || e.key === "Enter") {
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
    errEl.textContent = priced.error.replace(/^text: /, "")
      + (priced.offset !== undefined ? "  (at character " + priced.offset + ")" : "");
    costEl.innerHTML = "";
    runBtn.disabled = true;
    return;
  }
  wrap.classList.remove("qbad");
  errEl.hidden = true;
  const pct = ((priced.nodes / SCHEMA.limits.maxNodes) * 100).toFixed(1);
  costEl.innerHTML = '<span class="hw-pill is-active">within budget</span>'
    + '<span class="hw-note">' + nf(priced.nodes) + " of " + nf(SCHEMA.limits.maxNodes)
    + " answer nodes (" + pct + "%) · " + priced.frames + " of " + SCHEMA.limits.maxFrames + " plan frames</span>";
  runBtn.disabled = false;
}

async function run() {
  qout.innerHTML = '<div class="hw-panel"><p class="hw-note">Running…</p></div>';
  let d;
  try {
    const res = await fetch("/query", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: ta.value }),
    });
    d = await res.json();
  } catch (err) {
    qout.innerHTML = '<p class="hw-err">Request failed: ' + esc(err.message) + "</p>";
    return;
  }
  if (d.refused) {
    qout.innerHTML = '<div class="hw-panel"><p class="hw-sh" style="margin-top:0">refused</p>'
      + '<p class="hw-note">' + esc(d.refused.replace(/^text: /, "")) + "</p>"
      + (d.offset !== undefined ? '<p class="hw-sub">at character ' + d.offset + "</p>" : "") + "</div>";
    if (d.offset !== undefined) {
      ta.focus();
      ta.setSelectionRange(d.offset, d.offset);
    }
    return;
  }
  if (d.error) {
    qout.innerHTML = '<p class="hw-err">' + esc(d.name || "error") + ": " + esc(d.error) + "</p>";
    return;
  }
  const r = d.read;
  qout.innerHTML = '<div class="hw-panel">'
    + '<p class="hw-sh" style="margin-top:0">result</p>'
    + '<p class="hw-note">Assembled from <b>' + r.hosts.length + "</b> host"
    + (r.hosts.length === 1 ? "" : "s") + " in <b>" + r.requests + "</b> request"
    + (r.requests === 1 ? "" : "s") + " over <b>" + r.objects + "</b> objects — <b>" + r.ms
    + " ms</b>. Priced at " + nf(d.cost.nodes) + " answer nodes across " + d.cost.frames + " frames.</p>"
    + '<div class="hw-hosts">' + r.hosts.map((h) => '<span class="hw-host">host ' + h + "</span>").join("") + "</div>"
    + '<div style="margin-top:18px"></div>'
    + '<pre class="hw-code"><code>' + esc(JSON.stringify(d.rows, null, 2)) + "</code></pre></div>";
}

runBtn.addEventListener("click", () => void run());
exSel.addEventListener("change", () => {
  ta.value = EXAMPLES[exSel.value];
  paint();
  void reprice();
  ta.focus();
});

// ---------------------------------------------------------------- start

(async () => {
  SCHEMA = await (await fetch("/schema")).json();
  nsbox.innerHTML = SCHEMA.entry.namespaces.map((n) =>
    '<option value="' + n.value + '">' + esc(n.label) + "</option>").join("");
  // The editor's whole vocabulary, read off the schema so the popup cannot offer a name the engine
  // would not resolve -- the one property of this editor worth stating.
  EDGE_SHORT = SCHEMA.edges.map((e) => e.name.replace(/^wiki\./, ""));
  FIELDS = SCHEMA.objects[0].fields.map((f) => ({ name: f.name, type: f.type + (f.optional ? "?" : "") }));
  OPS = SCHEMA.limits.ops;
  exSel.innerHTML = Object.keys(EXAMPLES).map((k) => "<option>" + esc(k) + "</option>").join("");
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
