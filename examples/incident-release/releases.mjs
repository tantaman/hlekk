// A maintainer publishes an existing SQL view. Postgres owns the data and its revisions.
import pg from "pg";
import { listen } from "../../src/adapters/node/http.ts";
import { Catalog, plan } from "../../src/catalog/catalog.ts";
import { surfaceOf } from "../../src/protocol/surface.ts";
import { PUBLIC } from "../../src/query/serve.ts";

const catalog = Catalog.compile(plan({
  packages: { objects: { "packages.release": { fields: { component: "string", tag: "string", change: "string" } } } },
}));
const releaseType = catalog.objectNamed("packages.release").otype;
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ??
    "postgresql://hlekk_release_reader:local-fixture-reader@127.0.0.1:15432/maintainer",
  connectionTimeoutMillis: 3000,
});

// This vocabulary exposes one object type with no outgoing edges. The protocol
// handler validates and prices the request before calling this batch lookup.
const source = {
  async normalized(_plan, ids) {
    const { rows } = await pool.query(
      "SELECT id::text, revision, component, tag, change_note FROM release_demo.published_releases WHERE id = ANY($1::bigint[])",
      [ids],
    );
    const objects = {};
    for (const { id, revision, component, tag, change_note } of rows) {
      objects[id] = { otype: releaseType, version: revision, data: { component, tag, change: change_note } };
    }
    return { roots: ids.filter(id => Object.hasOwn(objects, id)), objects, lists: {}, counts: {}, shape: { 0: {} } };
  },
};

await pool.query("SELECT id FROM release_demo.published_releases LIMIT 0");
const server = await listen(
  { catalog, source, surface: surfaceOf(catalog), policy: { ...PUBLIC, cache: () => ({ reuse: "never" }) } },
  { path: "/releases", port: Number(process.env.RELEASE_PORT ?? 8461) },
);
console.log(`Release publisher: ${server.database}`);
