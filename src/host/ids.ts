// Object ids. An id is an unsigned 64-bit integer whose high bits name its vshard. Ids are decimal
// strings in the API and 8-byte big-endian blobs in SQLite, so one vshard's rows form one contiguous
// key range and nothing is ever coerced through a double.

import type { Id } from "../query/types.ts";

// 16 vshard bits, 47 sequence bits, and the top bit RESERVED and required to be zero.
//
// It was 24/40/0, then 20/40/4, then 20/43/1. Three things decide it.
//
// 1. The sequence is the field that can NEVER be widened. The vshard field is anchored at bit
//    SEQ_BITS, so widening the sequence MOVES it: an id minted as (vshard 5, seq 100) is
//    5*2^47 + 100, and re-reading that number at a different SEQ_BITS yields a different vshard.
//    Every id would have to be re-minted, which edges make impossible. So the sequence is sized
//    generously and the vshard field is sized for what is actually needed.
//
// 2. The sequence's burn rate is NOT the per-DO request limit, which is the mistake the earlier
//    splits were sized against. 1,000/sec is REQUESTS, and one request is one transaction that can
//    create many objects in a colocation group — so a bulk load behind `with: parentId` burns ids
//    at requests x objects-per-transaction. Sustained into one vshard, 2^47 is ~4,460 years at
//    1,000 creates/sec, ~45 years at 100,000, and ~4.5 years at a million. 2^40 would have been
//    ~4 months at 100,000, which is a realistic tenant import, and that is what made the original
//    40-bit sequence wrong rather than merely tight.
//
// 3. A logical database is what one customer spins up, and the service scales by adding databases
//    rather than by growing one. So the vshard field bounds a single customer's database, not the
//    product: 2^16 vshards is ~65 TB at the current ~1 GB cap — the line managed Postgres draws,
//    RDS at 64 TiB and Aurora at 128 TiB — and ~6.5 PB once a vshard's size stops being bounded by
//    what a stop-the-world move can copy. A customer past that shards above hlekk, as they would
//    past a Postgres instance.
//
// The reserved bit is the SIGN bit and it is load-bearing, not option value. Keeping it clear puts
// every id below 2^63, the threshold where SQLite coerces an integer to REAL and two distinct ids
// can compare equal (design.md, "Why BLOB storage" — a local sqlite3 test confirmed it). Blob keys
// are the defence; this makes the collision unrepresentable, which is principle 7 applied to the
// layout. It also means the vshard field is FIXED at 16 bits: widening it would spend that bit, and
// there is no spare above it. That is the accepted cost of sizing the sequence for batched writes.
//
// Deliberately NOT carved up further. A fixed sub-slab field for the split scheme (design.md,
// "If splits are ever needed") would come out of the sequence, which is the field under real
// pressure. Slabs are allocated dynamically out of the sequence space, with continuation slabs
// when one fills, which is what makes them work at any vshard size.
export const VSHARD_BITS = 16n;
export const SEQ_BITS = 47n;
export const RESERVED_BITS = 64n - VSHARD_BITS - SEQ_BITS;

export const MAX_VSHARD = (1n << VSHARD_BITS) - 1n;
export const MAX_SEQ = (1n << SEQ_BITS) - 1n;
// Also the sign-bit check: an id at or above 2^63 is out of range, so the one value SQLite would
// coerce to REAL cannot reach storage even if a caller hands one in.
const MAX_ID = (1n << (VSHARD_BITS + SEQ_BITS)) - 1n;

/** Parses a decimal id. Throws on anything else, rather than letting it reach SQLite. */
export function parseId(id: Id): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(id)) throw new TypeError(`not an id: ${JSON.stringify(id)}`);
  const n = BigInt(id);
  if (n > MAX_ID) throw new RangeError(`id out of range: ${id}`);
  return n;
}

export function makeId(vshard: bigint, seq: bigint): Id {
  if (vshard < 0n || vshard > MAX_VSHARD) throw new RangeError(`vshard out of range: ${vshard}`);
  if (seq < 0n || seq > MAX_SEQ) throw new RangeError(`sequence out of range: ${seq}`);
  return ((vshard << SEQ_BITS) | seq).toString();
}

export function toKey(id: Id): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, parseId(id)); // big-endian by default
  return b;
}

export function fromKey(b: Uint8Array): Id {
  if (b.byteLength !== 8) throw new TypeError(`not an id key: ${b.byteLength} bytes`);
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0).toString();
}

export const vshardOf = (id: Id): bigint => parseId(id) >> SEQ_BITS;

/** Inclusive bounds, so the last vshard doesn't wrap past 2^64: WHERE id BETWEEN ? AND ?. */
export const vshardRange = (v: bigint): [Uint8Array, Uint8Array] => [toKey(makeId(v, 0n)), toKey(makeId(v, MAX_SEQ))];
