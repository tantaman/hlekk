// Object ids. An id is an unsigned 64-bit integer whose high bits name its vshard. Ids are decimal
// strings in the API and 8-byte big-endian blobs in SQLite, so one vshard's rows form one contiguous
// key range and nothing is ever coerced through a double.

import type { Id } from "../query/types.ts";

export const VSHARD_BITS = 24n;
export const SEQ_BITS = 40n;

export const MAX_VSHARD = (1n << VSHARD_BITS) - 1n;
export const MAX_SEQ = (1n << SEQ_BITS) - 1n;
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
