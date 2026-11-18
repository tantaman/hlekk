// The hint: one database telling another where to look.
//
// A cross-database edge lives entirely in the database that drew it (`docs/protocol.md`, "The graph
// is directed and one-sided"), so the database it points at does not know it exists. A hint is how
// it finds out — and it is deliberately the weakest thing that could do that job:
//
//   "My object `source` may have an edge `edge` to your object `target`. Look if you care."
//
// **It is not a write.** Nothing in it is believed. A database that wants a backlink reads the
// source itself, over the protocol that already exists, and records what it READ — as an ordinary
// outbound edge of its own, written by its own client. So the cross-database graph is still outbound
// links only, there is still no operation by which one database changes another, and the one new
// thing a stranger can do is ask to be looked at.
//
// **It says "look", not "this exists".** The same hint is sent when an edge is drawn and when it is
// withdrawn, and the read is what tells them apart. That is what makes a duplicate, a replay and a
// lie all the same event: a read that finds what is there.
//
// This file is the wire half and the receiving half, with no network in it: what a hint is, and a
// bounded place to put one until somebody looks. `backlinks.ts` is the half that reads.

import { parseId } from "../host/ids.ts";
import { Refused } from "../query/request.ts";
import type { Id } from "../query/types.ts";
import { Backoff } from "./backoff.ts";

/** The body of `POST {db}/hint`. */
export interface Hint {
  /** The CALLER's own object, as a bare id of the calling database. Bare on purpose: a database may
   *  speak only about its own objects, and a reference that cannot name another database's is a rule
   *  nobody has to check. */
  source: Id;
  /** The edge type's name in the caller's vocabulary — what a read of `source` hops to find it. */
  edge: string;
  /** The answering database's own object, as a bare id of it. */
  target: Id;
}

export const HINT_MEMBERS = ["source", "edge", "target"] as const;

/** Longest edge name a hint may carry, which is `common.json`'s bound on any type name. */
const MAX_NAME = 128;

/**
 * Reads a hint off the wire, or refuses it naming where.
 *
 * As strict as a read request, and for the same reason: a member this does not know is refused
 * rather than ignored, because a caller that cannot tell whether what it sent took effect retries
 * blind. That matters more here than anywhere, since a hint's answer says nothing else.
 */
export function parseHint(body: unknown): Hint {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Refused("hint", "expected an object");
  const given = body as Record<string, unknown>;
  for (const name of Object.keys(given)) {
    if (!(HINT_MEMBERS as readonly string[]).includes(name)) {
      throw new Refused("hint", `no such member "${name}"; a hint takes ${HINT_MEMBERS.join(", ")}`);
    }
  }
  const id = (name: "source" | "target", whose: string): Id => {
    const value = given[name];
    if (typeof value !== "string") throw new Refused(name, `must be a decimal string, a bare id of ${whose}`);
    try {
      parseId(value);
    } catch (e) {
      // A qualified reference lands here too, and that is the rule rather than an accident of the
      // parser: `source` is the caller's own and `target` is this database's own, so neither has a
      // database to name.
      throw new Refused(name, `is not a bare id of ${whose}: ${(e as Error).message}`);
    }
    return value;
  };
  const source = id("source", "the calling database");
  const edge = given.edge;
  if (typeof edge !== "string" || edge.length === 0 || edge.length > MAX_NAME) {
    throw new Refused("edge", `must be an edge type name of 1 to ${MAX_NAME} characters`);
  }
  const target = id("target", "this database");
  return { source, edge, target };
}

/** A hint with the one fact about it that was verified: who signed it. */
export interface ReceivedHint extends Hint {
  /** The canonical URI of the database that signed the request, which is the database `source` is
   *  an id of. */
  caller: string;
}

/**
 * Where a hint goes once it has been received.
 *
 * `offer` must return quickly and must not read the calling database: the claim is looked at later,
 * off the request path, because a request that makes this database fetch from another while it
 * waits is a request whose latency a stranger chooses. It may throw `Backoff` to say "not now", and
 * it may drop a hint without saying so — nobody is owed a backlink.
 */
export interface HintSink {
  offer(hint: ReceivedHint): void | Promise<void>;
}

export interface HintQueueOptions {
  /** Hints held at once, from everybody. */
  capacity?: number;
  /** Hints held at once from one calling database. */
  perCaller?: number;
  /** Seconds a refused caller is told to wait. */
  retryAfter?: number;
}

/**
 * A bounded queue of hints nobody has looked at yet. In memory, and that is a decision.
 *
 * A hint may be dropped — that is the property that lets it exist at all. The outbox delivers an
 * inverse edge by retrying forever, which is why an inverse may not cross a database boundary: there
 * is no give-up, and it would need credentials to write somewhere else. A hint needs neither. If
 * this process dies with fifty of them queued, fifty edges go unrecorded until their sources say so
 * again, and nothing that was true has become false.
 *
 * Bounded twice, because the two bounds stop different things. `perCaller` stops one database from
 * filling the queue; `capacity` stops a thousand databases from filling memory. Neither stops a
 * thousand databases from filling the queue, which costs each of them a domain and a published key
 * and is what the 503 is for.
 */
export class HintQueue implements HintSink {
  readonly #pending = new Map<string, ReceivedHint>();
  readonly #held = new Map<string, number>();
  readonly #capacity: number;
  readonly #perCaller: number;
  readonly #retryAfter: number;

  constructor(opts: HintQueueOptions = {}) {
    this.#capacity = opts.capacity ?? 1024;
    this.#perCaller = opts.perCaller ?? 64;
    this.#retryAfter = opts.retryAfter ?? 30;
  }

  get size(): number {
    return this.#pending.size;
  }

  offer(hint: ReceivedHint): void {
    // The same hint again while the first is still waiting is one hint. It says "look", and one look
    // answers both — including when the second was sent because the edge was withdrawn.
    const key = JSON.stringify([hint.caller, hint.source, hint.edge, hint.target]);
    if (this.#pending.has(key)) return;
    const held = this.#held.get(hint.caller) ?? 0;
    if (held >= this.#perCaller) throw new Backoff(this.#retryAfter, "caller");
    if (this.#pending.size >= this.#capacity) throw new Backoff(this.#retryAfter, "database");
    this.#pending.set(key, hint);
    this.#held.set(hint.caller, held + 1);
  }

  /** Removes and returns up to `n` hints, oldest first. Taken rather than peeked: a hint that fails
   *  to settle is not put back, because the retry a hint gets is its source sending it again. */
  take(n = Infinity): ReceivedHint[] {
    const out: ReceivedHint[] = [];
    for (const [key, hint] of this.#pending) {
      if (out.length >= n) break;
      this.#pending.delete(key);
      const held = (this.#held.get(hint.caller) ?? 1) - 1;
      if (held <= 0) this.#held.delete(hint.caller);
      else this.#held.set(hint.caller, held);
      out.push(hint);
    }
    return out;
  }
}
