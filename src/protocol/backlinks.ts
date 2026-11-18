// Backlinks: an edge another database drew at this one, recorded here as an edge of this one's own.
//
// `hint.ts` is what arrives. This is what is done about it, and it is three functions because there
// are three parties to the act and each does one thing:
//
// - `sendHint`, by the database that drew the edge. Signed, best-effort, and never an error to the
//   write that preceded it — the edge is already written and is true whether or not anyone is told.
// - `checkHint`, by the database the edge points at. **A read of the source, over the protocol that
//   already exists.** This is the whole of the trust model: what gets recorded is what this database
//   read, so a hint that lies is a read that finds nothing.
// - `settleHint`, which puts the two together with this database's own policy: is there anything
//   here to hang an edge on, would it keep one, what did the read find, and then one write by its own
//   client.
//
// **What is recorded is an ordinary outbound edge.** `page --cited_by--> https://notes.example/db#7`
// is a foreign edge like any other, stored in this database, ordered by this database's clock,
// served under this database's policy, and read with the protocol exactly as it stood before any of
// this existed. Nothing here adds a kind of edge, and the cross-database graph is still made of
// outbound links only. A backlink is one of those, drawn by the database it points back from.
//
// **Policy before the read.** `settleHint` asks whether this database would keep anything BEFORE it
// spends a request on the source. A hint is an instruction to make a request, and the cheapest
// defence against being made to is to decide first that the answer would not matter.
//
// **The read is something the caller sees.** It arrives at the hinting database's own server, so
// whether one is made is an answer as surely as a status is — and the one answer a hint must not
// give is whether its target exists. So a target the hinting database could not have read is treated
// as one that is not there: no read, no pin, no row. And the hinting database is looked at without
// being remembered; it is interned and pinned only once an edge into it has actually been recorded,
// so a hint that is not true leaves nothing behind in the registry.

import type { Catalog } from "../catalog/catalog.ts";
import type { Hlekk } from "../client/client.ts";
import { parseId } from "../host/ids.ts";
import { canonicalDb, formatRef, parseRef } from "../query/ref.ts";
import type { Ref } from "../query/ref.ts";
import type { Id, Plan } from "../query/types.ts";
import { DEFAULT_HOP_LIMIT } from "../query/request.ts";
import { PUBLIC } from "../query/serve.ts";
import type { Policy } from "../query/serve.ts";
import { ForeignRefused, ForeignUnreachable, Repudiated, discoverPinned, exchange, readJson, refusalOf } from "./client.ts";
import type { ForeignOptions, Pins, TransportOptions } from "./client.ts";
import type { Descriptor } from "./http.ts";
import { signRequest } from "./identity.ts";
import type { SignedHeaders } from "./identity.ts";
import type { ReceivedHint } from "./hint.ts";
import { retryAfterOf } from "./backoff.ts";
import { WireError, decodeRead } from "./wire.ts";

/** What both halves need to reach another database: a transport, and optionally a name to sign as
 *  and a place to keep what the other database proved. */
export type Reach = TransportOptions & Pick<ForeignOptions, "identity" | "pins" | "now">;

// ---- sending

/** What became of a hint. Every arm but the first is a hint that was not taken, and none of them is
 *  an error: the edge it was about is written either way. */
export type HintSent =
  | { sent: true }
  /** The target database advertises no hint route. It keeps no backlinks, or none from strangers. */
  | { sent: false; why: "unsupported" }
  /** It answered and said no. Sending the same hint again gets the same answer. */
  | { sent: false; why: "refused"; status: number; error: string }
  /** It answered and said not now. `retryAfter` is in seconds, null when it did not say. */
  | { sent: false; why: "later"; status: number; retryAfter: number | null }
  | { sent: false; why: "unreachable"; error: string };

/**
 * Tells the database a reference points into that this database's `source` has, or no longer has,
 * an edge `edge` to it.
 *
 * Sent after the edge is written and after it is removed alike — a hint says "look", and the look is
 * what finds out which. **Sending one is consent**: it tells the target that the edge exists and
 * permits it to record that, so it is never sent on anyone's behalf but the application's own.
 *
 * Never throws for anything the other database did or failed to do. A hint may be dropped, and a
 * caller that wrapped its edge write and its hint in one `try` must not find the write reported as
 * failed because a stranger's server was down.
 */
