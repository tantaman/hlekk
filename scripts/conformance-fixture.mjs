// Loads `spec/fixture/` into this implementation and runs the conformance suite against it.
//
//   npm run conformance:fixture
//
// The suite imports nothing from `src/`, so something has to put a database in front of it with
// known contents. This is that something — and it is also the worked example of what
// `spec/fixture/README.md` asks any implementation to do: load the catalog and the graph by your own
// means, enforce the policy table, serve the result, and report which id you gave each named object.
//
// Writing is by this implementation's own client, because there is no protocol for it and there is
// not going to be one: the cross-database graph is reads only.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Catalog } from "../src/catalog/catalog.ts";
import { open } from "../src/adapters/node/database.ts";
import { listen } from "../src/adapters/node/http.ts";

const spec = new URL("../spec/fixture/", import.meta.url);
const lock = JSON.parse(readFileSync(new URL("catalog.json", spec), "utf8"));
const graph = JSON.parse(readFileSync(new URL("graph.json", spec), "utf8"));
const catalog = Catalog.compile(lock);

const dir = mkdtempSync(join(tmpdir(), "hlekk-fixture-"));
let code = 1;
try {
  code = await run();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);

async function run() {
  /**
   * The policy table, enforced.
   *
   * The fixture names objects and this maps them to ids once they exist. `hidden` is never visible;
   * `countless` edges have objects but no counts; `signedOnly` is visible to a verified caller and
   * not to the anonymous one — which here means to nobody, since the suite's own key is not
   * published anywhere this process can read.
   */
  const ids = {};
  const hidden = new Set();
  const countless = new Set();
  const signedOnly = new Set();

  const database = await open({
    dir,
    lock,
    allowLoopback: true,
    // No identity on the serving side: the suite checks that an UNVERIFIABLE signature is refused,
    // which needs the responder to try, and trying needs no key of its own.
    identity: false,
    policy: {
      object: (id) => !hidden.has(id) && !signedOnly.has(id),
      count: (id, atype) => !countless.has(atype),
      cache: () => graph.policy.cache,
    },
  });

  const otypeOf = (name) => {
    const t = catalog.objectNamed(name);
    if (t === undefined) throw new Error(`the fixture's catalog has no ${name}`);
    return t.otype;
  };
  const atypeOf = (name) => {
    const e = catalog.edgeNamed(name);
    if (e?.atype === undefined) throw new Error(`the fixture's catalog has no stored edge ${name}`);
    return e.atype;
  };

  // In the order the fixture gives them, because the order an edge list is read in is the order its
  // `time` says and the suite relies on what that produces.
  for (const o of graph.objects) {
    ids[o.name] = await database.db.create(otypeOf(o.type), o.fields, { vshard: "3" });
  }
  for (const e of graph.edges) {
    await database.db.assocAdd(atypeOf(e.edge), ids[e.from], ids[e.to], e.time);
  }
  for (const e of graph.foreignEdges ?? []) {
    await database.db.assocAdd(atypeOf(e.edge), ids[e.from], e.to, e.time);
  }

  for (const name of graph.policy.hidden.objects) hidden.add(ids[name]);
  for (const name of graph.policy.signedOnly.objects) signedOnly.add(ids[name]);
  for (const name of graph.policy.countless.edges) countless.add(atypeOf(name));

  const { database: _derived, ...parts } = database.binding;
  const node = await listen(parts, { path: "/db" });
  database.cluster.directory.setDatabaseUri(node.database);

  const manifest = join(dir, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ database: node.database, ids }, null, 2));
  console.log(`serving ${node.database} with the fixture loaded\n`);

  const status = await new Promise((done) => {
    const child = spawn(process.execPath, ["scripts/conformance.mjs", node.database, "--fixture", manifest], {
      stdio: "inherit",
    });
    child.on("exit", (code) => done(code ?? 1));
    child.on("error", () => done(1));
  });

  await node.close();
  database.close();
  return status;
}
