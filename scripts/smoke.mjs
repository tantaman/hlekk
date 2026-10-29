// Runs the Durable Object smoke harness on real workerd. Kept out of `npm test`, which stays
// hermetic and fast; this one starts a server and needs a port.

import { spawn } from "node:child_process";

const PORT = Number(process.env.SMOKE_PORT ?? 8787);
const server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--inspector-port", "0"], {
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
for (const stream of [server.stdout, server.stderr]) stream.on("data", (b) => (log += b.toString()));

let body = null;
try {
  for (let i = 0; i < 45 && body === null; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/?host=smoke-${Date.now()}`);
      body = await res.json();
    } catch {
      // not up yet
    }
  }
} finally {
  server.kill("SIGTERM");
}

if (body === null) {
  console.error(`wrangler dev never answered on port ${PORT}.\n${log.slice(-2000)}`);
  process.exit(1);
}
for (const c of body.checks) {
  console.log(`${c.ok ? "ok  " : "FAIL"}  ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
}
const passed = body.checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${body.checks.length} checks against real Durable Object SQLite`);
process.exit(body.ok ? 0 : 1);
