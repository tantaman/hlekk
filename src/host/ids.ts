// Object ids. An id is an unsigned 64-bit integer whose high bits name its vshard. Ids are decimal
// strings in the API and 8-byte big-endian blobs in SQLite, so one vshard's rows form one contiguous
// key range and nothing is ever coerced through a double.

import type { Id } from "../query/types.ts";

// 20 vshard bits, 43 sequence bits, and the top bit RESERVED and required to be zero.
//
// It was 24/40/0, and briefly 20/40/4. Two asymmetries decide the split, and both point the same
// way.
//
// 1. SEQ_BITS can never change. The vshard field is anchored at bit SEQ_BITS, so widening the
//    sequence MOVES it: an id minted as (vshard 5, seq 100) is 5*2^40 + 100, and re-reading that
//    number at SEQ_BITS = 44 yields vshard 0. Every id would have to be re-minted, which edges
//    make impossible. Widening VSHARD_BITS upward into reserved bits is the only free move, since
//    every existing id has zeros up there and `id >> SEQ_BITS` is unchanged. So spare bits only
//    ever help the vshard field.
//
// 2. The pressure moved the other way. The vshard field narrowed BECAUSE a vshard can be larger,
//    so fewer are needed; reserving bits to relieve vshard pressure while arguing that pressure is
//    falling makes no sense. Meanwhile the byte cap is what used to retire a vshard early, and
//    removing it means vshards live longer and accumulate more ids — the sequence is what becomes
//    the binding lifetime bound. The bits follow the pressure.
//
// The failure modes are not symmetric either. Running out of vshards stops new roots but has two
// outs: widen the field, or shard above hlekk into a second logical database. Running out of
// sequence in one vshard means that vshard can never take a colocated child again, and there is no
// out — `with: parent` is a guarantee the caller asked for, and an object cannot be re-identified
// without breaking every edge that names it.
//
// What 43 bits buys: a vshard's creates are bounded by one DO at ~1,000/sec, which is 3.15e10 ids a
// year, so 2^43 is ~279 years at that ceiling and ~27,900 at the 10/sec the design doc's worked
// example uses. 2^40 was ~35 years at the ceiling, which is where the doc's "3,500 years" came
// from — that figure assumed 10/sec, one percent of what one vshard can serve.
//
// The one reserved bit is NOT option value; it is the sign bit, and it is load-bearing. Keeping it
// clear puts every id below 2^63, which is the threshold where SQLite coerces an integer to REAL
// and two distinct ids can compare equal (design.md, "Why BLOB storage" — a local sqlite3 test
// confirmed it). Blob keys are the defence; this makes the collision unrepresentable rather than
// merely avoided, which is principle 7 applied to the layout. It also means the vshard field is now
// effectively fixed at 20 bits, since widening it would spend that bit: 2^20 vshards is ~1 PB at
// the current ~1 GB cap and ~105 PB at 100 GB each, and the escape hatch above is a second database.
//
// Deliberately NOT carved up further. A fixed sub-slab field for the split scheme (design.md,
// "If splits are ever needed") would have to come out of the sequence, and 16 slab bits leaves 27
// for the sequence — 134M objects per vshard, where a 100 GB vshard of 1 KB objects wants ~10^8.
// Slabs are allocated dynamically out of the sequence space, with continuation slabs when one
// fills, which is what makes them work at any vshard size.
export const VSHARD_BITS = 20n;
export const SEQ_BITS = 43n;
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
