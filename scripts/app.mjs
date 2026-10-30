// Drives the demo on local workerd and asserts what it did.
//
// The claim being checked is the one the whole design rests on: that a database can be spread over
// several Durable Objects, that an application writes and reads it without naming any of them, and
// that moving the data does not change an answer. So it is not enough for the requests to succeed —
// the script looks at where the rows actually landed, and fails if they all landed in one place.

import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

// What a host DO's SQLite weighs with the schema in place and nothing stored. The shed threshold has
// to sit above this, or it is crossed before any data exists. Measured on workerd, not assumed.
const EMPTY_DB_BYTES = 40960;

const PORT = Number(process.env.APP_PORT ?? 8788);
const base = `http://127.0.0.1:${PORT}`;

// A state directory of its own, emptied before the run rather than after it. Durable Object storage
// survives a `wrangler dev` restart and laying a database out is a one-time operation, so a run that
// inherited the last one's hosts would be asserting about whatever happened to be left behind — and
// clearing up afterwards is exactly what a killed run does not do.
//
// Under .wrangler, where wrangler keeps its own: workerd exits without a word if its persistence
// path is somewhere it will not write, and the system temp directory is one such place.
const state = join(".wrangler", "app-state");
rmSync(state, { recursive: true, force: true });
mkdirSync(state, { recursive: true });
console.log(`state: ${state}`);
// Its own process group, so shutting it down reaches workerd and not just the wrangler that started
// it. A surviving workerd holds the old database open and flushes it back after this script has
// cleared the directory, which is how the next run silently inherits the last one's hosts.
const server = spawn(
  "npx",
  ["wrangler", "dev", "--config", "wrangler.app.jsonc", "--port", String(PORT), "--inspector-port", "0", "--persist-to", state],
  { stdio: ["ignore", "pipe", "pipe"], detached: true },
);
let log = "";
for (const stream of [server.stdout, server.stderr]) stream.on("data", (b) => (log += b.toString()));

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail === undefined ? "" : `  (${detail})`}`);
};

async function hit(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${path}: ${res.status} ${text.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(parsed)}`);
  return parsed;
}

