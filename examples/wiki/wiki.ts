// The enwiki link and category graph. See docs/wikimedia-import.md, and wikimedia-demo.md for the
// demo this feeds.
//
// One domain file's worth of names, planned into a lock, plus the runtime values a query is built
// from. Revisions would be `wiki.revision` plus an edge type, and both are additions, which What a
// change costs puts in the catalog-only column — so nothing here has to move to add them.

import { plan } from "../../src/catalog/catalog.ts";
import { bool, defineObject, edge, num, str } from "../../src/schema/define.ts";

export const LOCK = plan({
  wiki: {
    objects: {
      // One type for every page in every namespace, because in MediaWiki a category *is* a page
      // (namespace 14) and so is a template. Giving categories their own object type would mean two
      // types for one row in `page` and an edge whose target type depended on the namespace, which
      // is the polymorphic-target problem docs/demo-dataset.md records against the Merkle DAG. One
      // type with `ns` on the payload avoids it entirely.
      "wiki.page": {
        fields: {
          ns: "number",
          title: "string",
          redirect: "boolean",
          len: "number",
          // The first ~300 characters of the article, so a page reads as something. Absent outside
          // namespace 0. Full wikitext is not in either build's budget.
          extract: { optional: "string" },
        },
      },
    },
    edges: {
      // ---- the link graph: two independent types, deliberately not a pair.
      //
      // Pairing these would put ~1.78 billion inverse writes through the outbox, which is the
      // largest single risk in the load, and it would buy nothing: a dump is a static snapshot, so
      // the two sides cannot drift apart. The loader writes each side from its own sorted pass over
      // `pagelinks`. What this gives up is real and worth naming — the engine is not enforcing that
      // the two agree, so `invariants.ts` has to check it as if they were paired, and a live
      // EventStreams tail would have to make them one.
      //
      // `time` is 0 on both: the dump does not record where in an article a link appeared, so there
      // is no ordinal to sort by and the primary key's id2 breaks the tie. Stable, and arbitrary.
      "wiki.page_links": { from: "wiki.page", to: "wiki.page" },
      "wiki.linked_from": { from: "wiki.page", to: "wiki.page" },

      // ---- the category graph: also two independent types, for the same reason.
      //
      // This was a maintained pair in the first draft, specifically to exercise the outbox at 242
      // million. wikimedia-demo.md puts outbox delivery out of scope and has the loader materialize
      // both halves of every pair and the counts for both directions — because a bulk load cannot
      // route backlinks through the outbox at this volume. So pairing this bought a demonstration
      // of a mechanism the demo excludes, and charged 242 million queued ops on the critical path
      // for it. Unpaired, each side is one sorted pass over `categorylinks`.
      //
      // `time` is `cl_timestamp`, which the table still carries, so "recently added to this
      // category" is a real query. `category_pages` is from a page in namespace 14.
      "wiki.page_categories": { from: "wiki.page", to: "wiki.page" },
      "wiki.category_pages": { from: "wiki.page", to: "wiki.page" },
    },
  },
});

const ot = (name: string) => LOCK.objects[name].otype;
const at = (name: string) => LOCK.edges[name].atype!;

export const Page = defineObject("wiki.page", ot("wiki.page"), {
  ns: num(),
  title: str(),
  redirect: bool(),
  len: num(),
  extract: str().optional(),
});

export const pageLinks = edge("wiki.page_links", at("wiki.page_links"), Page, Page);
export const linkedFrom = edge("wiki.linked_from", at("wiki.linked_from"), Page, Page);
export const pageCategories = edge("wiki.page_categories", at("wiki.page_categories"), Page, Page);
/** The maintained half: nothing writes it directly, so every row in it arrived through the outbox
 *  from the host that wrote the other side. Reading it is how the demo shows that happened. */
export const categoryPages = edge("wiki.category_pages", at("wiki.category_pages"), Page, Page);

// ---- the global unique index on title
//
// `idx` is a bare integer the caller supplies: as built, the lock does not declare indexes, though
// design.md's Indexing says it should. 1 is this database's only index.
export const TITLE_IDX = 1;

