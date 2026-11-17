// A database authenticates a database, and that is sufficient rather than a compromise.
//
// The reason is that nothing forwards. A database does not continue a traversal on anyone's behalf,
// so the topology is not one database relaying to the next: the coordinator is the hub. It asks B
// directly, and if B's answer carries a reference into C it asks C directly as well. B never speaks
// to C and never speaks for A. So every database authenticates exactly the one party addressing it,
// there is no delegation chain to verify, and the many hops of a federated read are many *graph*
// edges rather than many trust hops (`docs/protocol.md`).
//
// That is worth stating because the alternative is the thing that sinks federated identity schemes: a
// caller passing along a claim about a third party's user, to a database that cannot check it,
// several times over. It is not avoided here by being careful. It is unrepresentable.
//
// **The scheme.** One Ed25519 pair per database. The public half is published in the descriptor at
// the database's own URI, so TLS already proves domain control and there is no PKI to coordinate.
// A caller is named by its URI in a header and proves it with a signature over the request. The key
// is pinned on first contact and checked on later contact, which is what makes substitution loud
// instead of silent — SSH's model rather than a naming authority.
//
// **Measured**: WebCrypto signs and verifies Ed25519 on Node 22 with no dependency, against RFC
// 8032's own vectors, and deterministically — which is what lets the tests below hold fixed vectors
// rather than only round-trips. `scripts/edge-order.mjs` prints the same reading.
//
// **No dependency, and none wanted.** Everything here is `crypto.subtle` and string handling, so it
// runs on a Worker and on Node unchanged, and the package stays at zero runtime dependencies.

import { canonicalDb } from "../query/ref.ts";

/** The one algorithm. A second would need a reason, and "some caller might prefer it" is not one:
 *  every algorithm a verifier accepts is an algorithm an attacker may choose. */
export const ALG = "ed25519";

/** The label every signature in this profile carries. Fixed, because the profile is. */
export const LABEL = "hlekk";

/** The header naming the calling database. Its value is a canonical database URI. */
export const CALLER_HEADER = "hlekk-caller";

/** How far a request's creation time may be from the responder's clock. Reads apply nothing, so a
 *  replay inside this window costs the responder work and changes nothing; the window is about clock
 *  skew between two deployments, not about replay. */
export const MAX_SKEW_SECONDS = 300;

/** The components this profile signs, in this order, and no others.
 *
 *  A restricted profile of RFC 9421 is the point: the full specification lets a signer choose what it
 *  covers, and a verifier that accepts the signer's choice accepts a signature over nothing much. So
 *  the list is fixed here and a request whose `Signature-Input` does not match it exactly is refused
 *  rather than verified against its own smaller claim. */
export const COVERED = ["@method", "@target-uri", "content-digest", CALLER_HEADER] as const;

export class SignatureRefused extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`the request signature was refused: ${reason}`);
    this.name = "SignatureRefused";
    this.reason = reason;
  }
}

// ---- keys

/** A published key. `id` is derived from the key rather than chosen, so no key can claim another's. */
export interface PublicKey {
  id: string;
  alg: typeof ALG;
  /** The raw 32-byte public key, base64url, unpadded. */
  key: string;
  /**
   * A signature by the key this one replaces, over this one, so a holder of the old pin can walk
   * forward to the new key without being told to trust it.
   *
   * Key rotation is the part that gets skipped, and pinning without it is a foot-gun: a database
   * that cannot rotate either never rotates or breaks every edge into it. It is also the argument
   * against putting the key *in* the URI, self-certifying though that would be — identity has to
   * survive rotation, or rotation is impossible.
   */
  signedBy?: { id: string; signature: string };
  /** When it stopped being the current key, so a verifier can see the grace window it is in. */
  retired?: number;
}

/** A database's own pair. The private half never leaves the deployment. */
export interface KeyPair {
  public: PublicKey;
  /** The 32-byte Ed25519 seed, base64url. Short enough to live in one row of the directory's
   *  storage, and the only form `crypto.subtle` needs to reconstruct the pair. */
  seed: string;
}

