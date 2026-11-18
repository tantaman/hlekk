import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan as planLock } from "../catalog/catalog.ts";
import type { Lock } from "../catalog/catalog.ts";
import { federate } from "../testkit/federation.ts";
import type { Federation } from "../testkit/federation.ts";
import { ForeignUnreachable, NotFollowed, ResponseCache, foreignClient } from "./client.ts";
import { defineObject, edge, str } from "../schema/define.ts";
import { objField } from "../schema/query.ts";
import { DEFAULT_LIMITS } from "../query/request.ts";
import { PUBLIC } from "../query/serve.ts";
import { BudgetSpent } from "../client/client.ts";
import { assertSound } from "../testkit/invariants.ts";
import type { Id, Plan } from "../query/types.ts";
import type { Hlekk } from "../client/client.ts";

// Milestone A: a new database holds an edge to an object in another one, and one query returns it.

const WIKI = "https://wiki.example/db";
const NOTES = "https://notes.example/db";
const GONE = "https://gone.example/db";

/** The wiki: pages linking to pages, all local. */
const WIKI_LOCK: Lock = planLock({
  wiki: {
    objects: { "wiki.page": { fields: { title: "string", secret: { optional: "string" } } } },
    edges: { "wiki.page_links": { from: "wiki.page", to: "wiki.page" } },
  },
});

/** The notes database: notes with an edge into the wiki. It declares `wiki.page` too, because a type
 *  name is only half of an agreement — what crosses the wire is the name, and a reader has to know
 *  the shape behind it or decline the type. */
const NOTES_LOCK: Lock = planLock({
  notes: {
    objects: { "notes.note": { fields: { body: "string", aboutId: { optional: { id: "wiki.page" } } } } },
    edges: {
      "notes.note_about": { from: "notes.note", to: "wiki.page", foreign: true },
      "notes.note_about_field": { from: "notes.note", to: "wiki.page", field: "aboutId", foreign: true },
    },
  },
  // `wiki.page_links` is declared here too, and it has to be: a plan carries the ASKING database's
  // atypes, and the wire carries names. A notes query that hops `page -> page_links` can only name
  // that edge if its own catalog has an entry for it. The two databases' integers are unrelated —
  // here `notes.note_about` and `wiki.page_links` are both 1 in their own catalogs — which is the
  // whole reason integers never cross.
  wiki: {
    objects: { "wiki.page": { fields: { title: "string" } } },
    edges: { "wiki.page_links": { from: "wiki.page", to: "wiki.page" } },
  },
});

/** What the wiki serves: pages by title, and not the field it keeps to itself. A projection is the
 *  mechanism for that, and it is the responder's to state — field agreement between two catalogs is
 *  a different question, and the answer is the vocabulary comparison further down this file. */
const WIKI_PUBLIC = { name: "public", include: ["wiki.*"], fields: { "wiki.page": ["title"] } };

const NOTES_CATALOG = Catalog.compile(NOTES_LOCK);
const WIKI_CATALOG = Catalog.compile(WIKI_LOCK);
const T = {
  note: NOTES_CATALOG.objectNamed("notes.note")!.otype,
  about: NOTES_CATALOG.edgeNamed("notes.note_about")!.atype!,
  page: WIKI_CATALOG.objectNamed("wiki.page")!.otype,
  // From the NOTES catalog, because that is whose plan traverses it.
  links: NOTES_CATALOG.edgeNamed("wiki.page_links")!.atype!,
  wikiLinks: WIKI_CATALOG.edgeNamed("wiki.page_links")!.atype!,
};

