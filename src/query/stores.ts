// Stores behind the operators: a host's local data (a stand-in for DO SQLite) and the coordinator's
// gathered graph. The async driver's store, which reaches the hosts, is in driver.ts.

import { isQualified } from "./ref.ts";
import { UNKNOWN, cursorOf, edgeOrder, listKey } from "./types.ts";
import type { Cursor, Edge, EdgePage, Id, Maybe, Obj, Store } from "./types.ts";

/** One host DO's data. It owns some vshards; everything else is UNKNOWN to it. */
export class HostData {
  readonly owns: (id: Id) => boolean;
  readonly objects = new Map<Id, Obj>();
  readonly lists = new Map<string, Edge[]>(); // each kept in edge order

  constructor(owns: (id: Id) => boolean) {
    this.owns = owns;
  }

  putObject(o: Obj): void {
    this.objects.set(o.id, o);
  }

  putEdge(e: Edge): void {
    const k = listKey(e.id1, e.atype);
    this.lists.set(k, [...(this.lists.get(k) ?? []), e].sort((a, b) => edgeOrder(cursorOf(a), cursorOf(b))));
  }
}

/** A host's store over its own data. Reads are synchronous, as DO SQLite's are, so every promise it
 *  returns is already settled. It records each known read so the host can ship back what it read. */
export class HostStore implements Store {
  readonly host: HostData;
  readonly #objects = new Map<Id, Obj | null>();
  readonly #lists: EdgeSegment[] = [];
  readonly #counts = new Map<string, number>();

  constructor(host: HostData) {
    this.host = host;
  }

  object(id: Id): Promise<Maybe<Obj | null>> {
    if (isQualified(id)) return Promise.resolve(UNKNOWN); // another database's object; see SqlStore
    if (!this.host.owns(id)) return Promise.resolve(UNKNOWN);
    // SELECT otype, version, data FROM objects WHERE id = ?
    const o = this.host.objects.get(id) ?? null;
    this.#objects.set(id, o);
    return Promise.resolve(o);
  }

  edges(id1: Id, atype: number, after: Cursor | null, n: number): Promise<Maybe<EdgePage>> {
    if (after?.token !== undefined) throw new TypeError("a host cannot place another database's continuation token");
    if (!this.host.owns(id1)) return Promise.resolve(UNKNOWN);
    // SELECT id2, time, data FROM assocs WHERE id1 = ? AND atype = ? AND (time, id2) < (?, ?)
    // ORDER BY time DESC, id2 DESC LIMIT n + 1 -- the extra row only says whether the list goes on.
    // Read into an array: a cursor must not stay open across an await.
    const rest = (this.host.lists.get(listKey(id1, atype)) ?? []).filter(
      (e) => after === null || edgeOrder(after, cursorOf(e)) < 0,
    );
    const page: EdgePage = { rows: rest.slice(0, n), complete: rest.length <= n };
    this.#lists.push({ id1, atype, after, ...page });
    return Promise.resolve(page);
  }

  count(id1: Id, atype: number): Promise<Maybe<number>> {
    if (!this.host.owns(id1)) return Promise.resolve(UNKNOWN);
    // SELECT n FROM assoc_counts WHERE id1 = ? AND atype = ?
    const n = this.host.lists.get(listKey(id1, atype))?.length ?? 0;
    this.#counts.set(listKey(id1, atype), n);
    return Promise.resolve(n);
  }

