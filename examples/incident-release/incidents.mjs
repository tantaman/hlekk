// The downstream team knows which build it deployed. The release notes stay with the maintainer.
import { open } from "../../src/adapters/node/database.ts";
import { listen } from "../../src/adapters/node/http.ts";
import { plan } from "../../src/catalog/catalog.ts";
import { formatRef, parseRef } from "../../src/query/ref.ts";

const release = process.argv[2];
if (!release || !parseRef(release).db) throw new Error("Pass the maintainer's qualified release reference.");
const lock = plan({
  ops: {
    objects: { "ops.incident": { fields: { ticket: "string", observation: "string" } } },
    edges: { "ops.deployed_release": { from: "ops.incident", to: "packages.release", foreign: true, unique: true } },
  },
  packages: { objects: { "packages.release": { fields: {} } } },
});
const store = await open({
  dir: process.env.INCIDENT_DIR ?? ".local/incidents", lock, format: 2, identity: false,
});
const server = await listen(store.binding, { path: "/incidents", port: Number(process.env.INCIDENT_PORT ?? 8460) });
if (!store.cluster.directory.indexVshards().length) {
  store.cluster.openIndexVshards(1);
  await store.cluster.publish();
}
const ticket = "INC-217";
const id = await store.db.lookupUnique(1, ticket) ?? await store.db.createUnique(
  1, ticket, store.catalog.objectNamed("ops.incident").otype,
  { ticket, observation: "Duplicate deliveries began after our rollout of Relay 3.7.2. The rollout log identifies the deployed build." },
);
await store.db.assocAdd(store.catalog.edgeNamed("ops.deployed_release").atype, id, release, 0);
console.log(`Incident reference: ${formatRef(server.database, id)}`);
