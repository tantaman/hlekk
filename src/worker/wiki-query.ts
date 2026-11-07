// The query editor's safe surface: what the schema is, what a submitted query may say, and the
// static guard that decides whether it may run at all.
//
// WHY THIS EXISTS. docs/wikimedia-demo.md draws a line: "A fixed page view and a box a stranger
// types a query into are not the same exposure, and the engine is ready for the first but not the
// second." It then names three holes, all reachable from a plan a user can type:
//
//   1. The answer is exponential in depth and no read budget sees it. A chain of `related` levels
//      materializes the product of its limits, so depth 14 at limit 3 exhausts the heap -- while
//      storage reads stay flat at 58 objects and 32 requests across depths 10, 12 and 14. A budget
//      on reads, requests, rounds or objects never fires. The guard has to count *answer* nodes.
//   2. A cycle through two edge frames recurses until the heap is gone.
//   3. A child frame index naming a frame that does not exist is an unvalidated read of
//      `plan.frames[i]`, and surfaces as a raw TypeError.
//
// Two of those three stop being representable here, which is the reason this takes a nested
// description rather than a `Plan`. A submitted query is a tree: a hop holds its children, so there
// is no frame index for a user to get wrong (3), and no way to name an ancestor and make a cycle
// (2). `Query.compile()` reserves a frame before emitting its children, so the builder cannot
// produce a cycle either. That answers the demo doc's open question -- whether the editor accepts a
// Plan directly or only a builder-produced query -- in the direction that removes the holes instead
// of guarding them.
//
// What is left is (1), which is arithmetic and is checked before any I/O: multiply the limits down
// each root-to-leaf path, sum what every node along the way materializes, and refuse the query if
// the total exceeds a budget. Plus the ordinary checks that every name exists and every value has
// the type its field declares -- an unknown field is refused rather than matching nothing, because
// in an editor a silently empty answer is a worse bug than an error message.
//
// What this does NOT fix, and nothing here can: a selective filter walks its whole edge list, so
// `where` over a page with a million backlinks reads the million. design.md's "A scan cap per
// query, returning a cursor, is not built yet" is still true, and `maxLimit` is not a bound on it.

import type { Cond, Json, Plan } from "../query/types.ts";
import type { CmpOp } from "../query/types.ts";
import type { FieldSpec } from "../catalog/catalog.ts";
import { Query } from "../schema/query.ts";
import { LOCK, Page, categoryPages, linkedFrom, pageCategories, pageLinks } from "./wiki.ts";
import type { EdgeType, FieldMap } from "../schema/define.ts";
import {
  DEFAULT_HOP_LIMIT,
  DEFAULT_LIMITS,
  OPS,
  Refused as QueryRefused,
  check as checkRequest,
  countEdge,
  describe,
} from "../query/request.ts";
import type { Cmp, Cost, CountSpec, Hop, Limits, Request, Vocabulary } from "../query/request.ts";

/** Every relation the editor may traverse, by the name the schema gives it. Taken from the typed
 *  values rather than re-listed, so the editor cannot offer an edge the catalog does not have. */
const EDGES: Record<string, EdgeType<FieldMap, FieldMap, boolean>> = {
  [pageLinks.name]: pageLinks as unknown as EdgeType<FieldMap, FieldMap, boolean>,
  [linkedFrom.name]: linkedFrom as unknown as EdgeType<FieldMap, FieldMap, boolean>,
  [pageCategories.name]: pageCategories as unknown as EdgeType<FieldMap, FieldMap, boolean>,
  [categoryPages.name]: categoryPages as unknown as EdgeType<FieldMap, FieldMap, boolean>,
};

// What a submitted query may say, and the guard that prices it, are generic and live in
// `../query/request.ts`, so that this editor's boundary and the cross-database protocol's boundary are
// the same code checked by the same tests. What stays here is particular to this schema: the four
// relations, entry by (ns, title), and the text syntax.
export { OPS, QueryRefused, countEdge };
export type { Cmp, Cost, CountSpec, Hop };

/** The budget this deployment serves to its client and enforces on submit. */
export const LIMITS: Limits = DEFAULT_LIMITS;

/** A count's result name. The short form drops this schema's prefix, which is a presentation choice
 *  and so stays here rather than in the core. */
export const countAlias = (c: CountSpec): string =>
  typeof c === "string" ? c.replace(/^wiki\./, "") : c.as;

export interface QuerySpec extends Request {
  /** Where the query enters: a title, which is the only entry the database has. */
  from: { ns: number; title: string };
}

