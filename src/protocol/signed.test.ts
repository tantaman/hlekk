import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LocalCluster } from "../client/local.ts";
import { Catalog, plan as planLock } from "../catalog/catalog.ts";
import type { Lock } from "../catalog/catalog.ts";
import { federate, pinsOf } from "../testkit/federation.ts";
import { foreignClient, ForeignUnreachable, Repudiated } from "./client.ts";
import type { Caller } from "./identity.ts";
import type { Policy } from "../query/serve.ts";
import type { Id, Plan } from "../query/types.ts";

// Identity, end to end: one database signs as itself, another verifies it against the caller's own
// descriptor, and what it proved is pinned. Nothing before this needed it, because the wiki is
// public; everything after it does.

const WIKI = "https://wiki.example/db";
const NOTES = "https://notes.example/db";
const OTHER = "https://other.example/db";

const WIKI_LOCK: Lock = planLock({
  wiki: { objects: { "wiki.page": { fields: { title: "string" } } } },
});
const NOTES_LOCK: Lock = planLock({
  notes: { objects: { "notes.note": { fields: { body: "string" } } }, edges: { "notes.note_about": { from: "notes.note", to: "wiki.page", foreign: true } } },
  wiki: { objects: { "wiki.page": { fields: { title: "string" } } } },
});
const NOTES_CATALOG = Catalog.compile(NOTES_LOCK);
const T = {
  note: NOTES_CATALOG.objectNamed("notes.note")!.otype,
  about: NOTES_CATALOG.edgeNamed("notes.note_about")!.atype!,
  page: Catalog.compile(WIKI_LOCK).objectNamed("wiki.page")!.otype,
};

const ABOUT_PLAN: Plan = {
  frames: [
    { source: { kind: "ids" }, children: [{ alias: "about", frame: 1 }], counts: [] },
    { source: { kind: "edge", atype: T.about }, children: [], counts: [] },
  ],
};

const PUBLIC: Policy = { object: () => true, count: () => true, cache: () => ({ reuse: "public", seconds: 60 }) };
const NOTHING: Policy = { object: () => false, count: () => false, cache: () => ({ reuse: "never" }) };

/** The wiki admits one caller by name and nobody else, which is what `Policy` per request buys. */
const admitting = (who: string) => async (caller: Caller | null) =>
  caller !== null && caller.database === who ? { policy: PUBLIC, remember: true } : { policy: NOTHING };

interface Signed {
  f: Awaited<ReturnType<typeof federate>>;
  note: Id;
  page: Id;
}

async function signed(
  policyFor: MemberPolicy = admitting(NOTES),
  members: string[] = [NOTES],
): Promise<Signed> {
  const f = await federate({
    identity: true,
    members: [
      { uri: WIKI, lock: WIKI_LOCK, database: "wiki", policyFor },
      ...members.map((uri, i) => ({ uri, lock: NOTES_LOCK, database: `notes${i}` })),
    ],
  });
  const wiki = f.member(WIKI);
  const page = await wiki.db.create(T.page, { title: "Country" }, { vshard: "3" });
  const notes = f.member(members[0]!);
  const note = await notes.db.create(T.note, { body: "a note" }, { vshard: "7" });
  await notes.db.assocAdd(T.about, note, `${WIKI}#${page}`, 1);
  return { f, note, page };
}

type MemberPolicy = (caller: Caller | null) => Promise<{ policy: Policy; remember?: boolean }>;

