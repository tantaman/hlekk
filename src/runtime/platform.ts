// What the host platform imposes, in one place.
//
// Every figure here is a property of where a host runs, not of the design. They were read off
// Cloudflare Durable Objects, and the design holds at any values: a port states its own and changes
// nothing else. They live together because the alternative is what this file replaced — the same
// limit restated in four comments beside four literals, where a reader porting the system had to
// find all four to know which numbers were theirs to change.
//
// Nothing consults these per request. They are the provenance of the derived defaults below, which
// is why they are plain data and not a seam like `Clock`.

export interface PlatformLimits {
  /** Storage one host may hold, in bytes of 10^9, as the platform bills and enforces it. The vshard
   *  cap and the per-host shed threshold both derive from this. */
  hostBytes: number;
  /** Sustained requests per second to one host. This bounds a host's density and one object's write
   *  rate, and it is why reads batch per host rather than per object. */
  hostRequests: number;
  /** The largest single row, and so the cap on an object payload. */
  rowBytes: number;
}

/** Cloudflare Durable Objects on Workers Paid, which every figure in `design.md` was set against.
 *  See its *Platform limits that shape the design* table for the sources. */
export const CLOUDFLARE: PlatformLimits = {
  hostBytes: 10_000_000_000,
  hostRequests: 1_000,
  rowBytes: 2 * 1024 * 1024,
};

/** The platform the defaults below are derived from. A port reassigns this and nothing else. */
export const PLATFORM: PlatformLimits = CLOUDFLARE;

// The two margins are absolute rather than proportional, which is what keeps them meaningful at
// Cloudflare's 10 GB: each covers a fixed cost, not a share of the host. A platform with a very
// large host would want them proportional, and that is a judgement for whoever ports it rather than
// arithmetic this file can do on their behalf.

/** Left below the host limit for what no vshard owns: the `vshards` table, and the freelist a delete
 *  leaves behind. */
const VSHARD_MARGIN = 1_000_000_000;

/** Left below the host limit so the placement controller can shed before a write meets SQLITE_FULL,
 *  past which writes fail while reads and deletes keep working. */
const SHED_MARGIN = 2_000_000_000;

/** A vshard's soft size cap. */
export const vshardCap = (p: PlatformLimits = PLATFORM): number => p.hostBytes - VSHARD_MARGIN;

/** Bytes on one host before it sheds. */
export const shedBytes = (p: PlatformLimits = PLATFORM): number => p.hostBytes - SHED_MARGIN;
