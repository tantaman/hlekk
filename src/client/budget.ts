// What one query may spend reaching other databases, and the wrapper that spends it.
//
// It was part of the client. It is its own file because there are now two things that run a query
// across databases — `client.ts`, over a database of its own, and `reader/reader.ts`, over none — and a
// bound that only one of them enforced would not be a bound on the other.

import type { HostClient } from "../query/driver.ts";
import type { Clock } from "../runtime/runtime.ts";

/**
 * What one query may spend reaching other databases.
 *
 * Per query, not per client: a foreign client is built once per isolate and a budget that lived
 * there would be shared by every query the isolate runs, which is the opposite of what it is for.
 * One tenant's query latency is partly another tenant's problem the moment a hop crosses the
 * internet, and three numbers are what bound it — a deadline, how many requests, and how many
 * databases.
 */
export interface Budget {
  /** Milliseconds for the whole query's foreign hops. */
  deadlineMs?: number;
  /** Requests to other databases. */
  requests?: number;
  /** Databases one query may reach. */
  databases?: number;
}

export const DEFAULT_BUDGET: Required<Budget> = { deadlineMs: 15_000, requests: 64, databases: 8 };

/** A query's budget, spent. `what` is which of the three ran out, so a caller can raise the right
 *  one rather than guessing. */
export class BudgetSpent extends Error {
  readonly what: "deadline" | "requests" | "databases";
  constructor(what: "deadline" | "requests" | "databases", detail: string) {
    super(`this query's foreign-hop budget is spent: ${detail}`);
    this.name = "BudgetSpent";
    this.what = what;
  }
}

/**
 * One query's budget, as a wrapper around whichever foreign client it reaches for.
 *
 * The wrapper and not the client, because the client is cached for the isolate and the budget is
 * not. Every hop goes through here, so the three numbers are enforced in one place and a refusal
 * says which ran out.
 */
export function budgeted(clock: Clock, given: Budget | undefined): (database: string, client: HostClient) => HostClient {
  const budget = { ...DEFAULT_BUDGET, ...given };
  const until = clock.now() + budget.deadlineMs;
  const reached = new Set<string>();
  let requests = budget.requests;
  // One wrapper per database per query, and not one per call. Both drivers batch by client
  // IDENTITY, so a fresh object per miss would put every miss in its own batch — twelve objects in
  // one database would be twelve requests, which is exactly what the batching exists to avoid.
  const wrapped = new Map<string, HostClient>();
  const wrap = (database: string, client: HostClient): HostClient => ({
    exec: async (plan, tasks) => {
      if (!reached.has(database) && reached.size >= budget.databases) {
        throw new BudgetSpent(
          "databases",
          `${budget.databases} databases, and ${database} would be the ${reached.size + 1}st`,
        );
      }
      reached.add(database);
      const remaining = until - clock.now();
      const expired = () => new BudgetSpent("deadline", `${budget.deadlineMs} ms for foreign hops to ${database}`);
      if (remaining <= 0) throw expired();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(expired()), remaining);
      const spend = () => {
        if (clock.now() >= until || controller.signal.aborted) throw expired();
        if (requests <= 0) throw new BudgetSpent("requests", `${budget.requests} requests to other databases`);
        requests--;
        return controller.signal;
      };
      try {
        if (!client.metersRequests) spend();
        const timedOut = new Promise<never>((_, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        });
        return await Promise.race([client.exec(plan, tasks, spend), timedOut]);
      } finally {
        clearTimeout(timer);
      }
    },
  });
  return (database, client) => {
    let held = wrapped.get(database);
    if (!held) wrapped.set(database, (held = wrap(database, client)));
    return held;
  };
}
