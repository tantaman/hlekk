// The shard map's published form. The directory holds the whole map; everyone else holds the chunks
// they routed to, so what a reader carries is bounded by its working set and not by the database.
//
// One key per span of vshards, each chunk self-describing, so a reader computes its key from the
// vshard it wants and does one read. An entry is a run of consecutive vshards on one host at one
// epoch, packed to 12 bytes as three parallel u32 arrays and binary-searched with no allocation.

export const SPAN_BITS = 12n;
export const SPAN = Number(1n << SPAN_BITS);

const MAGIC = 0x484c4b4d; // "HLKM"
const ENC_VERSION = 1;
const HEADER = 32; // padded, so the entry arrays start 4-byte aligned

/** A run with no owner. A gap has to be explicit, or the run before it would answer for vshards that
 *  were never assigned. */
export const UNASSIGNED = 0xffffffff;

export interface Entry {
  /** First vshard of the run, clamped to the chunk's base so a chunk answers on its own. */
  start: number;
  host: number;
  epoch: number;
}

export interface Route {
  host: number;
  epoch: number;
}

export const chunkOf = (vshard: bigint): number => Number(vshard >> SPAN_BITS);
export const chunkBase = (index: number): bigint => BigInt(index) << SPAN_BITS;

/** Collapses assignments into runs over one chunk's span. Input must be sorted by vshard and lie
 *  inside the chunk. Vshards with no assignment become UNASSIGNED runs. */
export function runs(index: number, assigned: readonly { vshard: bigint; host: number; epoch: number }[]): Entry[] {
  const base = chunkBase(index);
  const out: Entry[] = [];
  let at = base;
  const push = (start: bigint, host: number, epoch: number) => {
    const last = out[out.length - 1];
    if (last && last.host === host && last.epoch === epoch) return; // extends the run
    out.push({ start: Number(start - base), host, epoch });
  };
  for (const a of assigned) {
    if (a.vshard > at) push(at, UNASSIGNED, 0); // the gap before it
    push(a.vshard, a.host, a.epoch);
    at = a.vshard + 1n;
  }
  if (at < base + BigInt(SPAN)) push(at, UNASSIGNED, 0);
  return out;
}

export function encodeChunk(index: number, mapVersion: number, entries: readonly Entry[]): Uint8Array {
  const bytes = new Uint8Array(HEADER + entries.length * 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC);
  view.setUint16(4, ENC_VERSION);
  view.setUint32(8, SPAN);
  view.setUint32(12, index);
  view.setBigUint64(16, BigInt(mapVersion));
  view.setUint32(24, entries.length);
  const starts = new Uint32Array(bytes.buffer, HEADER, entries.length);
  const hosts = new Uint32Array(bytes.buffer, HEADER + entries.length * 4, entries.length);
  const epochs = new Uint32Array(bytes.buffer, HEADER + entries.length * 8, entries.length);
  entries.forEach((e, i) => {
    starts[i] = e.start;
    hosts[i] = e.host;
    epochs[i] = e.epoch;
  });
  return bytes;
}

/** A decoded chunk. Holds the bytes and reads through them, so decoding costs nothing per lookup. */
export class Chunk {
  readonly index: number;
  readonly span: number;
  readonly mapVersion: number;
  readonly #starts: Uint32Array;
  readonly #hosts: Uint32Array;
  readonly #epochs: Uint32Array;

  constructor(bytes: Uint8Array) {
    if (bytes.byteLength < HEADER) throw new TypeError(`chunk is ${bytes.byteLength} bytes, too short for a header`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0) !== MAGIC) throw new TypeError("not a shard-map chunk");
    const enc = view.getUint16(4);
    if (enc !== ENC_VERSION) throw new TypeError(`shard-map chunk encoding ${enc}, expected ${ENC_VERSION}`);
    this.span = view.getUint32(8);
    this.index = view.getUint32(12);
    this.mapVersion = Number(view.getBigUint64(16));
    const n = view.getUint32(24);
    if (bytes.byteLength < HEADER + n * 12) throw new TypeError("shard-map chunk is shorter than its entry count");
    // The arrays are views, not copies: a lookup allocates nothing.
    const at = bytes.byteOffset + HEADER;
    this.#starts = new Uint32Array(bytes.buffer, at, n);
    this.#hosts = new Uint32Array(bytes.buffer, at + n * 4, n);
    this.#epochs = new Uint32Array(bytes.buffer, at + n * 8, n);
  }

  get entries(): number {
    return this.#starts.length;
  }

  /** The route for a vshard in this chunk, or undefined when nothing owns it. */
  lookup(vshard: bigint): Route | undefined {
    const offset = Number(vshard - chunkBase(this.index));
    if (offset < 0 || offset >= this.span) return undefined;
    // The run with the greatest start at or below the offset.
    let lo = 0;
    let hi = this.#starts.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.#starts[mid] <= offset) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (found < 0 || this.#hosts[found] === UNASSIGNED) return undefined;
    return { host: this.#hosts[found], epoch: this.#epochs[found] };
  }
}

/** The key a chunk is published under. One namespace, keys prefixed by database, so many databases
 *  share it; KV Instant's envelope is per namespace, which is where that would have to change. */
export const chunkKey = (database: string, index: number): string => `m/${database}/${index}`;