// ---- the query language
//
// The editor submits text, so something has to turn text into the spec above. It is a parser and
// not an `eval`: the text arrives at a Worker, and evaluating a stranger's text there would hand
// them the isolate. The grammar is deliberately hlekk's own builder chain rather than a SQL dialect,
// so what an author types is what the demo's own code says, and so there is one vocabulary to learn.
//
//   page("Country")
//     .countAs("linkCount", page_links)
//     .related("links", page_links, q => q
//       .limit(25)
//       .where("len", ">", 20000)
//       .related("via", linked_from, q => q.limit(3)))

/** Edge names as an author types them, without the domain prefix the catalog carries. */
const SHORT: Record<string, string> = Object.fromEntries(
  Object.keys(EDGES).map((name) => [name.replace(/^wiki\./, ""), name]),
);

export const METHODS = ["limit", "where", "countAs", "related"] as const;

interface Tok {
  /** `name`, `str`, `num`, `punct`. */
  kind: string;
  text: string;
  /** Character offset in the source, for pointing a caret at a mistake. */
  at: number;
  /** For a string token, its contents with the quotes removed. */
  value?: string;
}

/** The same token shapes the editor's highlighter paints, so the two cannot disagree about what a
 *  piece of text is. A comment is dropped here and coloured there. */
export function lex(text: string): Tok[] {
  const out: Tok[] = [];
  const re = /\/\/[^\n]*|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|[A-Za-z_$][A-Za-z0-9_$]*|=>|[().,]|\s+|[^\s]/g;
  for (const m of text.matchAll(re)) {
    const t = m[0];
    if (/^\s/.test(t) || t.startsWith("//")) continue;
    if (t.startsWith('"')) {
      if (!t.endsWith('"') || t.length < 2) throw new QueryRefused("text", "unterminated string", m.index);
      out.push({ kind: "str", text: t, at: m.index, value: JSON.parse(t) as string });
    } else if (/^-?\d/.test(t)) out.push({ kind: "num", text: t, at: m.index });
    else if (/^[A-Za-z_$]/.test(t)) out.push({ kind: "name", text: t, at: m.index });
    else if (t === "=>" || "().,".includes(t)) out.push({ kind: "punct", text: t, at: m.index });
    // A character the grammar has no use for becomes a token the parser will reject *in context*.
    // The lexer has no context: it cannot tell whether a stray `*` means `SELECT * FROM` — where
    // the useful message is that a query starts with page(...) — or a typo inside a good query,
    // where the useful message names what belonged in that position.
    else out.push({ kind: "other", text: t, at: m.index });
  }
  return out;
}

/**
 * Parses the editor's text into a spec. Throws `QueryRefused` with an offset, so the editor can put
 * the caret on the problem rather than describing it.
 *
 * It produces a spec and nothing else — which is what keeps every guarantee in `check` intact. A
 * text front end does not widen what a query may say; it only changes how it is written.
 */
