import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan as planLock } from "../catalog/catalog.ts";
import type { Lock } from "../catalog/catalog.ts";
import { federate } from "../testkit/federation.ts";
import type { Federation } from "../testkit/federation.ts";
import { ForeignUnreachable, NotFollowed, foreignClient } from "./client.ts";
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
  wiki: { objects: { "wiki.page": { fields: { title: "string" } } } },
});

/** What the wiki serves: pages by title, and not the field it keeps to itself. A projection is the
 *  mechanism for that, and it is the responder's to state — field agreement between two catalogs is
 *  a different question, settled in PLAN.md step 6. */
const WIKI_PUBLIC = { name: "public", include: ["wiki.*"], fields: { "wiki.page": ["title"] } };

const NOTES_CATALOG = Catalog.compile(NOTES_LOCK);
const WIKI_CATALOG = Catalog.compile(WIKI_LOCK);
const T = {
  note: NOTES_CATALOG.objectNamed("notes.note")!.otype,
  about: NOTES_CATALOG.edgeNamed("notes.note_about")!.atype!,
  page: WIKI_CATALOG.objectNamed("wiki.page")!.otype,
  links: WIKI_CATALOG.edgeNamed("wiki.page_links")!.atype!,
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
  await wiki.db.assocAdd(T.links, page, other, 1);
  const note = await notes.db.create(T.note, { body: "about a country" }, { vshard: "7" });
  await notes.db.assocAdd(T.about, note, `${WIKI}#${page}`, 1);
  return { f, note, page, other };
}

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
      body: JSON.stringify({ ids: [inB], hops: [{ as: "out", edge: "a.out" }] }),
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
    assert.equal(`2:${inC}` in body.lists, false);
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

  it("names a list or a count in another database rather than answering it as empty", async () => {
    const { f, note } = await two();
    // The coordinator would need a one-hop request with `after` or `counts`, which is step 6. An
    // empty list here would be a wrong answer that looks like a right one.
    await assert.rejects(
      f.member(NOTES).db.query(
        {
          frames: [
            { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
            { source: { kind: "edge", atype: T.about }, children: [{ alias: "links", frame: 2 }], counts: [] },
            { source: { kind: "edge", atype: T.links }, children: [], counts: [] },
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
      members: [{ uri: NOTES, lock: NOTES_LOCK, database: "notes2" }],
      wrap: () => async () =>
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
