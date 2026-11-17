import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALG,
  CALLER_HEADER,
  LABEL,
  MAX_SKEW_SECONDS,
  SignatureRefused,
  b64url,
  contentDigest,
  generateKeyPair,
  keyIdOf,
  keyPairFrom,
  reachable,
  signRequest,
  signRotation,
  signatureBase,
  unb64url,
  verifyRequest,
  wellFormed,
} from "./identity.ts";
import type { PublicKey } from "./identity.ts";

// A fixed seed, so these are vectors and not only round-trips. Ed25519 is deterministic, so one key
// and one message give one signature — which is what makes a vector possible at all, and what the
// probe behind `scripts/edge-order.mjs` confirmed on this runtime.
const SEED = b64url(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const CALLER = "https://notes.example/db";
const TARGET = "https://wiki.example/db/read";
const BODY = JSON.stringify({ ids: ["1"] });
const CREATED = 1_700_000_000;

const headersOf = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

describe("the key", () => {
  it("derives its id from itself, so no key can claim another's", async () => {
    const pair = await keyPairFrom(SEED);
    assert.equal(pair.public.id, await keyIdOf(pair.public.key));
    assert.equal(unb64url(pair.public.key).byteLength, 32);
    assert.equal(pair.public.alg, ALG);
    // The vector: this seed, this key, this id, on any runtime that implements Ed25519.
    assert.equal(pair.public.key, "ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ");
    assert.equal(pair.public.id, "ZbYGc9btiEvwHCwiLYKtoHQPKawzVdapJcgfF_R6J7g");
  });

  it("round-trips a generated pair through its seed alone", async () => {
    const made = await generateKeyPair();
    const again = await keyPairFrom(made.seed);
    assert.deepEqual(again.public, made.public);
  });

  it("refuses a seed that is not one", async () => {
    await assert.rejects(keyPairFrom(b64url(new Uint8Array(16))), /32 bytes/);
  });
});

describe("the request signature", () => {
  const signed = (over: Partial<Parameters<typeof signRequest>[0]> = {}) =>
    signRequest({
      method: "POST",
      url: TARGET,
      body: BODY,
      caller: CALLER,
      seed: SEED,
      keyId: "ZbYGc9btiEvwHCwiLYKtoHQPKawzVdapJcgfF_R6J7g",
      created: CREATED,
      ...over,
    });

  const keysOf = async () => [(await keyPairFrom(SEED)).public];

  it("is a fixed vector over a fixed base", async () => {
    const digest = await contentDigest(BODY);
    assert.equal(digest, "sha-256=:D9a+MJj2oRWwt8V6/0fRnecI3sO5vqNXZyX2sXpB/bU=:");
    const base = signatureBase({
      method: "POST",
      url: TARGET,
      body: BODY,
      caller: CALLER,
      keyId: "ZbYGc9btiEvwHCwiLYKtoHQPKawzVdapJcgfF_R6J7g",
      created: CREATED,
      digest,
    });
    // Written out, because the whole of what a signature means is what its base says.
    assert.equal(
      base,
      [
        '"@method": POST',
        '"@target-uri": https://wiki.example/db/read',
        '"content-digest": sha-256=:D9a+MJj2oRWwt8V6/0fRnecI3sO5vqNXZyX2sXpB/bU=:',
        '"hlekk-caller": https://notes.example/db',
        '"@signature-params": ("@method" "@target-uri" "content-digest" "hlekk-caller");created=1700000000;' +
          'keyid="ZbYGc9btiEvwHCwiLYKtoHQPKawzVdapJcgfF_R6J7g";alg="ed25519"',
      ].join("\n"),
    );
    const h = await signed();
    assert.equal(
      h.signature,
      "hlekk=:nu53JMo198lt2RkfwqsROeTgRt/ncQ6ONxUY9BbPjt1Hwx8vViOSYJR+BIHTlVxiBq3Qu73Vueybgtge07HOAw==:",
    );
  });

  it("verifies, and names the caller it verified", async () => {
    const h = await signed();
    const caller = await verifyRequest({
      method: "POST",
      url: TARGET,
      body: BODY,
      headers: headersOf(h),
      now: CREATED,
      keysOf,
    });
    assert.equal(caller?.database, CALLER);
    assert.equal(caller?.key.id, "ZbYGc9btiEvwHCwiLYKtoHQPKawzVdapJcgfF_R6J7g");
  });

  it("is refused when the body, the target, the caller or the time is altered", async () => {
    const h = await signed();
    const verifying = (over: Partial<Parameters<typeof verifyRequest>[0]>) =>
      verifyRequest({ method: "POST", url: TARGET, body: BODY, headers: headersOf(h), now: CREATED, keysOf, ...over });

    // The body: through `content-digest`, which is the component that makes the signature cover a
    // body it never sees in the base.
    await assert.rejects(verifying({ body: JSON.stringify({ ids: ["2"] }) }), /content-digest does not match/);
    // The target: a signature made for one database must not be replayable at another, which is what
    // `@target-uri` is for.
    await assert.rejects(verifying({ url: "https://elsewhere.example/db/read" }), /does not cover this request/);
    await assert.rejects(verifying({ method: "GET" }), /does not cover this request/);
    // The caller: changing the header changes the base, so it cannot be claimed by someone else.
    await assert.rejects(
      verifying({ headers: headersOf({ ...h, [CALLER_HEADER]: "https://other.example/db" }) }),
      /does not cover this request/,
    );
    // The time, outside the skew window.
    await assert.rejects(verifying({ now: CREATED + MAX_SKEW_SECONDS + 1 }), /outside the accepted window/);
    await assert.rejects(verifying({ now: CREATED - MAX_SKEW_SECONDS - 1 }), /outside the accepted window/);
    await assert.doesNotReject(verifying({ now: CREATED + MAX_SKEW_SECONDS }));
    // And the signature itself.
    const flipped = `${LABEL}=:${btoa(String.fromCharCode(...unb64url(b64url(new Uint8Array(64)))))}:`;
    await assert.rejects(verifying({ headers: headersOf({ ...h, signature: flipped }) }), /does not cover this request/);
  });

  it("refuses a signature-input that covers anything but this profile's components", async () => {
    const h = await signed();
    for (const input of [
      `${LABEL}=("@method");created=${CREATED};keyid="x";alg="ed25519"`,
      `${LABEL}=("@method" "@target-uri" "content-digest" "hlekk-caller");created=${CREATED};keyid="x";alg="rsa-v1_5-sha256"`,
      `other=("@method" "@target-uri" "content-digest" "hlekk-caller");created=${CREATED};keyid="x";alg="ed25519"`,
      `${LABEL}=("@target-uri" "@method" "content-digest" "hlekk-caller");created=${CREATED};keyid="x";alg="ed25519"`,
      `${LABEL}=("@method" "@target-uri" "content-digest" "hlekk-caller");keyid="x";alg="ed25519"`,
    ]) {
      // Every component a verifier lets a signer choose is a component an attacker may drop.
      await assert.rejects(
        verifyRequest({
          method: "POST",
          url: TARGET,
          body: BODY,
          headers: headersOf({ ...h, "signature-input": input }),
          now: CREATED,
          keysOf,
        }),
        SignatureRefused,
        input,
      );
    }
  });

  it("treats a request with no signature at all as the anonymous caller", async () => {
    const caller = await verifyRequest({
      method: "POST",
      url: TARGET,
      body: BODY,
      headers: headersOf({}),
      now: CREATED,
      keysOf,
    });
    // Not an error: a database serving public data authenticates nobody, and the policy decides what
    // an anonymous caller gets.
    assert.equal(caller, null);
  });

  it("refuses a half-signed request rather than reading it as anonymous", async () => {
    const h = await signed();
    // Otherwise stripping a header is a downgrade: a caller that cannot sign would get a different
    // answer by deleting one, which is worse than being refused.
    for (const drop of ["signature", "signature-input", CALLER_HEADER]) {
      const partial = { ...h };
      delete partial[drop];
      await assert.rejects(
        verifyRequest({ method: "POST", url: TARGET, body: BODY, headers: headersOf(partial), now: CREATED, keysOf }),
        /carries all of/,
      );
    }
  });

  it("refuses a caller that is not a canonical database URI", async () => {
    const h = await signed();
    await assert.rejects(
      verifyRequest({
        method: "POST",
        url: TARGET,
        body: BODY,
        headers: headersOf({ ...h, [CALLER_HEADER]: "https://Notes.example/db" }),
        now: CREATED,
        keysOf,
      }),
      /not a canonical database URI/,
    );
  });

  it("checks the identifier against the published key bytes before accepting it", async () => {
    const pair = await keyPairFrom(SEED);
    const wrong = (await generateKeyPair()).public.id;
    const h = await signed({ keyId: wrong });
    await assert.rejects(verifyRequest({
      method: "POST", url: TARGET, body: BODY, headers: headersOf(h), now: CREATED,
      keysOf: async () => [{ ...pair.public, id: wrong }],
    }), /malformed keys/);
  });

  it("refuses a key the caller does not publish", async () => {
    const h = await signed();
    await assert.rejects(
      verifyRequest({ method: "POST", url: TARGET, body: BODY, headers: headersOf(h), now: CREATED, keysOf: async () => [] }),
      /publishes no key/,
    );
  });
});

describe("rotation", () => {
  /** Three generations, each signed by the one before. */
  const chain = async () => {
    const one = await keyPairFrom(SEED);
    const two = await generateKeyPair();
    const three = await generateKeyPair();
    const second: PublicKey = { ...two.public, signedBy: await signRotation(one.seed, two.public) };
    const third: PublicKey = { ...three.public, signedBy: await signRotation(two.seed, three.public) };
    return { one, two, three, keys: [{ ...one.public, retired: 1 }, { ...second, retired: 2 }, third] };
  };

  it("walks a pin forward to the newest key", async () => {
    const { one, three, keys } = await chain();
    assert.equal(await wellFormed(keys), true);
    // A holder of the oldest pin reaches the newest key without being told to trust it, which is the
    // whole of why rotation is signed rather than announced.
    assert.equal((await reachable(keys, one.public.id))?.id, three.public.id);
  });

  it("accepts a pin on the current key, and one midway along the chain", async () => {
    const { two, three, keys } = await chain();
    assert.equal((await reachable(keys, three.public.id))?.id, three.public.id);
    assert.equal((await reachable(keys, two.public.id))?.id, three.public.id);
  });

  it("refuses a key the pin cannot reach, which is what repudiates an alias", async () => {
    const { one, keys } = await chain();
    const stranger = await generateKeyPair();
    // A database answering at the same URI with a key that is neither the pinned one nor signed by
    // it is, to everyone holding an edge into it, a different database. This is the reassignment
    // hazard, and null is what makes it loud.
    assert.equal(await reachable([stranger.public], one.public.id), null);
    // And a key that merely CLAIMS to be signed by the pin is not reachable from it.
    const forged: PublicKey = { ...stranger.public, signedBy: { id: one.public.id, signature: b64url(new Uint8Array(64)) } };
    assert.equal((await reachable([keys[0]!, forged], one.public.id))?.id, one.public.id);
    assert.equal(await wellFormed([keys[0]!, forged]), false);
  });

  it("refuses a rotation signature replayed from a request signature, and the other way round", async () => {
    // Both schemes sign with one key, so without domain separation a signature made for one could be
    // presented as the other — which turns two sound schemes into neither.
    const one = await keyPairFrom(SEED);
    const next = await generateKeyPair();
    const asRotation = await signRotation(one.seed, next.public);
    const h = await signRequest({
      method: "POST",
      url: TARGET,
      body: BODY,
      caller: CALLER,
      seed: one.seed,
      keyId: one.public.id,
      created: CREATED,
    });
    const requestSignature = /^hlekk=:(.*):$/.exec(h.signature)![1]!;
    assert.notEqual(asRotation!.signature, b64url(Uint8Array.from(atob(requestSignature), (c) => c.charCodeAt(0))));
    // The rotation signature does not verify as a request signature.
    const asHeader = `${LABEL}=:${btoa(String.fromCharCode(...unb64url(asRotation!.signature)))}:`;
    await assert.rejects(
      verifyRequest({
        method: "POST",
        url: TARGET,
        body: BODY,
        headers: headersOf({ ...h, signature: asHeader }),
        now: CREATED,
        keysOf: async () => [one.public],
      }),
      /does not cover this request/,
    );
    // And the request signature does not verify as a rotation.
    const claimed: PublicKey = {
      ...next.public,
      signedBy: { id: one.public.id, signature: b64url(Uint8Array.from(atob(requestSignature), (c) => c.charCodeAt(0))) },
    };
    assert.equal(await wellFormed([one.public, claimed]), false);
  });

  it("refuses a descriptor whose key id is not the digest of its key", async () => {
    const pair = await keyPairFrom(SEED);
    assert.equal(await wellFormed([{ ...pair.public, id: "something-else" }]), false);
    assert.equal(await wellFormed([{ ...pair.public, key: b64url(new Uint8Array(16)) }]), false);
    assert.equal(await wellFormed([{ ...pair.public, alg: "rsa" as never }]), false);
  });

  it("stops rather than looping on a cycle of rotation signatures", async () => {
    const one = await keyPairFrom(SEED);
    const two = await generateKeyPair();
    // Each signs the other, which is well formed and still has to terminate.
    const a: PublicKey = { ...one.public, signedBy: await signRotation(two.seed, one.public) };
    const b: PublicKey = { ...two.public, signedBy: await signRotation(one.seed, two.public) };
    assert.equal(await wellFormed([a, b]), true);
    const got = await reachable([a, b], one.public.id);
    assert.ok(got !== null);
  });
});
