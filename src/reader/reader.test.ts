import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Catalog, plan as planLock } from "../catalog/catalog.ts";
import type { Lock } from "../catalog/catalog.ts";
import { ForeignRefused, ForeignUnreachable, Repudiated } from "../protocol/client.ts";
import { generateKeyPair } from "../protocol/identity.ts";
import { surfaceOf } from "../protocol/surface.ts";
import { Refused } from "../query/request.ts";
import { defineObject, edge, str } from "../schema/define.ts";
import { federate } from "../testkit/federation.ts";
import type { Federation } from "../testkit/federation.ts";
import { BudgetSpent } from "../client/budget.ts";
import { NoSuchEdge, Reader, connect } from "./reader.ts";
import type { Page, Row } from "./reader.ts";

// Three databases run by three parties, each declaring only its own types and the names of the ones
// it points at. Nobody holds a catalog that covers all three, which is the situation a reader is for.

const NOTES = "https://notes.example/db";
const OPS = "https://ops.example/db";
const PACKAGES = "https://packages.example/db";

const NOTES_LOCK: Lock = planLock({
  notes: {
    objects: { "notes.note": { fields: { title: "string", body: "string", authorId: { optional: { id: "notes.author" } } } }, "notes.author": { fields: { name: "string" } } },
    edges: {
      "notes.cites": { from: "notes.note", to: "notes.note" },
      "notes.about": { from: "notes.note", to: "ops.incident", foreign: true },
      "notes.author_of": { from: "notes.note", to: "notes.author", field: "authorId" },
    },
  },
  ops: { objects: { "ops.incident": { fields: {} } } },
});

const OPS_LOCK: Lock = planLock({
  ops: {
    objects: { "ops.incident": { fields: { ticket: "string", severity: "number", internal: { optional: "string" } } } },
    edges: { "ops.deployed_release": { from: "ops.incident", to: "packages.release", foreign: true, unique: true } },
  },
  packages: { objects: { "packages.release": { fields: {} } } },
});

const PACKAGES_LOCK: Lock = planLock({
  packages: {
    objects: { "packages.release": { fields: { tag: "string", change: "string" } } },
    edges: { "packages.supersedes": { from: "packages.release", to: "packages.release" } },
  },
});

/** What ops serves: not the field it keeps to itself. */
const OPS_PUBLIC = { name: "public", include: ["ops.*"], fields: { "ops.incident": ["ticket", "severity"] } };

const of = (lock: Lock) => {
  const catalog = Catalog.compile(lock);
  return {
    type: (name: string) => catalog.objectNamed(name)!.otype,
    edge: (name: string) => catalog.edgeNamed(name)!.atype!,
  };
};

interface World {
  f: Federation;
  reader: Reader;
  /** References, as a reader holds them. */
  first: string;
  second: string;
  incident: string;
  release: string;
  older: string;
  author: string;
}

async function world(opts: Partial<Parameters<typeof federate>[0]> = {}, readerOpts: ConstructorParameters<typeof Reader>[0] = {}): Promise<World> {
  const f = await federate({
    members: [
      { uri: NOTES, lock: NOTES_LOCK, database: "notes" },
      { uri: OPS, lock: OPS_LOCK, database: "ops", projection: OPS_PUBLIC },
      { uri: PACKAGES, lock: PACKAGES_LOCK, database: "packages" },
    ],
    ...opts,
  });
  const [notes, ops, packages] = [f.member(NOTES), f.member(OPS), f.member(PACKAGES)];
  const [n, o, p] = [of(NOTES_LOCK), of(OPS_LOCK), of(PACKAGES_LOCK)];

  const older = await packages.db.create(p.type("packages.release"), { tag: "3.7.1", change: "Added a counter." }, { vshard: "2" });
  const release = await packages.db.create(p.type("packages.release"), { tag: "3.7.2", change: "Deadline 30s to 10s." }, { vshard: "2" });
  await packages.db.assocAdd(p.edge("packages.supersedes"), release, older, 1);

  const incident = await ops.db.create(o.type("ops.incident"), { ticket: "INC-217", severity: 2, internal: "not yours" }, { vshard: "3" });
  await ops.db.assocAdd(o.edge("ops.deployed_release"), incident, `${PACKAGES}#${release}`, 1);

  const author = await notes.db.create(n.type("notes.author"), { name: "ada" }, { vshard: "5" });
  const first = await notes.db.create(n.type("notes.note"), { title: "Duplicates", body: "Seen after 3.7.2.", authorId: author }, { vshard: "5" });
  const second = await notes.db.create(n.type("notes.note"), { title: "Follow-up", body: "Checking the deadline." }, { vshard: "6" });
  await notes.db.assocAdd(n.edge("notes.cites"), second, first, 1);
  await notes.db.assocAdd(n.edge("notes.about"), first, `${OPS}#${incident}`, 1);

  return {
    f,
    reader: new Reader({ fetch: f.fetch, ...readerOpts }),
    first: `${NOTES}#${first}`,
    second: `${NOTES}#${second}`,
    incident: `${OPS}#${incident}`,
    release: `${PACKAGES}#${release}`,
    older: `${PACKAGES}#${older}`,
    author: `${NOTES}#${author}`,
  };
}

