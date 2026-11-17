import assert from "node:assert/strict";

const base = new URL(process.argv[2]);
const token = process.env.HLEKK_ADMIN_TOKEN;
if (!token) throw new Error("Set HLEKK_ADMIN_TOKEN to the example deployment's operator token.");

async function post(path, body) {
  const response = await fetch(new URL(path, base), {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const reply = await response.text();
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${reply}`);
  const result = JSON.parse(reply);
  if (result.failed) throw new Error(`${path} failed: ${reply}`);
  return result;
}

await post("/admin/init?hosts=2&indexVshards=1", {});
const pages = ["Hlekk", "SQLite"].map((title) => ({
  key: title,
  affinity: title,
  fields: { ns: 0, title, redirect: false, len: 0 },
}));
const { ids } = await post("/ingest/pages", { pages });
await post("/ingest/edges", {
  edges: [
    ["wiki.page_links", ids.Hlekk, ids.SQLite, 0],
    ["wiki.linked_from", ids.SQLite, ids.Hlekk, 0],
  ],
});

const url = new URL("/page?title=Hlekk", base);
const response = await fetch(url);
assert.equal(response.status, 200, await response.clone().text());
const { page } = await response.json();
assert.equal(page.id, ids.Hlekk);
assert.ok(page.links.items.some((item) => item.id === ids.SQLite && item.title === "SQLite"));
console.log(`Read Hlekk → SQLite at ${url}`);