export const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function unb64url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** The PKCS#8 prefix for a bare Ed25519 seed. `crypto.subtle` imports no other private form, and a
 *  seed plus this constant is the whole of the conversion. */
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

const sha256 = async (bytes: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer));

/** A key's id: the digest of the key itself, so the id is a fact about the key and not a claim. */
export const keyIdOf = async (key: string): Promise<string> => b64url(await sha256(unb64url(key)));

export async function generateKeyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const key = b64url(raw);
  return { public: { id: await keyIdOf(key), alg: ALG, key }, seed: b64url(pkcs8.slice(PKCS8_PREFIX.length)) };
}

/** The pair a stored seed names. Derived rather than stored, so there is one source of truth. */
export async function keyPairFrom(seed: string): Promise<KeyPair> {
  const bytes = unb64url(seed);
  if (bytes.byteLength !== 32) throw new TypeError(`an Ed25519 seed is 32 bytes, got ${bytes.byteLength}`);
  // Extractable, and only here. WebCrypto will not hand back a public key from a private one, but a
  // JWK export of the private key carries both halves — so the public half is derived from the seed
  // once, at open time, rather than stored beside it where the two could disagree. The key used for
  // SIGNING is imported separately and is not extractable.
  const priv = await importSeed(seed, true);
  const jwk = (await crypto.subtle.exportKey("jwk", priv)) as { x?: string };
  if (typeof jwk.x !== "string") throw new TypeError("this runtime will not export an Ed25519 public key");
  const key = jwk.x; // already base64url, unpadded
  return { public: { id: await keyIdOf(key), alg: ALG, key }, seed };
}

const importSeed = (seed: string, extractable = false): Promise<CryptoKey> => {
  const bytes = unb64url(seed);
  const der = new Uint8Array(PKCS8_PREFIX.length + bytes.length);
  der.set(PKCS8_PREFIX);
  der.set(bytes, PKCS8_PREFIX.length);
  return crypto.subtle.importKey("pkcs8", der as unknown as ArrayBuffer, "Ed25519", extractable, ["sign"]);
};

