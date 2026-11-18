import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan as planLock } from "../catalog/catalog.ts";
import type { Lock } from "../catalog/catalog.ts";
import { federate, pinsOf } from "../testkit/federation.ts";
import { T, served } from "../testkit/served.ts";
import type { Federation, Member, MemberOptions } from "../testkit/federation.ts";
import { DEFAULT_LIMITS } from "../query/request.ts";
import type { Policy } from "../query/serve.ts";
import type { Id, Plan } from "../query/types.ts";
import { Backoff } from "./backoff.ts";
import { checkHint, settleHint } from "./backlinks.ts";
import type { Settled } from "./backlinks.ts";
import { HintQueue, parseHint } from "./hint.ts";
import { generateKeyPair, signRequest } from "./identity.ts";
import type { Caller } from "./identity.ts";

// Backlinks, end to end: one database draws an edge at another, says so, and the other records an
// edge back — after reading the first one itself, and only for what that read showed.
//
// Everything here goes through the real handler and the real client, with the socket taken out, as
// in `federation.test.ts`. What the tests are about is the one thing that is new: a route by which a
// stranger can ask to be looked at, and that nothing it says is believed.

const WIKI = "https://wiki.example/db";
const NOTES = "https://notes.example/db";
const OTHER = "https://other.example/db";

/** The wiki: pages, and the edge it records a citation under. `notes.note` is declared because an
 *  edge type lands somewhere, and so that the wiki can read through its own backlink. */
const WIKI_LOCK: Lock = planLock({
  wiki: {
    objects: { "wiki.page": { fields: { title: "string" } }, "wiki.stub": { fields: {} } },
    edges: {
      "wiki.page_cited_by": { from: "wiki.page", to: "notes.note", foreign: true },
      "wiki.page_links": { from: "wiki.page", to: "wiki.page" },
    },
  },
  notes: { objects: { "notes.note": { fields: { body: "string" } } } },
});

/** A database of notes about wiki pages. Two of these make two sources. */
const NOTES_LOCK: Lock = planLock({
  notes: {
    objects: { "notes.note": { fields: { body: "string" } } },
    edges: { "notes.note_about": { from: "notes.note", to: "wiki.page", foreign: true } },
  },
  wiki: { objects: { "wiki.page": { fields: { title: "string" } } } },
});

const WIKI_CATALOG = Catalog.compile(WIKI_LOCK);
const NOTES_CATALOG = Catalog.compile(NOTES_LOCK);
const W = {
  page: WIKI_CATALOG.objectNamed("wiki.page")!.otype,
  stub: WIKI_CATALOG.objectNamed("wiki.stub")!.otype,
  citedBy: WIKI_CATALOG.edgeNamed("wiki.page_cited_by")!.atype!,
  links: WIKI_CATALOG.edgeNamed("wiki.page_links")!.atype!,
};
const N = {
  note: NOTES_CATALOG.objectNamed("notes.note")!.otype,
  about: NOTES_CATALOG.edgeNamed("notes.note_about")!.atype!,
};

/** The wiki's own query through its backlink: the page, and whoever cites it. */
const CITED: Plan = {
  frames: [
    { source: { kind: "ids" }, children: [{ alias: "cited", frame: 1 }], counts: [] },
    { source: { kind: "edge", atype: W.citedBy }, children: [], counts: [] },
  ],
};

const PUBLIC: Policy = { object: () => true, count: () => true, cache: () => ({ reuse: "public", seconds: 60 }) };
const NOTHING: Policy = { object: () => false, count: () => false, cache: () => ({ reuse: "never" }) };

/** Every confirmed citation of a page, from anybody. The open policy. */
const anyone = (_hint: unknown, targetType: string) => (targetType === "wiki.page" ? "wiki.page_cited_by" : undefined);

interface World {
  f: Federation;
  wiki: Member;
  notes: Member;
  page: Id;
  note: Id;
}