const page = (row: Row, name: string): Page => row[name] as Page;

/** note -> cites -> about -> release, which is every database in the world. */
const CHAIN = {
  hops: [
    {
      edge: "notes.cites",
      as: "cites",
      hops: [{ edge: "notes.about", as: "about", hops: [{ edge: "ops.deployed_release", as: "release" }] }],
    },
  ],
};

describe("a reader with no database of its own", () => {
  it("reads through three databases that share no catalog", async () => {
    const w = await world();
    const [row] = await w.reader.read(w.second, CHAIN);

    assert.equal(row.id, w.second);
    assert.equal(row.$type, "notes.note");
    assert.equal(row.title, "Follow-up");

    const cited = page(row, "cites").items[0]!;
    assert.equal(cited.id, w.first);
    const incident = page(cited, "about").items[0]!;
    assert.deepEqual([incident.id, incident.$type, incident.ticket], [w.incident, "ops.incident", "INC-217"]);
    const release = page(incident, "release").items[0]!;
    assert.deepEqual([release.id, release.$type, release.tag], [w.release, "packages.release", "3.7.2"]);
  });

  it("reads what the engine's client reads, which holds one catalog for all three", async () => {
    // The same chain through the other asking half: a database of its own, a lock that declares
    // every type and edge in the world, and a query that starts from an object in ANOTHER database.
    // It used to be refused here — it sent the whole subtree to the notes database, which has no
    // `ops.deployed_release` to be asked about — and `protocol/federation.test.ts` holds the fix.
    const w = await world();
    const all = planLock({
      notes: {
        objects: { "notes.note": { fields: { title: "string" } } },
        edges: { "notes.cites": { from: "notes.note", to: "notes.note" }, "notes.about": { from: "notes.note", to: "ops.incident", foreign: true } },
      },
      ops: {
        objects: { "ops.incident": { fields: { ticket: "string" } } },
        edges: { "ops.deployed_release": { from: "ops.incident", to: "packages.release", foreign: true } },
      },
      packages: { objects: { "packages.release": { fields: { tag: "string" } } } },
    });
    const elsewhere = await federate({ members: [{ uri: "https://asker.example/db", lock: all, database: "asker" }], wrap: () => w.f.fetch });
    const catalog = Catalog.compile(all);
    const hop = (name: string) => ({ kind: "edge" as const, atype: catalog.edgeNamed(name)!.atype! });
    type Its = { id: string; cites: { id: string; about: { id: string; ticket: string; release: { id: string; tag: string }[] }[] }[] }[];
    const its = (await elsewhere.member("https://asker.example/db").db.query(
      {
        frames: [
          { source: { kind: "ids" }, children: [{ alias: "cites", frame: 1 }], counts: [] },
          { source: hop("notes.cites"), children: [{ alias: "about", frame: 2 }], counts: [] },
          { source: hop("notes.about"), children: [{ alias: "release", frame: 3 }], counts: [] },
          { source: hop("ops.deployed_release"), children: [], counts: [] },
        ],
      },
      [w.second],
    )) as Its;

    const [row] = await w.reader.read(w.second, CHAIN);
    const cited = page(row, "cites").items[0]!;
    const incident = page(cited, "about").items[0]!;
    const release = page(incident, "release").items[0]!;
    assert.deepEqual(
      [its[0]!.id, its[0]!.cites[0]!.id, its[0]!.cites[0]!.about[0]!.id, its[0]!.cites[0]!.about[0]!.release[0]!.id],
      [row.id, cited.id, incident.id, release.id],
    );
    assert.deepEqual([its[0]!.cites[0]!.about[0]!.ticket, its[0]!.cites[0]!.about[0]!.release[0]!.tag], [incident.ticket, release.tag]);
  });

  it("asks each database once for what it holds, however deep the request goes inside it", async () => {
    const w = await world();
    const stats = { rounds: 0, requests: 0 };
    await w.reader.read(w.second, CHAIN, { stats });
    // notes answers both of its hops in one request, since the subtree it can be asked rides along.
    assert.deepEqual(
      [w.f.member(NOTES).served.read, w.f.member(OPS).served.read, w.f.member(PACKAGES).served.read],
      [1, 1, 1],
    );
    // And each vocabulary was asked for once, which is what the reader read each of them by.
    assert.deepEqual(
      [w.f.member(NOTES).served.vocabulary, w.f.member(OPS).served.vocabulary, w.f.member(PACKAGES).served.vocabulary],
      [1, 1, 1],
    );
    await w.reader.read(w.second, CHAIN, { stats });
    assert.equal(w.f.member(NOTES).served.vocabulary, 1, "a vocabulary is kept between reads");
  });

  it("reads every reference it was given, however many", async () => {
    // More references than the engine's default page holds, and more than one request to a database
    // may carry. The first used to cut the read to fifty rows, twice over — here, and again in the
    // database answering — and a row has no cursor to say that anything was left out.
    const w = await world();
    const packages = w.f.member(PACKAGES);
    const p = of(PACKAGES_LOCK);
    const refs: string[] = [];
    for (let i = 0; i < 120; i++) {
      const id = await packages.db.create(p.type("packages.release"), { tag: `5.0.${i}`, change: "One of many." }, { vshard: "9" });
      refs.push(`${PACKAGES}#${id}`);
    }
    assert.equal(refs.length > (await w.reader.database(PACKAGES)).limits.maxIds, true, "so it takes more than one request");
    for (const driver of ["async", "rounds"] as const) {
      const rows = await new Reader({ fetch: w.f.fetch }).read(refs, {}, { driver });
      assert.deepEqual(rows.map((r) => r.id), refs, `every reference, in the order given, on ${driver}`);
      assert.deepEqual([rows[0]!.tag, rows[119]!.tag], ["5.0.0", "5.0.119"]);
    }
  });

  it("gives the same answer on either driver", async () => {
    const w = await world();
    const a = await w.reader.read(w.second, CHAIN, { driver: "async" });
    const b = await new Reader({ fetch: w.f.fetch }).read(w.second, CHAIN, { driver: "rounds" });
    assert.deepEqual(a, b);
  });

  it("keeps only what a database exposes, and makes a payload id a reference", async () => {
    const w = await world();
    const [incident] = await w.reader.read(w.incident);
    assert.equal("internal" in incident, false, "a field the projection drops never arrives");
    assert.equal(incident.severity, 2);

    // `authorId` is a bare id in the notes database's payload. It means an object THERE, and a
    // reader has no database of its own for a bare id to be mistaken for.
    const [note] = await w.reader.read(w.first);
    assert.equal(note.authorId, w.author);
  });

  it("follows a field relationship as a list of one, without knowing which field it reads", async () => {
    const w = await world();
    const notes = await w.reader.database(NOTES);
    assert.equal(notes.edges["notes.author_of"]!.counted, false);
    const [note] = await w.reader.read(w.first, { hops: [{ edge: "notes.author_of", as: "author" }] });
    assert.deepEqual(page(note, "author").items.map((a) => [a.id, a.$type, a.name]), [[w.author, "notes.author", "ada"]]);
    const [none] = await w.reader.read(w.second, { hops: [{ edge: "notes.author_of", as: "author" }] });
    assert.deepEqual(page(none, "author").items, []);
  });

  it("reads counts, and a count the request names differently from its hop", async () => {
    const w = await world();
    const [row] = await w.reader.read(w.second, {
      counts: [{ as: "cited", edge: "notes.cites" }],
      hops: [{ edge: "notes.cites", counts: ["notes.about"] }],
    });
    assert.equal(row.cited, 1);
    assert.equal(page(row, "notes.cites").items[0]!["notes.about"], 1);
  });
});

