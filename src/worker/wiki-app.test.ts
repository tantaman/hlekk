// How the wiki Worker decides that a request is not its to answer.
//
// The demo's claim is a comparison between three placements, and a placement is a property of a
// whole database: one deployment holds exactly one. So `?placement=b` and `?placement=c` are
// forwards, not lookups, and the things worth testing are that only those two values forward, that
// each names its own binding, and that the parameter does not survive the trip -- the other
// deployments run this same code, so a forward that kept it would ask to be forwarded again, and
// the loop would be a Worker calling itself until it ran out.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LocalCluster } from "../client/local.ts";
import { altTarget, cardQuery, relationPage, titleLookup, wipeTarget } from "./wiki-app.ts";
import { LOCK, Page, legacyTitleKey, pageLinks, storedTitle, titleKey } from "./wiki.ts";
import type { Env } from "../do/bindings.ts";

/** The card's row, as the Worker hands it to the UI. */
interface CardRow {
  linkCount: number;
  links: { items: { id: string; title: string }[]; cursor: string | null; more: boolean };
}

const at = (query: string) => altTarget(new URL("https://wiki.example.com/page" + query));

describe("altTarget", () => {
  it("forwards the control placement", () => {
    const alt = at("?ns=0&title=Country&placement=b");
    assert.ok(alt !== null);
    assert.equal(alt.to.pathname, "/page");
    assert.equal(alt.which, "b");
  });

  it("forwards the graph placement to its own binding", () => {
    // Which binding, not just that it forwards: the control and the placement under test are not
    // interchangeable, and sending one to the other would quote a ratio of a database against
    // itself.
    const alt = at("?ns=0&title=Country&placement=c");
    assert.ok(alt !== null);
    assert.equal(alt.to.pathname, "/page");
    assert.equal(alt.which, "c");
  });

  it("strips the parameter, so the forward cannot bounce back", () => {
    for (const which of ["b", "c"]) {
      const alt = at("?title=Country&placement=" + which);
      assert.ok(alt !== null);
      assert.equal(alt.to.searchParams.get("placement"), null);
      assert.equal(altTarget(alt.to), null, "the forwarded URL must be one the other side answers itself");
    }
  });

  it("carries everything else across unchanged", () => {
    const alt = at("?ns=14&title=Cancer_deaths_in_Canada&limit=25&placement=b&driver=rounds");
    assert.ok(alt !== null);
    assert.equal(alt.to.searchParams.get("ns"), "14");
    assert.equal(alt.to.searchParams.get("title"), "Cancer_deaths_in_Canada");
    assert.equal(alt.to.searchParams.get("limit"), "25");
    assert.equal(alt.to.searchParams.get("driver"), "rounds");
  });

  it("answers everything else itself", () => {
    // Including the names an earlier design accepted as aliases. One spelling per placement, so
    // there is one answer to "did this request go to another database".
    for (const q of ["", "?placement=a", "?placement=alt", "?placement=hash", "?placement=", "?placement=B", "?placement=C", "?placement=graph", "?placement=d"]) {
      assert.equal(at(q), null, q === "" ? "(no parameter)" : q);
    }
  });
});

