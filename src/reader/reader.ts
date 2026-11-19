// A reader: queries across databases, from a process that has none of its own.
//
// `client/client.ts` is a client over a database you run, which can also follow an edge out of it. This is
// the other half of that sentence on its own. It has no hosts, no directory and no storage, and it
// imports nothing from a platform, so it runs wherever `fetch` does.
//
// It is not a second implementation of the asking half. The two drivers already run a query over
// whatever `route` hands them, and `protocol/client.ts` already turns a database reached over HTTP
// into one of those: batching, the responder's own page tokens, the deadline and the byte cap, no
// redirects, pinned keys, and an answer validated rather than cast. What a database of your own adds
// to that is a catalog — the integers a plan is written in, and the names they stand for. So that is
// the one thing this file supplies, and it supplies it two ways:
//
// - **From the responder.** Each database is read by its own `/vocabulary`, numbered for the read.
//   A name has one number for the whole of a read, so a plan means the same thing in every database
//   it reaches, while the fields behind the name are whatever that database says they are. Nothing
//   has to be declared to read a database nobody described.
// - **From a lock**, for a caller that has one and a module generated from it. Its numbers are kept,
//   so that module's queries run here unchanged, and its fields are what an answer is narrowed to —
//   with a type the responder cannot fill declined rather than guessed at, as in the engine.
//
// **One catalog per database, not one for the reader.** A single merged catalog was the simpler
// thing and it is wrong. Two publishers may use one type name for different shapes, and the union
// of their fields describes neither: a field one of them calls an id would be read as a reference
// in the other's payload. Read by its own vocabulary, each database's objects carry the fields that
// database states, and a hop is only ever sent to a database that exposes its edge — an unknown one
// is asked of whichever database the references lead to, which is what "the caller is the hub"
// means. (The engine's client learned the second half of that from this file: see `subtree` in
// `protocol/client.ts`.)
//
// **Every edge a vocabulary names is read as a list.** A vocabulary says whether an edge is counted,
// which tells a stored edge from a field relationship, and does not say which field — so a reader
// cannot follow one by reading the payload itself. It does not need to: a hop names the edge, and
// the responder answers a field relationship as a list of at most one.
//
// **Some of a request can only be refused once it has been asked.** Whether a filter's field
// exists, and whether a name the caller chose is one the object already has, are questions about a
// type, and a reader learns what an object is from the database holding it. So those two refusals
// come after the read instead of before it (`#late`). They still come, with their place in the
// request, and not as an empty page or a field that went missing.
//
// **What a reader keeps is bounded.** Between reads it keeps a vocabulary per database, for as many
// databases as `vocabularies` allows, and what each database proved about itself. It does not keep
// the numbers. They were once given for the life of the reader, which kept every name any request
// had ever used — and a request written by someone guessing at names is mostly names no database
// has. Given per read, they go when the read does.
//
// A reader is the anonymous caller. A signature names a database (`spec/protocol.md` §7.2), and
// this is not one.

import { Catalog, CatalogError } from "../catalog/catalog.ts";
import type { FieldSpec, Lock, ObjectType } from "../catalog/catalog.ts";
import { runAsync, runRounds } from "../query/driver.ts";
import { stoppedAt } from "../query/ops.ts";
import type { Answer, HostClient, Stats } from "../query/driver.ts";
import { canonicalDb, formatRef, parseRef } from "../query/ref.ts";
import type { Ref } from "../query/ref.ts";
import { PROTOCOL_ALIASING, Refused, checkAliases, checkShape, checkValue, compile, countEdge, onlyKnown } from "../query/request.ts";
import type { Cmp, Cost, CountSpec, Request } from "../query/request.ts";
import { listKey, targetOf } from "../query/types.ts";
import type { Cursor, Id, Json, Miss, Obj, Plan, Source } from "../query/types.ts";
import { systemClock } from "../runtime/runtime.ts";
import type { Clock } from "../runtime/runtime.ts";
import { decodeCursor, pageEnd } from "../schema/query.ts";
import {
  ForeignUnreachable,
  NotFollowed,
  ResponseCache,
  askPrice,
  discoverPinned,
  discoverVocabulary,
  foreignClient,
  vocabularyHeld,
} from "../protocol/client.ts";
import type { ForeignOptions, Omitted, Pins } from "../protocol/client.ts";
import type { Descriptor } from "../protocol/http.ts";
import type { VocabularyDoc } from "../protocol/surface.ts";
import { budgeted } from "../client/budget.ts";
import type { Budget } from "../client/budget.ts";
import { ReadBuilder } from "./query.ts";