describe("a database authenticates a database", () => {
  it("refuses a signature whose signer cannot be looked up, rather than faulting", async () => {
    const { f, page } = await signed();
    // Well formed, and signed as a database nobody runs. The responder goes to read that database's
    // descriptor and cannot — which is a signature it could not verify, and the caller's to fix.
    const res = await f.fetch(`${WIKI}/read`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "hlekk-caller": "https://nobody.example/db",
        "content-digest": "sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:",
        "signature-input": `hlekk=("@method" "@target-uri" "content-digest" "hlekk-caller");created=${Math.floor(Date.now() / 1000)};keyid="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";alg="ed25519"`,
        signature: `hlekk=:${"A".repeat(86)}==:`,
      },
      body: "",
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string; at: string };
    assert.equal(body.at, "signature");
    assert.match(body.error, /could not be read from its descriptor/);
    void page;
  });

  it("signs as itself, is verified, and gets the answer its policy allows", async () => {
    const { f, note, page } = await signed();
    const rows = (await f.member(NOTES).db.query(ABOUT_PLAN, [note])) as { about: { id: string; title: string }[] }[];
    assert.deepEqual(rows[0].about.map((a) => [a.id, a.title]), [[`${WIKI}#${page}`, "Country"]]);
  });

  it("gets nothing when the responder does not distinguish it", async () => {
    // A verified caller the policy does not admit. Forbidden is indistinguishable from absent, so
    // what comes back is the reference and no object — the same thing a deleted page looks like.
    const { f, note } = await signed(admitting("https://someone.else/db"));
    const rows = (await f.member(NOTES).db.query(ABOUT_PLAN, [note])) as { about: unknown[] }[];
    assert.deepEqual(rows[0].about, []);
  });

  it("is the anonymous caller when it does not sign, and the policy decides about that too", async () => {
    // `identity: false`, so no request is signed. Not an error: a database serving public data
    // authenticates nobody, and this is the state step 2's deployed wiki is in.
    const f = await federate({
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "wiki", policyFor: async () => ({ policy: PUBLIC }) },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
      ],
    });
    const page = await f.member(WIKI).db.create(T.page, { title: "Country" }, { vshard: "3" });
    const note = await f.member(NOTES).db.create(T.note, { body: "n" }, { vshard: "7" });
    await f.member(NOTES).db.assocAdd(T.about, note, `${WIKI}#${page}`, 1);
    const rows = (await f.member(NOTES).db.query(ABOUT_PLAN, [note])) as { about: { title: string }[] }[];
    assert.deepEqual(rows[0].about.map((a) => a.title), ["Country"]);

    // And an anonymous caller a policy refuses gets nothing, which is the other half of it.
    const closed = await federate({
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "wiki2", policyFor: admitting(NOTES) },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes2" },
      ],
    });
    const p2 = await closed.member(WIKI).db.create(T.page, { title: "Country" }, { vshard: "3" });
    const n2 = await closed.member(NOTES).db.create(T.note, { body: "n" }, { vshard: "7" });
    await closed.member(NOTES).db.assocAdd(T.about, n2, `${WIKI}#${p2}`, 1);
    const refused = (await closed.member(NOTES).db.query(ABOUT_PLAN, [n2])) as { about: unknown[] }[];
    assert.deepEqual(refused[0].about, []);
  });

  it("refuses a request whose signature does not cover it", async () => {
    const { f, note } = await signed();
    // Re-signed is not the point: this alters the body AFTER it was signed, which is what a proxy
    // in the path could do and what `content-digest` is in the base for.
    const tampered = await federate({
      identity: true,
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "wiki3", policyFor: admitting(NOTES) },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes3" },
      ],
      wrap: (inner) => async (input, init) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (!url.endsWith("/read") || init?.body === undefined) return inner(input, init);
        return inner(input, { ...init, body: String(init.body).replace(/"ids":\[/, '"ids":["999",') });
      },
    });
    const page = await tampered.member(WIKI).db.create(T.page, { title: "Country" }, { vshard: "3" });
    const n = await tampered.member(NOTES).db.create(T.note, { body: "n" }, { vshard: "7" });
    await tampered.member(NOTES).db.assocAdd(T.about, n, `${WIKI}#${page}`, 1);
    // A 401 is the responder answering and saying no, not a transport failure: a caller cannot
    // retry its way out of a signature that does not cover its request.
    await assert.rejects(tampered.member(NOTES).db.query(ABOUT_PLAN, [n]), /refused a read: signature/);
    void f;
    void note;
  });

  it("records only the callers its policy distinguishes", async () => {
    // Strangers do not grow the registry: it is the one piece of per-database state outside the
    // lock, and a row per stranger who ever called would be unbounded.
    const { f } = await signed(admitting(OTHER), [NOTES, OTHER]);
    const wiki = f.member(WIKI);
    const notes = f.member(NOTES);
    const other = f.member(OTHER);
    const page = await wiki.db.create(T.page, { title: "p" }, { vshard: "3" });

    for (const m of [notes, other]) {
      const id = await m.db.create(T.note, { body: "n" }, { vshard: "7" });
      await m.db.assocAdd(T.about, id, `${WIKI}#${page}`, 1);
      await m.db.query(ABOUT_PLAN, [id]);
    }
    // Only the admitted one is in the wiki's registry, and its key is pinned.
    const rows = wiki.cluster.directory.aliases();
    assert.deepEqual(rows.map((r) => r.uri), [OTHER]);
    assert.equal(wiki.cluster.directory.pinnedOf(OTHER), (await other.cluster.directory.identity(0)).public.id);
    assert.equal(wiki.cluster.directory.pinnedOf(NOTES), undefined);
  });
});

