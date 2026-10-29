// Moving a vshard, v1: stop-the-world, driven by the directory as a resumable state machine. A crash
// mid-move resumes from the step it recorded instead of leaving a vshard fenced forever.
//
// The source is fenced from the first step until the last, so the two hosts never both accept writes.
// Writes to that one vshard pause for the length of the copy; every other vshard is unaffected. Reads
// continue throughout: a fenced vshard still serves them.

import type { Snapshot } from "../host/host.ts";
import type { Directory } from "./directory.ts";

export const MOVE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS moves (
     vshard    INTEGER PRIMARY KEY,
     from_host INTEGER NOT NULL,
     to_host   INTEGER NOT NULL,
     epoch     INTEGER NOT NULL,   -- the epoch the vshard will be owned at
     state     TEXT    NOT NULL,
     attempts  INTEGER NOT NULL DEFAULT 0
   )`,
];

/** The steps, in order. Each is idempotent, so resuming re-runs the recorded one. */
export const STEPS = ["fence", "copy", "flip", "retire", "purge", "done"] as const;
export type Step = (typeof STEPS)[number];

export interface MoveRow {
  vshard: number;
  from_host: number;
  to_host: number;
  epoch: number;
  state: Step;
  attempts: number;
}

/** What the mover needs from the hosts. DO stubs in production. */
export interface MoveHosts {
  fence(host: number, vshard: string): Promise<void>;
  snapshot(host: number, vshard: string): Promise<Snapshot>;
  install(host: number, snapshot: Snapshot, epoch: number): Promise<void>;
  retire(host: number, vshard: string): Promise<void>;
  purge(host: number, vshard: string): Promise<void>;
  /** Called before the copy, so a brand-new target exists with the right region or jurisdiction. */
  ensure(host: number): Promise<void>;
}

export class MoveFailed extends Error {
  readonly vshard: string;
  readonly step: Step;
  constructor(vshard: string, step: Step, cause: unknown) {
    super(`moving vshard ${vshard} failed at ${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "MoveFailed";
    this.vshard = vshard;
    this.step = step;
    this.cause = cause;
  }
}

export class Mover {
  readonly directory: Directory;
  readonly hosts: MoveHosts;
  /** How many times a step may be retried before the move is left for a human. */
  readonly maxAttempts: number;

  constructor(directory: Directory, hosts: MoveHosts, maxAttempts = 8) {
    this.directory = directory;
    this.hosts = hosts;
    this.maxAttempts = maxAttempts;
    for (const stmt of MOVE_DDL) directory.sql.run(stmt);
  }

  /** Records the intent to move a vshard. Driving it is a separate call, so a crash between the two
   *  leaves a move to resume rather than a vshard half moved. */
  begin(vshard: bigint, to: number): MoveRow {
    const route = this.directory.resolve(vshard);
    if (!route) throw new Error(`no host owns vshard ${vshard}`);
    if (route.host === to) throw new Error(`vshard ${vshard} is already on host ${to}`);
    const existing = this.pending(vshard);
    if (existing) return existing;
    this.directory.sql.run(
      "INSERT INTO moves (vshard, from_host, to_host, epoch, state) VALUES (?, ?, ?, ?, 'fence')",
      Number(vshard),
      route.host,
      to,
      route.epoch + 1,
    );
    return this.pending(vshard)!;
  }

  pending(vshard: bigint): MoveRow | undefined {
    return this.directory.sql.all<MoveRow>("SELECT * FROM moves WHERE vshard = ?", Number(vshard))[0];
  }

  /** Every move still in flight, which is what an alarm picks up after a crash. */
  inFlight(): MoveRow[] {
    return this.directory.sql.all<MoveRow>("SELECT * FROM moves WHERE state != 'done' ORDER BY vshard");
  }

  /** Runs a move to completion, or to the first step that fails. Safe to call again after a failure:
   *  it resumes from the recorded step. */
  async run(vshard: bigint): Promise<Step> {
    if (!this.pending(vshard)) throw new Error(`no move recorded for vshard ${vshard}`);
    for (;;) {
      // Re-read each time: the last step removes the row, which is what "no move in flight" means.
      const move = this.pending(vshard);
      if (!move || move.state === "done") return "done";
      const v = move.vshard.toString();
      this.#attempt(move);
      try {
        await this.#step(move, v);
      } catch (e) {
        throw new MoveFailed(v, move.state, e);
      }
    }
  }

  /** Resumes every move in flight. An alarm calls this. */
  async resume(): Promise<void> {
    for (const move of this.inFlight()) {
      await this.run(BigInt(move.vshard));
    }
  }

  async #step(move: MoveRow, v: string): Promise<void> {
    switch (move.state) {
      case "fence":
        // Writes are rejected from here until retire, so the two hosts never both accept one.
        await this.hosts.fence(move.from_host, v);
        this.#advance(move, "copy");
        return;
      case "copy": {
        await this.hosts.ensure(move.to_host);
        this.directory.addHost(move.to_host);
        const snap = await this.hosts.snapshot(move.from_host, v);
        // Install marks it owned at epoch + 1 on the target. Both hosts now hold the rows, but only
        // the target would accept a write, and nothing routes there yet.
        await this.hosts.install(move.to_host, snap, move.epoch);
        this.#advance(move, "flip");
        return;
      }
      case "flip":
        // The one durable instant: before it the source is authoritative and fenced, after it the
        // target is. A reader with a stale route is refused and re-resolves.
        this.directory.assign(BigInt(move.vshard), move.to_host, move.epoch);
        this.#advance(move, "retire");
        return;
      case "retire":
        await this.hosts.retire(move.from_host, v);
        this.#advance(move, "purge");
        return;
      case "purge":
        // After a grace period in production, so a reader still holding the old route finds out by
        // being refused rather than by reading rows that are already gone.
        await this.hosts.purge(move.from_host, v);
        this.#advance(move, "done");
        return;
      case "done":
        return;
    }
  }

  #advance(move: MoveRow, to: Step): void {
    this.directory.sql.run("UPDATE moves SET state = ?, attempts = 0 WHERE vshard = ?", to, move.vshard);
    if (to === "done") this.directory.sql.run("DELETE FROM moves WHERE vshard = ?", move.vshard);
  }

  #attempt(move: MoveRow): void {
    const n = move.attempts + 1;
    if (n > this.maxAttempts) {
      throw new Error(`vshard ${move.vshard} has failed ${move.attempts} times at ${move.state}; leaving it alone`);
    }
    this.directory.sql.run("UPDATE moves SET attempts = ? WHERE vshard = ?", n, move.vshard);
  }
}