async function world(
  opts: { wiki?: Partial<MemberOptions>; notes?: Partial<MemberOptions>; more?: MemberOptions[]; fed?: Partial<Parameters<typeof federate>[0]> } = {},
): Promise<World> {
  const f = await federate({
    identity: true,
    members: [
      { uri: WIKI, lock: WIKI_LOCK, database: "wiki", backlinks: anyone, ...opts.wiki },
      { uri: NOTES, lock: NOTES_LOCK, database: "notes", ...opts.notes },
      ...(opts.more ?? []),
    ],
    ...opts.fed,
  });
  const wiki = f.member(WIKI);
  const notes = f.member(NOTES);
  const page = await wiki.db.create(W.page, { title: "Country" }, { vshard: "3" });
  const note = await notes.db.create(N.note, { body: "about a country" }, { vshard: "7" });
  return { f, wiki, notes, page, note };
}

/** What anyone reads of a page's citations, over the protocol and unsigned. */
async function citations(f: Federation, page: Id): Promise<string[]> {
  const res = await f.fetch(`${WIKI}/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [page], hops: [{ as: "cited", edge: "wiki.page_cited_by", limit: 50 }] }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { lists: Record<string, { ids: string[] }>; objects: Record<string, unknown> };
  return body.lists[`1:${page}`]?.ids ?? [];
}

/** A request signed as one member, with a body of the test's choosing. */
async function signedPost(f: Federation, from: Member, url: string, body: unknown): Promise<Response> {
  const text = JSON.stringify(body);
  const pair = await from.cluster.directory.identity(0);
  const headers = await signRequest({
    method: "POST",
    url,
    body: text,
    caller: from.uri,
    seed: pair.seed,
    keyId: pair.public.id,
    created: Math.floor(Date.now() / 1000),
  });
  return f.fetch(url, { method: "POST", body: text, headers: { "content-type": "application/json", ...headers } });
}

describe("a backlink", () => {
  it("is an edge the target draws itself, after reading the edge it was told about", async () => {
    const { f, wiki, notes, page, note } = await world();
    await notes.db.assocAdd(N.about, note, `${WIKI}#${page}`, 1);

    // Told, and nothing more: the hint is queued and the wiki has read nobody.
    assert.deepEqual(await notes.hint("notes.note_about", note, `${WIKI}#${page}`), { sent: true });
    assert.equal(wiki.served.hint, 1);
    assert.equal(wiki.hints!.size, 1);
    assert.equal(notes.served.read, 0);
    assert.deepEqual(await citations(f, page), []);

    // Looked at. One read of the source, and then one edge of the wiki's own.
    assert.deepEqual(await wiki.confirm(), ["recorded"]);
    assert.equal(notes.served.read, 1);
    assert.equal(wiki.hints!.size, 0);

    // And it is read with the protocol exactly as it stood before any of this: a foreign edge, listed
    // as a reference, with nothing behind it in the answer.
    assert.deepEqual(await citations(f, page), [`${NOTES}#${note}`]);

    // Which the wiki's own client follows back, like any other edge out of it.
    const rows = (await wiki.db.query(CITED, [page])) as { title: string; cited: { id: string; body: string }[] }[];
    assert.deepEqual(rows[0].cited.map((c) => [c.id, c.body]), [[`${NOTES}#${note}`, "about a country"]]);
  });

  it("records nothing for a hint that is not true", async () => {
    const { f, wiki, notes, page, note } = await world();
    // No edge was drawn. The hint is well formed, signed by a real database, and false.
    assert.deepEqual(await notes.hint("notes.note_about", note, `${WIKI}#${page}`), { sent: true });
    assert.deepEqual(await wiki.confirm(), ["removed"]);
    // It was checked rather than ignored, and what the check found is what was kept.
    assert.equal(notes.served.read, 1);
    assert.deepEqual(await citations(f, page), []);
  });

  it("is withdrawn by the same hint, sent again once the edge is gone", async () => {
    const { f, wiki, notes, page, note } = await world();
    const target = `${WIKI}#${page}`;
    await notes.db.assocAdd(N.about, note, target, 1);
    await notes.hint("notes.note_about", note, target);
    assert.deepEqual(await wiki.confirm(), ["recorded"]);

    await notes.db.assocRemove(N.about, note, target);
    // A hint says "look", so there is no second kind of message for a removal.
    assert.deepEqual(await notes.hint("notes.note_about", note, target), { sent: true });
    assert.deepEqual(await wiki.confirm(), ["removed"]);
    assert.deepEqual(await citations(f, page), []);
  });

  it("keeps its place in the list however often its source repeats itself", async () => {
    // The clock is the test's, a second at a time, and stays inside the signature window.
    let clock = Date.now();
    const { f, wiki, notes, page, note } = await world({ fed: { foreign: { now: () => clock } } });
    const target = `${WIKI}#${page}`;
    const later = await notes.db.create(N.note, { body: "a second note" }, { with: note });

    await notes.db.assocAdd(N.about, note, target, 1);
    await notes.hint("notes.note_about", note, target);
    await wiki.confirm();
    clock += 1000;
    await notes.db.assocAdd(N.about, later, target, 2);
    await notes.hint("notes.note_about", later, target);
    await wiki.confirm();
    // Newest first, by when the WIKI confirmed each.
    assert.deepEqual(await citations(f, page), [`${NOTES}#${later}`, `${NOTES}#${note}`]);

    // The first note says so again, later. An upsert would put it at the head of the wiki's list —
    // and then the head of anyone's backlinks would be whoever repeated themselves last.
    clock += 1000;
    await notes.hint("notes.note_about", note, target);
    assert.deepEqual(await wiki.confirm(), ["recorded"]);
    assert.deepEqual(await citations(f, page), [`${NOTES}#${later}`, `${NOTES}#${note}`]);
  });

  it("reads only the database that signed the hint, whatever the hint says", async () => {
    const { f, wiki, notes, page, note } = await world({
      more: [{ uri: OTHER, lock: NOTES_LOCK, database: "other" }],
    });
    const other = f.member(OTHER);
    await notes.db.assocAdd(N.about, note, `${WIKI}#${page}`, 1);

    // A third database hints, naming an id that is a note in NOTES. `source` is a bare id of the
    // caller, so this is a claim about an object of OTHER's that happens to share the number — there
    // is no way to spell "go and read notes.example".
    assert.deepEqual(await other.hint("notes.note_about", note, `${WIKI}#${page}`), { sent: true });
    await wiki.confirm();
    assert.equal(notes.served.read, 0);
    assert.equal(notes.served.descriptor, 0);
    assert.equal(other.served.read, 1);
    assert.deepEqual(await citations(f, page), []);

    // And a qualified source is not a hint at all.
    const aimed = await signedPost(f, other, `${WIKI}/hint`, { source: `${NOTES}#${note}`, edge: "notes.note_about", target: page });
    assert.equal(aimed.status, 400);
    assert.equal(((await aimed.json()) as { at: string }).at, "source");
  });
});