export interface ReaderOptions {
  /**
   * Your own declarations, for a caller that has a lock and a module generated from it.
   *
   * Its integers are kept, so that module's queries run here unchanged. A type it declares is read
   * through the fields it declares, and declined where the responder cannot supply one it requires.
   * Absent, every database is read by its own vocabulary and nothing is declared at all.
   */
  lock?: Lock;
  /** Injected, so a test can hand in the handler itself. */
  fetch?: typeof fetch;
  /**
   * Refuses a URI before it is reached, where the platform can tell.
   *
   * A reference is written by whoever wrote the edge, so following one is being told where to
   * connect. A process that can reach a private network has to refuse those addresses, and that
   * needs DNS, which this file does not have: `adapters/node` supplies the guard and a `reader()`
   * that carries it.
   */
  guard?: ForeignOptions["guard"];
  deadlineMs?: number;
  maxResponseBytes?: number;
  /** Where a database's proven key is recorded. Held in memory by default, which catches a key that
   *  changes under a running reader and forgets it when the process ends. */
  pins?: Pins;
  /** Answers kept for as long as their responder permits. On by default; `false` asks every time. */
  cache?: ResponseCache | false;
  /** What one read may spend. A read may narrow or widen it. */
  budget?: Budget;
  /**
   * How many databases' vocabularies are kept between reads.
   *
   * One past it is forgotten, the one longest unread first, and asked for again when a read next
   * reaches that database. Without a bound, a reader that follows references wherever they lead
   * keeps a document for every database it ever met.
   */
  vocabularies?: number;
  clock?: Clock;
  /** Milliseconds since the epoch, for the cache and the vocabulary's age. */
  now?: () => number;
}

export interface ReadOptions {
  budget?: Budget;
  /**
   * Collects databases that could not be reached instead of failing the read.
   *
   * Absent, an unreachable database fails the read by name. Present, what it held is left out, and
   * this says which databases and how many references — an answer that is missing something has to
   * say so, because an empty list is never how a failure is reported. Give it a `references` array
   * and it names them too: `{ databases: {}, references: [] }`.
   *
   * It covers a database out of reach, and not a request that is wrong. One a database refuses as
   * a bad request fails the read either way: nothing was missing but a correct request.
   */
  omit?: Omitted;
  driver?: "async" | "rounds";
  /** Filled in with what the read cost: rounds, and requests. */
  stats?: Stats;
}

/** One page of a list: what a hop returns. A list is always a page, so it always says whether it
 *  goes on and where from. */
export interface Page<R extends Row = Row> {
  items: R[];
  /** Hand it back as the hop's `after`. Opaque. */
  cursor: string | null;
  more: boolean;
}

/** An object as a read returns it: its payload, and beside it what the payload cannot say. */
export interface Row {
  /** Always a full reference. A reader has no database for a bare id to be relative to. */
  id: Ref;
  /** The type's name, as the database holding the object states it. */
  $type: string;
  $version: number;
  /** The edge that reached it. Absent on a root. */
  $edge?: { time: number; data: Json | null };
  [name: string]: Json | Page | undefined;
}

/**
 * A hop or a count over an edge the database holding the object does not expose.
 *
 * Not an empty list. A database that has no such edge was not asked a question it could answer, and
 * nothing is an answer a caller cannot tell from a true empty list.
 */
export class NoSuchEdge extends Error {
  readonly database: string;
  readonly edge: string;
  constructor(database: string, edge: string, exposed: readonly string[]) {
    super(`${database} exposes no edge ${JSON.stringify(edge)}; it has ${exposed.join(", ") || "none"}`);
    this.name = "NoSuchEdge";
    this.database = database;
    this.edge = edge;
  }
}

/** Pins that live as long as the reader does. */
export function memoryPins(): Pins {
  const held = new Map<string, { pinned: string | null; state: string | null }>();
  const of = (uri: string) => held.get(uri) ?? { pinned: null, state: null };
  return {
    pinOf: async (uri) => of(uri),
    pin: async (uri, keyId) => void held.set(uri, { ...of(uri), pinned: keyId }),
    repudiate: async (uri) => void held.set(uri, { ...of(uri), state: "repudiated" }),
  };
}

/** How many vocabularies a reader keeps unless it is told otherwise. */
export const VOCABULARIES_KEPT = 128;

/** A name's number, for one read. Objects and edges are numbered separately, as a lock numbers
 *  them, and a lock's own numbers are the ones every read starts from. */
class Names {
  readonly #numbers = new Map<string, number>();
  readonly #names = new Map<number, string>();

