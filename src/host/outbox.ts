// Outbox delivery. An alarm on the host drains its rows and deletes each one when acknowledged. A
// crash after commit loses nothing: the row is still there on the next alarm.
//
// In order, one at a time, per (source vshard, target vshard). Each inverse edge has exactly one
// writer, the vshard of its forward edge, so per-source ordering is enough. Groups are independent,
// so they drain together.

import type { Hlekk } from "../client/client.ts";
import type { Host, OutboxRow } from "./host.ts";

export interface Drained {
  /** Rows acknowledged and deleted. */
  delivered: number;
  /** Groups that stopped early, so their remaining rows wait for the next alarm. */
  stalled: number;
  /** Rows still waiting when this pass ended. */
  pending: number;
}

/** Groups rows by source and target vshard, each in sequence order. */
export function groups(rows: readonly OutboxRow[]): OutboxRow[][] {
  const by = new Map<string, OutboxRow[]>();
  for (const r of rows) {
    const k = `${r.vshard}:${r.target_vshard}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by.values()].map((g) => [...g].sort((a, b) => a.seq - b.seq));
}

export class Deliverer {
  readonly host: Host;
  readonly client: Hlekk;
  /** Reasons groups stalled, for a log or a test. */
  readonly failures: Error[] = [];

  constructor(host: Host, client: Hlekk) {
    this.host = host;
    this.client = client;
  }

  /** One pass of the alarm. Delivery routes through the client, so a target that has moved is found
   *  again and the row is retried against its new owner rather than lost. */
  async drain(limit = 64): Promise<Drained> {
    const rows = this.host.pending(limit);
    let delivered = 0;
    let stalled = 0;
    this.failures.length = 0;

    await Promise.all(
      groups(rows).map(async (group) => {
        for (const row of group) {
          try {
            // Apply is an upsert, a delete-if-present or a delete-if-present, so a redelivery after a
            // lost ack is a no-op.
            await this.client.write({ kind: "apply", op: row.op });
          } catch (e) {
            // Stop this group: a later op must not overtake the one that failed. Other groups carry on.
            this.failures.push(e instanceof Error ? e : new Error(String(e)));
            stalled++;
            return;
          }
          this.host.ack(row.vshard, row.seq);
          delivered++;
        }
      }),
    );

    return { delivered, stalled, pending: this.host.pending(limit).length };
  }

  /** Drains until nothing is left or nothing more can be done. An alarm reschedules instead. */
  async drainAll(passes = 16): Promise<Drained> {
    let last: Drained = { delivered: 0, stalled: 0, pending: this.host.pending().length };
    for (let i = 0; i < passes && last.pending > 0; i++) {
      const pass = await this.drain();
      last = { delivered: last.delivered + pass.delivered, stalled: pass.stalled, pending: pass.pending };
      if (pass.delivered === 0) break; // no progress: leave it for the next alarm
    }
    return last;
  }
}