describe("a hint's answer", () => {
  it("is the same for an object that is there and one that is not", async () => {
    const { f, wiki, notes, page, note } = await world();
    const there = await signedPost(f, notes, `${WIKI}/hint`, { source: note, edge: "notes.note_about", target: page });
    const absent = await signedPost(f, notes, `${WIKI}/hint`, { source: note, edge: "notes.note_about", target: "999999" });
    assert.equal(there.status, 202);
    assert.equal(absent.status, 202);
    // Byte for byte. A hint that answered differently for an object the caller may not see would be
    // the way around "forbidden is indistinguishable from absent".
    assert.equal(await there.text(), await absent.text());

    // What differs is what the wiki then does, which the caller never hears: one is checked and one
    // is dropped without a request being made on its account.
    const settled = await wiki.confirm();
    assert.deepEqual(settled.sort(), ["declined", "removed"]);
    assert.equal(notes.served.read, 1);
  });

  it("is a refusal for a hint nobody signed", async () => {
    const { f, wiki, notes, page, note } = await world();
    const res = await f.fetch(`${WIKI}/hint`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: note, edge: "notes.note_about", target: page }),
    });
    // The one route where the anonymous caller is not a caller: without a signature there is no
    // telling whose database the checking read would go to.
    assert.equal(res.status, 401);
    assert.equal(((await res.json()) as { at: string }).at, "signature");
    assert.equal(wiki.hints!.size, 0);
    assert.equal(notes.served.descriptor, 0);
  });

  it("is a refusal that names where, for a hint that is not one", async () => {
    const { f, notes, page, note } = await world();
    const cases: [string, unknown, string][] = [
      ["a member it does not know", { source: note, edge: "notes.note_about", target: page, why: "please" }, "hint"],
      ["a body that is not an object", [note, page], "hint"],
      ["no edge", { source: note, target: page }, "edge"],
      ["an edge that is not a name", { source: note, edge: "", target: page }, "edge"],
      ["a source that is not an id", { source: "7x", edge: "notes.note_about", target: page }, "source"],
      ["a target in another database", { source: note, edge: "notes.note_about", target: `${OTHER}#5` }, "target"],
      ["a target that is a number", { source: note, edge: "notes.note_about", target: 5 }, "target"],
    ];
    for (const [why, body, where] of cases) {
      const res = await signedPost(f, notes, `${WIKI}/hint`, body);
      assert.equal(res.status, 400, why);
      assert.equal(((await res.json()) as { at: string }).at, where, why);
    }
    const get = await f.fetch(`${WIKI}/hint`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST, OPTIONS");
  });

  it("is a refusal for a database hinting itself", async () => {
    const { f, wiki, page } = await world();
    const res = await signedPost(f, wiki, `${WIKI}/hint`, { source: page, edge: "wiki.page_links", target: page });
    assert.equal(res.status, 400);
    await assert.rejects(wiki.hint("wiki.page_links", page, `${WIKI}#${page}`), /an edge into yourself is a local edge/);
    await assert.rejects(wiki.hint("wiki.page_links", page, page), /an object of this one/);
  });

  it("says not now, and for how long, to a caller that has sent too many", async () => {
    const { f, wiki, notes, page, note } = await world({ wiki: { hintQueue: { perCaller: 2, retryAfter: 7 } } });
    const target = `${WIKI}#${page}`;
    assert.deepEqual(await notes.hint("notes.note_about", note, target), { sent: true });
    // The same hint again is the same hint: it says "look", and one look answers both.
    assert.deepEqual(await notes.hint("notes.note_about", note, target), { sent: true });
    assert.equal(wiki.hints!.size, 1);
    assert.deepEqual(await notes.hint("notes.note_other", note, target), { sent: true });
    assert.deepEqual(await notes.hint("notes.note_third", note, target), { sent: false, why: "later", status: 429, retryAfter: 7 });

    const raw = await signedPost(f, notes, `${WIKI}/hint`, { source: note, edge: "notes.note_fourth", target: page });
    assert.equal(raw.status, 429);
    assert.equal(raw.headers.get("retry-after"), "7");

    // Looked at, and there is room again.
    await wiki.confirm();
    assert.deepEqual(await notes.hint("notes.note_third", note, target), { sent: true });
  });

  it("says not now to everyone when it is holding all it will", async () => {
    const { f, wiki, notes, page, note } = await world({
      wiki: { hintQueue: { capacity: 1, retryAfter: 3 } },
      more: [{ uri: OTHER, lock: NOTES_LOCK, database: "other" }],
    });
    assert.deepEqual(await notes.hint("notes.note_about", note, `${WIKI}#${page}`), { sent: true });
    // Somebody else's doing, so it is a 503 and not a 429: this caller did nothing to slow down from.
    assert.deepEqual(await f.member(OTHER).hint("notes.note_about", "5", `${WIKI}#${page}`), {
      sent: false,
      why: "later",
      status: 503,
      retryAfter: 3,
    });
    assert.equal(wiki.hints!.size, 1);
  });
});

