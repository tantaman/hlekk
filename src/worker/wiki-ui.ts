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
    <form class="entry" id="qf">
      <input type="search" id="qtitle" placeholder="Start from this title" autocomplete="off" value="Country">
      <select id="qns" aria-label="Namespace"></select>
      <button class="go" type="submit" id="run">Run</button>
    </form>
    <p class="hint">Build a query by adding hops along the schema's edges. Fields and edge names
       autocomplete from <code>/schema</code>. The cost below is the product of the limits down each
       path — the thing no storage budget can see — and the server refuses the same number it shows.</p>

    <div class="card">
      <h3>Count at the root <span class="n">— from maintained counters, not a scan</span></h3>
      <div class="cbs" id="rootcounts"></div>
      <h3 style="margin-top:18px">Hops</h3>
      <div id="hops"></div>
      <button class="ghost" id="addhop" type="button">+ add hop</button>

      <div class="cost" id="cost"></div>
    </div>

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

<datalist id="dl-edges"></datalist>
<datalist id="dl-fields"></datalist>

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

// hop = { edge, as, limit, where: [{field, op, value}], counts: [], hops: [] }
const spec = { counts: [], hops: [{ edge: "wiki.page_links", limit: 10, where: [], counts: [], hops: [] }] };

const hopsEl = document.getElementById("hops");
const costEl = document.getElementById("cost");
const runBtn = document.getElementById("run");

function hopHtml(hop, path, depth) {
  const edges = SCHEMA.edges.map((e) => e.name);
  const canNest = depth < SCHEMA.limits.maxDepth;
  return '<div class="hop" data-path="' + path + '">'
    + '<div class="row">'
      + '<label>edge</label>'
      + '<input class="edge" list="dl-edges" value="' + esc(hop.edge) + '" data-k="edge" placeholder="wiki.page_links">'
      + '<label>as</label><input class="alias" value="' + esc(hop.as || "") + '" data-k="as" placeholder="auto">'
      + '<label>limit</label><input class="lim" type="number" min="1" max="' + SCHEMA.limits.maxLimit
        + '" value="' + esc(hop.limit) + '" data-k="limit">'
      + '<button class="ghost" type="button" data-act="rmhop">remove</button>'
      + (canNest ? '<button class="ghost" type="button" data-act="addkid">+ nested hop</button>' : "")
    + "</div>"
    + '<div class="filters">'
      + hop.where.map((w, i) =>
          '<div class="filter" data-i="' + i + '">'
          + '<label>where</label>'
          + '<input class="field" list="dl-fields" value="' + esc(w.field) + '" data-k="field" placeholder="ns">'
          + '<select data-k="op">' + SCHEMA.limits.ops.map((o) =>
              '<option' + (o === w.op ? " selected" : "") + ">" + o + "</option>").join("") + "</select>"
          + '<input class="val" value="' + esc(w.raw !== undefined ? w.raw : w.value) + '" data-k="value" placeholder="0">'
          + '<button class="ghost" type="button" data-act="rmfilter">×</button>'
          + "</div>").join("")
      + '<button class="ghost" type="button" data-act="addfilter">+ filter</button>'
    + "</div>"
    + '<div class="cbs"><span>count here:</span>' + edges.map((e) =>
        '<label><input type="checkbox" data-act="count" value="' + e + '"'
        + (hop.counts.includes(e) ? " checked" : "") + ">" + e.replace(/^wiki\./, "") + "</label>").join("") + "</div>"
    + (hop.hops.length ? '<div class="kids">' + hop.hops.map((k, i) => hopHtml(k, path + "." + i, depth + 1)).join("") + "</div>" : "")
    + "</div>";
}

const at = (path) => path.split(".").reduce((node, i) => (node.hops ? node.hops[Number(i)] : node), spec);

function render() {
  hopsEl.innerHTML = spec.hops.map((h, i) => hopHtml(h, String(i), 1)).join("")
    || '<p class="hint" style="margin:0 0 10px">No hops: the query reads just the page and its counts.</p>';
  document.getElementById("rootcounts").innerHTML = SCHEMA.edges.map((e) =>
    '<label><input type="checkbox" data-root-count value="' + e.name + '"'
    + (spec.counts.includes(e.name) ? " checked" : "") + ">" + e.name.replace(/^wiki\./, "") + "</label>").join("");
  void reprice();
}

/** A filter's value typed as the field's own type, so "0" on a number field is 0 and not "0". The
 *  server refuses a mistyped value rather than matching nothing, so this is what makes the obvious
 *  thing work. */
function typed(field, raw) {
  const f = SCHEMA.objects[0].fields.find((x) => x.name === field);
  if (!f) return raw;
  if (f.type === "number") return raw === "" ? raw : Number(raw);
  if (f.type === "boolean") return raw === "true" || raw === "1";
  return raw;
}