// Erasing a database is the one irreversible thing this Worker can do, and the only way to reclaim a
// Durable Object's storage -- so the guard in front of it is worth more tests than the operation.
// Two independent facts have to agree: the deployment names a victim in configuration, and the
// request names the same one. Neither alone does anything.
describe("wipeTarget", () => {
  const armed = { HLEKK_WIPE: "wiki-pilot2" } as unknown as Env;
  const url = (q: string) => new URL("https://wiki.example.com/admin/wipe" + q);

  it("wipes the armed database when the request names it", () => {
    assert.equal(wipeTarget(armed, url("?database=wiki-pilot2")), "wiki-pilot2");
  });

  it("arms several databases from one list, since abandoned ones accumulate", () => {
    const many = { HLEKK_WIPE: "wiki, wiki-pilot ,wiki-pilot2" } as unknown as Env;
    for (const name of ["wiki", "wiki-pilot", "wiki-pilot2"]) {
      assert.equal(wipeTarget(many, url("?database=" + name)), name, name);
    }
    // And nothing beyond the list, including the live database and a prefix of a listed name.
    for (const name of ["wiki-simple-cat", "wiki-pilot3", "wiki-", "pilot"]) {
      assert.equal(wipeTarget(many, url("?database=" + name)), null, name);
    }
  });

  it("refuses when nothing is armed, which is the committed state", () => {
    for (const env of [{}, { HLEKK_WIPE: "" }, { HLEKK_DATABASE: "wiki-simple-cat" }]) {
      assert.equal(wipeTarget(env as unknown as Env, url("?database=wiki-simple-cat")), null);
      assert.equal(wipeTarget(env as unknown as Env, url("?database=wiki-pilot2")), null);
    }
  });

  it("refuses a request that names any other database", () => {
    // Including the live one, a near-miss, and the shapes that would reach another tenant's objects
    // if the name were ever taken from the request rather than merely matched against it.
    for (const asked of [
      "wiki-simple-cat", "wiki-pilot", "wiki-pilot2 ", "WIKI-PILOT2", "", "demo",
      "../wiki-simple-cat", "wiki-pilot2/h-0", "*",
    ]) {
      assert.equal(wipeTarget(armed, url("?database=" + encodeURIComponent(asked))), null, asked);
    }
  });

  it("refuses a request that names nothing at all", () => {
    assert.equal(wipeTarget(armed, url("")), null);
    assert.equal(wipeTarget(armed, url("?confirm=wiki-pilot2")), null);
  });
});

// The page card and "show more" are two halves of one contract: the card reads the first page of
// each list, the button reads the rest, and the cursor the card returns is the only thing joining
// them. The card used plain `related`, which hands back rows and no cursor -- so the button had
// nowhere to resume from, re-read each list from its start, and appended rows that were already on
// screen. A page with 20 links showed 40 chips, every one of them twice.
//
// Both sides run the Worker's own builders against a real cluster here, because a test that wrote
// the queries out again would have agreed with itself while the Worker disagreed.
describe("the page card and the list it continues", () => {
  async function seeded(links: number) {
    const c = new LocalCluster();
    c.directory.applyLock(LOCK);
    c.spreadCatalog();
    await c.publish();
    const db = c.client();
    const page = (title: string, vshard: string) =>
      db.create(Page.otype, { ns: 0, title, redirect: false, len: 100 }, { vshard });
    const from = await page("Country", "5");
    for (let i = 1; i <= links; i++) {
      // Spread over vshards, as the real graph is: a page's links point anywhere.
      const to = await page("Target" + i, String(10 + (i % 7)));
      await db.assocAdd(pageLinks.atype, from, to, 0);
    }
    return { db, from };
  }

  it("hands the button a cursor, so the next page continues rather than repeats", async () => {
    const { db, from } = await seeded(5);
    const [card] = (await cardQuery(from, 2).run(db)) as unknown as CardRow[];
    assert.equal(card.linkCount, 5, "the counter sees the whole list");
    assert.equal(card.links.items.length, 2);
    assert.equal(card.links.more, true);
    assert.ok(card.links.cursor, "a card with more to show must say where to resume");

    const [next] = (await relationPage(from, pageLinks, 2, card.links.cursor).run(db)) as unknown as {
      items: { items: { id: string; title: string }[]; cursor: string | null; more: boolean };
    }[];
    const titles = [...card.links.items, ...next.items.items].map((l) => l.title);
    assert.equal(new Set(titles).size, titles.length, "a row the card already showed came back: " + titles.join(", "));
    assert.equal(titles.length, 4);
  });

  it("says a list that fits the card is whole, so no button is drawn", async () => {
    // The other half of the same bug: "20 total" over 20 chips still offered "show more", and
    // pressing it was the only way to find out there was nothing behind it.
    const { db, from } = await seeded(3);
    const [card] = (await cardQuery(from, 25).run(db)) as unknown as CardRow[];
    assert.equal(card.links.items.length, 3);
    assert.equal(card.links.more, false);
  });

  it("reads a whole list through its cursors with nothing lost or repeated", async () => {
    const { db, from } = await seeded(9);
    const seen: string[] = [];
    const [card] = (await cardQuery(from, 4).run(db)) as unknown as CardRow[];
    seen.push(...card.links.items.map((l) => l.title));
    let cursor = card.links.cursor;
    let more = card.links.more;
    for (let round = 0; more && round < 10; round++) {
      const [page] = (await relationPage(from, pageLinks, 4, cursor).run(db)) as unknown as {
        items: { items: { title: string }[]; cursor: string | null; more: boolean };
      }[];
      seen.push(...page.items.items.map((l) => l.title));
      cursor = page.items.cursor;
      more = page.items.more;
    }
    assert.equal(seen.length, 9, "every link, once: " + seen.join(", "));
    assert.equal(new Set(seen).size, 9);
  });
});