  constructor(taken: Iterable<[string, number]> = []) {
    for (const [name, n] of taken) this.#set(name, n);
  }

  #set(name: string, n: number): void {
    this.#numbers.set(name, n);
    this.#names.set(n, name);
  }

  of(name: string): number {
    let n = this.#numbers.get(name);
    if (n === undefined) {
      n = this.#names.size + 1;
      while (this.#names.has(n)) n++;
      this.#set(name, n);
    }
    return n;
  }

  named(n: number): string | undefined {
    return this.#names.get(n);
  }
}

/** A field as a vocabulary describes it, back as a spec. A description this reader has no name for
 *  is still a value it can carry, so it is read as JSON rather than refused. */
function specOf(described: { type: string; optional: boolean }): FieldSpec {
  const id = /^id\((.+)\)$/.exec(described.type);
  const values = /^enum\((.*)\)$/.exec(described.type);
  const spec: FieldSpec = id
    ? { id: id[1]! }
    : values
      ? { enum: values[1]!.split("|") }
      : described.type === "string" || described.type === "number" || described.type === "boolean"
        ? described.type
        : "json";
  return described.optional ? { optional: spec } : spec;
}

/** A vocabulary, as it is kept between reads. */
interface Learned {
  /** The descriptor's catalog version this was read under. */
  version: number;
  at: number;
  doc: VocabularyDoc;
}

/** One read: the numbers it reads by, and each database as this read met it. */
interface Reading {
  types: Names;
  edges: Names;
  /**
   * One vocabulary per database and the catalog built from it, held for the read.
   *
   * The pair is what a request to that database was grouped by, so it is what the answer is read
   * by: a vocabulary another read learns meanwhile, or one this reader has since forgotten, is not
   * seen half-way through this one.
   */
  met: Map<string, { doc: VocabularyDoc; catalog: Catalog }>;
}

/** A request as a plan, and what of the request has to be remembered to refuse it later. */
interface Asked {
  plan: Plan;
  /** Per frame, the names its rows will carry beside their payload, each with its place. */
  names: { name: string; at: string; what: string }[][];
  /** Per frame, the filters over its rows, each with its place. */
  where: { cmp: Cmp; at: string }[][];
}

/** What a request to a reader may carry. Not `ids`: the references to enter from are an argument. */
const REQUEST_MEMBERS = ["counts", "hops"] as const;

/**
 * Refuses what can be refused of a request before any database is asked: a member the protocol
 * does not define, names that would collide in the answer (`spec/protocol.md` §5.1.1), a filter
 * that is not a comparison. The checks are `query/request.ts`'s own, which is what makes a mistake
 * here the mistake it would have been on the wire.
 */
function wellFormed(request: Request): void {
  if (request === null || typeof request !== "object" || Array.isArray(request)) throw new Refused("query", "expected an object");
  onlyKnown(request, REQUEST_MEMBERS, "query", "; the references to enter from are the first argument");
  checkAliases(request, PROTOCOL_ALIASING, Infinity);
  checkShape(request);
}

export class Reader {
  readonly clock: Clock;
  readonly #opts: ReaderOptions;
  readonly #declared: Catalog | undefined;
  /** The numbers a lock gave its names, which every read starts from. */
  readonly #numbered: { types: [string, number][]; edges: [string, number][] };
  readonly #pins: Pins;
  readonly #cache: ResponseCache | undefined;
  readonly #now: () => number;
  /** In the order last read, oldest first, which is the order they are forgotten in. */
  readonly #learned = new Map<string, Learned>();
  readonly #kept: number;