describe("meeting one database", () => {
  it("states what it is, and what may be asked of an object of each type", async () => {
    const w = await world();
    const ops = await connect(OPS, { fetch: w.f.fetch });
    assert.equal(ops.database, OPS);
    assert.equal(ops.limits.maxIds > 0, true);
    assert.deepEqual(Object.keys(ops.types["ops.incident"]!.fields), ["ticket", "severity"]);
    assert.deepEqual(ops.edgesFrom("ops.incident"), ["ops.deployed_release"]);
    assert.deepEqual(ops.edgesFrom("packages.release"), []);
    assert.equal(ops.edges["ops.deployed_release"]!.foreign, true);
  });

  it("takes its own ids bare, and reads on through its reader", async () => {
    const w = await world();
    const ops = await w.reader.database(OPS);
    const bare = w.incident.slice(w.incident.indexOf("#") + 1);
    assert.equal(ops.ref(bare), w.incident);
    assert.equal(ops.ref(w.release), w.release, "a reference stays where it points");
    const [row] = await ops.read(bare, { hops: [{ edge: "ops.deployed_release", as: "release" }] });
    assert.equal(page(row, "release").items[0]!.tag, "3.7.2");
  });

  it("prices a request there, with nothing read", async () => {
    const w = await world();
    const notes = await w.reader.database(NOTES);
    const before = w.f.member(NOTES).served.read;
    const bare = w.second.slice(w.second.indexOf("#") + 1);
    const cost = await notes.price(bare, { hops: [{ edge: "notes.cites", limit: 10 }] });
    assert.deepEqual(cost, { frames: 2, nodes: 11 });
    assert.equal(w.f.member(NOTES).served.read, before);
    assert.equal(w.f.member(NOTES).served.price, 1);
    assert.deepEqual(await notes.price(w.second, { hops: [{ edge: "notes.cites", limit: 10 }] }), cost, "its own reference is its own id");
    assert.throws(() => notes.price(w.incident), /is not in/);
  });

  it("refuses a URI that is not canonical rather than repairing it", async () => {
    const w = await world();
    await assert.rejects(w.reader.database(OPS + "/"), /canonical|trailing/i);
  });
});