describe("the pin", () => {
  it("serializes concurrent key creation and rotation into one chain", async () => {
    const { directory } = new LocalCluster();
    const first = await Promise.all(Array.from({ length: 4 }, () => directory.identity(0)));
    assert.equal(new Set(first.map(pair => pair.public.id)).size, 1);
    const rotations = await Promise.all([directory.rotateKey(1), directory.rotateKey(1)]);
    assert.equal(rotations[0].signedBy?.id, first[0].public.id);
    assert.equal(rotations[1].signedBy?.id, rotations[0].id);
    assert.deepEqual(directory.publishedKeys().filter(key => key.retired === undefined).map(key => key.id), [rotations[1].id]);
  });

  it("keeps a persisted pin during an outage and retries discovery", async () => {
    const { f, note, page } = await signed();
    const notes = f.member(NOTES);
    await notes.db.query(ABOUT_PLAN, [note]);
    let offline = true;
    const client = foreignClient(WIKI, {
      catalog: notes.catalog, pins: pinsOf(notes),
      fetch: (input, init) => offline ? Promise.resolve(new Response(null, { status: 503 })) : f.fetch(input, init),
    });
    const read = () => client.exec({ frames: [] }, [{ kind: "object", id: WIKI + "#" + page, frame: 0 }]);
    await assert.rejects(read(), ForeignUnreachable);
    assert.equal(notes.cluster.directory.stateOf(WIKI), "live");
    offline = false;
    await read();
  });

  it("is taken on first contact and advanced along a rotation chain", async () => {
    const { f, note } = await signed();
    const notes = f.member(NOTES);
    const wiki = f.member(WIKI);

    await notes.db.query(ABOUT_PLAN, [note]);
    const first = (await wiki.cluster.directory.identity(0)).public.id;
    assert.equal(notes.cluster.directory.pinnedOf(WIKI), first, "trust on first use");

    // The wiki rotates. The new key carries the old one's signature over it, and the old one stays
    // published through the grace window.
    const next = await wiki.cluster.directory.rotateKey(1);
    wiki.binding.keys = wiki.cluster.directory.publishedKeys();
    assert.equal(next.signedBy?.id, first);

    await notes.db.query(ABOUT_PLAN, [note]);
    assert.equal(notes.cluster.directory.pinnedOf(WIKI), next.id, "the pin advanced to the key it proved");
  });

  // The reassignment case: a database torn down and another brought up at the same URI with a new
  // key. The URI is the identity, so the two are indistinguishable by name — and a pin is the only
  // thing that makes the substitution loud.
  it("repudiates a database that answers at the same URI with an unrelated key", async () => {
    const { f, note } = await signed();
    const notes = f.member(NOTES);
    await notes.db.query(ABOUT_PLAN, [note]);
    assert.notEqual(notes.cluster.directory.pinnedOf(WIKI), undefined);

    // Someone else at the wiki's URI, with their own key and no rotation signature from the old one.
    const stranger = await federate({
      identity: true,
      members: [{ uri: WIKI, lock: WIKI_LOCK, database: "stranger", policyFor: admitting(NOTES) }],
    });
    f.member(WIKI).binding.keys = stranger.member(WIKI).binding.keys;
    await assert.rejects(notes.db.query(ABOUT_PLAN, [note]), Repudiated);
    assert.equal(notes.cluster.directory.stateOf(WIKI), "repudiated");

    // Every read through that alias fails from here on, by name, and local reads carry on: a
    // repudiated foreign database is not an outage of this one.
    await assert.rejects(notes.db.query(ABOUT_PLAN, [note]), Repudiated);
    const local = (await notes.db.query({ frames: [{ source: { kind: "ids" }, children: [], counts: [] }] }, [note])) as {
      body: string;
    }[];
    assert.equal(local[0].body, "a note");

    // Only an operator clears it, and clearing it drops the pin: whatever is at that URI now has to
    // prove itself from scratch.
    notes.cluster.directory.unrepudiate(WIKI);
    assert.equal(notes.cluster.directory.stateOf(WIKI), "live");
    assert.equal(notes.cluster.directory.pinnedOf(WIKI), undefined);
  });

  it("is not omitted away by a caller that opted into partial answers", async () => {
    // `omit` is for a database that could not be reached. A repudiated one was reached and answered,
    // and turning the loudest signal in the design into an empty list would be the one thing it must
    // not do.
    const f = await federate({
      identity: true,
      omit: true,
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "wiki4", policyFor: admitting(NOTES) },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes4" },
      ],
    });
    const notes = f.member(NOTES);
    const page = await f.member(WIKI).db.create(T.page, { title: "p" }, { vshard: "3" });
    const note = await notes.db.create(T.note, { body: "n" }, { vshard: "7" });
    await notes.db.assocAdd(T.about, note, `${WIKI}#${page}`, 1);
    notes.cluster.directory.pin(WIKI, "a-key-it-never-published", 0);
    await assert.rejects(notes.db.query(ABOUT_PLAN, [note]), Repudiated);
    assert.deepEqual(f.omitted.databases, {});
  });
});