describe("a database that takes no hints", () => {
  it("says so by not stating the route, and a sender reads that rather than trying", async () => {
    const { f, wiki, notes, page, note } = await world();
    const descriptor = (await (await f.fetch(NOTES)).json()) as { routes: Record<string, string> };
    assert.equal(descriptor.routes.hint, undefined);
    assert.equal(((await (await f.fetch(WIKI)).json()) as { routes: Record<string, string> }).routes.hint, `${WIKI}/hint`);

    assert.deepEqual(await wiki.hint("wiki.page_cited_by", page, `${NOTES}#${note}`), { sent: false, why: "unsupported" });
    assert.equal(notes.served.hint, 0);

    // And the route is simply not one of its routes.
    const res = await signedPost(f, wiki, `${NOTES}/hint`, { source: page, edge: "wiki.page_cited_by", target: note });
    assert.equal(res.status, 404);
  });

  it("is every database that verifies no signature, whatever else it was given", async () => {
    // No identity on the federation, so nobody publishes a key and nobody can say who is hinting.
    const f = await federate({
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "wiki", backlinks: anyone },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
      ],
    });
    const descriptor = (await (await f.fetch(WIKI)).json()) as { routes: Record<string, string> };
    assert.equal(descriptor.routes.hint, undefined);
    const res = await f.fetch(`${WIKI}/hint`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404);
    // And a database with no identity has nothing to sign a hint with.
    await assert.rejects(f.member(NOTES).hint("notes.note_about", "1", `${WIKI}#1`), /no identity to sign with/);
  });
});

