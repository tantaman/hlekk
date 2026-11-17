import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toKey } from "../host/ids.ts";
import { MAX_DB_URI_LENGTH, RefError, canonicalDb, formatRef, isQualified, parseRef } from "./ref.ts";
import { seeded } from "../runtime/runtime.ts";
import { makeId } from "../host/ids.ts";

/** `assert.throws` checks but does not hand the error back, and these tests are about what the
 *  refusal says. */
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail("expected a throw");
}

// A canonical URI, built from pieces that are canonical by construction: lowercase labels, a port
// that is never the scheme's default, and path segments of unreserved and sub-delim characters plus
// escapes of *reserved* ones, which are the escapes the canonical form keeps.
function generateDb(r: ReturnType<typeof seeded>): string {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const label = () => {
    const n = 1 + r.int(8);
    let s = r.pick([...letters]);
    for (let i = 1; i < n; i++) s += r.pick([...letters, ..."0123456789", "-"]);
    return s.endsWith("-") ? `${s}z` : s;
  };
  const host = [label(), label(), r.pick(["example", "test", "invalid"])].slice(r.int(2)).join(".");
  const port = r.chance(0.2) ? `:${1024 + r.int(60000)}` : "";
  const segment = () => {
    const n = 1 + r.int(10);
    let s = r.pick([...letters]);
    for (let i = 1; i < n; i++) {
      s += r.chance(0.15) ? r.pick(["%2F", "%23", "%3F", "%25", "%5B"]) : r.pick([...letters, ..."0123456789-._~!$&'()*+,;=:@"]);
    }
    return s;
  };
  const depth = r.int(4);
  const path = Array.from({ length: depth }, () => `/${segment()}`).join("");
  return `${r.chance(0.05) ? "http://localhost" : `https://${host}${port}`}${path}`;
}

describe("a reference has one spelling", () => {
  it("round-trips a generated database URI and id", () => {
    const r = seeded(7);
    for (let i = 0; i < 2000; i++) {
      const db = canonicalDb(generateDb(r)); // canonical by construction, and asserted to be
      const id = makeId(BigInt(r.int(65536)), BigInt(r.int(1_000_000)));
      const ref = formatRef(db, id);
      assert.deepEqual(parseRef(ref), { db, id }, ref);
      assert.equal(isQualified(ref), true);
      // And a reference re-formatted from its parts is the same string, which is what lets the
      // registry's unique index on the URI mean what it says.
      const parsed = parseRef(ref);
      assert.equal(formatRef(parsed.db, parsed.id), ref);
    }
  });

  it("round-trips a local id as the bare decimal that storage already holds", () => {
    const r = seeded(11);
    for (let i = 0; i < 500; i++) {
      const id = makeId(BigInt(r.int(65536)), BigInt(r.int(1_000_000)));
      assert.equal(formatRef(null, id), id);
      assert.deepEqual(parseRef(id), { db: null, id });
      assert.equal(isQualified(id), false);
    }
  });

  // The first `#` is the separator because a canonical database URI has no fragment. An escaped `#`
  // inside the path is therefore not a split point, which is the property that makes the rule safe
  // rather than merely convenient.
  it("splits at the one # a canonical URI cannot contain", () => {
    const ref = formatRef("https://db.example/a%23b", "281474976710691");
    assert.equal(ref, "https://db.example/a%23b#281474976710691");
    assert.deepEqual(parseRef(ref), { db: "https://db.example/a%23b", id: "281474976710691" });

    // A second `#` lands in the id half, where `parseId` refuses it.
    assert.throws(() => parseRef("https://db.example/x#5#6"), /not an id/);
    assert.throws(() => parseRef("#5"), RefError);
  });

  it("is the example in the plan", () => {
    assert.deepEqual(parseRef("https://db.example/wiki#281474976710691"), {
      db: "https://db.example/wiki",
      id: "281474976710691",
    });
  });
});

