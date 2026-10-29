// The storage seam. A host's logic is written against this, so the same code runs over a Durable
// Object's ctx.storage.sql in production and over node:sqlite in tests. Both are synchronous, which
// is what lets a host answer a whole batch in one turn of the event loop, as one snapshot.
//
// No node builtins here: the node-backed implementation lives in sql.node.ts so a Workers build never
// reaches for one.

export type Param = string | number | bigint | null | Uint8Array;

export interface Sql {
  /** Rows as objects. Blobs come back as Uint8Array. */
  all<R extends object>(query: string, ...params: Param[]): R[];
  run(query: string, ...params: Param[]): void;
  /** One local transaction. A throw rolls it back and writes nothing. Nesting joins the outer one. */
  txn<T>(f: () => T): T;
  close(): void;
}

/** The shape a Durable Object's storage presents. */
export interface DoStorage {
  sql: { exec(query: string, ...params: unknown[]): { toArray(): unknown[] } };
  transactionSync<T>(f: () => T): T;
}

/** ctx.storage, for production. DO SQLite hands back blobs as ArrayBuffer, so they are normalized to
 *  Uint8Array here and nowhere else. */
export function doSql(storage: DoStorage): Sql {
  const blobs = (row: Record<string, unknown>) => {
    for (const k in row) {
      const v = row[k];
      if (v instanceof ArrayBuffer) row[k] = new Uint8Array(v);
    }
    return row;
  };
  return {
    all<R extends object>(query: string, ...params: Param[]): R[] {
      return storage.sql.exec(query, ...params).toArray().map((r) => blobs(r as Record<string, unknown>)) as R[];
    },
    run(query: string, ...params: Param[]): void {
      storage.sql.exec(query, ...params).toArray();
    },
    txn: (f) => storage.transactionSync(f),
    close: () => {},
  };
}
