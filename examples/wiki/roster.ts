// The host roster a visitor's page draws its grid from.
//
// Its own module, and not beside the route that serves it, for a reason the suite cannot see: the
// Workers runtime accepts only handlers and functions as an entry module's named exports, so a
// constant exported from `wiki-app.ts` passes every test under Node and then stops the Worker from
// starting at all (`Incorrect type for map entry 'ROSTER_TTL_MS'`). Found by running it on workerd.

/** What a visitor may know about the cluster: which hosts exist, and how much each holds. */
export interface Roster {
  hosts: { host: number; objects: number; vshards: number }[];
  /** How many vshards serve the title index. The count, not which. */
  indexVshards: number;
}

/**
 * The public part of the directory's `where` reply.
 *
 * `where` is an operator's view: the database's name, its catalog and map versions, every vshard a
 * host holds with its epoch and state, each host's undelivered outbox and the moves in flight. The
 * page draws a grid of hosts and lights the ones that served a read, which needs three numbers per
 * host. So this copies those and nothing else, field by field, so a field added to `where` later is
 * not published by default.
 */
export function narrowRoster(where: {
  hosts: { host: number; objects: number; vshards: number }[];
  indexVshards: unknown[];
}): Roster {
  return {
    hosts: where.hosts.map((h) => ({ host: h.host, objects: h.objects, vshards: h.vshards })),
    indexVshards: where.indexVshards.length,
  };
}

/** How long one isolate keeps a roster. The page said of this read that it "does not change while the
 *  demo is being looked at", which is true of a loaded, read-only database for far longer. */
export const ROSTER_TTL_MS = 10 * 60_000;

const rosters = new WeakMap<object, { at: number; roster: Promise<Roster> }>();

/**
 * The roster for one deployment, read at most once per isolate per `ROSTER_TTL_MS`.
 *
 * WHY IT IS HELD. `where` asks every host what it holds and what it has pending, so one call is two
 * requests per host and a `COUNT(*)` per vshard: 86 requests on the 43-host pilot, which
 * `wikimedia-import.md` records overloading the directory under load. The page asked for it on every
 * visit, so one public GET bought 86 Durable Object requests, as often as anyone cared to send it.
 * Held here, a visit costs a map lookup and the fan-out happens once per isolate per window however
 * many visitors arrive.
 *
 * Keyed by an object the caller keeps for the isolate's life. Callers that arrive while a load is in
 * flight share it. A load that fails is forgotten rather than held, so one overloaded moment does not
 * become ten minutes of a missing grid.
 */
export function rosterOf(key: object, now: number, load: () => Promise<Roster>): Promise<Roster> {
  const held = rosters.get(key);
  if (held !== undefined && now - held.at < ROSTER_TTL_MS) return held.roster;
  const roster = load();
  rosters.set(key, { at: now, roster });
  roster.catch(() => {
    if (rosters.get(key)?.roster === roster) rosters.delete(key);
  });
  return roster;
}