/** The plan for `note -> about`, which is the whole of Milestone A. */
const ABOUT_PLAN: Plan = {
  frames: [
    { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
    { source: { kind: "edge", atype: T.about }, children: [], counts: [] },
  ],
};

interface Two {
  f: Federation;
  note: Id;
  page: Id;
  other: Id;
}

async function two(opts: Partial<Parameters<typeof federate>[0]> = {}): Promise<Two> {
  const f = await federate({
    members: [
      { uri: WIKI, lock: WIKI_LOCK, database: "wiki", projection: WIKI_PUBLIC },
      { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
    ],
    ...opts,
  });
  const wiki = f.member(WIKI);
  const notes = f.member(NOTES);
  const page = await wiki.db.create(T.page, { title: "Country", secret: "not yours" }, { vshard: "3" });
  const other = await wiki.db.create(T.page, { title: "Capital" }, { with: page });
  await wiki.db.assocAdd(T.wikiLinks, page, other, 1);
  const note = await notes.db.create(T.note, { body: "about a country" }, { vshard: "7" });
  await notes.db.assocAdd(T.about, note, `${WIKI}#${page}`, 1);
  return { f, note, page, other };
}

describe("foreign pages", () => {
  const Page = defineObject("wiki.page", NOTES_CATALOG.objectNamed("wiki.page")!.otype, { title: str() });
  const links = edge("wiki.page_links", T.links, Page, Page);

  for (const driver of ["async", "rounds"] as const) {
    it(`continues through empty pages, filters and application page boundaries on ${driver}`, async () => {
      const { f, page } = await two();
      const wiki = f.member(WIKI);
      wiki.binding.limits = { ...DEFAULT_LIMITS, maxLimit: 2 };
      const hidden = new Set<string>();
      wiki.binding.policy = { ...PUBLIC, object: id => !hidden.has(id) };
      for (let i = 2; i <= 8; i++) {
        const id = await wiki.db.create(T.page, { title: i === 5 ? "skip" : String(i) }, { with: page });
        if (i >= 7) hidden.add(id);
        await wiki.db.assocAdd(T.wikiLinks, page, id, i);
      }
      const root = `${WIKI}#${page}`;
      const db = f.member(NOTES).db;
      const queryPage = (start: string | null) => Page.gen(root).relatedPage("links", links, sub => {
        const level = sub.where(objField("title", "!=", "skip")).limit(2);
        return start ? level.after(start) : level;
      });
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 4; i++) {
        const query = queryPage(cursor);
        const [answer] = await query.run(db, { driver });
        const normalized = await db.normalized(query.compile().plan, [root], { driver });
        assert.equal(answer.links.cursor, normalized.lists[`1:${root}`].cursor);
        seen.push(...answer.links.items.map(row => row.title));
        if (!answer.links.more) break;
        cursor = answer.links.cursor;
        assert.ok(cursor);
      }
      assert.deepEqual(seen, ["6", "4", "3", "2", "Capital"]);
    });
  }
});

describe("the first cross-database read", () => {
  for (const driver of ["async", "rounds"] as const) {
    it(`follows an edge into another database, on the ${driver} driver`, async () => {
      const { f, note, page } = await two();
      const rows = (await f.member(NOTES).db.query(ABOUT_PLAN, [note], { driver })) as {
        body: string;
        about: { id: string; title: string }[];
      }[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0].body, "about a country");
      // The page came back, and its id is absolute: past the seam the coordinator holds references,
      // so an application that logs or stores this one can follow it again.
      assert.deepEqual(rows[0].about, [{ title: "Country", id: `${WIKI}#${page}`, $version: 1, $edge: { time: 1, data: null } }]);
      assertSound(f.member(NOTES).cluster, { quiesced: true });
      assertSound(f.member(WIKI).cluster, { quiesced: true });
    });
  }

  it("follows a reference out of a payload, which carries the URI already", async () => {
    const { f, page } = await two();
    const notes = f.member(NOTES);
    const note = await notes.db.create(T.note, { body: "by field", aboutId: `${WIKI}#${page}` }, { vshard: "7" });
    const field = NOTES_CATALOG.edgeNamed("notes.note_about_field")!;
    const rows = (await notes.db.query(
      {
        frames: [
          { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
          { source: { kind: "field", field: field.field! }, children: [], counts: [] },
        ],
      },
      [note],
    )) as { about: { id: string; title: string }[] }[];
    // A payload reference needs no alias: it was written as a URI and read back as one, which is why
    // `ref.ts` had to exist before any storage changed.
    assert.deepEqual(rows[0].about.map((a) => [a.id, a.title]), [[`${WIKI}#${page}`, "Country"]]);
  });

  // The test the whole alias-in-the-key design exists for.
  it("does not answer with the local object that happens to share the id", async () => {
    const f = await federate({
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "wiki" },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
      ],
    });
    const notes = f.member(NOTES);
    const wiki = f.member(WIKI);
    // One id, in both databases: the notes database has an object at it, the wiki does not.
    const local = await notes.db.create(T.note, { body: "local" }, { vshard: "7" });
    const note = await notes.db.create(T.note, { body: "the note" }, { with: local });
    await notes.db.assocAdd(T.about, note, `${WIKI}#${local}`, 1);
    assert.equal(await objectExists(wiki, local), false, "the wiki has no object at that id");

    const rows = (await notes.db.query(ABOUT_PLAN, [note])) as { about: unknown[] }[];
    // An edge to the wiki's `local`, which does not exist there. The notes database's own `local`
    // must not be the answer: that would be an answer about a different object with nothing to mark
    // it as one, which is the failure that put the alias in the key.
    assert.deepEqual(rows[0].about, []);
  });

  it("asks a foreign database once however many of its objects a query needs", async () => {
    const f = await federate({
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "wiki" },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
      ],
    });
    const wiki = f.member(WIKI);
    const notes = f.member(NOTES);
    const pages: Id[] = [];
    for (let i = 0; i < 12; i++) pages.push(await wiki.db.create(T.page, { title: `p${i}` }, { vshard: "3" }));
    const note = await notes.db.create(T.note, { body: "many" }, { vshard: "7" });
    for (const [i, p] of pages.entries()) await notes.db.assocAdd(T.about, note, `${WIKI}#${p}`, i + 1);

    wiki.served.read = 0;
    const rows = (await notes.db.query(
      {
        frames: [
          { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
          { source: { kind: "edge", atype: T.about }, limit: 20, children: [], counts: [] },
        ],
      },
      [note],
    )) as { about: unknown[] }[];
    assert.equal(rows[0].about.length, 12);
    // Both drivers batch by client identity, and a foreign database is one client — so twelve
    // targets in one database are one request, which is the same property a wide local fan-out has.
    assert.equal(wiki.served.read, 1, "twelve objects in one database, one request");
  });
});