describe("a list is a page", () => {
  async function many(): Promise<{ w: World; root: string; tags: string[] }> {
    const w = await world();
    const packages = w.f.member(PACKAGES);
    const p = of(PACKAGES_LOCK);
    const root = await packages.db.create(p.type("packages.release"), { tag: "4.0.0", change: "Everything." }, { vshard: "9" });
    const tags: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const id = await packages.db.create(p.type("packages.release"), { tag: `3.9.${i}`, change: i % 2 ? "odd" : "even" }, { vshard: "9" });
      await packages.db.assocAdd(p.edge("packages.supersedes"), root, id, i);
      tags.unshift(`3.9.${i}`); // newest first
    }
    return { w, root: `${PACKAGES}#${root}`, tags };
  }

  it("continues from the cursor it was given, to the end", async () => {
    const { w, root, tags } = await many();
    const seen: string[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const [row] = await w.reader.read(root, { hops: [{ edge: "packages.supersedes", as: "older", limit: 2, ...(after ? { after } : {}) }] });
      const list = page(row, "older");
      seen.push(...list.items.map((r) => r.tag as string));
      if (!list.more) break;
      assert.equal(typeof list.cursor, "string");
      after = list.cursor!;
    }
    assert.deepEqual(seen, tags);
  });

  it("refuses a cursor it did not hand out, and says which hop carried it", async () => {
    const { w, root } = await many();
    const err = (await w.reader
      .read(root, { hops: [{ edge: "packages.supersedes", after: "somewhere" }] })
      .then(() => null, (e: Error) => e)) as Refused;
    assert.ok(err instanceof Refused, String(err));
    assert.equal(err.at, "hops[0].after");
  });

  it("filters on the far side's fields", async () => {
    const { w, root } = await many();
    const [row] = await w.reader.read(root, {
      hops: [{ edge: "packages.supersedes", as: "odd", where: [{ field: "change", op: "=", value: "odd" }] }],
    });
    assert.deepEqual(page(row, "odd").items.map((r) => r.tag), ["3.9.5", "3.9.3", "3.9.1"]);
  });
});