export async function sendHint(target: Ref, source: Id, edge: string, opts: Reach): Promise<HintSent> {
  const { db, id } = parseRef(target);
  if (db === null) throw new TypeError(`a hint goes to another database, and ${target} is an object of this one`);
  parseId(source);
  if (opts.identity === undefined) {
    throw new TypeError("a hint is signed, and this database has no identity to sign with");
  }
  const { database, pair } = await opts.identity();
  if (database === null) throw new TypeError("a hint names its sender by URI, and this database was never told its own");
  if (database === db) throw new TypeError(`${target} is in this database; an edge into yourself is a local edge`);

  try {
    const descriptor = await discoverPinned(db, opts);
    // Read off the descriptor rather than tried and seen to fail: a 404 from a database that takes
    // no hints and a 404 from one that is misconfigured are the same bytes, and only one of them is
    // an answer.
    if (descriptor.routes.hint === undefined) return { sent: false, why: "unsupported" };
    const url = descriptor.routes.hint;
    const body = JSON.stringify({ source, edge, target: id });
    const signed = await signRequest({
      method: "POST",
      url,
      body,
      caller: database,
      seed: pair.seed,
      keyId: pair.public.id,
      created: Math.floor((opts.now?.() ?? Date.now()) / 1000),
    });
    const res = await exchange(db, url, opts, { method: "POST", body, headers: { "content-type": "application/json", ...signed } });
    if (res.status === 202) return { sent: true };
    if (res.status === 429 || res.status === 503) {
      return { sent: false, why: "later", status: res.status, retryAfter: retryAfterOf(res.headers) };
    }
    const refusal = refusalOf(res.body);
    return { sent: false, why: "refused", status: res.status, error: refusal?.error ?? `status ${res.status}` };
  } catch (e) {
    if (e instanceof ForeignUnreachable || e instanceof ForeignRefused || e instanceof Repudiated) {
      return { sent: false, why: "unreachable", error: e.message };
    }
    if ((e as Error).name === "PrivateAddress") return { sent: false, why: "unreachable", error: (e as Error).message };
    throw e;
  }
}

// ---- checking

/**
 * What a read of the source found.
 *
 * `unknown` is the important one. It is every outcome that is not a successful read to the end of
 * the answer — unreachable, refused, repudiated, malformed, a list longer than this database will
 * page through — and it changes nothing. An edge is recorded on `present` and removed on `absent`,
 * and "I could not tell" must never be either: recording on it would store a stranger's claim, and
 * removing on it would let anyone who can make the source unreachable erase its backlinks.
 */
export type Verdict = "present" | "absent" | "unknown";

export interface CheckOptions extends Reach {
  /** This database's own canonical URI. What is looked for is the reference `<self>#<target>`. */
  self: string;
  /** The catalog an answer is decoded against. Its types need not be the source's: an object of a
   *  type this database does not declare is declined, and the list that names it is still read. */
  catalog: Catalog;
  /**
   * Whether to read as this database or as nobody.
   *
   * `"anonymous"`, the default, sends no signature even when there is an identity to sign with. That
   * is the reading that makes a recorded backlink safe to serve to anyone: it is exactly what anyone
   * could have read from the source themselves. `"self"` signs, and may be shown an edge the public
   * is not — which this database then knows and must not pass on, since nothing in the protocol
   * would stop it (`docs/protocol.md`, "What authentication does not buy").
   */
  as?: "anonymous" | "self";
  /** Pages of the source's list to read before giving up with `unknown`. */
  maxPages?: number;
}

/** Pages read by default. With the usual page of 100, an edge among the newest 400 of its list is
 *  found; one deeper is `unknown`, which is the cost of a responder that will not answer "is this
 *  edge there" except by listing. */
export const DEFAULT_CHECK_PAGES = 4;

const LIST = "l";

/**
 * Reads the hinting database to see whether the edge it hinted at is there.
 *
 * The request is the one any caller could send: the source object, one hop over the named edge,
 * continued by the responder's own cursor. The edge name is the caller's and is sent as it came —
 * this database does not have to declare it, because the wire carries names and the answer is only
 * searched for one reference.
 */
export async function checkHint(hint: ReceivedHint, opts: CheckOptions): Promise<Verdict> {
  return (await look(hint, opts)).verdict;
}