describe("settling a hint", () => {
  it("asks the policy before it reads anybody", async () => {
    const { f, wiki, notes, page, note } = await world({ wiki: { backlinks: () => undefined } });
    await notes.db.assocAdd(N.about, note, `${WIKI}#${page}`, 1);
    await notes.hint("notes.note_about", note, `${WIKI}#${page}`);
    // The descriptor was read once already, to verify the signature. Nothing more is.
    const before = { ...notes.served };
    assert.deepEqual(await wiki.confirm(), ["declined"]);
    assert.deepEqual(notes.served, before);
    assert.deepEqual(await citations(f, page), []);
  });

  it("makes no request on account of a target the hinting database could not have read", async () => {
    // The wiki hides whatever is in this set, from everybody.
    const hidden = new Set<Id>();
    const { f, wiki, notes, page, note } = await world({
      wiki: { policy: { ...PUBLIC, object: (id) => !hidden.has(id) } },
    });
    const secret = await wiki.db.create(W.page, { title: "Unannounced" }, { with: page });
    hidden.add(secret);
    // The edge is real, so a read of notes WOULD list the reference. What decides is the wiki.
    await notes.db.assocAdd(N.about, note, `${WIKI}#${secret}`, 1);
    assert.deepEqual(await notes.hint("notes.note_about", note, `${WIKI}#${secret}`), { sent: true });
    assert.deepEqual(await notes.hint("notes.note_about", note, `${WIKI}#999999`), { sent: true });

    // Neither is looked at. The checking read lands on the caller's own server, so one made for the
    // page that exists and none for the id that does not would tell the caller which is which — what
    // a 403 beside a 404 would, by another route. To notes, both are a hint nothing came of.
    const before = { ...notes.served };
    assert.deepEqual(await wiki.confirm(), ["declined", "declined"]);
    assert.deepEqual(notes.served, before);
    assert.deepEqual(wiki.cluster.directory.aliases(), []);

    // It was the policy that decided, and not the edge: shown the page, the same hint is checked.
    hidden.delete(secret);
    await notes.hint("notes.note_about", note, `${WIKI}#${secret}`);
    assert.deepEqual(await wiki.confirm(), ["recorded"]);
    assert.deepEqual(await citations(f, secret), [`${NOTES}#${note}`]);
  });

  it("treats a target of a type it does not expose as one that is not there", async () => {
    // Pages are held and not exposed: no read of the wiki can return one, whoever asks.
    const { wiki, notes, page, note } = await world({ wiki: { projection: { name: "stubs", include: ["wiki.stub"] } } });
    await notes.db.assocAdd(N.about, note, `${WIKI}#${page}`, 1);
    await notes.hint("notes.note_about", note, `${WIKI}#${page}`);
    const before = { ...notes.served };
    assert.deepEqual(await wiki.confirm(), ["declined"]);
    assert.deepEqual(notes.served, before);
  });

  it("puts the target to the policy for the database that hinted, where that differs by caller", async () => {
    const { f, wiki, notes, page, note } = await world({ more: [{ uri: OTHER, lock: NOTES_LOCK, database: "other" }] });
    const other = f.member(OTHER);
    const theirs = await other.db.create(N.note, { body: "also about it" }, { vshard: "9" });
    const target = `${WIKI}#${page}`;
    await notes.db.assocAdd(N.about, note, target, 1);
    await other.db.assocAdd(N.about, theirs, target, 1);
    await notes.hint("notes.note_about", note, target);
    await other.hint("notes.note_about", theirs, target);

    // Settled by hand, with a policy that shows the wiki's pages to NOTES and to nobody else. Both
    // edges are real; only one of the two callers could have read what its edge points at.
    const settled: Settled[] = [];
    for (const hint of wiki.hints!.take()) {
      settled.push(
        await settleHint(hint, {
          fetch: f.fetch,
          db: wiki.db,
          catalog: wiki.catalog,
          self: WIKI,
          edgeFor: anyone,
          policy: (from) => (from.caller === NOTES ? PUBLIC : NOTHING),
        }),
      );
    }
    assert.deepEqual(settled, ["recorded", "declined"]);
    assert.equal(notes.served.read, 1);
    assert.equal(other.served.read, 0);
  });

  it("keeps nothing about a database whose hint was not true, and pins one whose hint was", async () => {
    const { wiki, notes, page, note } = await world();
    const target = `${WIKI}#${page}`;
    await notes.hint("notes.note_about", note, target);
    assert.deepEqual(await wiki.confirm(), ["removed"]);
    // Looked at, and not remembered: no alias, no pin, no row. A database that has only ever asked
    // to be looked at is a stranger, and strangers do not grow the registry — it would otherwise
    // cost one domain to add a row to anybody's.
    assert.equal(notes.served.read, 1);
    assert.deepEqual(wiki.cluster.directory.aliases(), []);
    assert.equal(wiki.cluster.directory.pinnedOf(NOTES), undefined);

    await notes.db.assocAdd(N.about, note, target, 1);
    await notes.hint("notes.note_about", note, target);
    assert.deepEqual(await wiki.confirm(), ["recorded"]);
    // Now the wiki holds an edge into it. It has an alias because the edge needs one, and it is
    // pinned at the key the checking read was made against, as on any other first contact.
    assert.deepEqual(wiki.cluster.directory.aliases().map((a) => a.uri), [NOTES]);
    assert.equal(wiki.cluster.directory.pinnedOf(NOTES), (await notes.cluster.directory.identity(0)).public.id);
  });

  it("still holds a database it already knows to the key it pinned", async () => {
    const { f, wiki, notes, page, note } = await world();
    const target = `${WIKI}#${page}`;
    await notes.db.assocAdd(N.about, note, target, 1);
    await notes.hint("notes.note_about", note, target);
    assert.deepEqual(await wiki.confirm(), ["recorded"]);

    // Whatever answers at that URI now publishes a key the pinned one never signed. Looking without
    // remembering is for strangers; this is not one, and a look at it is checked like any other.
    notes.binding.keys = [(await generateKeyPair()).public];
    const again = { caller: NOTES, source: note, edge: "notes.note_about", target: page };
    assert.equal(await checkHint(again, { fetch: f.fetch, pins: pinsOf(wiki), catalog: wiki.catalog, self: WIKI }), "unknown");
    assert.equal(wiki.cluster.directory.stateOf(NOTES), "repudiated");
  });

  it("is told who is hinting and what at, so a policy can admit some and not others", async () => {
    const { f, wiki, notes, page, note } = await world({
      wiki: { backlinks: (hint, type) => (hint.caller === NOTES && type === "wiki.page" ? "wiki.page_cited_by" : undefined) },
      more: [{ uri: OTHER, lock: NOTES_LOCK, database: "other" }],
    });
    const other = f.member(OTHER);
    const theirs = await other.db.create(N.note, { body: "also about it" }, { vshard: "9" });
    const stub = await wiki.db.create(W.stub, {}, { with: page });
    await notes.db.assocAdd(N.about, note, `${WIKI}#${page}`, 1);
    await other.db.assocAdd(N.about, theirs, `${WIKI}#${page}`, 1);
    await notes.db.assocAdd(N.about, note, `${WIKI}#${stub}`, 2);

    await notes.hint("notes.note_about", note, `${WIKI}#${page}`);
    await other.hint("notes.note_about", theirs, `${WIKI}#${page}`);
    await notes.hint("notes.note_about", note, `${WIKI}#${stub}`);
    // Both edges are real. One caller is admitted, and one of its two targets is a type it keeps
    // citations of.
    assert.deepEqual(await wiki.confirm(), ["recorded", "declined", "declined"]);
    assert.deepEqual(await citations(f, page), [`${NOTES}#${note}`]);
  });

  it("is loud about a policy that names an edge type which cannot hold one", async () => {
    const { wiki, notes, page, note } = await world({ wiki: { backlinks: () => "wiki.page_links" } });
    await notes.hint("notes.note_about", note, `${WIKI}#${page}`);
    // `wiki.page_links` is not declared foreign, so it could never store the reference.
    await assert.rejects(wiki.confirm(), /cannot record a backlink to a wiki\.page/);
  });

  it("records only what anyone could have read, unless it reads as itself", async () => {
    // Notes shows its edges to the wiki and to nobody else.
    const admitting = async (caller: Caller | null) =>
      caller !== null && caller.database === WIKI ? { policy: PUBLIC, remember: true } : { policy: NOTHING };

    const open = await world({ notes: { policyFor: admitting } });
    await open.notes.db.assocAdd(N.about, open.note, `${WIKI}#${open.page}`, 1);
    await open.notes.hint("notes.note_about", open.note, `${WIKI}#${open.page}`);
    // Read anonymously, the default, the source is not there: forbidden is absent. So nothing is
    // recorded, and nothing the wiki serves discloses an edge the public could not have found.
    assert.deepEqual(await open.wiki.confirm(), ["removed"]);
    assert.deepEqual(await citations(open.f, open.page), []);

    const privy = await world({ notes: { policyFor: admitting }, wiki: { backlinksAs: "self" } });
    await privy.notes.db.assocAdd(N.about, privy.note, `${WIKI}#${privy.page}`, 1);
    await privy.notes.hint("notes.note_about", privy.note, `${WIKI}#${privy.page}`);
    assert.deepEqual(await privy.wiki.confirm(), ["recorded"]);
  });

  it("changes nothing when it could not tell", async () => {
    let down = false;
    const { f, wiki, notes, page, note } = await world({
      fed: {
        wrap: (inner) => async (input, init) => {
          const url = typeof input === "string" ? input : (input as Request).url;
          if (down && url === `${NOTES}/read`) throw new Error("connection refused");
          return inner(input, init);
        },
      },
    });
    const target = `${WIKI}#${page}`;
    await notes.db.assocAdd(N.about, note, target, 1);
    await notes.hint("notes.note_about", note, target);
    assert.deepEqual(await wiki.confirm(), ["recorded"]);

    // The source cannot be read. "I could not tell" is not "it is gone": removing on it would let
    // anyone who can make a database unreachable erase its backlinks.
    down = true;
    await notes.hint("notes.note_about", note, target);
    assert.deepEqual(await wiki.confirm(), ["unknown"]);
    assert.deepEqual(await citations(f, page), [`${NOTES}#${note}`]);
  });

  it("gives up as unknown on a list longer than it will page through, rather than as absent", async () => {
    const { f, wiki, notes, page, note } = await world();
    const target = `${WIKI}#${page}`;
    // Two rows a page, so the default four pages reach eight edges. The one hinted about is the
    // oldest of ten.
    notes.binding.limits = { ...DEFAULT_LIMITS, maxLimit: 2 };
    await notes.db.assocAdd(N.about, note, target, 1);
    for (let i = 0; i < 9; i++) {
      const elsewhere = await wiki.db.create(W.page, { title: `p${i}` }, { with: page });
      await notes.db.assocAdd(N.about, note, `${WIKI}#${elsewhere}`, 10 + i);
    }
    await notes.hint("notes.note_about", note, target);
    assert.deepEqual(await wiki.confirm(), ["unknown"]);
    assert.equal(notes.served.read, 4);
    assert.deepEqual(await citations(f, page), []);
  });
});