  constructor(opts: ReaderOptions = {}) {
    this.#opts = opts;
    this.clock = opts.clock ?? systemClock;
    this.#now = opts.now ?? (() => Date.now());
    this.#declared = opts.lock === undefined ? undefined : Catalog.compile(opts.lock);
    this.#numbered = {
      types: Object.entries(opts.lock?.objects ?? {}).map(([name, o]) => [name, o.otype]),
      edges: Object.entries(opts.lock?.edges ?? {}).flatMap(([name, e]) => (e.atype === undefined ? [] : [[name, e.atype] as [string, number]])),
    };
    this.#kept = Math.max(1, opts.vocabularies ?? VOCABULARIES_KEPT);
    this.#pins = opts.pins ?? memoryPins();
    this.#cache = opts.cache === false ? undefined : (opts.cache ?? new ResponseCache(this.#now));
  }

  get #transport(): Pick<ForeignOptions, "fetch" | "guard" | "deadlineMs" | "maxResponseBytes" | "pins"> {
    const { fetch, guard, deadlineMs, maxResponseBytes } = this.#opts;
    return { fetch, guard, deadlineMs, maxResponseBytes, pins: this.#pins };
  }

  // ---- one database

  /** Meets a database: its descriptor, checked and pinned, and its vocabulary. */
  async database(uri: string): Promise<Database> {
    const db = canonicalDb(uri);
    const descriptor = await discoverPinned(db, this.#transport);
    return new Database(this, descriptor, await this.#learn(db, descriptor));
  }

  /**
   * A database's vocabulary, asked for or kept from an earlier read.
   *
   * Asked for again when the descriptor reports a different catalog version, after
   * `VOCABULARY_TTL_MS` whatever it reports, and when this reader has met `vocabularies` other
   * databases since and forgotten it.
   */
  async #learn(db: string, descriptor: Descriptor, spend?: () => AbortSignal): Promise<VocabularyDoc> {
    const held = this.#learned.get(db);
    const now = this.#now();
    const doc = vocabularyHeld(held, descriptor, now) ? held.doc : await discoverVocabulary(db, this.#transport, spend);
    const learned = doc === held?.doc ? held : { version: descriptor.catalog, at: now, doc };
    // Taken out and put back, so that it is the newest: what is forgotten is what was read longest ago.
    this.#learned.delete(db);
    this.#learned.set(db, learned);
    while (this.#learned.size > this.#kept) this.#learned.delete(this.#learned.keys().next().value!);
    return doc;
  }

  /** What a read starts with: a lock's numbers if there is one, and no database met yet. */
  #begin(): Reading {
    return { types: new Names(this.#numbered.types), edges: new Names(this.#numbered.edges), met: new Map() };
  }

  /** The catalog one database is read by, in one read: its vocabulary, in that read's numbers. */
  #catalogOf(db: string, doc: VocabularyDoc, reading: Reading): Catalog {
    // Maps, and not objects keyed by a stranger's names. To `in`, every object already has a
    // `constructor`, so an edge landing on a type of that name found it declared and never added
    // it; and assigning under `__proto__` sets an object's prototype rather than adding a type.
    const objects = new Map<string, Lock["objects"][string]>();
    const type = (name: string, fields: Record<string, FieldSpec>): void => {
      // A type the caller declared is read through the caller's fields. Whether the responder can
      // fill them is `agree`'s to decide, with this same document.
      objects.set(name, { otype: reading.types.of(name), fields: this.#declared?.objectNamed(name)?.fields ?? fields });
    };
    for (const [name, entry] of Object.entries(doc.types)) {
      type(name, Object.fromEntries(Object.entries(entry.fields).map(([field, described]) => [field, specOf(described)])));
    }
    const edges = new Map<string, Lock["edges"][string]>();
    for (const [name, entry] of Object.entries(doc.edges)) {
      // An edge may land on a type the vocabulary names and does not list. It is still somewhere a
      // hop can arrive, so it is a type with nothing to read.
      for (const end of [entry.from, entry.to]) if (!objects.has(end)) type(end, {});
      const field = this.#declared?.edgeNamed(name)?.field;
      edges.set(
        name,
        field !== undefined && Object.hasOwn(objects.get(entry.from)!.fields, field)
          ? { from: entry.from, to: entry.to, field }
          : { from: entry.from, to: entry.to, atype: reading.edges.of(name), ...(entry.foreign === true ? { foreign: true } : {}) },
      );
    }
    try {
      return Catalog.compile({ version: 1, objects: Object.fromEntries(objects), edges: Object.fromEntries(edges) });
    } catch (e) {
      if (!(e instanceof CatalogError)) throw e;
      throw new ForeignUnreachable(db, `invalid vocabulary: ${e.message}`);
    }
  }

  // ---- running a query

  /**
   * Runs a plan from references, across however many databases it reaches.
   *
   * This is what a query built with `hlekk/schema` calls, so `Type.gen(ref).related(...).run(reader)`
   * is a query against databases you do not run.
   */
  async answer(plan: Plan, rootIds: Id[], opts: ReadOptions = {}): Promise<Answer> {
    return this.#gather(plan, rootIds, opts, this.#begin());
  }

  async #gather(plan: Plan, rootIds: Id[], opts: ReadOptions, reading: Reading): Promise<Answer> {
    for (const id of rootIds) {
      if (parseRef(id).db === null) {
        throw new TypeError(
          `${JSON.stringify(id)} is a bare id, and a reader has no database for it to be relative to.` +
            " Start from `<database URI>#<id>`, or read through `database(uri)`, which qualifies its own ids.",
        );
      }
    }
    const spending = budgeted(this.clock, { ...this.#opts.budget, ...opts.budget });
    const clients = new Map<string, HostClient>();
    const route = (id: Ref): HostClient => {
      const { db } = parseRef(id);
      if (db === null) throw new TypeError(`an answer led to the bare id ${id}, which names no database`);
      let client = clients.get(db);
      if (client === undefined) clients.set(db, (client = spending(db, this.#client(db, opts.omit, reading))));
      return client;
    };
    const answer =
      opts.driver === "rounds"
        ? await runRounds(plan, rootIds, route, opts.stats)
        : await runAsync(plan, rootIds, route, opts.stats, (f) => this.clock.defer(f));
    for (const row of answer.rows) this.#stamp(plan, answer, row, 0, reading);
    return answer;
  }

  #client(db: string, omit: Omitted | undefined, reading: Reading): HostClient {
    const declared = this.#declared;
    const asking = foreignClient(db, {
      ...this.#transport,
      catalog: async (descriptor, spend) => {
        const doc = await this.#learn(db, descriptor, spend);
        let met = reading.met.get(db);
        if (met?.doc !== doc) reading.met.set(db, (met = { doc, catalog: this.#catalogOf(db, doc, reading) }));
        return { catalog: met.catalog, vocabulary: doc };
      },
      // Only a declaration can disagree with a vocabulary. A type read from one is that document.
      agree: declared === undefined ? false : (type) => declared.objectNamed(type) !== undefined,
      cache: this.#cache,
      now: this.#now,
      omit,
    });
    return {
      metersRequests: true,
      exec: async (plan, tasks, spend) => {
        // A list or a count is asked of the database that holds the object it hangs under, and that
        // database may not expose the edge. That is the caller's mistake, so it is raised here,
        // before a request is spent on it — and by name, where the client underneath has only this
        // read's number for the edge.
        const before = this.#unexposed(db, tasks, reading);
        if (before) throw before;
        try {
          return await asking.exec(plan, tasks, spend);
        } catch (e) {
          throw (e instanceof NotFollowed && this.#unexposed(db, tasks, reading)) || e;
        }
      },
    };
  }

  #unexposed(db: string, tasks: readonly Miss[], reading: Reading): NoSuchEdge | undefined {
    const met = reading.met.get(db);
    if (met === undefined) return undefined;
    for (const task of tasks) {
      if (task.kind === "object" || met.catalog.edge(task.atype) !== undefined) continue;
      return new NoSuchEdge(db, reading.edges.named(task.atype) ?? `#${task.atype}`, Object.keys(met.doc.edges));
    }
    return undefined;
  }

  /** Writes each row's type beside it. The engine's rows do not carry one, because a query built
   *  from a catalog knows what it asked for; a reader that started from a reference does not. */
  #stamp(plan: Plan, answer: Answer, value: Json, frame: number, reading: Reading): void {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const held = answer.graph.objects.get(value.id as Id);
    if (held) value.$type = reading.types.named(held.otype) ?? null;
    for (const child of plan.frames[frame]!.children) {
      const below = value[child.alias];
      if (Array.isArray(below)) for (const item of below) this.#stamp(plan, answer, item, child.frame, reading);
    }
  }

  /**
   * What a request would cost one database, asked of it. See `Database.price`.
   *
   * `exposed` is that database's edges, where the caller holds its vocabulary: with it, what is
   * priced is the part of the request a read would send there (`shareOf`). Without it the request
   * is priced whole, and a hop into an edge the database does not expose is refused.
   */
  async priceAt(database: string, ids: Id[], request: Request = {}, exposed?: VocabularyDoc["edges"]): Promise<Cost> {
    wellFormed(request);
    return askPrice(database, { ids, ...shareOf(request, exposed) }, this.#transport);
  }

  /**
   * Refuses what could only be refused once a database had said what an object is.
   *
   * Two things, and both would otherwise come back looking like an answer:
   *
   * - **A filter over a field the type does not have, or a value the field could not hold.** A
   *   reader applies filters itself — they are not sent, for the reason `subtree` gives — so no
   *   database ever checked one, and a field that was misspelled matched nothing: an empty page,
   *   which is what a list with no such rows looks like. `POST {db}/read` refuses the same request
   *   by the vocabulary. This refuses it by the type of each object the filter was asked of, which
   *   is the same check made where the type is known.
   * - **A name that is also a field.** A row holds its payload, its relationships and its counts in
   *   one object, so a hop called `title` took the place of the object's own `title`, silently.
   *   `checkAliases` refuses a name a row always carries; this is the one it could not have known.
   *
   * Asked of each type once per frame, and of nothing where no rows of the frame arrived: with no
   * object to be wrong about, an empty page is the true answer.
   */
  #late(asked: Asked, answer: Answer, reading: Reading): void {
    const { plan } = asked;
    // A reader's ids are all references, and each was parsed on its way in.
    const holder = (id: Ref): string => id.slice(0, id.indexOf("#"));
    const typeOf = (obj: Obj): ObjectType | undefined => reading.met.get(holder(obj.id))?.catalog.object(obj.otype);
    const settled = new Set<string>();
    const first = (what: string, frame: number, obj: Obj): ObjectType | undefined => {
      const key = `${what}:${frame}:${obj.otype}:${holder(obj.id)}`;
      if (settled.has(key)) return undefined;
      settled.add(key);
      return typeOf(obj);
    };

    const named = (frame: number, obj: Obj): void => {
      if (asked.names[frame]!.length === 0) return;
      const type = first("names", frame, obj);
      if (type === undefined) return;
      for (const { name, at, what } of asked.names[frame]!) {
        if (!Object.hasOwn(type.fields, name)) continue;
        throw new Refused(at, `"${name}" is a field of ${type.name}, and one answer cannot hold both under it: give ${what} another name with \`as\``);
      }
    };
    const filtered = (frame: number, obj: Obj): void => {
      const type = first("where", frame, obj);
      if (type === undefined) return;
      for (const { cmp, at } of asked.where[frame]!) checkValue(at, cmp.field, cmp.value, type.name, { fields: () => type.fields });
    };
    /** Every object a hop's filter could have been asked of: the whole list it was read from, not
     *  only the rows that passed, since a filter that is wrong passes none. */
    const reached = (parent: Obj, source: Source): (Obj | null | undefined)[] => {
      if (source.kind === "field") {
        const id = parent.data[source.field];
        return typeof id === "string" ? [answer.graph.objects.get(id)] : [];
      }
      if (source.kind !== "edge") return [];
      const list = answer.graph.lists.get(listKey(parent.id, source.atype));
      if (list === undefined) return [];
      const rows = list.pages ? [...list.pages.values()].flatMap((page) => page.rows) : list.rows;
      return rows.map((edge) => answer.graph.objects.get(targetOf(edge)));
    };

    const visit = (row: Json, frame: number): void => {
      if (row === null || typeof row !== "object" || Array.isArray(row)) return;
      const held = answer.graph.objects.get(row.id as Id);
      if (!held) return;
      named(frame, held);
      for (const child of plan.frames[frame]!.children) {
        if (asked.where[child.frame]!.length > 0) {
          for (const target of reached(held, plan.frames[child.frame]!.source)) if (target) filtered(child.frame, target);
        }
        const below = row[child.alias];
        if (Array.isArray(below)) for (const item of below) visit(item, child.frame);
      }
    };
    for (const row of answer.rows) visit(row, 0);
  }

  // ---- reading by name

  /**
   * Reads objects by reference, and whatever the request hangs under them.
   *
   * The request is the body `POST {db}/read` takes, without its `ids`: the same hops, counts,
   * filters and limits, under the same rules. What differs is that it does not stop at the
   * database it entered. A hop is asked of whichever database holds the object it starts from, so
   * one request may name edges from several vocabularies. And a cursor is this reader's: the one a
   * page of this list returned here, not the one a database's own answer carries (`cursorOf`).
   */
  async read(refs: Ref | readonly Ref[], request: Request = {}, opts: ReadOptions = {}): Promise<Row[]> {
    const roots = typeof refs === "string" ? [refs] : [...refs];
    if (roots.length === 0) throw new Refused("ids", "a read enters from at least one reference");
    const reading = this.#begin();
    const asked = this.#planOf(request, reading);
    const { plan } = asked;
    const answer = await this.#gather(plan, roots, opts, reading);
    this.#late(asked, answer, reading);
    const page = (value: Json, frame: number): Row => {
      // The type goes beside the id, which is where a reader looks for what a thing is.
      const row = {} as Row;
      for (const [key, held] of Object.entries(value as Record<string, Json>)) {
        if (key !== "$type") row[key] = held;
        if (key === "id") row.$type = (value as Record<string, Json>).$type as string;
      }
      for (const child of plan.frames[frame]!.children) {
        const below = row[child.alias];
        const items = Array.isArray(below) ? below.map((item) => page(item, child.frame)) : [];
        const spec = plan.frames[child.frame]!;
        const last = (stoppedAt(below) as Json | undefined) ?? (items.at(-1) as Json | undefined);
        row[child.alias] = { items, ...pageEnd(row.id, spec.source, spec.after, last, answer.graph) };
      }
      return row;
    };
    return answer.rows.map((row) => page(row, 0));
  }

  /**
   * Starts a read from references, to be built by chaining: `related`, `countAs`, then `run`.
   *
   * The same read as `read(refs, request)`, written rather than spelled out. `request()` on what
   * this returns is that request.
   */
  from(refs: Ref | readonly Ref[]): ReadBuilder {
    return new ReadBuilder(this, typeof refs === "string" ? [refs] : [...refs]);
  }

  /**
   * A request as a plan, in this read's numbers.
   *
   * Checked here for what can be checked without a vocabulary (`wellFormed`). Whether an edge exists
   * is the question only the database it is asked of can answer, and it does; what a filter's field
   * holds, and whether a name is one an object already has, are `#late`'s, which is why each frame's
   * names and filters are kept beside the plan with their places in the request.
   */
  #planOf(request: Request, reading: Reading): Asked {
    wellFormed(request);
    const names: Asked["names"] = [];
    const where: Asked["where"] = [];
    const plan = compile(
      request,
      {
        source: (hop) => this.#sourceOf(hop.edge, reading),
        counted: (count, at) => this.#counted(count, at, reading),
        cursor: cursorOf,
      },
      PROTOCOL_ALIASING,
      (frame, node, at) => {
        const under = at === "" ? "" : `${at}.`;
        names[frame] = [
          ...(node.hops ?? []).map((hop, i) => ({ name: PROTOCOL_ALIASING.hop(hop), at: `${under}hops[${i}]`, what: `the "${hop.edge}" hop` })),
          ...(node.counts ?? []).map((c, i) => ({ name: PROTOCOL_ALIASING.count(c), at: `${under}counts[${i}]`, what: `the "${countEdge(c)}" count` })),
        ];
        where[frame] = (node.where ?? []).map((cmp, i) => ({ cmp, at: `${at}.where[${i}]` }));
      },
    );
    return { plan, names, where };
  }

  #sourceOf(edge: string, reading: Reading): Source {
    const field = this.#declared?.edgeNamed(edge)?.field;
    return field !== undefined ? { kind: "field", field } : { kind: "edge", atype: reading.edges.of(edge) };
  }

  #counted(count: CountSpec, at: string, reading: Reading): number {
    const edge = countEdge(count);
    if (this.#declared?.edgeNamed(edge)?.field !== undefined) {
      throw new Refused(at, `edge "${edge}" has no count: it follows an id in a payload and stores nothing`);
    }
    return reading.edges.of(edge);
  }
}

/**
 * A cursor this reader handed back in an earlier page. One from anywhere else is refused here,
 * with its place in the request, rather than reaching a database as a position it never gave.
 *
 * That includes a cursor a database's own answer carries, which decodes and is still not one of
 * these. It is a sort key into a list the process reading it holds, and a reader holds no list:
 * every page it returns continues from the token of the database that does, wrapped, or from a
 * place inside one of that database's pages. So a reader's cursor and a database's are not one
 * string, in either direction, and the one request member that is not the wire's own is `after`.
 */
function cursorOf(after: string, at: string): Cursor {
  let cursor: Cursor;
  try {
    cursor = decodeCursor(after);
  } catch (e) {
    throw new Refused(at, `${(e as Error).message}; a cursor is the one a page of this list returned`);
  }
  if (cursor.token === undefined && cursor.resume === undefined) {
    throw new Refused(
      at,
      "this is a database's own cursor, from an answer read off the wire, and a reader cannot place it;" +
        " a cursor here is the one a reader's page of this list returned",
    );
  }
  return cursor;
}

/**
 * The part of a request a read would ask of one database, which is what that database can price.
 *
 * A read does not send a database the request as written, and neither does a price of one:
 *
 * - **Below the first hop, what the database does not expose is left out.** A hop under another
 *   hop may hang under objects that are another database's, and that database answers for it
 *   (`subtree` in `protocol/client.ts`). A hop directly under the ids stays: those are this
 *   database's own objects, and its refusal is the answer.
 * - **Filters are left out.** A reader applies them itself, and a filter may be over a field only
 *   the database a hop lands in exposes. They cost nothing either way: a price is the product of
 *   the limits down each path.
 * - **A cursor goes as the token it wraps**, which is the database's own and the only kind it takes.
 */
function shareOf(request: Request, exposed: VocabularyDoc["edges"] | undefined): Request {
  const sent = (edge: string, depth: number): boolean => depth < 2 || exposed === undefined || Object.hasOwn(exposed, edge);
  const level = (node: Request, depth: number, at: string): Request => {
    const counts = (node.counts ?? []).filter((count) => sent(countEdge(count), depth));
    const hops = (node.hops ?? []).flatMap((hop, i) => {
      if (!sent(hop.edge, depth)) return [];
      const path = `${at}hops[${i}]`;
      const token = hop.after === undefined ? undefined : cursorOf(hop.after, `${path}.after`).token;
      return [
        {
          edge: hop.edge,
          ...(hop.as !== undefined ? { as: hop.as } : {}),
          ...(hop.limit !== undefined ? { limit: hop.limit } : {}),
          ...(token !== undefined ? { after: token } : {}),
          ...level(hop, depth + 1, `${path}.`),
        },
      ];
    });
    return { ...(counts.length > 0 ? { counts } : {}), ...(hops.length > 0 ? { hops } : {}) };
  };
  return level(request, 1, "");
}

/** One database, as a reader met it. A place to start from: its ids are the only ones this reader
 *  can take bare, and its vocabulary says what may be asked of them. */
export class Database {
  readonly reader: Reader;
  /** The canonical URI. Every reference into this database begins with it. */
  readonly database: string;
  readonly descriptor: Descriptor;
  readonly vocabulary: VocabularyDoc;

  constructor(reader: Reader, descriptor: Descriptor, vocabulary: VocabularyDoc) {
    this.reader = reader;
    this.database = descriptor.database;
    this.descriptor = descriptor;
    this.vocabulary = vocabulary;
  }

  get limits(): Descriptor["limits"] {
    return this.descriptor.limits;
  }

  get types(): VocabularyDoc["types"] {
    return this.vocabulary.types;
  }

  get edges(): VocabularyDoc["edges"] {
    return this.vocabulary.edges;
  }

  /** The edges that may be hung under an object of a type: the ones that start there
   *  (`spec/protocol.md` §4.3). An answer states each object's type, so this is what to ask next. */
  edgesFrom(type: string): string[] {
    return Object.entries(this.edges).flatMap(([name, edge]) => (edge.from === type ? [name] : []));
  }

  /** A reference to one of this database's objects. One that is already a reference is returned as
   *  it is, wherever it points. */
  ref(id: Id | Ref): Ref {
    return parseRef(id).db === null ? formatRef(this.database, id) : id;
  }

  /** `Reader.from`, entered from this database's own ids. */
  from(ids: Id | Ref | readonly (Id | Ref)[]): ReadBuilder {
    return this.reader.from((typeof ids === "string" ? [ids] : [...ids]).map((id) => this.ref(id)));
  }

  /** `Reader.read`, entered from this database's own ids. */
  read(ids: Id | Ref | readonly (Id | Ref)[], request: Request = {}, opts: ReadOptions = {}): Promise<Row[]> {
    const refs = (typeof ids === "string" ? [ids] : [...ids]).map((id) => this.ref(id));
    return this.reader.read(refs, request, opts);
  }

  /**
   * What a request would cost this database, with nothing read.
   *
   * It is the part of the request a read would send here that is priced (`shareOf`), so the price
   * is exact for a request that stays in this database, and is this database's share of one that
   * goes on into another. Priced as written instead, such a request was refused — this database
   * has no edge by the next one's name — and those are the requests a reader is for.
   *
   * A hop directly under the ids that this database does not expose is still refused, by name: a
   * read of it would be. And nothing is fitted to the database's limits. A limit or a depth over
   * what it advertises is refused here as it is on the wire, where a read asks for what the
   * database will take and comes back for the rest.
   */
  price(ids: Id | Ref | readonly (Id | Ref)[], request: Request = {}): Promise<Cost> {
    const own = (typeof ids === "string" ? [ids] : [...ids]).map((id) => {
      const { db, id: bare } = parseRef(id);
      if (db !== null && db !== this.database) throw new TypeError(`${id} is not in ${this.database}, so this database cannot price it`);
      return bare;
    });
    return this.reader.priceAt(this.database, own, request, this.edges);
  }
}

/** Meets one database with a reader made for it. `database.reader` is that reader, for reading on
 *  from references that lead elsewhere. */
export function connect(uri: string, opts: ReaderOptions = {}): Promise<Database> {
  return new Reader(opts).database(uri);
}