describe("what a reader refuses, and how", () => {
  it("refuses a bare id, which names no database", async () => {
    const w = await world();
    await assert.rejects(w.reader.read("5"), /bare id/);
  });

  it("refuses a member the protocol does not define, and says where", async () => {
    const w = await world();
    const hopz = await w.reader.read(w.second, { hopz: [] } as never).then(() => null, (e: Error) => e);
    assert.ok(hopz instanceof Refused);
    const limitt = (await w.reader
      .read(w.second, { hops: [{ edge: "notes.cites", limitt: 2 }] } as never)
      .then(() => null, (e: Error) => e)) as Refused;
    assert.equal(limitt.at, "hops[0]");
    const ids = (await w.reader.read(w.second, { ids: ["1"] } as never).then(() => null, (e: Error) => e)) as Refused;
    assert.match(ids.message, /first argument/);
  });

  it("refuses two names that would land on one, which a responder could no longer see", async () => {
    // The client underneath relabels every hop and count before it sends them, so the collision a
    // responder would have refused never reaches one. It has to be caught here or not at all.
    const w = await world();
    const err = (await w.reader
      .read(w.second, { counts: ["notes.cites"], hops: [{ edge: "notes.cites" }] })
      .then(() => null, (e: Error) => e)) as Refused;
    assert.ok(err instanceof Refused);
    assert.equal(err.at, "counts[0]");
  });

  it("names an edge the database holding the object does not expose, rather than answering empty", async () => {
    const w = await world();
    const err = (await w.reader
      .read(w.second, { hops: [{ edge: "notes.nope" }] })
      .then(() => null, (e: Error) => e)) as NoSuchEdge;
    assert.ok(err instanceof NoSuchEdge, String(err));
    assert.equal(err.database, NOTES);
    assert.equal(err.edge, "notes.nope");
    assert.match(err.message, /notes\.cites/);

    // The same for an edge that exists, in a database the object is not in.
    const elsewhere = await w.reader
      .read(w.second, { hops: [{ edge: "ops.deployed_release" }] }, { omit: { databases: {} } })
      .then(() => null, (e: Error) => e);
    assert.ok(elsewhere instanceof NoSuchEdge, "and `omit` does not take it for a database being down");
  });

  it("is absent where a database says nothing, which is not an error", async () => {
    const w = await world();
    assert.deepEqual(await w.reader.read(`${OPS}#999`), []);
    const rows = await w.reader.read([`${OPS}#999`, w.incident]);
    assert.deepEqual(rows.map((r) => r.id), [w.incident]);
  });
});

describe("a database that cannot be reached", () => {
  const GONE = "https://gone.example/db";

  async function dangling(): Promise<World> {
    const w = await world();
    const notes = w.f.member(NOTES);
    const bare = w.first.slice(w.first.indexOf("#") + 1);
    await notes.db.assocAdd(of(NOTES_LOCK).edge("notes.about"), bare, `${GONE}#7`, 2);
    return w;
  }

  it("fails the read by name", async () => {
    const w = await dangling();
    const err = await w.reader.read(w.first, { hops: [{ edge: "notes.about" }] }).then(() => null, (e: Error) => e);
    assert.ok(err instanceof ForeignUnreachable, String(err));
    assert.equal(err.database, GONE);
  });

  it("or is left out and reported, for a caller that asked for that", async () => {
    const w = await dangling();
    const omit = { databases: {} as Record<string, number>, references: [] as string[] };
    const [row] = await w.reader.read(w.first, { hops: [{ edge: "notes.about", as: "about" }] }, { omit });
    assert.deepEqual(page(row, "about").items.map((r) => r.id), [w.incident]);
    assert.deepEqual(omit.databases, { [GONE]: 1 });
    assert.deepEqual(omit.references, [`${GONE}#7`], "and which reference, so a caller can say what is missing");
  });

  it("is not what a refused request is, whatever the caller asked to have left out", async () => {
    // `notes.author_of` follows an id in a payload and has no count, so the notes database refuses
    // the request: reached, and answering. `omit` once took that for an outage, and the read came
    // back empty with the note it entered from reported as the thing that could not be read.
    const w = await world();
    const omit = { databases: {} as Record<string, number>, references: [] as string[] };
    const err = await w.reader.read(w.first, { counts: ["notes.author_of"] }, { omit }).then(() => null, (e: Error) => e);
    assert.ok(err instanceof ForeignRefused, String(err));
    assert.match(err.message, /has no count/);
    assert.deepEqual(omit, { databases: {}, references: [] });
  });

  it("is bounded by how many databases one read may reach", async () => {
    const w = await world();
    const err = (await w.reader.read(w.second, CHAIN, { budget: { databases: 2 } }).then(() => null, (e: Error) => e)) as BudgetSpent;
    assert.ok(err instanceof BudgetSpent, String(err));
    assert.equal(err.what, "databases");
    const narrow = new Reader({ fetch: w.f.fetch, budget: { databases: 1 } });
    await assert.rejects(narrow.read(w.second, CHAIN), BudgetSpent);
    assert.equal((await narrow.read(w.second, CHAIN, { budget: { databases: 3 } })).length, 1, "a read may widen it");
  });
});

