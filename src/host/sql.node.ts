// node:sqlite behind the Sql seam, for tests and the local harness. Kept apart from sql.ts so a
// Workers build never imports a node builtin.

import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Param, Sql } from "./sql.ts";

export function nodeSql(path = ":memory:"): Sql {
  const db = new DatabaseSync(path);
  const cache = new Map<string, StatementSync>();
  const prep = (q: string) => {
    let s = cache.get(q);
    if (!s) cache.set(q, (s = db.prepare(q)));
    return s;
  };
  let open = false;
  return {
    all<R extends object>(query: string, ...params: Param[]): R[] {
      return prep(query).all(...(params as never[])) as unknown as R[];
    },
    run(query: string, ...params: Param[]): void {
      prep(query).run(...(params as never[]));
    },
    txn<T>(f: () => T): T {
      if (open) return f(); // DO's transactionSync nests; only the outermost one commits
      open = true;
      db.exec("BEGIN");
      try {
        const v = f();
        db.exec("COMMIT");
        return v;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      } finally {
        open = false;
      }
    },
    close: () => db.close(),
  };
}
