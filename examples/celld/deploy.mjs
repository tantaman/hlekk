// celld deploy takes Worker variables from the Wrangler config. Keep the generated
// config beside the entry point so that its relative paths resolve as in local dev.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MIN_TOKEN_LENGTH } from "../../src/worker/guard.ts";

const token = process.env.HLEKK_ADMIN_TOKEN;
if (!token || token.length < MIN_TOKEN_LENGTH) throw new Error("Set HLEKK_ADMIN_TOKEN in .dev.vars.");
const config = JSON.parse(readFileSync(new URL("./wrangler.json", import.meta.url), "utf8"));
config.vars.HLEKK_ADMIN_TOKEN = token;
const path = fileURLToPath(new URL(`.dev.vars.${randomUUID()}.json`, import.meta.url));
writeFileSync(path, JSON.stringify(config), { flag: "wx", mode: 0o600 });
try {
  const result = spawnSync("celld", ["deploy", path, ...process.argv.slice(2)], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  unlinkSync(path);
}
