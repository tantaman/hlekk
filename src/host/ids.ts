// Object ids. An id is an unsigned 64-bit integer whose high bits name its vshard. Ids are decimal
// strings in the API and 8-byte big-endian blobs in SQLite, so one vshard's rows form one contiguous
// key range and nothing is ever coerced through a double.

import type { Id } from "../query/types.ts";

// 20 vshard bits, 40 sequence bits, and the top 4 RESERVED and required to be zero.
//
// It was 24/40/0. The vshard field narrowed because a vshard's size is no longer bounded by what a
// stop-the-world move can copy: 24 bits reached 16.7 PB only at the ~1 GB cap that bound set, and
// 2^20 vshards reach ~105 PB at 100 GB each — a higher ceiling from a narrower field. Even if the
// cap never moves, 2^20 × 1 GB is 1 PB, so this is not a bet on that change landing.
//
// The spare bits are at the TOP, and that is the whole point of doing this before any id exists.
// The vshard field stays anchored at bit 40, so every id ever minted has zeros above bit 59 and
// `id >> SEQ_BITS` decodes identically under a wider field: widening back to 24 bits later needs no
// migration. Narrowing later would need one. So this direction is free and reversible, and what it
// buys today is the refusal below — nothing can mint a vshard id above 2^20 and quietly spend the
// reservation.
//
// Deliberately NOT carved up further. A fixed sub-slab field for the split scheme (design.md,
// "If splits are ever needed") would have to come out of the sequence, and 16 slab bits leaves 24
// for the sequence — 16.7M objects per vshard, where a 100 GB vshard of 1 KB objects wants ~10^8.
// Slabs are allocated dynamically out of the sequence space, with continuation slabs when one
// fills, which is what makes them work at any vshard size.
export const VSHARD_BITS = 20n;
export const SEQ_BITS = 40n;
export const RESERVED_BITS = 64n - VSHARD_BITS - SEQ_BITS;

export const MAX_VSHARD = (1n << VSHARD_BITS) - 1n;
export const MAX_SEQ = (1n << SEQ_BITS) - 1n;
// Also the reserved-bits check: an id with any bit above 59 set is out of range, so a reservation
// cannot be spent by accident on the read path either.
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
