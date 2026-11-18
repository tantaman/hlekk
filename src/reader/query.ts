// A read, built by chaining rather than written out.
//
// `Reader.read` takes a request as data: the body `POST {db}/read` takes, without its ids. That is
// the form that crosses a wire, goes in a file, and is what an agent emits. This is the same request
// written the way `hlekk/schema` writes a query — `related`, `countAs`, `where`, `limit`, `after`
// — for a caller that has no lock, and so has names where that builder has typed values.
//
// **It is a writer of requests, and nothing else.** A builder holds the request it has built so far
// and `request()` hands it back, so there is one meaning for a read and it is the wire's: nothing
// can be said here that the data form cannot say, and nothing here decides what a name means. That
// is why there is no `or`, no `exists` and no filter on an edge's own fields, all of which the typed
// builder has. They are not in the protocol's request, and a second language that compiled to more
// than the first could express would be a second protocol.
//
// What it adds is that the names a caller chooses are known to the compiler. A hop called `cites`
// is a page of rows under `row.cites`, and a count called `cited` is a number under `row.cited`,
// without a cast. The fields of a row stay untyped, because no schema was declared to type them.

import { PROTOCOL_ALIASING, Refused, checkAliases } from "../query/request.ts";
import type { Cmp, Hop, Request } from "../query/request.ts";
import type { CmpOp, Json } from "../query/types.ts";
import type { Ref } from "../query/ref.ts";
import type { Page, ReadOptions, Reader, Row } from "./reader.ts";

/** A row with the caller's own names on it. */
export type Shaped<S> = Row & S;

/**
 * A name taken at one level, checked as it is taken.
 *
 * `Reader.read` refuses the same things when the request runs, with a path into it. Here the
 * mistake is still one line long and the stack still points at it, so it is refused now: two names
 * that would land on one, and a name a row already carries (`spec/protocol.md` §5.1.1).
 */
function added<N extends Request>(level: N, more: Request): N {
  const next = {
    ...level,
    ...(more.counts ? { counts: [...(level.counts ?? []), ...more.counts] } : {}),
    ...(more.hops ? { hops: [...(level.hops ?? []), ...more.hops] } : {}),
  };
  checkAliases({ counts: next.counts, hops: next.hops }, PROTOCOL_ALIASING, Infinity);
  return next;
}

const named = (alias: string, edge: string): void => {
  if (typeof alias !== "string" || alias.length === 0) throw new Refused("as", "a relationship or a count needs a name to appear under");
  if (typeof edge !== "string" || edge.length === 0) throw new Refused("edge", `"${alias}" needs the name of an edge from a vocabulary`);
};

/** What hangs under one hop: its own page, and whatever is asked of the rows in it. */
export class HopBuilder<S = unknown> {
  readonly #hop: Hop;

  constructor(hop: Hop) {
    this.#hop = hop;
  }

  /** Follows an edge from each row of this hop, naming the result. */
  related<A extends string, C = unknown>(
    alias: A,
    edge: string,
    build?: (hop: HopBuilder) => HopBuilder<C>,
  ): HopBuilder<S & { [K in A]: Page<Shaped<C>> }> {
    return new HopBuilder(added(this.#hop, { hops: [hopOf(alias, edge, build)] }));
  }

  /** The number of edges of a type from each row, from the maintained counter. */
  countAs<A extends string>(alias: A, edge: string): HopBuilder<S & { [K in A]: number }> {
    named(alias, edge);
    return new HopBuilder(added(this.#hop, { counts: [{ as: alias, edge }] }));
  }

  /** Keeps the rows a comparison holds for. Called again, both must hold: a request's filters are
   *  one condition, and it is their conjunction. */
  where(field: string, op: CmpOp, value: Json): HopBuilder<S> {
    const cmp: Cmp = { field, op, value };
    return new HopBuilder({ ...this.#hop, where: [...(this.#hop.where ?? []), cmp] });
  }

  /** How many rows this page may hold. Every list is a page, and this is its size. */
  limit(n: number): HopBuilder<S> {
    return new HopBuilder({ ...this.#hop, limit: n });
  }

  /** Continues the list from a cursor an earlier page of it returned. */
  after(cursor: string): HopBuilder<S> {
    return new HopBuilder({ ...this.#hop, after: cursor });
  }

  /** The hop as the request carries it. */
  hop(): Hop {
    return structuredClone(this.#hop);
  }
}

function hopOf(alias: string, edge: string, build?: (hop: HopBuilder) => HopBuilder<unknown>): Hop {
  named(alias, edge);
  const start = new HopBuilder({ edge, as: alias });
  return (build ? build(start) : start).hop();
}

/** A read from some references: what to ask of them, and the means to ask it. */
export class ReadBuilder<S = unknown> {
  readonly #reader: Reader;
  readonly #refs: readonly Ref[];
  readonly #request: Request;

  constructor(reader: Reader, refs: readonly Ref[], request: Request = {}) {
    this.#reader = reader;
    this.#refs = refs;
    this.#request = request;
  }

  /** Follows an edge from each object the read enters from, naming the result. */
  related<A extends string, C = unknown>(
    alias: A,
    edge: string,
    build?: (hop: HopBuilder) => HopBuilder<C>,
  ): ReadBuilder<S & { [K in A]: Page<Shaped<C>> }> {
    return new ReadBuilder(this.#reader, this.#refs, added(this.#request, { hops: [hopOf(alias, edge, build)] }));
  }

  /** The number of edges of a type from each object the read enters from. */
  countAs<A extends string>(alias: A, edge: string): ReadBuilder<S & { [K in A]: number }> {
    named(alias, edge);
    return new ReadBuilder(this.#reader, this.#refs, added(this.#request, { counts: [{ as: alias, edge }] }));
  }

  /** The references this read enters from. */
  get refs(): readonly Ref[] {
    return this.#refs;
  }

  /**
   * The request this has built, as data.
   *
   * It is what `Reader.read` takes, and the body `POST {db}/read` takes once its `ids` are added,
   * so a read written here can be stored, sent, priced or run by something else.
   */
  request(): Request {
    return structuredClone(this.#request);
  }

  /** Runs it. The same as handing `request()` to `Reader.read`, with the names typed. */
  async run(opts?: ReadOptions): Promise<Shaped<S>[]> {
    return (await this.#reader.read(this.#refs, this.#request, opts)) as Shaped<S>[];
  }
}