describe("what a database proved about itself", () => {
  it("is held against it for the life of the reader", async () => {
    const w = await world({ identity: true });
    assert.equal((await w.reader.read(w.incident)).length, 1);

    // The origin now advertises a key nothing signed. Same URI, same data, different database.
    const ops = w.f.member(OPS);
    ops.binding.keys = [(await generateKeyPair()).public];
    await assert.rejects(w.reader.read(w.incident), Repudiated);
    await assert.rejects(w.reader.read(w.incident), Repudiated, "and it stays that way");
    await assert.rejects(w.reader.database(OPS), Repudiated);

    // A reader that never met the old key takes the new one at first contact, as it must.
    assert.equal((await new Reader({ fetch: w.f.fetch }).read(w.incident)).length, 1);
  });

  it("walks forward along a signed rotation", async () => {
    const w = await world({ identity: true });
    await w.reader.read(w.incident);
    const ops = w.f.member(OPS);
    await ops.cluster.directory.rotateKey(1);
    ops.binding.keys = ops.cluster.directory.publishedKeys();
    assert.equal((await w.reader.read(w.incident)).length, 1);
  });
});

describe("a schema that changes under a reader", () => {
  it("is read by the new vocabulary once the descriptor says there is one", async () => {
    const w = await world();
    await w.reader.read(w.release);
    const packages = w.f.member(PACKAGES);
    assert.equal(packages.served.vocabulary, 1);

    const v2 = planLock(
      {
        packages: {
          objects: { "packages.release": { fields: { tag: "string", change: "string" } }, "packages.advisory": { fields: { text: "string" } } },
          edges: {
            "packages.supersedes": { from: "packages.release", to: "packages.release" },
            "packages.advisories": { from: "packages.release", to: "packages.advisory" },
          },
        },
      },
      PACKAGES_LOCK,
    );
    packages.cluster.directory.applyLock(v2);
    packages.cluster.spreadCatalog();
    const catalog = Catalog.compile(v2);
    packages.binding.catalog = catalog;
    packages.binding.surface = surfaceOf(catalog);
    const bare = w.release.slice(w.release.indexOf("#") + 1);
    const advisory = await packages.db.create(catalog.objectNamed("packages.advisory")!.otype, { text: "Set the deadline explicitly." }, { with: bare });
    await packages.db.assocAdd(catalog.edgeNamed("packages.advisories")!.atype!, bare, advisory, 1);

    const [row] = await w.reader.read(w.release, { hops: [{ edge: "packages.advisories", as: "advisories" }] });
    assert.deepEqual(page(row, "advisories").items.map((r) => [r.$type, r.text]), [["packages.advisory", "Set the deadline explicitly."]]);
    assert.equal(packages.served.vocabulary, 2);
  });
});

