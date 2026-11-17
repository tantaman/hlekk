// Runs the black-box conformance script against this repository's own Node adapter.
//
//   npm run conformance:node
//
// `conformance.mjs` imports nothing from `src/`, which is what makes it worth running — so something
// has to put a database in front of it. This does: a `LocalCluster` with the small issues graph, one
// `node:http` server, the script as a separate process over a real socket, and the server shut down
// afterwards whatever happened.
//
// Kept out of `npm test`, which stays hermetic and needs no port.

import { spawn } from "node:child_process";

import { listen } from "../src/adapters/node/http.ts";
import { served } from "../src/testkit/served.ts";

const { binding } = await served();
const { database: _unused, ...parts } = binding;
const node = await listen(parts, { path: "/db" });

console.log(`serving ${node.database}\n`);

const code = await new Promise((done) => {
  const child = spawn(process.execPath, ["scripts/conformance.mjs", node.database], { stdio: "inherit" });
  child.on("exit", (status) => done(status ?? 1));
  child.on("error", () => done(1));
});

await node.close();
process.exit(code);