export function parseQuery(text: string): QuerySpec {
  const toks = lex(text);
  let i = 0;
  const end = () => (toks.length === 0 ? 0 : toks[toks.length - 1].at + toks[toks.length - 1].text.length);
  const peek = (): Tok | undefined => toks[i];
  const fail = (message: string, tok?: Tok): never => {
    throw new QueryRefused("text", message, tok ? tok.at : end());
  };
  const found = (t?: Tok) => (t ? `, found ${JSON.stringify(t.text)}` : ", found the end of the query");
  const take = (kind: string, what: string): Tok => {
    const t = peek();
    if (!t || t.kind !== kind) return fail(`expected ${what}${found(t)}`, t);
    i++;
    return t;
  };
  const punct = (ch: string): Tok => {
    const t = peek();
    if (!t || t.kind !== "punct" || t.text !== ch) return fail(`expected ${JSON.stringify(ch)}${found(t)}`, t);
    i++;
    return t;
  };
  const eat = (ch: string): boolean => {
    const t = peek();
    if (t && t.kind === "punct" && t.text === ch) {
      i++;
      return true;
    }
    return false;
  };
  const edge = (): string => {
    const t = take("name", `an edge name (${Object.keys(SHORT).join(", ")})`);
    const full = SHORT[t.text] ?? (EDGES[t.text] !== undefined ? t.text : undefined);
    if (full === undefined) return fail(`no edge "${t.text}"; the schema has ${Object.keys(SHORT).join(", ")}`, t);
    return full;
  };

  // page(ns, "title") | page("title")
  const head = peek();
  if (!head || head.kind !== "name" || head.text !== "page") return fail('a query starts with page("Title")', head);
  i++;
  punct("(");
  let ns = 0;
  if (peek()?.kind === "num") {
    ns = Number(take("num", "a namespace number").text);
    punct(",");
  }
  const title = take("str", 'a page title in quotes, e.g. "Country"').value!;
  punct(")");

  const spec: QuerySpec = { from: { ns, title }, counts: [], hops: [] };
  chain(spec as { counts?: CountSpec[]; hops?: Hop[] }, true);
  const extra = peek();
  if (extra) fail(`unexpected ${JSON.stringify(extra.text)} after the query`, extra);
  if (spec.counts!.length === 0) delete spec.counts;
  if (spec.hops!.length === 0) delete spec.hops;
  return spec;

  /** `.limit(n)`, `.where(f, op, v)`, `.countAs(a, edge)`, `.related(a, edge, q => …)` — applied to
   *  whichever node the chain is hanging off, which is the root or a hop. */
  function chain(node: { limit?: number; where?: Cmp[]; counts?: CountSpec[]; hops?: Hop[] }, root = false): void {
    while (eat(".")) {
      const m = take("name", `a method (${METHODS.join(", ")})`);
      punct("(");
      if (m.text === "limit") {
        // Told, not inferred. A hop also starts out with no hops and no filters, so inferring
        // "this is the root" from an empty node refuses `.limit()` written first in a lambda.
        if (root) fail("limit applies to a related list, not to the page the query starts from", m);
        node.limit = Number(take("num", "a number").text);
      } else if (m.text === "where") {
        const field = take("str", "a field name in quotes").value!;
        punct(",");
        const opTok = take("str", `an operator in quotes (${OPS.join(" ")})`);
        punct(",");
        const v = peek();
        let value: Json;
        if (v?.kind === "str") value = take("str", "a value").value!;
        else if (v?.kind === "num") value = Number(take("num", "a value").text);
        else if (v?.kind === "name" && (v.text === "true" || v.text === "false")) {
          value = take("name", "a value").text === "true";
          } else return fail("a value: a quoted string, a number, true or false", v);
        (node.where ??= []).push({ field, op: opTok.value as CmpOp, value });
      } else if (m.text === "countAs") {
        // The alias is kept. Discarding it and naming the count after its edge would answer a
        // different question than the one written, silently -- `countAs("backlinkCount", …)` would
        // come back as `linked_from` and the author would read it as a missing value.
        const as = peek()?.kind === "str" ? take("str", "an alias").value! : undefined;
        if (as !== undefined) punct(",");
        const e = edge();
        (node.counts ??= []).push(as === undefined ? e : { as, edge: e });
      } else if (m.text === "related") {
        const as = peek()?.kind === "str" ? take("str", "an alias").value! : undefined;
        if (as !== undefined) punct(",");
        const hop: Hop = { edge: edge(), ...(as !== undefined ? { as } : {}) };
        if (eat(",")) {
          // q => q.limit(…) — the parameter is named and then used, exactly as the builder reads.
          const param = take("name", "a lambda parameter, as in q => q.limit(10)");
          punct("=>");
          const body = take("name", `${param.text}, the lambda's own parameter`);
          if (body.text !== param.text) {
            fail(`the lambda body starts from ${param.text}, not ${JSON.stringify(body.text)}`, body);
          }
          chain(hop as { limit?: number; where?: Cmp[]; counts?: CountSpec[]; hops?: Hop[] });
        }
        punct(")");
        (node.hops ??= []).push(hop);
        continue; // `related` closed its own paren above
      } else {
        return fail(`no method "${m.text}"; there are ${METHODS.join(", ")}`, m);
      }
      punct(")");
    }
  }
}

/** The text a spec would be written as, so the editor can be seeded from a built query. */
export function unparse(spec: QuerySpec): string {
  const short = (name: string) => name.replace(/^wiki\./, "");
  const lit = (v: Json) => (typeof v === "string" ? JSON.stringify(v) : String(v));
  const body = (h: { limit?: number; where?: Cmp[]; counts?: CountSpec[]; hops?: Hop[] }, indent: string): string => {
    let out = "";
    if (h.limit !== undefined) out += `\n${indent}.limit(${h.limit})`;
    for (const w of h.where ?? []) out += `\n${indent}.where(${JSON.stringify(w.field)}, ${JSON.stringify(w.op)}, ${lit(w.value)})`;
    for (const c of h.counts ?? []) {
      out += `\n${indent}.countAs(${JSON.stringify(countAlias(c))}, ${short(countEdge(c))})`;
    }
    for (const k of h.hops ?? []) {
      out += `\n${indent}.related(${JSON.stringify(k.as ?? short(k.edge))}, ${short(k.edge)}, q => q${body(k, indent + "  ")})`;
    }
    return out;
  };
  // The namespace is written only when it is not the article one. parse() defaults it to 0, so the
  // round trip holds either way, and the form the editor is seeded with is the form it teaches.
  const from = spec.from.ns === 0
    ? JSON.stringify(spec.from.title)
    : `${spec.from.ns}, ${JSON.stringify(spec.from.title)}`;
  return `page(${from})${body(spec, "  ")}`;
}

// ---- the schema, as the editor's autocomplete sees it