  /** Everything read so far, to ship back to the coordinator. */
  reads(): ReadSet {
    return { objects: [...this.#objects], lists: [...this.#lists], counts: [...this.#counts] };
  }
}

/** A run of one edge list as read: from the head (after = null) or after a cursor. */
export interface EdgeSegment extends EdgePage {
  id1: Id;
  atype: number;
  after: Cursor | null;
}

export interface ReadSet {
  objects: [Id, Obj | null][];
  lists: EdgeSegment[];
  counts: [string, number][];
}

/** A contiguous run of one edge list, as the coordinator knows it. `from` is the cursor it starts
 *  immediately after, or null when it starts at the head: without that, a run read from the middle
 *  would answer a read of the head. */
export interface KnownRun {
  from: Cursor | null;
  rows: Edge[];
  complete: boolean;
  /** For a list another database holds: where IT says the run continues. The coordinator cannot work
   *  that out — the responder dropped whatever its policy hides — so it carries what it was told. */
  next?: string;
}

/** The coordinator's normalized graph: everything hosts have shipped back so far. */
export class Cache {
  readonly objects = new Map<Id, Obj | null>();
  readonly lists = new Map<string, KnownRun>();
  readonly counts = new Map<string, number>();

  merge(r: ReadSet): void {
    for (const [id, o] of r.objects) this.objects.set(id, o);
    for (const [k, n] of r.counts) this.counts.set(k, n);
    for (const s of r.lists) this.#mergeSegment(s);
  }

  #mergeSegment(s: EdgeSegment): void {
    const k = listKey(s.id1, s.atype);
    const cur = this.lists.get(k);
    const after = s.after;

    // Nothing known yet: the segment is the run, starting wherever it was read from. A plan can name
    // a starting cursor, so the first read of a list is not always a read of its head.
    if (!cur) {
      this.lists.set(k, { from: after, rows: s.rows, complete: s.complete, ...(s.next !== undefined ? { next: s.next } : {}) });
      return;
    }
    // A list another database holds joins by TOKEN and not by sort key: the rows the responder
    // dropped are rows this side never saw, so the last row it holds is not where the next page
    // began. Only the token the responder handed back says that.
    if (after?.token !== undefined || cur.next !== undefined || s.next !== undefined) {
      if (after?.token !== undefined && cur.next === after.token) {
        this.lists.set(k, {
          from: cur.from,
          rows: [...cur.rows, ...s.rows],
          complete: s.complete,
          ...(s.next !== undefined ? { next: s.next } : {}),
        });
        return;
      }
      if (after === null && (s.complete || s.rows.length > cur.rows.length || cur.from !== null)) {
        // A re-read of the head supersedes whatever was held, as it does for a local list.
        this.lists.set(k, { from: null, rows: s.rows, complete: s.complete, ...(s.next !== undefined ? { next: s.next } : {}) });
      }
      // Anything else is two runs of a foreign list that do not meet, and joining them would invent
      // adjacency across rows a policy removed.
      return;
    }
    if (after === null) {
      // A read of the head. It supersedes a run that began mid-list, or one it reads further than.
      if (cur.from !== null || s.complete || s.rows.length > cur.rows.length) {
        this.lists.set(k, { from: null, rows: s.rows, complete: s.complete });
      }
      return;
    }
    // A continuation joins the known run where its cursor falls inside it.
    const i = cur.rows.findIndex((e) => edgeOrder(cursorOf(e), after) === 0);
    if (i >= 0) {
      const rows = [...cur.rows.slice(0, i + 1), ...s.rows];
      if (s.complete || rows.length > cur.rows.length) this.lists.set(k, { from: cur.from, rows, complete: s.complete });
      return;
    }
    // Or it starts exactly where the known run does, in which case it replaces it.
    if (cur.from !== null && edgeOrder(cur.from, after) === 0) {
      if (s.complete || s.rows.length > cur.rows.length) {
        this.lists.set(k, { from: cur.from, rows: s.rows, complete: s.complete });
      }
      return;
    }
    // Otherwise the two runs are disjoint and joining them would invent adjacency. Keep what we have;
    // the read that wanted the other run will ask again.
  }

  object(id: Id): Maybe<Obj | null> {
    const o = this.objects.get(id);
    return o === undefined ? UNKNOWN : o;
  }

  /** Up to n known edges after `after`. UNKNOWN when none are known there and the list goes on. */
  page(id1: Id, atype: number, after: Cursor | null, n: number): Maybe<EdgePage> {
    const list = this.lists.get(listKey(id1, atype));
    if (!list) return UNKNOWN;
    // A foreign list is addressed by token, and a run is only an answer to the read that asked for
    // the token it starts at. Anything else is UNKNOWN, which sends the read to the database that
    // holds the list — the only party that can place a token.
    if (after?.token !== undefined) {
      if (list.from?.token !== after.token) return UNKNOWN;
      const rows = list.rows.slice(0, n);
      return { rows, complete: list.complete && n >= list.rows.length, ...(list.next !== undefined ? { next: list.next } : {}) };
    }
    if (list.from?.token !== undefined) return UNKNOWN; // held from a token, asked for by sort key
    if (list.next !== undefined) {
      // A head read of a foreign list: the run is what it is, and `next` is where it goes on.
      if (list.from !== null) return UNKNOWN;
      const rows = list.rows.slice(0, n);
      return { rows, complete: list.complete && n >= list.rows.length, next: list.next };
    }
    // The known run has to cover where this read starts, or its rows say nothing about it.
    if (after === null) {
      if (list.from !== null) return UNKNOWN;
    } else if (
      list.from !== null &&
      edgeOrder(list.from, after) !== 0 &&
      !list.rows.some((e) => edgeOrder(cursorOf(e), after) === 0)
    ) {
      return UNKNOWN;
    }
    const i = after === null ? 0 : list.rows.findIndex((e) => edgeOrder(after, cursorOf(e)) < 0);
    const from = i < 0 ? list.rows.length : i;
    const rows = list.rows.slice(from, from + n);
    if (rows.length === 0 && !list.complete) return UNKNOWN;
    return { rows, complete: list.complete && from + n >= list.rows.length };
  }

  count(id1: Id, atype: number): Maybe<number> {
    const n = this.counts.get(listKey(id1, atype));
    return n === undefined ? UNKNOWN : n;
  }
}

/** The round driver's store: the gathered graph as it stands, with gaps UNKNOWN. */
export class CacheStore implements Store {
  readonly cache: Cache;

  constructor(cache: Cache) {
    this.cache = cache;
  }

  object(id: Id): Promise<Maybe<Obj | null>> {
    return Promise.resolve(this.cache.object(id));
  }

  edges(id1: Id, atype: number, after: Cursor | null, n: number): Promise<Maybe<EdgePage>> {
    return Promise.resolve(this.cache.page(id1, atype, after, n));
  }

  count(id1: Id, atype: number): Promise<Maybe<number>> {
    return Promise.resolve(this.cache.count(id1, atype));
  }
}