// What a typed title has to resolve to. The loader indexes a page under the dump's own spelling --
// underscores, first letter upper -- so the only question a lookup asks is whether what someone
// typed lands on that key. It did from the browse pane, which normalized in the browser, and did
// not from the query editor, which sent the text straight to an exact-key lookup.
describe("resolving a title to the key the loader wrote", () => {
  const written = titleKey(0, "Computer_science");

  it("lands a typed title on the dump's own key", () => {
    for (const typed of ["Computer science", "computer science", "Computer_science", "  computer science  "]) {
      assert.equal(titleKey(0, storedTitle(typed)), written, typed);
    }
  });

  it("keeps a title that differs by more than spacing a different page", () => {
    // "Computer Science" is a real title in this dump and a *different* one -- a redirect to the
    // article. Normalizing case beyond the first letter would quietly answer a question nobody
    // asked, so the rule stops where MediaWiki's does.
    assert.notEqual(titleKey(0, storedTitle("Computer Science")), written);
    assert.equal(storedTitle("Computer Science"), "Computer_Science");
  });

  it("is idempotent, so normalizing at the lookup cannot harm a caller that already did", () => {
    for (const t of ["Computer science", "NASA", "North Korea", "éclair", "ß", ""]) {
      assert.equal(storedTitle(storedTitle(t)), storedTitle(t), t);
    }
  });

  it("finds a page from a title typed with spaces", async () => {
    // The index as the loader left it: one entry, under the dump's own spelling. Driving the real
    // lookup is the point -- the rule being right is no use if the read path does not apply it,
    // which is exactly the shape of the bug this fixes.
    const index = new Map([[written, "page-1"]]);
    const lookup = async (key: string) => index.get(key) ?? null;
    for (const typed of ["Computer science", "computer science", "Computer_science", " computer science "]) {
      assert.equal(await titleLookup(lookup, 0, typed), "page-1", typed);
    }
  });

  it("still does not invent a page that is not there", async () => {
    const index = new Map([[written, "page-1"]]);
    const lookup = async (key: string) => index.get(key) ?? null;
    // A different title, a different namespace, and a near-miss that normalization must not close.
    assert.equal(await titleLookup(lookup, 0, "Computer Science"), null);
    assert.equal(await titleLookup(lookup, 14, "Computer science"), null);
    assert.equal(await titleLookup(lookup, 0, "Computerscience"), null);
  });

  it("falls back to the key a loaded database may have been written under, and only on a miss", async () => {
    // 0.332% of simplewiki's titles spell differently under the two schemes, and the three loaded
    // databases used the old one. The fallback is what keeps them readable -- and it has to normalize
    // too, or a typed title reaches the legacy key no better than it reached the current one.
    const legacyOnly = new Map([[legacyTitleKey(0, "\u00C9clair"), "page-9"]]);
    const reads: string[] = [];
    const lookup = async (key: string) => {
      reads.push(key);
      return legacyOnly.get(key) ?? null;
    };
    assert.equal(await titleLookup(lookup, 0, "éclair"), "page-9");
    assert.equal(reads.length, 2, "the legacy key costs a second read");
    reads.length = 0;
    await titleLookup(lookup, 0, "Computerscience");
    assert.equal(reads.length, 1, "an ASCII title spells the same way, so there is nothing to retry");
  });

  it("leaves a namespace out of it", () => {
    // The index key is (ns, title) and the namespace is a separate column, so normalization touches
    // the title alone -- a category keeps its own namespace and gets the same spelling rule.
    assert.equal(storedTitle("France geography stubs"), "France_geography_stubs");
    assert.notEqual(titleKey(14, "France_geography_stubs"), titleKey(0, "France_geography_stubs"));
  });
});
