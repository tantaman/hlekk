// Build A's schema: the enwiki link and category graph. See docs/demo-dataset.md.
//
// One domain file's worth of names, planned into a lock, plus the runtime values a query is built
// from. Build B adds `wiki.revision` and `wiki.page_revisions`; both are additions, which What a
// change costs puts in the catalog-only column, so nothing here has to move to get there.

import { plan } from "../catalog/catalog.ts";
import { bool, defineObject, edge, num, str } from "../schema/define.ts";

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

      // ---- the category graph: a genuine maintained pair, at 242 million.
      //
      // Small enough that the outbox can carry it, which is the point: this is the one edge type in
      // Build A whose inverse arrives from another host, so it is the only thing in the demo that
      // exercises build-plan step 4 at scale. `time` is `cl_timestamp`, which categorylinks
      // carries, so "recently added to this category" is a real query.
      "wiki.page_categories": { from: "wiki.page", to: "wiki.page", inverse: "wiki.category_pages" },
      "wiki.category_pages": {
        from: "wiki.page",
        to: "wiki.page",
        inverse: "wiki.page_categories",
        maintained: true,
      },
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
 * So the key is made lowercase-stable instead: every uppercase ASCII letter becomes `%` plus its
 * lowercase hex code, which `toLowerCase()` then leaves alone. Lossless, and ugly for a reason —
 * the honest fix is for normalization to be a property of the index rather than one global
 * function, which is recorded as open in docs/demo-dataset.md. Underscores are kept as MediaWiki
 * stores them, so the caller passes a title in `page_title` form.
 */
export const titleKey = (ns: number, title: string): string =>
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