describe("a database answering a read never follows a reference out of itself", () => {
  // Otherwise it is the deputy protocol.md rules out: fetching from a third party on the caller's
  // behalf, under its own identity, with the caller unable to tell whose answer it got.
  const THREE: Lock = planLock({
    a: {
      objects: { "a.thing": { fields: { name: "string" } } },
      edges: { "a.out": { from: "a.thing", to: "a.thing", foreign: true } },
    },
  });
  const THING = Catalog.compile(THREE).objectNamed("a.thing")!.otype;
  const OUT = Catalog.compile(THREE).edgeNamed("a.out")!.atype!;
  const A = "https://a.example/db";
  const B = "https://b.example/db";
  const C = "https://c.example/db";

  it("lists the reference and loads nothing, which is not the same as an empty list", async () => {
    const f = await federate({
      members: [
        { uri: A, lock: THREE, database: "a" },
        { uri: B, lock: THREE, database: "b" },
        { uri: C, lock: THREE, database: "c" },
      ],
    });
    const [a, b, c] = [f.member(A), f.member(B), f.member(C)];
    const inA = await a.db.create(THING, { name: "a" }, { vshard: "1" });
    const inB = await b.db.create(THING, { name: "b" }, { vshard: "2" });
    const inC = await c.db.create(THING, { name: "c" }, { vshard: "3" });
    await a.db.assocAdd(OUT, inA, `${B}#${inB}`, 1);
    await b.db.assocAdd(OUT, inB, `${C}#${inC}`, 1);

    // A asks B for its object and one hop of its list. B holds an edge into C.
    c.served.read = 0;
    const res = await f.fetch(`${B}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [inB], hops: [{ as: "out", edge: "a.out", hops: [{ edge: "a.out" }] }] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      objects: Record<string, { type: string }>;
      lists: Record<string, { ids: string[] }>;
    };

    // The reference is in the list, and there is no object behind it. A caller must be able to tell
    // that from a list that is empty, and from an object that does not exist.
    assert.deepEqual(body.lists[`1:${inB}`].ids, [`${C}#${inC}`]);
    assert.equal(`${C}#${inC}` in body.objects, false);
    assert.equal(c.served.read, 0, "B asked C nothing");

    // And nothing hangs off it: B holds no edge list for an object it does not have, so an empty one
    // there would read as "C has nothing" rather than "ask C".
    assert.deepEqual(Object.keys(body.lists), [`1:${inB}`]);
    await b.db.query(ABOUT_PLAN, [inB], { driver: "rounds", foreign: "reference" });
    assert.equal(c.served.read, 0);
  });

  it("passes a reference through a filter undecided rather than dropping it", async () => {
    const f = await federate({
      members: [
        { uri: A, lock: THREE, database: "a" },
        { uri: B, lock: THREE, database: "b" },
      ],
    });
    const [a, b] = [f.member(A), f.member(B)];
    const inA = await a.db.create(THING, { name: "keep" }, { vshard: "1" });
    const localTarget = await a.db.create(THING, { name: "no" }, { with: inA });
    const inB = await b.db.create(THING, { name: "keep" }, { vshard: "2" });
    await a.db.assocAdd(OUT, inA, localTarget, 1);
    await a.db.assocAdd(OUT, inA, `${B}#${inB}`, 2);

    const res = await f.fetch(`${A}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ids: [inA],
        hops: [{ as: "out", edge: "a.out", where: [{ field: "name", op: "=", value: "keep" }] }],
      }),
    });
    const body = (await res.json()) as { lists: Record<string, { ids: string[] }> };
    // The local target fails the filter and is dropped. The reference cannot be judged here — this
    // database does not hold the object — so it passes through and the caller, who can follow it,
    // judges. Dropping it would hide that the reference exists at all.
    assert.deepEqual(body.lists[`1:${inA}`].ids, [`${B}#${inB}`]);
  });
});

describe("failure is stated, never inferred", () => {
  it("fails the query by default when a database cannot be reached", async () => {
    const f = await federate({
      members: [{ uri: NOTES, lock: NOTES_LOCK, database: "notes" }],
    });
    const notes = f.member(NOTES);
    const note = await notes.db.create(T.note, { body: "dangling" }, { vshard: "7" });
    await notes.db.assocAdd(T.about, note, `${GONE}#5`, 1);
    // A URI is mintable before the database behind it exists, which is the point of the design — so a
    // read has to be able to fail on one, by name, rather than answer an empty list.
    await assert.rejects(notes.db.query(ABOUT_PLAN, [note]), ForeignUnreachable);
  });

  it("omits and reports, for a caller that opts into that", async () => {
    const f = await federate({ members: [{ uri: NOTES, lock: NOTES_LOCK, database: "notes" }], omit: true });
    const notes = f.member(NOTES);
    const note = await notes.db.create(T.note, { body: "dangling" }, { vshard: "7" });
    await notes.db.assocAdd(T.about, note, `${GONE}#5`, 1);
    await notes.db.assocAdd(T.about, note, `${GONE}#6`, 2);
    const rows = (await notes.db.query(ABOUT_PLAN, [note])) as { about: unknown[] }[];
    assert.deepEqual(rows[0].about, []);
    // The answer says which database and how many references, because an empty list on its own is
    // indistinguishable from a database with nothing in it.
    assert.deepEqual(f.omitted.databases, { [GONE]: 2 });
  });

  it("carries a responder's refusal through with its `at`", async () => {
    const f = await federate({
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "wiki" },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
      ],
    });
    const wiki = f.member(WIKI);
    const res = await f.fetch(`${wiki.uri}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: ["1"], hops: [{ edge: "nope" }] }),
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { at: string }).at, "hops[0]");
  });

  it("follows a list that lives in the other database, which is where the query keeps going", async () => {
    const { f, note, page, other } = await two();
    // `note -> page -> the pages it links to`: the second hop is a list the wiki holds, so the
    // coordinator asks the wiki for it rather than answering an empty list. Milestone B.
    const rows = (await f.member(NOTES).db.query(
      {
        frames: [
          { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
          { source: { kind: "edge", atype: T.about }, children: [{ alias: "links", frame: 2 }], counts: [] },
          { source: { kind: "edge", atype: T.links }, children: [], counts: [] },
        ],
      },
      [note],
    )) as { about: { id: string; links: { id: string; title: string }[] }[] }[];
    assert.deepEqual(rows[0].about.map((a) => a.id), [`${WIKI}#${page}`]);
    assert.deepEqual(rows[0].about[0].links.map((l) => [l.id, l.title]), [[`${WIKI}#${other}`, "Capital"]]);
  });

  it("names an edge type this catalog cannot, rather than reading a list it could not interpret", async () => {
    const { f, note } = await two();
    // An atype with no name here is an atype that cannot be sent: the wire carries names.
    await assert.rejects(
      f.member(NOTES).db.query(
        {
          frames: [
            { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
            { source: { kind: "edge", atype: T.about }, children: [{ alias: "x", frame: 2 }], counts: [] },
            { source: { kind: "edge", atype: 9999 }, children: [], counts: [] },
          ],
        },
        [note],
      ),
      NotFollowed,
    );
  });

  it("refuses an answer that names a database the responder does not own", async () => {
    // A responder supplying objects for a third database would let it seed this one's view of that
    // database. Object keys must be bare ids of the answering database, and `decodeRead` checks it.
    const forged = await federate({
      members: [{ uri: NOTES, lock: NOTES_LOCK, database: "notes2" }, { uri: WIKI, lock: WIKI_LOCK }],
      wrap: (inner) => async (input, init) => String(input) === WIKI ? inner(input, init) :
        new Response(
          JSON.stringify({
            v: 1,
            roots: [],
            objects: { [`${GONE}#5`]: { type: "wiki.page", version: 1, data: { title: "x" } } },
            lists: {},
            counts: {},
            shape: {},
            cost: { frames: 1, nodes: 1 },
            cache: { reuse: "never" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const n = forged.member(NOTES);
    const id = await n.db.create(T.note, { body: "x" }, { vshard: "7" });
    await n.db.assocAdd(T.about, id, `${WIKI}#1`, 1);
    await assert.rejects(n.db.query(ABOUT_PLAN, [id]), /bare decimal/);
  });

  it("declines a type it does not understand, as an absent object rather than a guess", async () => {
    // The wiki's own catalog, which does not declare `notes.note`. An edge from the wiki into the
    // notes database would come back as a type the wiki cannot read.
    const WIKI_WITH_OUT: Lock = planLock(
      {
        wiki: {
          objects: { "wiki.page": { fields: { title: "string", secret: { optional: "string" } } } },
          edges: {
            "wiki.page_links": { from: "wiki.page", to: "wiki.page" },
            "wiki.page_out": { from: "wiki.page", to: "wiki.page", foreign: true },
          },
        },
      },
      WIKI_LOCK,
    );
    const f = await federate({
      members: [
        { uri: WIKI, lock: [WIKI_LOCK, WIKI_WITH_OUT], database: "wiki" },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
      ],
    });
    const wiki = f.member(WIKI);
    const notes = f.member(NOTES);
    const out = Catalog.compile(WIKI_WITH_OUT).edgeNamed("wiki.page_out")!.atype!;
    const page = await wiki.db.create(T.page, { title: "p" }, { vshard: "3" });
    const note = await notes.db.create(T.note, { body: "n" }, { vshard: "7" });
    await wiki.db.assocAdd(out, page, `${NOTES}#${note}`, 1);

    const rows = (await wiki.db.query(
      {
        frames: [
          { source: { kind: "ids" }, children: [{ alias: "out", frame: 1 }], counts: [] },
          { source: { kind: "edge", atype: out }, children: [], counts: [] },
        ],
      },
      [page],
    )) as { out: unknown[] }[];
    // A globally unique name says nothing about whether the reader knows the shape behind it, so a
    // reader has to be able to decline. It declines as absent, not as a guess at the fields.
    assert.deepEqual(rows[0].out, []);
  });
});

async function objectExists(m: { db: Hlekk }, id: Id): Promise<boolean> {
  const rows = await m.db.query({ frames: [{ source: { kind: "ids" }, children: [], counts: [] }] }, [id]);
  return rows.length > 0;
}

// ---- faults on the foreign fetch
//
// `testkit/unreliable.ts` does this for the internal transport, and the two failure modes it
// separates matter here for the same reason: a request that never arrived and a reply that was lost
// are indistinguishable to the caller, and only one of them is safe to retry blind. Reads apply
// nothing, so both are safe — but the ANSWER must not differ between them, and must never be an
// empty list.
describe("a foreign hop that fails", () => {
  const faulty = (mode: "before" | "after" | "hang") => (inner: typeof fetch): typeof fetch => {
    return async (input, init) => {
      if (mode === "before") throw new Error("connection refused");
      if (mode === "hang") {
        // A database that accepts the request and never answers. Two things are modelled because
        // both are what a real request does: the signal is honoured, which is how the deadline
        // reaches a stalled responder at all, and a timer holds the event loop open the way an
        // in-flight socket would. `AbortSignal.timeout` uses an unref'd timer, so without that the
        // test runner would drain and cancel before the deadline it is testing could fire.
        return new Promise((_, fail) => {
          const held = setTimeout(() => fail(new Error("gave up")), 5_000);
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener("abort", () => {
            clearTimeout(held);
            fail(new Error("aborted"));
          });
        });
      }
      await inner(input, init);
      throw new Error("the reply was lost");
    };
  };

  for (const mode of ["before", "after"] as const) {
    it(`fails the query by name when the request is lost ${mode === "before" ? "on the way out" : "on the way back"}`, async () => {
      const { f, note } = await two({ wrap: faulty(mode) });
      await assert.rejects(f.member(NOTES).db.query(ABOUT_PLAN, [note]), ForeignUnreachable);
    });

    it(`omits and reports the same way for ${mode}, so the two are not told apart by the answer`, async () => {
      const { f, note } = await two({ wrap: faulty(mode), omit: true });
      const rows = (await f.member(NOTES).db.query(ABOUT_PLAN, [note])) as { about: unknown[] }[];
      assert.deepEqual(rows[0].about, []);
      assert.deepEqual(f.omitted.databases, { [WIKI]: 1 });
    });
  }

  it("gives up on a deadline rather than waiting on a database that never answers", async () => {
    const { f, note } = await two({ wrap: faulty("hang"), foreign: { deadlineMs: 50 } });
    const started = Date.now();
    await assert.rejects(f.member(NOTES).db.query(ABOUT_PLAN, [note]), ForeignUnreachable);
    // One tenant's query latency is otherwise another tenant's to decide.
    assert.ok(Date.now() - started < 3_000, "the deadline, not the test runner, ended it");
  });

  it("refuses an answer over the byte cap", async () => {
    const { f, note } = await two({
      wrap: (inner) => async (input, init) => {
        const res = await inner(input, init);
        const body = await res.text();
        return new Response(body + " ".repeat(2048), { status: res.status, headers: res.headers });
      },
      foreign: { maxResponseBytes: 512 },
    });
    await assert.rejects(f.member(NOTES).db.query(ABOUT_PLAN, [note]), /byte cap/);
  });

  it("refuses an answer whose claimed length is over the cap, before reading it", async () => {
    const { f, note } = await two({
      wrap: (inner) => async (input, init) => {
        const res = await inner(input, init);
        const body = await res.text();
        return new Response(body, { status: res.status, headers: { "content-length": "99999999" } });
      },
      foreign: { maxResponseBytes: 512 },
    });
    await assert.rejects(f.member(NOTES).db.query(ABOUT_PLAN, [note]), /claims 99999999 bytes/);
  });

  it("refuses an answer that is not JSON at all", async () => {
    const { f, note } = await two({
      wrap: () => async () => new Response("<html>a proxy's error page</html>", { status: 200 }),
    });
    await assert.rejects(f.member(NOTES).db.query(ABOUT_PLAN, [note]), /not JSON/);
  });
});

describe("what a responder may not slip into an answer", () => {
  it("ignores lists and counts outside the requested frame and parents", async () => {
    const { f, page } = await two({
      wrap: inner => async (input, init) => {
        const res = await inner(input, init);
        if (!String(input).endsWith("/read")) return res;
        const body = await res.json();
        body.lists["1:999"] = { ids: [], cursor: null, more: false };
        body.counts["0:999"] = { [`a${T.links}`]: 99 };
        body.counts[`0:${body.roots[0]}`] = { a999: 99 };
        return Response.json(body);
      },
    });
    const reads = await foreignClient(WIKI, { catalog: NOTES_CATALOG, fetch: f.fetch }).exec({
      frames: [
        { source: { kind: "ids" }, children: [{ alias: "links", frame: 1 }], counts: [] },
        { source: { kind: "edge", atype: T.links }, children: [], counts: [] },
      ],
    }, [{ kind: "object", id: WIKI + "#" + page, frame: 0 }]);
    assert.deepEqual(reads.reads.lists.map(l => l.id1), [WIKI + "#" + page]);
    assert.deepEqual(reads.reads.counts, []);
  });

  it("validates the peer identity, wire version and limits during discovery", async () => {
    const { f, page } = await two();
    const descriptor = await (await f.fetch(WIKI)).json();
    for (const change of [
      { database: GONE }, { wire: [123] },
      { limits: { ...descriptor.limits, maxIds: 0 } },
      { limits: { ...descriptor.limits, maxLimit: 1.5 } },
    ]) {
      const client = foreignClient(WIKI, {
        catalog: NOTES_CATALOG,
        fetch: async () => Response.json({ ...descriptor, ...change }),
      });
      await assert.rejects(client.exec({ frames: [] }, [{ kind: "object", id: WIKI + "#" + page, frame: 0 }]), ForeignUnreachable);
    }
  });

  it("keeps nothing that was not asked for", async () => {
    // A responder that volunteers objects is answering a question nobody asked, and keeping those
    // would let it seed this database's view of its own graph.
    const { f, note, page } = await two({
      wrap: (inner) => async (input, init) => {
        const res = await inner(input, init);
        const url = typeof input === "string" ? input : (input as Request).url;
        if (!url.endsWith("/read")) return res;
        const body = (await res.json()) as { objects: Record<string, unknown> };
        body.objects["999999"] = { type: "wiki.page", version: 99, data: { title: "volunteered" } };
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const rows = (await f.member(NOTES).db.query(ABOUT_PLAN, [note])) as { about: { id: string }[] }[];
    assert.deepEqual(rows[0].about.map((a) => a.id), [`${WIKI}#${page}`]);

    // And the client's own reply holds exactly what it asked for, which is the mechanism rather than
    // the symptom: the answer is built from the asked ids, not from whatever came back.
    const client = foreignClient(WIKI, { catalog: NOTES_CATALOG, fetch: f.fetch, self: NOTES });
    const reply = await client.exec({ frames: [] }, [{ kind: "object", id: `${WIKI}#${page}`, frame: 0 }]);
    assert.deepEqual(reply.reads.objects.map(([id]) => id), [`${WIKI}#${page}`]);
    assert.deepEqual(reply.reads.lists, []);
    assert.deepEqual(reply.reads.counts, []);
  });

  it("answers every id that was asked for, as the object or as null", async () => {
    // Otherwise the coordinator waits on a read its store will never hold, which surfaces as an
    // internal error about a host rather than as "that object is not there".
    const { f, page } = await two();
    const client = foreignClient(WIKI, { catalog: NOTES_CATALOG, fetch: f.fetch, self: NOTES });
    const reply = await client.exec({ frames: [] }, [
      { kind: "object", id: `${WIKI}#${page}`, frame: 0 },
      { kind: "object", id: `${WIKI}#999999`, frame: 0 },
    ]);
    assert.deepEqual(
      reply.reads.objects.map(([id, o]) => [id, o === null ? null : (o.data as { title: string }).title]),
      [
        [`${WIKI}#${page}`, "Country"],
        [`${WIKI}#999999`, null],
      ],
    );
  });
});

describe("what one query may spend reaching other databases", () => {
  it("gives up when the request count is spent, saying which of the three ran out", async () => {
    const { f, note } = await two();
    // Discovery uses the only request available. The read must wait for another budget.
    const err = (await f
      .member(NOTES)
      .db.query(ABOUT_PLAN, [note], { budget: { requests: 1 } })
      .then(() => null, (e: Error) => e)) as BudgetSpent;
    assert.equal(err.name, "BudgetSpent");
    assert.equal(err.what, "requests");
    assert.equal(f.member(WIKI).served.descriptor, 1);
    assert.equal(f.member(WIKI).served.read, 0);
    // And the same query inside its budget is answered.
    const rows = (await f.member(NOTES).db.query(ABOUT_PLAN, [note], { budget: { requests: 4 } })) as {
      about: unknown[];
    }[];
    assert.equal(rows[0].about.length, 1);
  });

  it("gives up on the database count, which is what bounds a read fanning out", async () => {
    // Three real databases, so every hop would succeed and the only thing that stops the read is
    // how far it is allowed to fan out.
    const THIRD = "https://third.example/db";
    const f = await federate({
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "wiki" },
        { uri: THIRD, lock: WIKI_LOCK, database: "third" },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
      ],
    });
    const notes = f.member(NOTES);
    const note = await notes.db.create(T.note, { body: "many" }, { vshard: "7" });
    for (const [i, m] of [f.member(WIKI), f.member(THIRD)].entries()) {
      const page = await m.db.create(T.page, { title: `p${i}` }, { vshard: "3" });
      await notes.db.assocAdd(T.about, note, `${m.uri}#${page}`, i + 1);
    }
    // Two databases at a budget of two is fine.
    const ok = (await notes.db.query(ABOUT_PLAN, [note], { budget: { databases: 2 } })) as { about: unknown[] }[];
    assert.equal(ok[0].about.length, 2);

    const err = (await notes.db
      .query(ABOUT_PLAN, [note], { budget: { databases: 1 } })
      .then(() => null, (e: Error) => e)) as BudgetSpent;
    assert.equal(err.name, "BudgetSpent");
    assert.equal(err.what, "databases");
  });

  it("gives up on the deadline, which is the one a stalled responder spends", async () => {
    const { f, note } = await two({
      wrap: () => async () => new Promise<Response>((_, fail) => {
        const held = setTimeout(() => fail(new Error("gave up")), 5_000);
        void held;
      }),
      foreign: { deadlineMs: 10_000 },
    });
    // The budget's deadline is the query's, and it is checked before a request is sent — so a second
    // hop after a slow first one is refused rather than queued behind it.
    const notes = f.member(NOTES);
    const err = (await notes.db
      .query(ABOUT_PLAN, [note], { budget: { deadlineMs: -1 } })
      .then(() => null, (e: Error) => e)) as BudgetSpent;
    assert.equal(err.what, "deadline");
  });
});

describe("keeping an answer for as long as the responder permitted", () => {
  it("isolates identical reads from different databases sharing a cache", async () => {
    const { f, page } = await two({ members: [
      { uri: WIKI, lock: WIKI_LOCK }, { uri: GONE, lock: WIKI_LOCK }, { uri: NOTES, lock: NOTES_LOCK },
    ], foreign: { cache: new ResponseCache() } });
    const other = await f.member(GONE).db.create(T.page, { title: "Different" }, { vshard: "3" });
    assert.equal(other, page);
    const rows = await f.member(NOTES).db.query({ frames: [{ source: { kind: "ids" }, children: [], counts: [] }] }, [WIKI + "#" + page]);
    const next = await f.member(NOTES).db.query({ frames: [{ source: { kind: "ids" }, children: [], counts: [] }] }, [GONE + "#" + page]);
    assert.equal((rows[0] as { title: string }).title, "Country");
    assert.equal((next[0] as { title: string }).title, "Different");
  });

  it("answers a repeated read from the cache, and only while the response allows", async () => {
    let now = 1_000_000;
    const cache = new ResponseCache(() => now);
    const { f, note } = await two({ foreign: { cache } });
    const notes = f.member(NOTES);
    const wiki = f.member(WIKI);

    await notes.db.query(ABOUT_PLAN, [note]);
    assert.equal(wiki.served.read, 1);
    // The wiki's PUBLIC policy says public for 60 seconds, so the same read inside that window is
    // answered from here rather than sent.
    await notes.db.query(ABOUT_PLAN, [note]);
    assert.equal(wiki.served.read, 1, "the second read was not sent");
    assert.equal(cache.hits, 1);

    now += 61_000;
    await notes.db.query(ABOUT_PLAN, [note]);
    assert.equal(wiki.served.read, 2, "and past the window it is sent again");
  });

  it("keeps nothing a response said may not be kept", async () => {
    let now = 1_000_000;
    const cache = new ResponseCache(() => now);
    const f = await federate({
      members: [
        {
          uri: WIKI,
          lock: WIKI_LOCK,
          database: "wiki",
          policy: { object: () => true, count: () => true, cache: () => ({ reuse: "never" }) },
        },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
      ],
      foreign: { cache },
    });
    const wiki = f.member(WIKI);
    const notes = f.member(NOTES);
    const page = await wiki.db.create(T.page, { title: "Country" }, { vshard: "3" });
    const note = await notes.db.create(T.note, { body: "n" }, { vshard: "7" });
    await notes.db.assocAdd(T.about, note, `${WIKI}#${page}`, 1);

    await notes.db.query(ABOUT_PLAN, [note]);
    await notes.db.query(ABOUT_PLAN, [note]);
    // Only the responder knows its own enforcement granularity, so `never` is kept for no time at
    // all — a policy per request caches not at all, and this is what saying so buys.
    assert.equal(wiki.served.read, 2);
    assert.equal(cache.hits, 0);
  });
});

describe("type agreement, one step further", () => {
  it("declines a type whose shape the two catalogs do not agree on", async () => {
    // The notes database declares a field on `wiki.page` that the wiki does not expose. A name is
    // only half of an agreement: this side would get every page missing a field its own schema says
    // is always there, which is not something it can read through.
    const DISAGREEING: Lock = planLock({
      notes: {
        objects: { "notes.note": { fields: { body: "string" } } },
        edges: { "notes.note_about": { from: "notes.note", to: "wiki.page", foreign: true } },
      },
      wiki: { objects: { "wiki.page": { fields: { title: "string", summary: "string" } } } },
    });
    const catalog = Catalog.compile(DISAGREEING);
    const f = await federate({
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "wiki", projection: WIKI_PUBLIC },
        { uri: NOTES, lock: DISAGREEING, database: "notes" },
      ],
      foreign: { agree: true },
    });
    const wiki = f.member(WIKI);
    const notes = f.member(NOTES);
    const page = await wiki.db.create(T.page, { title: "Country" }, { vshard: "3" });
    const note = await notes.db.create(catalog.objectNamed("notes.note")!.otype, { body: "n" }, { vshard: "7" });
    const about = catalog.edgeNamed("notes.note_about")!.atype!;
    await notes.db.assocAdd(about, note, `${WIKI}#${page}`, 1);

    const rows = (await notes.db.query(
      {
        frames: [
          { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
          { source: { kind: "edge", atype: about }, children: [], counts: [] },
        ],
      },
      [note],
    )) as { about: unknown[] }[];
    // Declined as absent, not as a guess at the missing field.
    assert.deepEqual(rows[0].about, []);
  });

  it("reads a type the responder exposes more of than this side declares", async () => {
    // The other direction, which is fine: the reader reads what it declares, and the field it has
    // not heard of is dropped rather than carried into its own view of the object.
    const f = await federate({
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "wiki" }, // exposes `secret` too
        { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
      ],
      foreign: { agree: true },
    });
    const wiki = f.member(WIKI);
    const notes = f.member(NOTES);
    const page = await wiki.db.create(T.page, { title: "Country", secret: "not yours" }, { vshard: "3" });
    const note = await notes.db.create(T.note, { body: "n" }, { vshard: "7" });
    await notes.db.assocAdd(T.about, note, `${WIKI}#${page}`, 1);
    const rows = (await notes.db.query(ABOUT_PLAN, [note])) as { about: Record<string, unknown>[] }[];
    assert.deepEqual(Object.keys(rows[0].about[0]!).sort(), ["$edge", "$version", "id", "title"]);
  });
});

// Three databases run by three parties, each declaring its own types and only the NAMES of the
// ones it points at. Every federation above gives the first foreign database the later edges too,
// which is why none of them found this: a subtree is named through the asking catalog, and a
// responder that does not have one of those names refuses the whole request.
describe("a query through databases that share no catalog", () => {
  const JOURNAL = "https://journal.example/db";
  const OPS = "https://ops.example/db";
  const PACKAGES = "https://packages.example/db";

  const OPS_LOCK: Lock = planLock({
    ops: {
      objects: { "ops.incident": { fields: { ticket: "string" } } },
      edges: {
        "ops.related": { from: "ops.incident", to: "ops.incident" },
        "ops.deployed_release": { from: "ops.incident", to: "packages.release", foreign: true },
      },
    },
    packages: { objects: { "packages.release": { fields: {} } } },
  });
  const PACKAGES_LOCK: Lock = planLock({
    packages: {
      objects: { "packages.release": { fields: { tag: "string" } } },
      edges: { "packages.supersedes": { from: "packages.release", to: "packages.release" } },
    },
  });
  /** The asker's, which is the only catalog that covers all three. */
  const JOURNAL_LOCK: Lock = planLock({
    journal: {
      objects: { "journal.entry": { fields: { text: "string" } } },
      edges: { "journal.about": { from: "journal.entry", to: "ops.incident", foreign: true } },
    },
    ops: {
      objects: { "ops.incident": { fields: { ticket: "string" } } },
      edges: {
        "ops.related": { from: "ops.incident", to: "ops.incident" },
        "ops.deployed_release": { from: "ops.incident", to: "packages.release", foreign: true },
      },
    },
    packages: {
      objects: { "packages.release": { fields: { tag: "string" } } },
      edges: { "packages.supersedes": { from: "packages.release", to: "packages.release" } },
    },
  });
  const J = Catalog.compile(JOURNAL_LOCK);
  const O = Catalog.compile(OPS_LOCK);
  const P = Catalog.compile(PACKAGES_LOCK);
  const hop = (name: string) => ({ kind: "edge" as const, atype: J.edgeNamed(name)!.atype! });

  async function three() {
    const f = await federate({
      members: [
        { uri: JOURNAL, lock: JOURNAL_LOCK, database: "journal" },
        { uri: OPS, lock: OPS_LOCK, database: "ops" },
        { uri: PACKAGES, lock: PACKAGES_LOCK, database: "packages" },
      ],
    });
    const [journal, ops, packages] = [f.member(JOURNAL), f.member(OPS), f.member(PACKAGES)];
    const older = await packages.db.create(P.objectNamed("packages.release")!.otype, { tag: "3.7.1" }, { vshard: "2" });
    const release = await packages.db.create(P.objectNamed("packages.release")!.otype, { tag: "3.7.2" }, { vshard: "2" });
    await packages.db.assocAdd(P.edgeNamed("packages.supersedes")!.atype!, release, older, 1);
    const cause = await ops.db.create(O.objectNamed("ops.incident")!.otype, { ticket: "INC-216" }, { vshard: "3" });
    const incident = await ops.db.create(O.objectNamed("ops.incident")!.otype, { ticket: "INC-217" }, { vshard: "3" });
    await ops.db.assocAdd(O.edgeNamed("ops.related")!.atype!, incident, cause, 1);
    await ops.db.assocAdd(O.edgeNamed("ops.deployed_release")!.atype!, incident, `${PACKAGES}#${release}`, 1);
    const entry = await journal.db.create(J.objectNamed("journal.entry")!.otype, { text: "why did deliveries double?" }, { vshard: "4" });
    await journal.db.assocAdd(J.edgeNamed("journal.about")!.atype!, entry, `${OPS}#${incident}`, 1);
    return { f, journal, ops, packages, entry, incident: `${OPS}#${incident}`, release: `${PACKAGES}#${release}`, older: `${PACKAGES}#${older}` };
  }

  /** entry -> about -> release -> supersedes: three databases, and `packages.supersedes` is an edge
   *  the ops database has never heard of, two hops below the objects it is asked for. */
  const CHAIN: Plan = {
    frames: [
      { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
      { source: hop("journal.about"), children: [{ alias: "release", frame: 2 }], counts: [] },
      { source: hop("ops.deployed_release"), children: [{ alias: "older", frame: 3 }], counts: [] },
      { source: hop("packages.supersedes"), children: [], counts: [] },
    ],
  };
  type Chain = { about: { id: string; release: { id: string; tag: string; older: { id: string; tag: string }[] }[] }[] }[];

  for (const driver of ["async", "rounds"] as const) {
    it(`leaves out of a subtree what the responder does not expose, and asks whoever holds it, on ${driver}`, async () => {
      const w = await three();
      const rows = (await w.journal.db.query(CHAIN, [w.entry], { driver })) as Chain;
      const release = rows[0]!.about[0]!.release[0]!;
      assert.deepEqual([rows[0]!.about[0]!.id, release.id, release.tag], [w.incident, w.release, "3.7.2"]);
      assert.deepEqual(release.older.map((r) => [r.id, r.tag]), [[w.older, "3.7.1"]]);
    });
  }

  it("asks for a vocabulary only where a request nests, and once", async () => {
    const w = await three();
    await w.journal.db.query(CHAIN, [w.entry]);
    // ops was sent a hop under a hop, so what it exposes had to be known. packages was asked for
    // objects with one hop under them, and its own refusal would have been the answer.
    assert.deepEqual([w.ops.served.vocabulary, w.packages.served.vocabulary], [1, 0]);
    await w.journal.db.query(CHAIN, [w.entry]);
    assert.equal(w.ops.served.vocabulary, 1, "kept for the life of the client");
  });

  it("does the same for a count that hangs under a hop", async () => {
    const w = await three();
    const rows = (await w.journal.db.query(
      {
        frames: [
          { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
          { source: hop("journal.about"), children: [{ alias: "release", frame: 2 }], counts: [] },
          // A count on the release, which is in a database ops cannot answer for.
          { source: hop("ops.deployed_release"), children: [], counts: [{ alias: "older", atype: hop("packages.supersedes").atype }] },
        ],
      },
      [w.entry],
    )) as { about: { release: { older: number }[] }[] }[];
    assert.equal(rows[0]!.about[0]!.release[0]!.older, 1);
  });

  it("still refuses, by name, a hop under objects the responder does hold", async () => {
    // Left out of the subtree like any edge ops does not expose. But these parents are ops's own
    // incidents, so nobody else can be asked, and the read that asks ops directly is refused. What
    // must not come back is an empty list: nothing was asked that ops could answer.
    const w = await three();
    const err = await w.journal.db
      .query(
        {
          frames: [
            { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
            { source: hop("journal.about"), children: [{ alias: "related", frame: 2 }], counts: [] },
            { source: hop("ops.related"), children: [{ alias: "older", frame: 3 }], counts: [] },
            { source: hop("packages.supersedes"), children: [], counts: [] },
          ],
        },
        [w.entry],
      )
      .then(() => null, (e: Error) => e);
    assert.equal(err?.name, "ForeignRefused", String(err));
    assert.match(err!.message, /no edge "packages.supersedes"/);
  });

  it("fails by name where the vocabulary cannot be read, rather than send what may be refused", async () => {
    const f = await federate({
      members: [
        { uri: JOURNAL, lock: JOURNAL_LOCK, database: "journal" },
        { uri: OPS, lock: OPS_LOCK, database: "ops" },
      ],
      wrap: (inner) => async (input, init) =>
        String(input).endsWith("/vocabulary") ? new Response("{}", { status: 200 }) : inner(input, init),
    });
    const incident = await f.member(OPS).db.create(O.objectNamed("ops.incident")!.otype, { ticket: "INC-1" }, { vshard: "3" });
    const entry = await f.member(JOURNAL).db.create(J.objectNamed("journal.entry")!.otype, { text: "t" }, { vshard: "4" });
    await f.member(JOURNAL).db.assocAdd(J.edgeNamed("journal.about")!.atype!, entry, `${OPS}#${incident}`, 1);
    const err = await f.member(JOURNAL).db.query(CHAIN, [entry]).then(() => null, (e: Error) => e);
    assert.ok(err instanceof ForeignUnreachable, String(err));
    assert.match(err.message, /invalid vocabulary/);
    // And a read that does not nest never needed it.
    const shallow = (await f.member(JOURNAL).db.query(ABOUT_SHALLOW, [entry])) as { about: unknown[] }[];
    assert.equal(shallow[0]!.about.length, 1);
  });

  const ABOUT_SHALLOW: Plan = {
    frames: [
      { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
      { source: hop("journal.about"), children: [{ alias: "related", frame: 2 }], counts: [] },
      { source: hop("ops.related"), children: [], counts: [] },
    ],
  };
});