describe("the queue a hint waits in", () => {
  const hint = (caller: string, n: number) => ({ caller, source: String(n), edge: "e", target: "1" });

  it("hands hints back oldest first, each once", () => {
    const q = new HintQueue();
    q.offer(hint(NOTES, 1));
    q.offer(hint(OTHER, 2));
    q.offer(hint(NOTES, 1));
    assert.equal(q.size, 2);
    assert.deepEqual(q.take(1).map((h) => h.source), ["1"]);
    assert.deepEqual(q.take().map((h) => h.source), ["2"]);
    assert.deepEqual(q.take(), []);
  });

  it("bounds one caller without bounding the rest, and frees the room when a hint is taken", () => {
    const q = new HintQueue({ perCaller: 1, capacity: 2, retryAfter: 9 });
    q.offer(hint(NOTES, 1));
    assert.throws(() => q.offer(hint(NOTES, 2)), (e) => e instanceof Backoff && e.whose === "caller" && e.seconds === 9);
    q.offer(hint(OTHER, 1));
    assert.throws(() => q.offer(hint(WIKI, 1)), (e) => e instanceof Backoff && e.whose === "database");
    q.take(1);
    q.offer(hint(NOTES, 2));
  });

  it("reads a hint off the wire as its three members and nothing else", () => {
    assert.deepEqual(parseHint({ source: "5", edge: "a.b", target: "6" }), { source: "5", edge: "a.b", target: "6" });
    assert.throws(() => parseHint(null), /expected an object/);
    assert.throws(() => parseHint({ source: "05", edge: "a.b", target: "6" }), /source/);
  });
});

