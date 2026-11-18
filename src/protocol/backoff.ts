// "Not now", as distinct from "no".
//
// Every other refusal in this protocol is about the request: it names a part of what was sent, and
// sending the same thing again gets the same answer. This one is about the moment. The request was
// fine and will be fine later, and the only useful thing to tell the caller is how much later — which
// is exactly what a 400 cannot say, and why a responder with nothing but 400 to reach for teaches its
// callers to retry at once.
//
// Thrown by whatever a deployment plugs in — an admission check, a hint sink — and turned into a
// status by the handler, so a hook never has to know what HTTP calls it.

export class Backoff extends Error {
  /** Seconds until asking again is worth it. Whole and at least one: `Retry-After` has no fraction,
   *  and zero is an invitation to the retry loop this exists to prevent. */
  readonly seconds: number;
  /**
   * Whose limit was reached.
   *
   * `caller`: this caller has asked for too much, and another caller would be served. `database`:
   * nobody would be served right now. The handler answers 429 for the first and 503 for the second,
   * and the difference is one a caller acts on — the first is a reason to slow down, the second is
   * not a reason to think it did anything wrong.
   */
  readonly whose: "caller" | "database";

  constructor(seconds: number, whose: "caller" | "database" = "caller") {
    super(whose === "caller" ? `too many requests; retry in ${seconds} s` : `not serving now; retry in ${seconds} s`);
    this.name = "Backoff";
    this.seconds = Math.max(1, Math.ceil(Number.isFinite(seconds) ? seconds : 1));
    this.whose = whose;
  }
}