/**
 * `checkHint`, with the descriptor the read was made against: what there is to pin, should the
 * verdict turn out to be worth remembering the database for. Absent where none was read.
 *
 * The database is looked at and **not remembered**. Pinning interns, and this is a database that
 * has so far done nothing but ask to be looked at; a row for each of those would be the registry
 * growing at a stranger's say-so, whatever the read then showed. A pin already held is still
 * checked — see `discoverPinned`.
 */
async function look(hint: ReceivedHint, opts: CheckOptions): Promise<{ verdict: Verdict; descriptor?: Descriptor }> {
  const db = canonicalDb(hint.caller);
  try {
    const descriptor = await discoverPinned(db, { ...opts, remember: false });
    return { verdict: await listed(hint, db, descriptor, opts), descriptor };
  } catch (e) {
    if (
      e instanceof ForeignRefused ||
      e instanceof ForeignUnreachable ||
      e instanceof Repudiated ||
      e instanceof WireError ||
      (e as Error).name === "PrivateAddress"
    ) {
      return { verdict: "unknown" };
    }
    throw e;
  }
}

/** Pages the source's list for the reference, and throws whatever a read throws. */
async function listed(hint: ReceivedHint, db: string, descriptor: Descriptor, opts: CheckOptions): Promise<Verdict> {
  const wanted = formatRef(canonicalDb(opts.self), hint.target);
  const signing = opts.as === "self" ? opts.identity : undefined;
  const limit = Math.min(descriptor.limits.maxLimit, Math.max(DEFAULT_HOP_LIMIT, 100));
  const url = descriptor.routes.read;
  let after: string | undefined;
  for (let page = 0; page < (opts.maxPages ?? DEFAULT_CHECK_PAGES); page++) {
    const body = JSON.stringify({
      ids: [hint.source],
      hops: [{ as: LIST, edge: hint.edge, limit, ...(after === undefined ? {} : { after }) }],
    });
    let signed: SignedHeaders = {};
    if (signing !== undefined && descriptor.keys.length > 0) {
      const { database, pair } = await signing();
      if (database !== null) {
        signed = await signRequest({
          method: "POST",
          url,
          body,
          caller: database,
          seed: pair.seed,
          keyId: pair.public.id,
          created: Math.floor((opts.now?.() ?? Date.now()) / 1000),
        });
      }
    }
    const answer = await readJson(db, url, opts, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", ...signed },
    });
    const decoded = decodeRead(answer, opts.catalog);
    const frame = decoded.result.shape[0]?.[LIST];
    const list = frame === undefined ? undefined : decoded.result.lists[`${frame}:${hint.source}`];
    // No list at all is the source not being there for this reader — absent, or hidden, which are
    // the same answer by design. Either way there is no edge this database may say it saw.
    if (list === undefined) return "absent";
    if (list.ids.includes(wanted)) return "present";
    if (!list.more || list.cursor === null) return "absent";
    after = list.cursor;
  }
  return "unknown";
}

// ---- settling

/** What settling one hint did. */
export type Settled =
  /** The source shows the edge, and this database now holds one back. */
  | "recorded"
  /** The source does not show it, and this database holds none back (whether or not it did). */
  | "removed"
  /** Nothing here the hinting database could have read to hang an edge on, or a policy that keeps
   *  none for this hint. No request made. */
  | "declined"
  /** The read did not get an answer. Nothing changed. */
  | "unknown";

export interface SettleOptions extends CheckOptions {
  /** This database's own client. The edge is written by it and by nothing else. */
  db: Hlekk;
  /**
   * Which of this database's edge types records the edge, or undefined to keep nothing.
   *
   * The whole of the policy, and it is asked before the source is read. It is given who is hinting,
   * what they call their edge, and the type of the object here that it points at — which is enough
   * to say "citations from these three databases", "anything pointing at a release", or nothing.
   *
   * The edge type it names must be this database's own, stored, declared `foreign`, and start at
   * that object's type. One that is not is a misconfiguration and throws, rather than quietly
   * recording nothing.
   */
  edgeFor: (hint: ReceivedHint, targetType: string) => string | undefined;
  /**
   * The policy this database would answer a read of the target under, for the database that hinted:
   * what `ServeOptions.policy` is for that caller. `PUBLIC` by default, as there. A function is for
   * a database whose policy differs by caller.
   *
   * **A deployment that serves under a policy has to hand the same one here.** A target it hides is
   * declined exactly as one that does not exist is, with no request made — because the checking read
   * lands on the hinting database's own server, and a read made only for targets that exist would
   * tell that database which ids do. Declining to look for a caller that could have seen the target
   * costs it nothing it was owed; looking for one that could not is the way around "forbidden is
   * indistinguishable from absent".
   */
  policy?: Policy | ((hint: ReceivedHint) => Policy | Promise<Policy>);
  /** Which object types this database exposes at all: `ServeOptions.exposes`, and for the same
   *  reason. A target of a type nobody can read is one nobody is told about either. */
  exposes?: (otype: number) => boolean;
}

