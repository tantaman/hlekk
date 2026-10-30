// A smoke harness on real Durable Objects. The point is the adapter: everything else in this
// repository runs over node:sqlite, which is not DO SQLite. This is what tells us doSql is right —
// that blobs come back as ArrayBuffer and are normalized, that transactionSync commits and rolls
// back, and that an 8-byte big-endian key really does sort in unsigned numeric order in the engine
// the design rests on.

import { Catalog, plan } from "../catalog/catalog.ts";
import { Host } from "../host/host.ts";
import { fromKey, makeId, toKey, vshardOf } from "../host/ids.ts";
import { doSql } from "../host/sql.ts";
import type { DoStorage } from "../host/sql.ts";

const LOCK = plan({
  issues: {
    objects: {
      "issues.issue": { fields: { title: "string" } },
      "issues.comment": { fields: { body: "string" } },
    },
    edges: {
      "issues.issue_comment": {
        from: "issues.issue",
        to: "issues.comment",
        inverse: "issues.comment_issue",
        onDelete: "cascade",
      },
      "issues.comment_issue": { from: "issues.comment", to: "issues.issue", inverse: "issues.issue_comment", maintained: true },
    },
  },
});
const CATALOG = Catalog.compile(LOCK);
const ISSUE = CATALOG.objectNamed("issues.issue")!.otype;
const COMMENT = CATALOG.objectNamed("issues.comment")!.otype;
const ISSUE_COMMENT = CATALOG.edgeNamed("issues.issue_comment")!.atype!;
const COMMENT_ISSUE = CATALOG.edgeNamed("issues.comment_issue")!.atype!;

interface Ctx {
  storage: DoStorage;
}

/** One host, on this Durable Object's own SQLite. */
export class HlekkHost {
  readonly #host: Host;
  readonly #raw: DoStorage;

  constructor(ctx: Ctx) {
    this.#raw = ctx.storage;
    this.#host = Host.open(doSql(ctx.storage), CATALOG);
  }

  async fetch(): Promise<Response> {
    const checks: { name: string; ok: boolean; detail?: string }[] = [];
    const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

    try {
      // ---- blobs survive the round trip through DO SQLite, which hands them back as ArrayBuffer
      this.#raw.sql.exec("CREATE TABLE IF NOT EXISTS probe (k BLOB PRIMARY KEY) WITHOUT ROWID").toArray();
      this.#raw.sql.exec("DELETE FROM probe").toArray();
      const samples = ["9", "10", makeId(0n, 1n), makeId((1n << 24n) - 1n, (1n << 40n) - 1n)];
      for (const id of samples) this.#raw.sql.exec("INSERT INTO probe VALUES (?)", toKey(id)).toArray();
      const back = doSql(this.#raw).all<{ k: Uint8Array }>("SELECT k FROM probe ORDER BY k DESC");
      check("blobs normalize to Uint8Array", back.every((r) => r.k instanceof Uint8Array));
      const order = back.map((r) => fromKey(r.k));
      const expected = [...samples].sort((a, b) => (BigInt(b) < BigInt(a) ? -1 : 1));
      check("big-endian keys sort in unsigned numeric order", JSON.stringify(order) === JSON.stringify(expected), order.join(","));

      // ---- the write path, over real DO SQLite
      this.#host.adopt("5");
      const created = this.#host.create({ otype: ISSUE, data: { title: "Crash on save" }, vshard: "5", epoch: 0 });
      check("create", created.ok === true, JSON.stringify(created));
      if (!created.ok) return Response.json({ ok: false, checks });
      const issue = created.value;
      check("the vshard is in the id's high bits", vshardOf(issue) === 5n);

      const comments: string[] = [];
      for (const t of [1, 2, 3]) {
        const c = this.#host.create({ otype: COMMENT, data: { body: `c${t}` }, with: issue, epoch: 0 });
        if (!c.ok) return Response.json({ ok: false, checks: [...checks, { name: "create with", ok: false }] });
        comments.push(c.value);
        this.#host.assocAdd({ atype: ISSUE_COMMENT, id1: issue, id2: c.value, time: t, epoch: 0 });
      }
      check("colocated children share the parent's vshard", comments.every((c) => vshardOf(c) === 5n));

      // ---- counts and ordered range reads
      const store = this.#host.store();
      check("maintained count", (await store.count(issue, ISSUE_COMMENT)) === 3);
      const page = await store.edges(issue, ISSUE_COMMENT, null, 2);
      const ids = page === null || typeof page === "symbol" ? [] : page.rows.map((e) => e.id2);
      check("newest first, limited", JSON.stringify(ids) === JSON.stringify([comments[2], comments[1]]), ids.join(","));

      // ---- an inverse on the same host went in with the forward edge
      check("colocated inverse written inline", (await store.count(comments[0], COMMENT_ISSUE)) === 1);
      check("nothing queued for another host", this.#host.pending().length === 0);

      // ---- transactionSync rolls back: a refused write leaves no trace
      this.#host.setState("5", "fenced");
      const refused = this.#host.update({ id: issue, data: { title: "nope" }, epoch: 0 });
      this.#host.setState("5", "owned");
      const held = await this.#host.store().object(issue);
      const title = held && typeof held === "object" ? (held as { data: { title?: string } }).data.title : null;
      check("a refused write rolls back", refused.ok === false && title === "Crash on save", String(title));

      // ---- a vshard's rows are one key range, which is what a move copies. Taken before the
      // cascade below, or there would be nothing left in vshard 5 to find.
      this.#host.adopt("6");
      const other = this.#host.create({ otype: ISSUE, data: { title: "elsewhere" }, vshard: "6", epoch: 0 });
      const snap = this.#host.snapshot("5");
      check(
        "a snapshot takes one vshard and not its neighbour",
        other.ok === true &&
          snap.objects.length === 1 + comments.length &&
          snap.objects.every((o) => vshardOf(o.id) === 5n),
        `${snap.objects.length} objects, expected ${1 + comments.length}`,
      );
      check(
        "and it carries that vshard's edges and counts",
        snap.assocs.length === 2 * comments.length && snap.counts.length === 1 + comments.length,
        `${snap.assocs.length} edges, ${snap.counts.length} counts`,
      );

      // ---- onDelete cascade, in one transaction
      const deleted = this.#host.delete({ id: issue, epoch: 0 });
      const gone = await Promise.all(comments.map((c) => this.#host.store().object(c)));
      check("cascade", deleted.ok === true && gone.every((g) => g === null));
    } catch (e) {
      check("no exception", false, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    }

    const ok = checks.every((c) => c.ok);
    return Response.json({ ok, checks }, { status: ok ? 200 : 500 });
  }
}

interface Env {
  HLEKK_HOSTS: { idFromName(name: string): unknown; get(id: unknown): { fetch(url: string): Promise<Response> } };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // One host per request path, so a rerun starts clean.
    const name = new URL(req.url).searchParams.get("host") ?? `smoke-${Date.now()}`;
    const stub = env.HLEKK_HOSTS.get(env.HLEKK_HOSTS.idFromName(name));
    return stub.fetch("https://host/");
  },
};