describe("a policy that admits one caller", () => {
  it("answers a third database exactly as an empty one would", async () => {
    // Forbidden is indistinguishable from absent, and this is that property one level up: a caller a
    // policy does not admit cannot tell the difference between a database that refuses it and a
    // database with nothing in it. If it could, the policy would be leaking the shape of the graph
    // it is protecting.
    const THIRD = "https://third.example/db";
    const f = await federate({
      identity: true,
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "wiki", policyFor: admitting(NOTES) },
        { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
        { uri: THIRD, lock: NOTES_LOCK, database: "third" },
      ],
    });
    const wiki = f.member(WIKI);
    const page = await wiki.db.create(T.page, { title: "Country" }, { vshard: "3" });

    /** The same read, signed as whoever asks. */
    const read = async (caller: string) => {
      const { foreignClient } = await import("./client.ts");
      const m = f.member(caller);
      const client = foreignClient(WIKI, {
        catalog: m.catalog,
        fetch: f.fetch,
        self: caller,
        identity: async () => ({ database: caller, pair: await m.cluster.directory.identity(0) }),
        pins: pinsOf(m),
      });
      const reply = await client.exec({ frames: [] }, [{ kind: "object", id: `${WIKI}#${page}`, frame: 0 }]);
      return reply.reads.objects;
    };

    const admitted = await read(NOTES);
    assert.equal((admitted[0]![1]?.data as { title: string }).title, "Country");

    // And the same read from a database the wiki does not distinguish.
    const refused = await read(THIRD);
    assert.deepEqual(refused, [[`${WIKI}#${page}`, null]]);

    // An empty database at the same URI, read by the same caller. The answers have to be the same
    // object for object: `null` for everything asked, and nothing else said.
    const empty = await federate({
      identity: true,
      members: [
        { uri: WIKI, lock: WIKI_LOCK, database: "empty", policyFor: admitting(NOTES) },
        { uri: THIRD, lock: NOTES_LOCK, database: "third2" },
      ],
    });
    const third = empty.member(THIRD);
    const { foreignClient } = await import("./client.ts");
    const overEmpty = await foreignClient(WIKI, {
      catalog: third.catalog,
      fetch: empty.fetch,
      self: THIRD,
      identity: async () => ({ database: THIRD, pair: await third.cluster.directory.identity(0) }),
      pins: pinsOf(third),
    }).exec({ frames: [] }, [{ kind: "object", id: `${WIKI}#${page}`, frame: 0 }]);
    assert.deepEqual(overEmpty.reads.objects, refused);
  });

  it("hides a count the same way, since a count is separately authorized", async () => {
    // A count is one maintained row and therefore free, so it rides along on a read authorized for
    // something else unless it is asked about. "This object has 4,312 edges you cannot follow" is a
    // disclosure, and a policy thinking about objects will not notice it is answering about edges.
    const LINKS: Lock = planLock({
      wiki: {
        objects: { "wiki.page": { fields: { title: "string" } } },
        edges: { "wiki.page_links": { from: "wiki.page", to: "wiki.page" } },
      },
    });
    const atype = Catalog.compile(LINKS).edgeNamed("wiki.page_links")!.atype!;
    const f = await federate({
      identity: true,
      members: [
        {
          uri: WIKI,
          lock: LINKS,
          database: "counts",
          policyFor: async (caller) => ({
            // Objects yes, counts no, for everyone.
            policy: { object: () => true, count: () => false, cache: () => ({ reuse: "never" }) },
            remember: caller !== null,
          }),
        },
      ],
    });
    const wiki = f.member(WIKI);
    const a = await wiki.db.create(T.page, { title: "a" }, { vshard: "3" });
    const b = await wiki.db.create(T.page, { title: "b" }, { with: a });
    await wiki.db.assocAdd(atype, a, b, 1);

    const res = await f.fetch(`${WIKI}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [a], counts: ["wiki.page_links"] }),
    });
    const body = (await res.json()) as { objects: Record<string, unknown>; counts: Record<string, unknown> };
    assert.equal(a in body.objects, true, "the object is allowed");
    assert.deepEqual(body.counts, {}, "and the count is not, though it came free with the read");
  });
});