function payload() {
  const clean = (h) => ({
    edge: h.edge,
    ...(h.as ? { as: h.as } : {}),
    limit: Number(h.limit),
    ...(h.where.length ? { where: h.where.map((w) => ({ field: w.field, op: w.op, value: typed(w.field, w.raw !== undefined ? w.raw : w.value) })) } : {}),
    ...(h.counts.length ? { counts: h.counts } : {}),
    ...(h.hops.length ? { hops: h.hops.map(clean) } : {}),
  });
  return {
    from: { ns: Number(document.getElementById("qns").value), title: stored(document.getElementById("qtitle").value) },
    ...(spec.counts.length ? { counts: spec.counts } : {}),
    ...(spec.hops.length ? { hops: spec.hops.map(clean) } : {}),
  };
}

let pricing = 0;
async function reprice() {
  const mine = ++pricing;
  let priced;
  try {
    priced = await (await fetch("/price", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()),
    })).json();
  } catch (e) {
    return;
  }
  if (mine !== pricing) return; // a later edit already asked
  if (priced.error) {
    costEl.innerHTML = '<span class="bad"><b>refused</b> — ' + esc(priced.error) + "</span>";
    runBtn.disabled = true;
    return;
  }
  const pct = ((priced.nodes / SCHEMA.limits.maxNodes) * 100).toFixed(1);
  costEl.innerHTML = '<span class="ok">within budget</span>'
    + "<span>answer nodes: <b>" + nf(priced.nodes) + "</b> of " + nf(SCHEMA.limits.maxNodes) + " (" + pct + "%)</span>"
    + "<span>plan frames: <b>" + priced.frames + "</b> of " + SCHEMA.limits.maxFrames + "</span>";
  runBtn.disabled = false;
}

document.getElementById("addhop").onclick = () => {
  spec.hops.push({ edge: SCHEMA.edges[0].name, limit: 10, where: [], counts: [], hops: [] });
  render();
};

hopsEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (btn) {
    const path = btn.closest(".hop").dataset.path;
    const act = btn.dataset.act;
    if (act === "rmhop") {
      const parts = path.split(".");
      const i = Number(parts.pop());
      const parent = parts.length ? at(parts.join(".")) : spec;
      parent.hops.splice(i, 1);
    } else if (act === "addkid") {
      at(path).hops.push({ edge: SCHEMA.edges[0].name, limit: 5, where: [], counts: [], hops: [] });
    } else if (act === "addfilter") {
      at(path).where.push({ field: "ns", op: "=", raw: "0" });
    } else if (act === "rmfilter") {
      at(path).where.splice(Number(btn.closest(".filter").dataset.i), 1);
    }
    render();
    return;
  }
  const cb = e.target.closest("input[data-act=count]");
  if (cb) {
    const hop = at(cb.closest(".hop").dataset.path);
    if (cb.checked) hop.counts.push(cb.value);
    else hop.counts = hop.counts.filter((c) => c !== cb.value);
    void reprice();
  }
});

hopsEl.addEventListener("input", (e) => {
  const el = e.target.closest("[data-k]");
  if (!el) return;
  const hop = at(el.closest(".hop").dataset.path);
  const k = el.dataset.k;
  const filter = el.closest(".filter");
  if (filter) {
    const w = hop.where[Number(filter.dataset.i)];
    if (k === "value") w.raw = el.value;
    else w[k] = el.value;
  } else if (k === "limit") hop.limit = el.value === "" ? "" : Number(el.value);
  else hop[k] = el.value;
  void reprice();
});

document.getElementById("rootcounts").addEventListener("change", (e) => {
  const cb = e.target.closest("input[data-root-count]");
  if (!cb) return;
  if (cb.checked) spec.counts.push(cb.value);
  else spec.counts = spec.counts.filter((c) => c !== cb.value);
  void reprice();
});
document.getElementById("qtitle").addEventListener("input", () => void reprice());

const qout = document.getElementById("qout");
document.getElementById("qf").addEventListener("submit", async (e) => {
  e.preventDefault();
  qout.innerHTML = '<div class="card">Running…</div>';
  let d;
  try {
    const res = await fetch("/query", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()),
    });
    d = await res.json();
  } catch (err) {
    qout.innerHTML = '<div class="card err">Request failed: ' + esc(err.message) + "</div>";
    return;
  }
  if (d.refused) {
    qout.innerHTML = '<div class="card"><h3>Refused</h3><p class="err" style="margin:0">'
      + esc(d.refused) + '</p><p class="sub" style="margin-top:8px">at <code>' + esc(d.at) + "</code></p></div>";
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
    + "<h3 style=\"margin-top:16px\">Result</h3><pre>" + esc(JSON.stringify(d.rows, null, 2)) + "</pre></div>";
});

// ---------------------------------------------------------------- start

(async () => {
  SCHEMA = await (await fetch("/schema")).json();
  const nsOptions = SCHEMA.entry.namespaces.map((n) =>
    '<option value="' + n.value + '">' + esc(n.label) + "</option>").join("");
  nsbox.innerHTML = nsOptions;
  document.getElementById("qns").innerHTML = nsOptions;
  document.getElementById("dl-edges").innerHTML = SCHEMA.edges.map((e) =>
    '<option value="' + esc(e.name) + '">' + esc(e.from + " → " + e.to) + "</option>").join("");
  document.getElementById("dl-fields").innerHTML = SCHEMA.objects[0].fields.map((f) =>
    '<option value="' + esc(f.name) + '">' + esc(f.type + (f.optional ? " (optional)" : "")) + "</option>").join("");
  render();

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
