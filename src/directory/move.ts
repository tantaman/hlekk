// Moving a vshard, v1: stop-the-world, driven by the directory as a resumable state machine. A crash
// mid-move resumes from the step it recorded instead of leaving a vshard fenced forever.
//
// The source is fenced from the first step until the last, so the two hosts never both accept writes.
// Writes to that one vshard pause for the length of the copy; every other vshard is unaffected. Reads
// continue throughout: a fenced vshard still serves them.
//
// The copy goes a chunk at a time, and the directory records the cursor after each one, so a copy
// that dies partway resumes where it stopped rather than from the top. A whole vshard never has to
// fit in one request, one transaction or one isolate: that is what bounds a move by the vshard cap
// rather than by the size of a request.

import { COPY_START, DEFAULT_CHUNK } from "../host/host.ts";
import type { ChunkBudget, CopyCursor } from "../host/host.ts";
import type { Directory } from "./directory.ts";

export const MOVE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS moves (
     vshard    INTEGER PRIMARY KEY,
     from_host INTEGER NOT NULL,
     to_host   INTEGER NOT NULL,
     epoch     INTEGER NOT NULL,   -- the epoch the vshard will be owned at
     state     TEXT    NOT NULL,
     attempts  INTEGER NOT NULL DEFAULT 0,
     cursor    TEXT                -- during copy: NULL before it starts, then where the next chunk starts, then 'end'
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
  /** The copy's progress, as recorded. See `MOVE_DDL`. */
  cursor: string | null;
}

/** Every chunk is installed and the target owns the vshard at the move's epoch, unrouted. */
const COPIED = "end";

/** What the mover needs from the hosts. DO stubs in production. */
export interface MoveHosts {
  fence(host: number, vshard: string): Promise<void>;
  /**
   * Copies one chunk of `vshard` from host `from` to host `to`, starting at `cursor`, and installs it
   * on `to` at `epoch`. Returns where the next chunk starts, or null once the last one is installed,
   * which is also when `to` takes ownership.
   *
   * One call rather than a read and a write so that an implementation can have the target pull the
   * chunk straight from the source: a chunk is megabytes, and carried through the directory it would
   * be parsed and re-serialized there, two thousand times over for a full vshard.
   */
  copy(from: number, to: number, vshard: string, cursor: CopyCursor, epoch: number, budget: ChunkBudget): Promise<CopyCursor | null>;
  /** Clears what an earlier copy left on `host`, at most `rows` rows a call. True once none are left. */
  discard(host: number, vshard: string, epoch: number, rows: number): Promise<boolean>;
  retire(host: number, vshard: string): Promise<void>;
  /** Drops a retired vshard's rows, at most `rows` a call. True once the vshard is gone. */
  purge(host: number, vshard: string, rows: number): Promise<boolean>;
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
  /** What one chunk of a copy may carry, and how many rows one purge or discard call deletes. */
  readonly budget: ChunkBudget;

  constructor(directory: Directory, hosts: MoveHosts, maxAttempts = 8, budget: ChunkBudget = DEFAULT_CHUNK) {
    this.directory = directory;
    this.hosts = hosts;
    this.maxAttempts = maxAttempts;
    this.budget = budget;
    for (const stmt of MOVE_DDL) directory.sql.run(stmt);
    // A directory that recorded moves before copies were chunked has no `cursor`. Probed by asking
    // for the column, since a missing column is an error on every SQLite and which pragmas a
    // platform exposes is the platform's business. A NULL cursor is a copy from the top, which is
    // exactly what a move recorded at `copy` by the old code needs.
    try {
      directory.sql.all("SELECT cursor FROM moves LIMIT 0");
    } catch {
      directory.sql.run("ALTER TABLE moves ADD COLUMN cursor TEXT");
    }
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
   *  it resumes from the recorded step, and a copy from the recorded chunk. */
  async run(vshard: bigint): Promise<Step> {
    if (!this.pending(vshard)) throw new Error(`no move recorded for vshard ${vshard}`);
    let rewound = false;
    for (;;) {
      // Re-read each time: the last step removes the row, which is what "no move in flight" means.
      const move = this.pending(vshard);
      if (!move || move.state === "done") return "done";
      const v = move.vshard.toString();
      this.#attempt(move);
      try {
        await this.#step(move, v);
      } catch (e) {
        // The source was found taking writes during the copy, so the chunks already on the target
        // cannot be trusted to match it. Fence again and copy from the top, which discards them.
        // Once per run: nothing in this codebase unfences a vshard mid-move, so a second time in one
        // run is a bug somewhere else, and it fails loudly rather than copying in a loop. The move
        // is left rewound, so the next run starts from the fence.
        if (move.state === "copy" && e instanceof Error && e.name === "Unfenced") {
          this.#rewind(move);
          if (!rewound) {
            rewound = true;
            continue;
          }
        }
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
        let at = move.cursor;
        if (at === null) {
          // A copy from the top starts from an empty target. Whatever an abandoned or rewound copy
          // left there was copied from a source that may have changed since, and a row the source
          // has deleted would otherwise come back with the rest.
          while (!(await this.hosts.discard(move.to_host, v, move.epoch, this.budget.rows))) {
            // a bounded delete per call, until the target reports nothing left
          }
          at = this.#record(move, COPY_START);
        }
        while (at !== COPIED) {
          // Each chunk installs as one transaction on the target, and the cursor is recorded only
          // once it has: a crash in between re-sends that chunk, which lands as a no-op. The last
          // chunk takes ownership at epoch + 1. Both hosts then hold the rows, but only the target
          // would accept a write, and nothing routes there yet.
          const next = await this.hosts.copy(move.from_host, move.to_host, v, JSON.parse(at) as CopyCursor, move.epoch, this.budget);
          at = this.#record(move, next);
        }
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
        // being refused rather than by reading rows that are already gone. A bounded delete per
        // call, for the same reason the copy is chunked: a whole vshard is too much for one request.
        while (!(await this.hosts.purge(move.from_host, v, this.budget.rows))) {
          // a bounded delete per call, until the source reports the vshard gone
        }
        this.#advance(move, "done");
        return;
      case "done":
        return;
    }
  }

  /** Records where the copy has got to, and returns it as stored. A step's success resets the attempt
   *  count, so a long copy that keeps making progress is never mistaken for one that is stuck. */
  #record(move: MoveRow, next: CopyCursor | null): string {
    const at = next === null ? COPIED : JSON.stringify(next);
    this.directory.sql.run("UPDATE moves SET cursor = ?, attempts = 0 WHERE vshard = ?", at, move.vshard);
    return at;
  }

  #advance(move: MoveRow, to: Step): void {
    this.directory.sql.run("UPDATE moves SET state = ?, attempts = 0, cursor = NULL WHERE vshard = ?", to, move.vshard);
    if (to === "done") this.directory.sql.run("DELETE FROM moves WHERE vshard = ?", move.vshard);
  }

  /** Back to the fence, with the copy to start again from the top. */
  #rewind(move: MoveRow): void {
    this.directory.sql.run("UPDATE moves SET state = 'fence', cursor = NULL WHERE vshard = ?", move.vshard);
  }

  #attempt(move: MoveRow): void {
    const n = move.attempts + 1;
    if (n > this.maxAttempts) {
      throw new Error(`vshard ${move.vshard} has failed ${move.attempts} times at ${move.state}; leaving it alone`);
    }
    this.directory.sql.run("UPDATE moves SET attempts = ? WHERE vshard = ?", n, move.vshard);
  }
}