const IDS_ONLY: Plan = { frames: [{ source: { kind: "ids" }, children: [], counts: [] }] };

/**
 * Decides one hint: reads what it has to and writes at most one edge.
 *
 * **Recorded with `assocAddIfAbsent`.** A plain add is an upsert that moves the edge to the head of
 * its list, and a source can hint as often as it likes — so with a plain add, the newest entry in
 * anybody's list of backlinks would be whoever repeated themselves most recently. The edge keeps the
 * time this database FIRST confirmed it, by this database's clock: the list is this database's, and
 * so is its order.
 */
export async function settleHint(hint: ReceivedHint, opts: SettleOptions): Promise<Settled> {
  const self = canonicalDb(opts.self);
  if (canonicalDb(hint.caller) === self) return "declined";

  // Is there anything here to hang an edge on? Read through this database's own client, which sees
  // everything — so what it found is then put to the policy a read by the hinting database would
  // have been answered under. A target that caller could not have read is, to it, a target that is
  // not there, and it has to stay one here: everything below this point ends in a request to the
  // caller's own server, which is how it would find out otherwise.
  const local = await opts.db.normalized(IDS_ONLY, [hint.target], { foreign: "reference" });
  const held = local.objects[hint.target];
  if (held === undefined) return "declined";
  const policy = typeof opts.policy === "function" ? await opts.policy(hint) : (opts.policy ?? PUBLIC);
  if (opts.exposes?.(held.otype) === false || !policy.object(hint.target, held.otype)) return "declined";
  const targetType = opts.catalog.object(held.otype)?.name;
  if (targetType === undefined) return "declined";

  const name = opts.edgeFor(hint, targetType);
  if (name === undefined) return "declined";
  const edge = opts.catalog.edgeNamed(name);
  if (edge === undefined || edge.atype === undefined || !edge.foreign || edge.from !== targetType) {
    throw new TypeError(
      `${name} cannot record a backlink to a ${targetType}: it has to be a stored edge type of this` +
        ` database, declared "foreign": true, that starts at ${targetType}`,
    );
  }

  const { verdict, descriptor } = await look(hint, opts);
  if (verdict === "unknown") return "unknown";
  const back = formatRef(hint.caller, hint.source);
  if (verdict === "present") {
    await opts.db.assocAddIfAbsent(edge.atype, hint.target, back, opts.now?.());
    await remember(hint.caller, descriptor, opts.pins);
    return "recorded";
  }
  // Removes what is there and allocates nothing: a database this one has no alias for is one it
  // holds no edge into, and `assocRemove` does not intern one to find that out.
  await opts.db.assocRemove(edge.atype, hint.target, back);
  return "removed";
}

/**
 * Pins the hinting database at the key its checking read was made against, now that this database
 * holds an edge into it.
 *
 * Here, and not when it was first looked at: the edge is what gave it an alias, and from this point
 * it is a database this one has a relationship with — pinned on first contact, like any other it
 * reads through, rather than at whatever key it shows the first time somebody follows the edge. A
 * pin that was already held was checked, and advanced, by the look itself.
 */
async function remember(database: string, descriptor: Descriptor | undefined, pins: Pins | undefined): Promise<void> {
  const current = descriptor?.keys.find((k) => k.retired === undefined);
  if (pins === undefined || current === undefined) return;
  const db = canonicalDb(database);
  const held = await pins.pinOf(db);
  if (held.pinned === null && held.state !== "repudiated") await pins.pin(db, current.id);
}