try {
  // Nothing may already be answering here. An orphaned `wrangler dev` from an earlier run holds its
  // port and its own state directory, and a script that just polls until something replies will
  // happily assert against that one's database instead of the one it started — which reads exactly
  // like state leaking between runs.
  const squatter = await fetch(`${base}/health`).then(
    () => true,
    () => false,
  );
  if (squatter) throw new Error(`something is already serving ${base}; stop it before running this`);

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await hit("/health");
      break;
    } catch {
      // not up yet
    }
  }

  // ---- a database over four hosts
  const init = await hit("/admin/init?hosts=4", {});
  check(
    "the database opens across four host DOs",
    init.hosts === 4 && !init.alreadyInitialized,
    `catalog v${init.catalog}, ${init.chunks} chunk(s)`,
  );

  // ---- an application that names no host
  const alice = (await hit("/users", { name: "alice" })).id;
  const bob = (await hit("/users", { name: "bob" })).id;
  const issues = [];
  for (let i = 0; i < 12; i++) {
    issues.push((await hit("/issues", { title: `issue ${i}`, owner: i % 2 ? alice : bob })).id);
  }
  // Half the comments colocated with their issue, half placed by the allocator: one of those is a
  // read on one host and the other is not.
  const comments = [];
  for (const [i, issue] of issues.entries()) {
    for (let c = 0; c < 4; c++) {
      comments.push(
        (await hit(`/issues/${issue}/comments`, { body: `comment ${c}`, author: c ? alice : bob, colocate: i % 2 === 0 }))
          .id,
      );
    }
  }
  check(
    "writes land without the caller naming a host",
    issues.length === 12 && comments.length === 48,
    `${issues.length} issues, ${comments.length} comments, 2 users`,
  );

  // ---- the data really is spread
  const where = await hit("/admin/where");
  const populated = where.hosts.filter((h) => h.objects > 0);
  check(
    "the rows are on more than one host DO",
    populated.length > 1,
    populated.map((h) => `h${h.host}:${h.objects}`).join(" "),
  );

  // ---- cross-host inverse edges arrive
  //
  // Nothing writes `user_owned`: it is the maintained half of the owner pair, so every edge in this
  // answer was written by the issue's host and delivered to Alice's. Reading it back is the only way
  // to see that the outbox crossed a host at all.
  const queued = where.hosts.reduce((n, h) => n + h.pending, 0);
  const left = (await hit("/admin/deliver", {})).pending;
  const owned = (await hit(`/users/${alice}`)).user;
  const ownedElsewhere = (await hit(`/admin/route?ids=${alice},${owned.owns.map((i) => i.id).join(",")}`)).ids;
  const aliceHost = ownedElsewhere[0].host;
  check(
    "a maintained inverse edge arrives from the host that wrote its other half",
    owned.ownsCount === 6 && owned.owns.length === 6,
    `alice owns ${owned.ownsCount}; ${queued} were still queued when last looked, ${left} left now`,
  );
  check(
    "and those issues really are on other hosts",
    ownedElsewhere.slice(1).some((r) => r.host !== aliceHost),
    `alice on h${aliceHost}, her issues on ${[...new Set(ownedElsewhere.slice(1).map((r) => `h${r.host}`))].join(",")}`,
  );

  // ---- a graph read that crosses hosts
  const subject = issues[1]; // an issue whose comments were not colocated
  const read = await hit(`/issues/${subject}`);
  const got = read.issue;
  check(
    "a graph read assembles an answer from several hosts",
    read.read.hosts.length > 1,
    `hosts ${read.read.hosts.join(",")}, ${read.read.requests} host requests, ${read.read.rounds} round(s)`,
  );
  check(
    "and the answer is right",
    got?.commentCount === 4 && got?.comments?.length === 4 && got?.owner?.name === "alice" &&
      got.comments.every((c) => c.author?.name === "alice" || c.author?.name === "bob"),
    `${got?.commentCount} comments, owner ${got?.owner?.name}`,
  );

  // ---- both drivers agree
  const rounds = await hit(`/issues/${subject}?driver=rounds`);
  check("both drivers give the same answer", JSON.stringify(rounds.issue) === JSON.stringify(got));

  // ---- moving the data does not change the answer
  const routed = await hit(`/admin/route?ids=${subject}`);
  const vshard = routed.ids[0].vshard;
  const from = routed.ids[0].host;
  const to = where.hosts.length;
  const moved = await hit(`/admin/move?vshard=${vshard}&to=${to}`, {});
  check("a vshard moves to a host that has never held anything", moved.step === "done", `v${vshard}: h${from} -> h${to}`);
  const after = await hit(`/issues/${subject}`);
  check(
    "the same read answers the same after the move",
    JSON.stringify(after.issue) === JSON.stringify(got),
    `now from hosts ${after.read.hosts.join(",")}`,
  );
  const relocated = await hit(`/admin/route?ids=${subject}`);
  check("and the id did not change, only where it lives", relocated.ids[0].id === subject && relocated.ids[0].host === to);

  // ---- the placement controller
  const rebalanced = await hit("/admin/rebalance", {});
  const sheds = rebalanced.sheds;
  const spread = (await hit("/admin/where")).hosts.filter((h) => h.objects > 0);
  check(
    "the placement controller sheds a run when a host is over threshold",
    sheds.length > 0,
    sheds.map((s) => `h${s.from}->h${s.to} x${s.vshards.length} (${s.why})`).join(" ") || "nothing over threshold",
  );
  // The threshold is measured on what the engine reports, which starts in the tens of kilobytes
  // before a single row is written. So a shed only means something if the hosts that crossed it were
  // over that floor: a threshold below it is tripped before any data exists. Only hosts that have
  // reported are comparable — the ones this rebalance just created are still counted in shares.
  const loaded = rebalanced.loads.filter((l) => l.reported);
  check(
    "and the hosts that crossed it were over the empty-database floor",
    loaded.length > 0 && loaded.every((l) => l.bytes > EMPTY_DB_BYTES),
    loaded.map((l) => `h${l.host}:${(l.bytes / 1024).toFixed(0)}KB/${l.vshards}v`).join(" ") +
      ` | unreported: ${rebalanced.loads.filter((l) => !l.reported).length}`,
  );
  const last = await hit(`/issues/${subject}`);
  check("and the answer survives that too", JSON.stringify(last.issue) === JSON.stringify(got));
  check("the data is still spread after rebalancing", spread.length > 1, spread.map((h) => `h${h.host}:${h.objects}`).join(" "));
} catch (e) {
  check(`the run got as far as it did`, false, e.message);
  if (log) console.error(`\n--- wrangler ---\n${log.slice(-3000)}`);
} finally {
  await stop();
}

/** Signals the whole group and waits for it to go, so the state on disk is final. */
async function stop() {
  const gone = new Promise((done) => server.once("exit", done));
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
  await Promise.race([gone, new Promise((done) => setTimeout(done, 5000))]);
}

const passed = checks.filter((c) => c.ok).length;
console.log(`\n${passed}/${checks.length} checks against a database on local workerd`);
process.exit(passed === checks.length ? 0 : 1);