describe("an edge added only if it is absent", () => {
  // On `served()` rather than the federation above, which is format 2 by definition: this is the
  // engine's own option, and the suite runs it on both storage formats.
  const LINKS: Plan = {
    frames: [
      { source: { kind: "ids" }, children: [{ alias: "comments", frame: 1 }], counts: [{ alias: "n", atype: T.comments }] },
      { source: { kind: "edge", atype: T.comments }, children: [], counts: [] },
    ],
  };

  it("leaves one that is already there exactly as it was, and counts it once", async () => {
    const { db, issue, alice } = await served({ comments: 0 });
    const comment = await db.create(T.comment, { body: "first", authorId: alice }, { with: issue });
    await db.assocAddIfAbsent(T.comments, issue, comment, 5, { note: "first" });
    await db.assocAddIfAbsent(T.comments, issue, comment, 9, { note: "second" });
    const kept = await db.normalized(LINKS, [issue]);
    assert.deepEqual(kept.lists[`1:${issue}`].edges, [{ time: 5, data: { note: "first" } }]);
    assert.equal(kept.counts[`0:${issue}`].n, 1);

    // And a plain add is still the upsert it always was.
    await db.assocAdd(T.comments, issue, comment, 9);
    const moved = await db.normalized(LINKS, [issue]);
    assert.deepEqual(moved.lists[`1:${issue}`].edges, [{ time: 9, data: null }]);
    assert.equal(moved.counts[`0:${issue}`].n, 1);
  });
});
