// Runs one query four ways and checks that the answers agree, rindle's differential oracle in
// miniature: on one host and on four, each with the round driver and the async driver. Host latency is
// simulated on a virtual clock, so the timelines are exact and repeatable.

import { hostExec, runAsync, runRounds } from "./driver.ts";
import type { HostClient, Stats } from "./driver.ts";
import { VirtualClock } from "../runtime/runtime.ts";
import { HostData, HostStore } from "./stores.ts";
import type { Edge, Id, Json, Miss, Obj, Plan } from "./types.ts";

const [ISSUE, COMMENT, LABEL, USER] = [1, 2, 3, 4]; // otypes
const [ISSUE_COMMENT, ISSUE_LABEL, ISSUE_OWNER] = [1, 2, 3]; // atypes

const obj = (id: Id, otype: number, data: Obj["data"]): Obj => ({ id, otype, version: 1, data });
const edge = (id1: Id, atype: number, id2: Id, time: number): Edge => ({ id1, atype, id2, time, data: null });

// Oldest first. Alice wrote two of the eight, so the filter passes one row in four.
const comments: [Id, string, Id][] = [
  ["c1", "Repro attached", "u1"],
  ["c2", "+1", "u2"],
  ["c3", "Same on Linux", "u2"],
  ["c4", "Bisected to #40", "u2"],
  ["c5", "Any update?", "u2"],
  ["c6", "Fixed in #42", "u1"],
  ["c7", "Still broken for me", "u2"],
  ["c8", "Works after a clean build", "u2"],
];

const objects: Obj[] = [
  obj("i1", ISSUE, { title: "Crash on save" }),
  ...comments.map(([id, body, authorId]) => obj(id, COMMENT, { body, authorId })),
  obj("l1", LABEL, { name: "bug" }),
  obj("l2", LABEL, { name: "p1" }),
  obj("u1", USER, { name: "alice" }),
  obj("u2", USER, { name: "bob" }),
];

const edges: Edge[] = [
  ...comments.map(([id], i) => edge("i1", ISSUE_COMMENT, id, i + 1)),
  edge("i1", ISSUE_LABEL, "l1", 1),
  edge("i1", ISSUE_LABEL, "l2", 2),
  edge("i1", ISSUE_OWNER, "u1", 1),
];

// Issue.gen('i1')
//   .related('comments', issueComments, q => q
//     .where(exists(commentAuthor, a => a.where('name', '=', 'alice')))
//     .related('author', commentAuthor)
//     .limit(2))
//   .related('labels', issueLabels)
//   .related('owner', issueOwner)
//   .countAs('commentCount', issueComments)
const plan: Plan = {
  frames: [
    {
      source: { kind: "ids" },
      children: [
        { alias: "comments", frame: 1 },
        { alias: "labels", frame: 4 },
        { alias: "owner", frame: 5 },
      ],
      counts: [{ alias: "commentCount", atype: ISSUE_COMMENT }],
    },
    {
      source: { kind: "edge", atype: ISSUE_COMMENT },
      where: { exists: 3 },
      limit: 2,
      children: [{ alias: "author", frame: 2 }],
      counts: [],
    },
    { source: { kind: "field", field: "authorId" }, limit: 1, children: [], counts: [] },
    {
      source: { kind: "field", field: "authorId" },
      where: { cmp: "=", on: "obj", field: "name", value: "alice" },
      limit: 1,
      children: [],
      counts: [],
    },
    { source: { kind: "edge", atype: ISSUE_LABEL }, children: [], counts: [] },
    { source: { kind: "edge", atype: ISSUE_OWNER }, limit: 1, children: [], counts: [] },
  ],
};

/** Which host holds which objects. An object's outgoing edges live with it. */
type Placement = Record<string, Id[]>;
const ONE_HOST: Placement = { one: objects.map((o) => o.id) };
const FOUR_HOSTS: Placement = {
  issues: ["i1"],
  comments: comments.map(([id]) => id),
  users: ["u1", "u2"],
  labels: ["l1", "l2"],
};
const LATENCY: Record<string, number> = { one: 10, issues: 10, comments: 10, users: 10, labels: 50 };

const describe = (t: Miss) =>
  t.kind === "object" ? t.id : t.kind === "edges" ? `edges(${t.id1} after ${t.after?.id2 ?? "head"}, ${t.n})` : `count(${t.id1})`;

async function run(label: string, placement: Placement, driver: "rounds" | "async"): Promise<Json[]> {
  const clock = new VirtualClock();
  const log: { start: number; end: number; host: string; tasks: Miss[] }[] = [];
  const owner = new Map(Object.entries(placement).flatMap(([host, ids]) => ids.map((id) => [id, host] as const)));
  const hosts = new Map<string, HostClient>();
  for (const name of Object.keys(placement)) {
    const data = new HostData((id) => owner.get(id) === name);
    for (const o of objects) if (data.owns(o.id)) data.putObject(o);
    for (const e of edges) if (data.owns(e.id1)) data.putEdge(e);
    hosts.set(name, {
      async exec(plan, tasks) {
        const start = clock.now();
        const reply = await hostExec(new HostStore(data), plan, tasks);
        await clock.sleep(LATENCY[name]);
        log.push({ start, end: clock.now(), host: name, tasks });
        return reply;
      },
    });
  }
  const route = (id: Id) => hosts.get(owner.get(id)!)!;
  const stats: Stats = { rounds: 0, requests: 0 };
  const out =
    driver === "rounds"
      ? (await runRounds(plan, ["i1"], route, stats)).rows
      : (await runAsync(plan, ["i1"], route, stats, (f) => clock.defer(f))).rows;
  const answeredAt = clock.now();
  await clock.idle(); // let any speculative request finish, so the log shows it

  console.log(label);
  for (const r of log.sort((a, b) => a.start - b.start)) {
    const late = r.end > answeredAt ? "  (after the answer)" : "";
    const span = `${String(r.start).padStart(4)} → ${String(r.end).padStart(3)} ms`;
    console.log(`  ${span}  ${r.host.padEnd(9)} ${r.tasks.map(describe).join(", ")}${late}`);
  }
  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  const rounds = driver === "rounds" ? `${plural(stats.rounds, "round")}, ` : "";
  console.log(`  ${rounds}${plural(stats.requests, "request")}, answer at ${answeredAt} ms\n`);
  return out;
}

const answers = [
  await run("One host, rounds", ONE_HOST, "rounds"),
  await run("One host, async", ONE_HOST, "async"),
  await run("Four hosts, rounds (labels replies in 50 ms, the others in 10 ms)", FOUR_HOSTS, "rounds"),
  await run("Four hosts, async", FOUR_HOSTS, "async"),
];

console.log(JSON.stringify(answers[3], null, 2));
if (answers.some((a) => JSON.stringify(a) !== JSON.stringify(answers[0]))) throw new Error("answers differ");
console.log("\nAll four answers match.");