export interface SchemaView {
  objects: { name: string; otype: number; fields: { name: string; type: string; optional: boolean }[] }[];
  edges: { name: string; atype: number; from: string; to: string }[];
  entry: { by: string; namespaces: { value: number; label: string }[] };
  limits: Limits & { ops: readonly CmpOp[] };
}

/** The namespaces worth offering. MediaWiki has many; these are the ones this import holds enough of
 *  to be worth a menu entry, and the editor accepts any integer anyway. */
const NAMESPACES = [
  { value: 0, label: "Article" },
  { value: 14, label: "Category" },
  { value: 4, label: "Project" },
  { value: 10, label: "Template" },
  { value: 12, label: "Help" },
];

export function schemaView(): SchemaView {
  return {
    objects: Object.entries(LOCK.objects).map(([name, o]) => ({
      name,
      otype: o.otype,
      fields: Object.entries(o.fields).map(([f, spec]) => ({ name: f, ...describe(spec) })),
    })),
    edges: Object.entries(EDGES).map(([name, e]) => ({
      name,
      atype: e.atype,
      from: e.from.name,
      to: e.to.name,
    })),
    entry: { by: "(ns, title) — a unique index. There is no scan and no prefix search.", namespaces: NAMESPACES },
    limits: { ...LIMITS, ops: OPS },
  };
}

// ---- the guard

/** What a submitted query may name: the relations above, and the fields of the types they land on.
 *  Taken from the typed values and the lock rather than re-listed, so the editor cannot offer an edge
 *  the catalog does not have.
 *
 *  One thing changed in the lift. This file used to check every filter against `wiki.page`, the one
 *  type all four relations point at; the core checks a filter against the type its own hop lands on.
 *  The two agree here, because every relation in this schema is page-to-page — and the core's rule is
 *  the one that is right in general. */
const VOCAB: Vocabulary = {
  edge: (name) => (EDGES[name] === undefined ? undefined : { to: EDGES[name]!.to.name }),
  edges: () => Object.keys(EDGES),
  fields: (type) => LOCK.objects[type]?.fields,
};

/**
 * Refuses a query that must not run, and reports what a permitted one will cost.
 *
 * The entry is this schema's own — one exact `(ns, title)`, with no scan and no prefix search — so it
 * is checked here. Everything below the entry is the generic guard.
 */
export function check(spec: QuerySpec): Cost {
  if (!spec || typeof spec !== "object") throw new QueryRefused("query", "expected an object");
  const from = spec.from;
  if (!from || typeof from.title !== "string" || from.title.length === 0) {
    throw new QueryRefused("from", "a title is required; entry is by (ns, title)");
  }
  if (from.title.length > 512) throw new QueryRefused("from.title", "longer than 512 characters");
  if (!Number.isInteger(from.ns) || from.ns < 0 || from.ns > 5000) {
    throw new QueryRefused("from.ns", `namespace must be an integer in 0..5000, got ${String(from.ns)}`);
  }
  return checkRequest(spec, VOCAB, LIMITS);
}

/** Prices a query without refusing it, for an editor that wants to show the cost of something that
 *  is over budget rather than only of something under it. */
export function price(spec: QuerySpec): Cost | { error: string; at: string } {
  try {
    return check(spec);
  } catch (e) {
    if (e instanceof QueryRefused) return { error: e.message, at: e.at };
    throw e;
  }
}

// ---- compiling a checked query

/** Builds the typed query a checked spec describes. Call `check` first; this assumes it passed. */
export function build(spec: QuerySpec, rootId: string): Query<FieldMap, unknown> {
  let q = Page.gen(rootId) as unknown as Query<FieldMap, unknown>;
  for (const c of spec.counts ?? []) q = q.countAs(countAlias(c), EDGES[countEdge(c)]!);
  for (const hop of spec.hops ?? []) q = addHop(q, hop);
  return q;
}

function addHop(q: Query<FieldMap, unknown>, hop: Hop): Query<FieldMap, unknown> {
  const edge = EDGES[hop.edge]!;
  const alias = hop.as && hop.as.length > 0 ? hop.as : hop.edge.replace(/^wiki\./, "");
  return q.related(alias, edge, (child) => {
    let c = child.limit(hop.limit ?? DEFAULT_HOP_LIMIT) as unknown as Query<FieldMap, unknown>;
    for (const w of hop.where ?? []) c = c.where(w.field, w.op, w.value as never);
    for (const n of hop.counts ?? []) c = c.countAs(countAlias(n), EDGES[countEdge(n)]!);
    for (const inner of hop.hops ?? []) c = addHop(c, inner);
    return c as never;
  }) as unknown as Query<FieldMap, unknown>;
}

/** The compiled plan, for showing an author what their query became. */
export function planOf(spec: QuerySpec, rootId: string): Plan {
  return build(spec, rootId).compile().plan;
}

export type { Cond };