/**
 * The index key for a page title.
 *
 * `client.normalize` lowercases every key, and MediaWiki titles are case-sensitive after the first
 * character — `Ash` and `ASH` are different enwiki pages. Keyed on the title as written, the second
 * page of such a pair is refused with `ValueTaken` and the loader silently drops it.
 *
 * So the key is made lowercase-stable instead: every character `toLowerCase()` would change is
 * percent-encoded, one `%xx` per UTF-8 byte in lowercase hex, which `toLowerCase()` then leaves
 * alone. Underscores are kept as MediaWiki stores them, so the caller passes a title in
 * `page_title` form.
 *
 * Percent-encoding rather than a bare code point, because a code point's hex is variable-width and
 * `%` + hex is then ambiguous: `A1` would escape to `%411` and so would `Б` (U+0411), and the same
 * for `Ad`/`Н`, `Ae`/`О` and `Bd`/`Э`. Measured, that trade is a bad one — it fixes 7 collisions
 * and introduces 23. Two hex digits per byte is uniquely decodable, and it leaves `A` as `%41`,
 * exactly what the ASCII-only version emitted.
 *
 * Escaping only `[A-Z]` was not enough, and the gap was measured rather than argued. It left every
 * *non-ASCII* capital for the normalizer to fold, which collapsed 7 pairs of distinct simplewiki
 * pages onto 7 objects — `Coup_d'état` with `Coup_d'État`, `ß` with `ẞ`, `Русский_Язык` with
 * `Русский_язык`. The loser of each pair got no object at all, its edges were written onto the
 * winner's, and asking for its title served the other page. Seven in 950,421 here, and ~490 at the
 * same rate in enwiki — a floor, since enwiki's titles are less often pure ASCII.
 *
 * `%` is escaped too, or the escape is not injective: a page actually named `%43at` would key the
 * same as `Cat`. 13 simplewiki titles contain a `%` and none of them collides, which is luck.
 *
 * Still ugly for the reason it always was — the honest fix is for normalization to be a property of
 * the index rather than one global function, recorded as open in docs/demo-dataset.md.
 *
 * CHANGING THIS INVALIDATES A LOADED DATABASE'S TITLE INDEX, because the key decides which index
 * vshard holds the entry as well as what is stored in it. This version leaves 99.67% of simplewiki's
 * keys byte-identical; the other 0.332% — 3,157 titles — would stop resolving by title if a Worker
 * serving an already-loaded database were redeployed onto it.
 */
const ESCAPER = new TextEncoder();
const escape = (c: string): string =>
  [...ESCAPER.encode(c)].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");

/**
 * A title as `page_title` holds it: spaces as underscores, first letter upper case.
 *
 * This is MediaWiki's own rule rather than a fuzzy match. A dump never stores a space in
 * `page_title`, and `$wgCapitalLinks` capitalizes the first letter in every standard namespace, so
 * "Computer science", "Computer_science" and "computer science" are three spellings of one title
 * and only the third form is a key.
 *
 * It lives here because both ways into the database need it and only one of them had it: the browse
 * pane normalized in the browser, so a title typed into the query editor reached an exact-key lookup
 * with its spaces intact and missed a page that is plainly there.
 *
 * Idempotent, which is what makes it safe to apply at the lookup even for callers that had already
 * normalized -- the browse pane still does, because the address bar should carry the stored spelling.
 */
export const storedTitle = (title: string): string =>
  title.trim().replace(/ /g, "_").replace(/^./u, (c) => c.toUpperCase());

export const titleKey = (ns: number, title: string): string =>
  `${ns}:${title.replace(/./gsu, (c) => (c === "%" || c !== c.toLowerCase() ? escape(c) : c))}`;

/**
 * The key `titleKey` emitted before it escaped by UTF-8 byte. Kept only so that a database loaded
 * under it stays readable.
 *
 * A key decides which index vshard holds its entry, so the entries a load wrote cannot be found
 * under a different spelling — and the three simplewiki databases were loaded under this one. 99.67%
 * of their keys are byte-identical either way; this covers the 0.332% that are not, which is every
 * title holding a non-ASCII capital or a literal `%`.
 *
 * Read paths only. A *write* under this would recreate the collision the escape exists to prevent,
 * which is why `/ingest/pages` does not fall back.
 */
export const legacyTitleKey = (ns: number, title: string): string =>
  `${ns}:${title.replace(/[A-Z]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`;

/** The page card the demo renders: the page, its first outlinks and categories, and the two counts
 *  that would each have been a `COUNT(*)`. The outlink *targets* live in their own vshards, so this
 *  is the two-hop case — one request to the page's host, then one batched request per host holding
 *  a target. */
export const pageCard = (root: string) =>
  Page.gen(root)
    .countAs("linkCount", pageLinks)
    .countAs("backlinkCount", linkedFrom)
    .related("links", pageLinks, (q) => q.limit(50))
    .related("categories", pageCategories, (q) => q.limit(50));