describe("a caller with a lock of its own", () => {
  // What a generated module is, written out: a lock, and the values that carry its integers.
  const MINE: Lock = planLock({
    // Deliberately not in the order the publishers planned theirs, so no integer here matches one of
    // theirs by accident.
    packages: {
      objects: { "packages.release": { fields: { tag: "string" } } },
    },
    ops: {
      objects: { "ops.incident": { fields: { ticket: "string" } } },
      edges: { "ops.deployed_release": { from: "ops.incident", to: "packages.release", foreign: true, unique: true } },
    },
  });
  const mine = Catalog.compile(MINE);
  const Release = defineObject("packages.release", mine.objectNamed("packages.release")!.otype, { tag: str() });
  const Incident = defineObject("ops.incident", mine.objectNamed("ops.incident")!.otype, { ticket: str() });
  const deployedRelease = edge("ops.deployed_release", mine.edgeNamed("ops.deployed_release")!.atype!, Incident, Release, { unique: true });

  it("runs a query built from it against databases it does not run", async () => {
    const w = await world({}, { lock: MINE });
    const [row] = await Incident.gen(w.incident).related("release", deployedRelease).run(w.reader);
    assert.equal(row.ticket, "INC-217");
    assert.equal(row.release?.tag, "3.7.2");
    assert.equal(row.release?.id, w.release);
    // Narrowed to what was declared: the publisher exposes more, and a reader reads what it declares.
    assert.equal("severity" in row, false);
    assert.equal("change" in row.release!, false);
  });

  it("can still name what it did not declare, in the same read", async () => {
    const w = await world({}, { lock: MINE });
    const [row] = await w.reader.read(w.incident, {
      hops: [{ edge: "ops.deployed_release", as: "release", hops: [{ edge: "packages.supersedes", as: "older" }] }],
    });
    const release = page(row, "release").items[0]!;
    assert.deepEqual(page(release, "older").items.map((r) => r.id), [w.older]);
  });

  it("sees what a database's own client sees, given that database's lock", async () => {
    // The differential check, one level out. The notes database's client reads its own objects from
    // its own hosts and follows `notes.about` over the protocol; a reader holding the same lock
    // reads all of it over the protocol. The two answers have to be one answer, once the reader's
    // references into the notes database are spelled the way that database spells its own ids.
    const w = await world({}, { lock: NOTES_LOCK });
    const n = Catalog.compile(NOTES_LOCK);
    const Note = defineObject("notes.note", n.objectNamed("notes.note")!.otype, { title: str(), body: str() });
    const Thing = defineObject("ops.incident", n.objectNamed("ops.incident")!.otype, {});
    const cites = edge("notes.cites", n.edgeNamed("notes.cites")!.atype!, Note, Note);
    const about = edge("notes.about", n.edgeNamed("notes.about")!.atype!, Note, Thing);
    const query = (root: string) =>
      Note.gen(root).related("cites", cites, (q) => q.related("about", about).countAs("abouts", about));

    const bare = w.second.slice(w.second.indexOf("#") + 1);
    const own = await query(bare).run(w.f.member(NOTES).db);
    const read = await query(w.second).run(w.reader);

    const spelled = (value: unknown): unknown => {
      if (typeof value === "string") return value.startsWith(`${NOTES}#`) ? value.slice(NOTES.length + 1) : value;
      if (Array.isArray(value)) return value.map(spelled);
      if (value === null || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$type").map(([key, held]) => [key, spelled(held)]));
    };
    assert.deepEqual(spelled(read), own);
    assert.equal(own[0]!.cites[0]!.about[0]!.id, w.incident, "and the answer did cross a database");
  });

  it("declines a type the responder cannot fill, rather than guess at its fields", async () => {
    // `owner` is required here and the publisher has no such field, so every incident would arrive
    // missing something this caller's own schema says is always there.
    const wrong = planLock({ ops: { objects: { "ops.incident": { fields: { ticket: "string", owner: "string" } } } } });
    const w = await world({}, { lock: wrong });
    assert.deepEqual(await w.reader.read(w.incident), []);
    // Declined, and nothing else is: the type beside it reads as it did.
    assert.equal((await w.reader.read(w.release)).length, 1);
  });
});

describe("a read built by chaining", () => {
  /** The chain every database in the world is on, written rather than spelled out. */
  const chain = (reader: Reader, ref: string) =>
    reader
      .from(ref)
      .countAs("cited", "notes.cites")
      .related("cites", "notes.cites", (cites) =>
        cites.limit(5).related("about", "notes.about", (about) => about.related("release", "ops.deployed_release")),
      );

  it("is the request it compiles to, and nothing more", async () => {
    const w = await world();
    const q = chain(w.reader, w.second);
    assert.deepEqual(q.request(), {
      counts: [{ as: "cited", edge: "notes.cites" }],
      hops: [
        {
          edge: "notes.cites",
          as: "cites",
          limit: 5,
          hops: [{ edge: "notes.about", as: "about", hops: [{ edge: "ops.deployed_release", as: "release" }] }],
        },
      ],
    });
    assert.deepEqual(q.refs, [w.second]);
    // Run, it is that request handed to `read`: one meaning for a read, and it is the data's.
    assert.deepEqual(await q.run(), await new Reader({ fetch: w.f.fetch }).read(w.second, q.request()));
    // And the data survives a wire, which is the point of its being data.
    assert.deepEqual(await w.reader.read(w.second, JSON.parse(JSON.stringify(q.request()))), await q.run());
  });

  it("knows the names it was given, so a row needs no cast", async () => {
    const w = await world();
    const [row] = await chain(w.reader, w.second).run();
    const cited: number = row!.cited;
    const release = row!.cites.items[0]!.about.items[0]!.release.items[0]!;
    assert.deepEqual([cited, row!.cites.more, release.id, release.$type, release.tag], [1, false, w.release, "packages.release", "3.7.2"]);

    // The compiler holds these, which is the half of this test `npm run typecheck` runs. Never
    // called: each line is a mistake, and the point is that it does not compile.
    void (() => {
      // @ts-expect-error a count is a number, not a page
      void row!.cited.items;
      // @ts-expect-error a name that was never given, two levels down, is not a page either
      void row!.cites.items[0]!.nope.items;
      // @ts-expect-error the read enters from ids, and ids have no filter
      void w.reader.from(w.second).where;
    });
  });

  it("leaves what it was built from as it was", async () => {
    const w = await world();
    const base = w.reader.from(w.second).related("cites", "notes.cites");
    const counted = base.countAs("cited", "notes.cites");
    const limited = w.reader.from(w.second).related("cites", "notes.cites", (cites) => cites.limit(1));
    assert.deepEqual(base.request(), { hops: [{ edge: "notes.cites", as: "cites" }] });
    assert.deepEqual(Object.keys(counted.request()).sort(), ["counts", "hops"]);
    assert.equal(limited.request().hops![0]!.limit, 1);

    // What `request()` hands back is the caller's to change.
    const taken = base.request();
    taken.hops!.push({ edge: "notes.about" });
    assert.equal(base.request().hops!.length, 1);
  });

  it("refuses a name as it is given, where the mistake is one line long", async () => {
    const w = await world();
    const from = () => w.reader.from(w.second);
    const refused = (build: () => unknown): Refused => {
      try {
        build();
      } catch (e) {
        assert.ok(e instanceof Refused, String(e));
        return e;
      }
      return assert.fail("nothing was refused");
    };
    // A count and a hop under one name: the later one would silently win.
    assert.equal(refused(() => from().related("cites", "notes.cites").countAs("cites", "notes.cites")).at, "counts[0]");
    assert.equal(refused(() => from().related("x", "notes.cites").related("x", "notes.about")).at, "hops[1]");
    // A name a row already carries.
    assert.match(refused(() => from().related("id", "notes.cites")).message, /already carries/);
    assert.match(refused(() => from().countAs("$version", "notes.cites")).message, /already carries/);
    // The same one level down, inside the hop being built.
    refused(() => from().related("cites", "notes.cites", (c) => c.countAs("n", "notes.about").related("n", "notes.about")));
    // And a hop or a count with no name or no edge.
    refused(() => from().related("", "notes.cites"));
    refused(() => from().countAs("n", ""));
  });

  it("filters, limits and pages as the request does", async () => {
    const w = await world();
    const packages = w.f.member(PACKAGES);
    const p = of(PACKAGES_LOCK);
    const root = await packages.db.create(p.type("packages.release"), { tag: "4.0.0", change: "Everything." }, { vshard: "9" });
    for (let i = 1; i <= 5; i++) {
      const id = await packages.db.create(p.type("packages.release"), { tag: `3.9.${i}`, change: i % 2 ? "odd" : "even" }, { vshard: "9" });
      await packages.db.assocAdd(p.edge("packages.supersedes"), root, id, i);
    }
    const db = await w.reader.database(PACKAGES);

    // Two filters are one condition: both hold.
    const [both] = await db
      .from(root)
      .related("older", "packages.supersedes", (older) => older.where("change", "=", "odd").where("tag", "!=", "3.9.3"))
      .run();
    assert.deepEqual(both!.older.items.map((r) => r.tag), ["3.9.5", "3.9.1"]);

    const seen: string[] = [];
    let after: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const [row] = await db
        .from(root)
        .related("older", "packages.supersedes", (older) => (after === undefined ? older.limit(2) : older.limit(2).after(after)))
        .run();
      seen.push(...row!.older.items.map((r) => r.tag as string));
      if (!row!.older.more) break;
      after = row!.older.cursor!;
    }
    assert.deepEqual(seen, ["3.9.5", "3.9.4", "3.9.3", "3.9.2", "3.9.1"]);
  });

  it("passes on what `read` refuses, with its place in the request", async () => {
    const w = await world();
    const err = (await w.reader
      .from(w.second)
      .related("cites", "notes.cites", (cites) => cites.limit(0))
      .run()
      .then(() => null, (e: Error) => e)) as Refused;
    assert.ok(err instanceof Refused, String(err));
    assert.equal(err.at, "hops[0].limit");
    await assert.rejects(w.reader.from(w.second).related("nope", "notes.nope").run(), NoSuchEdge);
  });
});
