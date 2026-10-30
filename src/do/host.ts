// A host, as a Durable Object. It owns some vshards and holds their rows in its own SQLite.
//
// Everything it does is `Host`'s, unchanged: this adds the three things a DO needs and the local code
// did not. It keeps the lock in its own storage, so an eviction does not leave it without a catalog.
// It routes its own outbox deliveries, which is why it holds the same bindings a Worker does — a host
// talks to hosts, not only Workers to hosts. And it drains the outbox from an alarm, rescheduling
// while rows remain, which is what makes a cross-host inverse edge eventually arrive with nothing
// driving it.

import { Catalog } from "../catalog/catalog.ts";
import type { Lock } from "../catalog/catalog.ts";
import { Hlekk } from "../client/client.ts";
import { applyTo } from "../client/transport.ts";
import type { Mutation } from "../client/transport.ts";
import { Deliverer } from "../host/outbox.ts";
import { Host } from "../host/host.ts";
import type { Snapshot } from "../host/host.ts";
import { vshardRange } from "../host/ids.ts";
import { doSql } from "../host/sql.ts";
import type { Sql } from "../host/sql.ts";
import type { Miss, Plan } from "../query/types.ts";
import type { Ctx, Env } from "./bindings.ts";
import { routedFromWire, serve } from "./rpc.ts";
import { cloudflareTransport } from "./transport.ts";

/** The DO layer's own row, for what a host needs across an eviction and the host schema has no place
 *  for. The catalog is not a host concept; where this host keeps its copy of one is. */
const META_DDL = "CREATE TABLE IF NOT EXISTS do_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)";

/** How long after a failed delivery pass to try again. An op is retried because its target moved, is
 *  fenced for a copy, or was briefly unreachable, so the wait only has to outlast a move. */
export const RETRY_MS = 1_000;

export class HlekkHostDO {
  readonly #ctx: Ctx;
  readonly #env: Env;
  readonly #sql: Sql;
  #host: Host | null = null;
  #client: Hlekk | null = null;

  constructor(ctx: Ctx, env: Env) {
    this.#ctx = ctx;
    this.#env = env;
    this.#sql = doSql(ctx.storage);
  }

  /** The host, opened against whatever catalog this DO was last told about. */
  #open(): Host {
    if (!this.#host) {
      // On first use, not in the constructor: a Durable Object may not touch its storage while it is
      // being constructed.
      this.#sql.run(META_DDL);
      const row = this.#sql.all<{ v: string }>("SELECT v FROM do_meta WHERE k = 'lock'")[0];
      const catalog = row ? Catalog.compile(JSON.parse(row.v) as Lock) : Catalog.empty();
      this.#host = Host.open(this.#sql, catalog);
    }
    return this.#host;
  }

  /** One client for the life of the DO, so the shard-map chunks it reads for delivery are reused
   *  rather than fetched per op. */
  #routing(): Hlekk {
    if (!this.#client) this.#client = Hlekk.from(cloudflareTransport(this.#env));
    return this.#client;
  }

  async fetch(request: Request): Promise<Response> {
    // The table is built per call, inside the handler, because opening the host is the first thing
    // that touches storage and a throw on the way to a handler would otherwise be unreportable.
    return serve(request, () => {
      const host = this.#open();
      return {
        setCatalog: (lock: Lock) => {
          this.#sql.run(
            "INSERT INTO do_meta (k, v) VALUES ('lock', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v",
            JSON.stringify(lock),
          );
          this.#host = null; // reopened against the new catalog on the next call
          return { version: lock.version };
        },

        /** A batch, not one call per vshard: a new database opens its first 64 at once. */
        adopt: (entries: { vshard: string; epoch: number }[]) => {
          for (const e of entries) if (!host.holds(BigInt(e.vshard))) host.adopt(e.vshard, e.epoch);
          return host.vshards().length;
        },

        exec: (plan: Plan, tasks: Miss[], routed: [string, number][]) =>
          host.exec(plan, tasks, routedFromWire(routed)),

        write: async (m: Mutation, epoch: number) => {
          const reply = applyTo(host, m, epoch);
          // A write that queued an inverse wakes the alarm. Delivery is never on the write's path:
          // the caller's reply does not wait for another host.
          if (reply.ok && host.pending(1).length > 0) await this.#wake();
          return reply;
        },

        // ---- the move protocol, each step one call

        fence: (vshard: string) => host.setState(vshard, "fenced"),
        snapshot: (vshard: string) => host.snapshot(vshard),
        install: (snapshot: Snapshot, epoch: number) => {
          host.install(snapshot, epoch);
          // Outbox rows move with their source vshard, so a vshard that arrives holding undelivered
          // work has to be drained by whoever holds it now.
          return this.#wake();
        },
        retire: (vshard: string) => host.setState(vshard, "moved"),
        purge: (vshard: string) => host.purge(vshard),

        // ---- what the placement controller, the global index and an operator ask for

        stats: () => host.stats(),
        size: () => host.size(),

        /** What this host holds. Separate from `stats`, which resets the request counters: a view
         *  that read those would be taking the controller's window. */
        holdings: () =>
          host.vshards().map((row) => {
            const [lo, hi] = vshardRange(BigInt(row.vshard));
            const n = this.#sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM objects WHERE id BETWEEN ? AND ?", lo, hi);
            return { vshard: String(row.vshard), state: row.state, epoch: row.epoch, objects: n[0]?.n ?? 0 };
          }),

        indexLookup: (vshard: string, idx: number, key: string) => {
          // Not "no entry": a missing vshard and a missing value are different answers, and the
          // caller re-resolves on the difference.
          if (!host.holds(BigInt(vshard))) throw new Error(`host does not hold index vshard ${vshard}`);
          return host.indexLookup(vshard, idx, key);
        },
        indexSweep: (vshard: string, now: number, ttlMs: number) => host.indexSweep(vshard, now, ttlMs),

        /** Drains the outbox now, for a caller that would rather not wait for an alarm. */
        drain: () => this.#drain(),
        pending: () => host.pending().length,
      };
    });
  }

  /** The alarm: one pass, then again while anything is left. */
  async alarm(): Promise<void> {
    const left = await this.#drain();
    if (left > 0) await this.#ctx.storage.setAlarm(Date.now() + RETRY_MS);
  }

  async #drain(): Promise<number> {
    const host = this.#open();
    const pass = await new Deliverer(host, this.#routing()).drainAll();
    return pass.pending;
  }

  /** Schedules the alarm unless one is already due. */
  async #wake(): Promise<void> {
    if ((await this.#ctx.storage.getAlarm()) === null) await this.#ctx.storage.setAlarm(Date.now() + 1);
  }
}