describe("the canonical database URI", () => {
  // Each row is a spelling of one database that this implementation will not store, and the
  // canonical spelling it names instead. Repairing silently would put two aliases in the registry
  // for one database, which its unique index on the URI would not notice.
  const named: [string, string][] = [
    ["HTTPS://db.example/wiki", "https://db.example/wiki"],
    ["https://DB.Example/wiki", "https://db.example/wiki"],
    ["https://db.example./wiki", "https://db.example/wiki"],
    ["https://db.example:443/wiki", "https://db.example/wiki"],
    ["http://localhost:80/wiki", "http://localhost/wiki"],
    ["https://db.example/", "https://db.example"],
    ["https://db.example/wiki/", "https://db.example/wiki"],
    ["https://db.example/a/./b", "https://db.example/a/b"],
    ["https://db.example/a/../b", "https://db.example/b"],
    ["https://db.example/%7Ewiki", "https://db.example/~wiki"], // an escape that is not required
    ["https://db.example/%41", "https://db.example/A"],
    ["https://db.example/a%2fb", "https://db.example/a%2Fb"], // escapes are uppercase
    ["https://xn--wki-zma.example/x", "https://xn--wki-zma.example/x"], // but spelled as A-labels
    ["https://db.example/a b", "https://db.example/a%20b"],
    ["https://db.example/a\\b", "https://db.example/a/b"],
    ["  https://db.example/wiki  ", "https://db.example/wiki"],
    ["https://db.example/wiki?", "https://db.example/wiki"], // URL drops an empty query
    ["https://db.example/wiki#", "https://db.example/wiki"], // and an empty fragment
    // The URL parser's own "double-dot path segment" includes the `%2e` spellings, so an escaped
    // dot segment is resolved before this module sees it rather than smuggled past as opaque.
    ["https://db.example/a/%2E%2E/b", "https://db.example/b"],
    ["https://db.example/%2e/b", "https://db.example/b"],
  ];

  for (const [given, canonical] of named) {
    it(`refuses ${JSON.stringify(given)} and names ${canonical}`, () => {
      // The non-ASCII row is here for its canonical form, which is a different string than the
      // input even though neither is the other's repair.
      if (given === canonical) {
        assert.equal(canonicalDb(given), canonical);
        return;
      }
      const err = caught(() => canonicalDb(given)) as RefError;
      assert.ok(err instanceof RefError, `${err}`);
      assert.equal(err.canonical, canonical);
      assert.match(err.message, new RegExp(canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      // And the named form is itself canonical, so being told it once is enough.
      assert.equal(canonicalDb(canonical), canonical);
    });
  }

  it("accepts a canonical URI unchanged, port, empty path and loopback included", () => {
    for (const uri of [
      "https://db.example",
      "https://db.example/wiki",
      "https://db.example:8443/wiki",
      "https://db.example/a/b/c",
      "https://db.example/a%2Fb",
      "https://db.example/~a!$&'()*+,;=:@-._",
      "https://[::1]/wiki",
      "http://localhost:8787/wiki",
      "http://127.0.0.1/wiki",
    ]) {
      assert.equal(canonicalDb(uri), uri);
    }
  });

  // These have no canonical form to name: every repair would change which resource the URI
  // identifies, or which database a stored reference means.
  const refused: [string, string, RegExp][] = [
    ["a scheme that is not http(s)", "ftp://db.example/wiki", /is https/],
    ["a relative reference", "/wiki", /not a database URI/],
    ["a bare host", "db.example/wiki", /not a database URI/],
    ["http on a host that is not loopback", "http://db.example/wiki", /loopback/],
    ["http on a host that merely looks local", "http://localhost.db.example/wiki", /loopback/],
    ["userinfo", "https://u:p@db.example/wiki", /userinfo/],
    ["a username alone", "https://u@db.example/wiki", /userinfo/],
    ["a query", "https://db.example/wiki?v=1", /query/],
    ["a fragment, which is where the id goes", "https://db.example/wiki#1", /fragment/],
    ["an empty path segment", "https://db.example//wiki", /empty segment/],
    ["an empty segment in the middle", "https://db.example/a//b", /empty segment/],
    ["an incomplete escape", "https://db.example/a%", /incomplete percent-escape/],
    ["an escape that is not hex", "https://db.example/a%zz", /incomplete percent-escape/],
    ["a character that must be escaped", "https://db.example/a|b", /must be escaped/],
    ["a caret, which URL does not escape either", "https://db.example/a^b", /must be escaped/],
    ["no host", "https://", /not a database URI/],
  ];

  for (const [why, uri, message] of refused) {
    it(`refuses ${why}`, () => {
      const err = caught(() => canonicalDb(uri)) as RefError;
      assert.ok(err instanceof RefError, `${err}`);
      assert.equal(err.canonical, undefined);
      assert.match(err.message, message);
    });
  }

  it("caps the length, because the URI is a prefix of every reference stored in a payload", () => {
    const pad = (n: number) => `https://db.example/${"a".repeat(n - "https://db.example/".length)}`;
    assert.equal(canonicalDb(pad(MAX_DB_URI_LENGTH)).length, MAX_DB_URI_LENGTH);
    assert.throws(() => canonicalDb(pad(MAX_DB_URI_LENGTH + 1)), RangeError);
  });

  it("refuses a non-string", () => {
    assert.throws(() => canonicalDb(undefined as unknown as string), RefError);
    assert.throws(() => parseRef(7 as unknown as string), RefError);
  });
});

// The whole reason `ids.ts` was left alone: a qualified reference that reaches a key conversion has
// to fail loudly, not be truncated to a local id that may well exist.
describe("the 8-byte guard stays strict", () => {
  it("throws on every qualified form, rather than storing a local id that happens to exist", () => {
    for (const ref of [
      "https://db.example/wiki#5",
      "https://db.example#281474976710691",
      "http://localhost:8787/wiki#1",
      "https://db.example/wiki#",
      "#5",
    ]) {
      assert.throws(() => toKey(ref), /not an id/, ref);
    }
  });

  it("still takes a local id, which is what a reference into this database is", () => {
    assert.equal(toKey(parseRef("281474976710691").id).byteLength, 8);
  });
});