const importPublic = (key: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", unb64url(key) as unknown as ArrayBuffer, "Ed25519", false, ["verify"]);

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const sign = async (seed: string, message: string): Promise<string> =>
  b64url(new Uint8Array(await crypto.subtle.sign("Ed25519", await importSeed(seed), utf8(message) as unknown as ArrayBuffer)));

const verify = async (key: string, signature: string, message: string): Promise<boolean> => {
  try {
    return await crypto.subtle.verify(
      "Ed25519",
      await importPublic(key),
      unb64url(signature) as unknown as ArrayBuffer,
      utf8(message) as unknown as ArrayBuffer,
    );
  } catch {
    return false; // a malformed key or signature is a failed verification, not a fault
  }
};

// ---- rotation

/** What a rotation signature covers. Domain-separated from a request's signature base, so a
 *  signature made for one can never be presented as the other — which is the mistake that turns two
 *  independently sound signing schemes over one key into neither. */
const rotationMessage = (key: PublicKey): string => `hlekk-key-rotation\n${key.alg}\n${key.key}`;

/** Signs a new key with the old one, which is how a pin walks forward. */
export async function signRotation(previousSeed: string, next: PublicKey): Promise<PublicKey["signedBy"]> {
  const previous = await keyPairFrom(previousSeed);
  return { id: previous.public.id, signature: await sign(previousSeed, rotationMessage(next)) };
}

/**
 * The newest key reachable from a pinned id by following rotation signatures, or null.
 *
 * Null is what repudiates an alias: a database answering at the same URI with a key that is not the
 * pinned one and not signed by it is, as far as anyone holding an edge into it can tell, a different
 * database. That is the reassignment hazard `docs/global-ids.md` names, and this is the check that
 * makes it loud — an edge into it fails instead of resolving to a stranger's objects.
 */
export async function reachable(keys: readonly PublicKey[], pinned: string): Promise<PublicKey | null> {
  const byId = new Map(keys.map((k) => [k.id, k]));
  if (!byId.has(pinned)) return null;

  // Forward along `signedBy`, one step at a time, verifying each. A cycle or a forged link stops the
  // walk rather than looping: every step has to be a key not yet visited whose signature checks out.
  let current = byId.get(pinned)!;
  const seen = new Set<string>([pinned]);
  for (;;) {
    const next = keys.find((k) => k.signedBy?.id === current.id && !seen.has(k.id));
    if (next === undefined) return current;
    if (next.alg !== ALG) return current;
    if (!(await verify(current.key, next.signedBy!.signature, rotationMessage(next)))) return current;
    seen.add(next.id);
    current = next;
  }
}

/** Checks that a key's own id is the digest of its key, and that every rotation link verifies. A
 *  descriptor that fails this is malformed rather than untrusted, and is refused either way. */
export async function wellFormed(keys: readonly PublicKey[]): Promise<boolean> {
  const byId = new Map(keys.map((k) => [k.id, k]));
  for (const k of keys) {
    if (k.alg !== ALG) return false;
    if (unb64url(k.key).byteLength !== 32) return false;
    if ((await keyIdOf(k.key)) !== k.id) return false;
    if (k.signedBy === undefined) continue;
    const by = byId.get(k.signedBy.id);
    // A link to a key the descriptor does not list cannot be checked, so it is not a link. The key
    // is still usable on its own; it just cannot be walked to from a pin on its predecessor.
    if (by !== undefined && !(await verify(by.key, k.signedBy.signature, rotationMessage(k)))) return false;
  }
  return true;
}

// ---- the request signature

/** `Content-Digest`, as RFC 9530 spells it: one algorithm, as a byte-sequence member. */
export const contentDigest = async (body: string): Promise<string> =>
  `sha-256=:${btoa(String.fromCharCode(...(await sha256(utf8(body)))))}:`;

export interface SignedHeaders {
  [name: string]: string;
}

export interface SignOptions {
  method: string;
  /** The absolute URI the request is sent to, which is what a signature over `@target-uri` covers. */
  url: string;
  body: string;
  /** The calling database's canonical URI. */
  caller: string;
  seed: string;
  keyId: string;
  /** Seconds since the epoch. */
  created: number;
}

/** The signature base: the covered components, one per line, then the parameters. Exported because a
 *  test vector is only a vector if the thing it pins is nameable. */
export function signatureBase(opts: Omit<SignOptions, "seed"> & { digest: string }): string {
  const params = signatureParams(opts.created, opts.keyId);
  return [
    `"@method": ${opts.method.toUpperCase()}`,
    `"@target-uri": ${opts.url}`,
    `"content-digest": ${opts.digest}`,
    `"${CALLER_HEADER}": ${opts.caller}`,
    `"@signature-params": ${params}`,
  ].join("\n");
}

const signatureParams = (created: number, keyId: string): string =>
  `(${COVERED.map((c) => `"${c}"`).join(" ")});created=${created};keyid="${keyId}";alg="${ALG}"`;

/** The headers a signed request carries. */
export async function signRequest(opts: SignOptions): Promise<SignedHeaders> {
  const digest = await contentDigest(opts.body);
  const base = signatureBase({ ...opts, digest });
  return {
    [CALLER_HEADER]: opts.caller,
    "content-digest": digest,
    "signature-input": `${LABEL}=${signatureParams(opts.created, opts.keyId)}`,
    signature: `${LABEL}=:${btoa(String.fromCharCode(...unb64url(await sign(opts.seed, base))))}:`,
  };
}

/** What a verified request carries about its caller. */
export interface Caller {
  /** The canonical URI of the calling database. */
  database: string;
  /** The key that signed it. */
  key: PublicKey;
}

export interface VerifyOptions {
  method: string;
  url: string;
  body: string;
  headers: { get(name: string): string | null };
  /** Seconds since the epoch, as the responder sees it. */
  now: number;
  maxSkewSeconds?: number;
  /** The caller's published keys. Fetched by the responder from the caller's own descriptor, with
   *  the same defences a read of it gets — see `protocol/client.ts`. */
  keysOf: (database: string) => Promise<readonly PublicKey[]>;
}

/**
 * Verifies a request's signature, or throws saying which part failed.
 *
 * Returns null for a request that carries no signature at all. That is the **anonymous caller**, not
 * an error: a database serving public data authenticates nobody, and the policy decides what an
 * anonymous caller gets. A request that carries a signature and fails is refused, because the
 * alternative is that stripping a header downgrades a caller to anonymous and gets a different answer
 * than forging one would.
 */
export async function verifyRequest(opts: VerifyOptions): Promise<Caller | null> {
  const input = opts.headers.get("signature-input");
  const signature = opts.headers.get("signature");
  const caller = opts.headers.get(CALLER_HEADER);
  if (input === null && signature === null && caller === null) return null;
  if (input === null || signature === null || caller === null) {
    throw new SignatureRefused("a signed request carries all of signature-input, signature and a caller");
  }

  let database: string;
  try {
    database = canonicalDb(caller);
  } catch (e) {
    throw new SignatureRefused(`the caller is not a canonical database URI: ${(e as Error).message}`);
  }

  const parsed = parseInput(input);
  if (parsed === null) {
    // The restricted profile: a `Signature-Input` that covers something else is refused rather than
    // verified against its own narrower claim.
    throw new SignatureRefused(`signature-input must be exactly ${LABEL}=${signatureParams(0, "<id>").replace("created=0", "created=<n>")}`);
  }
  if (Math.abs(opts.now - parsed.created) > (opts.maxSkewSeconds ?? MAX_SKEW_SECONDS)) {
    throw new SignatureRefused(`created ${parsed.created} is outside the accepted window around ${opts.now}`);
  }

  const digest = await contentDigest(opts.body);
  const sent = opts.headers.get("content-digest");
  if (sent !== digest) throw new SignatureRefused("content-digest does not match the body");

  const keys = await opts.keysOf(database);
  const key = keys.find((k) => k.id === parsed.keyId);
  if (key === undefined) throw new SignatureRefused(`${database} publishes no key ${parsed.keyId}`);
  if (key.alg !== ALG) throw new SignatureRefused(`key ${key.id} is ${key.alg}, and this profile is ${ALG}`);

  const raw = parseSignature(signature);
  if (raw === null) throw new SignatureRefused(`signature must be ${LABEL}=:<base64>:`);
  const base = signatureBase({
    method: opts.method,
    url: opts.url,
    body: opts.body,
    caller: database,
    keyId: parsed.keyId,
    created: parsed.created,
    digest,
  });
  if (!(await verify(key.key, raw, base))) throw new SignatureRefused("the signature does not cover this request");
  return { database, key };
}

/** The one shape of `Signature-Input` this profile accepts. Written as a regex over the exact text
 *  rather than parsed as a structured field, because accepting only one shape is the restriction. */
function parseInput(input: string): { created: number; keyId: string } | null {
  const covered = COVERED.map((c) => `"${c}"`).join(" ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${LABEL}=\\(${covered}\\);created=(\\d{1,15});keyid="([A-Za-z0-9_-]{1,64})";alg="${ALG}"$`);
  const m = re.exec(input.trim());
  return m === null ? null : { created: Number(m[1]), keyId: m[2]! };
}

function parseSignature(signature: string): string | null {
  const m = new RegExp(`^${LABEL}=:([A-Za-z0-9+/=]{1,200}):$`).exec(signature.trim());
  if (m === null) return null;
  const bytes = Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0));
  return bytes.byteLength === 64 ? b64url(bytes) : null;
}
