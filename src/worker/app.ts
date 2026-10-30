// The demo: a Worker over a database spread across several host Durable Objects.
//
// There is nothing about placement in it. It creates objects without naming a vshard, reads a graph
// without naming a host, and the only reason it knows how many hosts there are is that the admin
// routes are there to show you.

import { Hlekk } from "../client/client.ts";
import { vshardOf } from "../host/ids.ts";
import type { Id, Json } from "../query/types.ts";
import { databaseOf, directoryStub } from "../do/bindings.ts";
import type { Env } from "../do/bindings.ts";
import { call } from "../do/rpc.ts";
import { cloudflareTransport } from "../do/transport.ts";
import { Comment, Issue, LOCK, User, commentAuthor, issueComments, issueOwner, userOwned } from "./schema.ts";

export { HlekkHostDO } from "../do/host.ts";
export { HlekkDirectoryDO } from "../do/directory.ts";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, null, 1), { status, headers: { "content-type": "application/json" } });

/** The graph read the demo is for: an issue, its comments with each comment's author, its owner, and
 *  the comment count from the maintained counter rather than a scan. Three object types, four hops,
 *  and nothing in it says where any of them live. */
const graph = (root: Id) =>
  Issue.gen(root)
    .countAs("commentCount", issueComments)
    .related("comments", issueComments, (c) => c.limit(20).related("author", commentAuthor))
    .related("owner", issueOwner);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const db = Hlekk.from(cloudflareTransport(env));
    const directory = directoryStub(env);
    const body = async <T>(): Promise<T> => (request.method === "POST" ? ((await request.json()) as T) : ({} as T));
    const num = (k: string, fallback: number) => Number(url.searchParams.get(k) ?? fallback);

    try {
      // ---- operating it

      if (path === "/health") return json({ ok: true, database: databaseOf(env) });

      if (path === "/admin/init") {
        return json(await call(directory, "init", LOCK, num("hosts", 4), num("indexVshards", 2)));
      }
      if (path === "/admin/where") return json(await call(directory, "where"));
      if (path === "/admin/deliver") return json({ pending: await call(directory, "deliver") });
      if (path === "/admin/rebalance") return json(await call(directory, "rebalance"));
      if (path === "/admin/move") {
        return json(await call(directory, "move", url.searchParams.get("vshard"), num("to", 1)));
      }

      /** Where a set of ids actually lives, which is the only way to see it from outside. */
      if (path === "/admin/route") {
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
        const vshards = [...new Set(ids.map(vshardOf))];
        await db.routes.routeAll(vshards);
        return json({
          ids: ids.map((id) => ({ id, vshard: vshardOf(id).toString(), host: db.routes.peek(vshardOf(id))?.host ?? null })),
        });
      }

      // ---- the application

      if (path === "/users" && request.method === "POST") {
        const { name } = await body<{ name: string }>();
        // An affinity key, not a vshard: objects sharing one land together and stay on one host as
        // the database spreads. The caller never sizes or picks anything.
        return json({ id: await db.create(User.otype, { name }, { affinity: name }) });
      }

      if (path === "/issues" && request.method === "POST") {
        const { title, status = "open", owner } = await body<{ title: string; status?: string; owner?: Id }>();
        const id = await db.create(Issue.otype, { title, status });
        if (owner) await db.assocAdd(issueOwner.atype, id, owner, Date.now());
        return json({ id });
      }

      const comments = /^\/issues\/(\d+)\/comments$/.exec(path);
      if (comments && request.method === "POST") {
        const issue = comments[1];
        const { body: text, author, colocate = false } = await body<{ body: string; author: Id; colocate?: boolean }>();
        // `with` is hard colocation: the comment takes the issue's vshard, so the two can transact.
        // Without it the allocator places it, which is how a comment ends up on another host.
        const id = await db.create(
          Comment.otype,
          { body: text, authorId: author },
          colocate ? { with: issue } : {},
        );
        await db.assocAdd(issueComments.atype, issue, id, Date.now());
        return json({ id, colocated: colocate });
      }

      /** A user and the issues they own — which is the maintained half of a pair, so every edge in
       *  the answer arrived from another host's write rather than being written here. */
      const user = /^\/users\/(\d+)$/.exec(path);
      if (user && request.method === "GET") {
        const rows = await User.gen(user[1])
          .countAs("ownsCount", userOwned)
          .related("owns", userOwned, (i) => i.limit(50))
          .run(db);
        return json({ user: rows[0] ?? null });
      }

      const issue = /^\/issues\/(\d+)$/.exec(path);
      if (issue) {
        const stats = { rounds: 0, requests: 0 };
        const rows = await graph(issue[1]).run(db, { driver: url.searchParams.get("driver") === "rounds" ? "rounds" : "async", stats });
        // Which hosts the answer came from. Not something an application would ask; it is the whole
        // point of the demo.
        const ids = idsIn(rows as unknown as Json);
        await db.routes.routeAll([...new Set(ids.map(vshardOf))]);
        const hosts = [...new Set(ids.map((id) => db.routes.peek(vshardOf(id))?.host))].filter((h) => h !== undefined);
        return json({ issue: rows[0] ?? null, read: { ...stats, objects: ids.length, hosts: hosts.sort() } });
      }

      return json({ error: `no route for ${request.method} ${path}` }, 404);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      return json({ error: error.message, name: error.name }, 500);
    }
  },
};

/** Every id in an answer, so the demo can say which hosts it was assembled from. */
function idsIn(value: Json): Id[] {
  if (Array.isArray(value)) return value.flatMap(idsIn);
  if (value === null || typeof value !== "object") return [];
  const out: Id[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (k === "id" && typeof v === "string") out.push(v);
    else out.push(...idsIn(v));
  }
  return out;
}
