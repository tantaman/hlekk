// Refusing a database URI that resolves to an address inside this network, before anything is sent
// to it.
//
// A database URI is drawn by whoever writes the edge, and an edge can be written at a name nobody
// has deployed — that openness is the point of the design. The cost is that a URI is also an
// instruction to this process to make a request, so a reference to `http://169.254.169.254/db` or to
// a name whose A record points at `10.0.0.5` turns a read into a probe of whatever this deployment
// can reach but a stranger cannot. That is server-side request forgery with the request body chosen
// by the caller.
//
// This is in `adapters/node/` and not in `protocol/client.ts` because resolving a name is a platform
// thing: `node:dns` does not exist on Workers, and on Workers it is not needed — a Worker's `fetch`
// reaches the public internet and the platform's own bindings, not a VPC. So the check arrives as
// `guard` where the platform can make it, and the protocol client knows only that something may
// refuse before it sends.
//
// **What this is not.** It is not a defence against a hostile DNS server that answers differently
// for the check and for the request, which is a time-of-check-to-time-of-use gap only a resolving
// HTTP client can close. It raises the cost of the obvious attack and says plainly that it does not
// close that gap.

import { lookup } from "node:dns/promises";

import { canonicalDb } from "../../query/ref.ts";

export class PrivateAddress extends Error {
  readonly database: string;
  readonly address: string;
  constructor(database: string, address: string) {
    super(`${database} resolves to ${address}, which is not a public address`);
    this.name = "PrivateAddress";
    this.database = database;
    this.address = address;
  }
}

/** Whether an address is one a stranger's URI may send this process to. */
export function isPublicAddress(address: string): boolean {
  if (address.includes(":")) return isPublicV6(address);
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return false; // "this network"
  if (a === 10) return false; // RFC 1918
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local, and the cloud metadata services on it
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC 1918
  if (a === 192 && b === 168) return false; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return false; // RFC 6598, carrier NAT
  if (a === 192 && b === 0) return false; // 192.0.0.0/24 and 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51) return false; // documentation
  if (a === 203 && b === 0) return false; // documentation
  if (a >= 224) return false; // multicast, and everything reserved above it
  return true;
}

function isPublicV6(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "").toLowerCase();
  if (a === "::1" || a === "::") return false;
  // IPv4-mapped and IPv4-compatible: judged as the v4 address they carry, or the mapping is the way
  // past this check.
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return isPublicAddress(mapped[1]!);
  if (a.startsWith("fe80")) return false; // link-local
  if (/^f[cd]/.test(a)) return false; // unique local
  if (a.startsWith("ff")) return false; // multicast
  if (a.startsWith("2001:db8")) return false; // documentation
  return true;
}

export interface GuardOptions {
  /** Allows a loopback database URI, which is how two databases talk in one test. Off by default,
   *  because the whole point of the check is that a stranger's URI does not reach this network. */
  allowLoopback?: boolean;
  /** Injectable, so the policy above can be tested without a resolver. */
  resolve?: (hostname: string) => Promise<{ address: string }[]>;
}

/**
 * Refuses a database URI whose host resolves to an address inside this network.
 *
 * Every address a name resolves to has to be public, not just the first: a name with one public and
 * one private A record would otherwise pass the check and be reached at whichever the connection
 * picked.
 */
export function privateAddressGuard(opts: GuardOptions = {}): (database: string) => Promise<void> {
  const resolve = opts.resolve ?? ((hostname: string) => lookup(hostname, { all: true, verbatim: true }));
  const cache = new Map<string, Promise<void>>();
  return (database: string) => {
    let checked = cache.get(database);
    if (!checked) cache.set(database, (checked = check(database, resolve, opts.allowLoopback ?? false)));
    return checked;
  };
}

async function check(
  database: string,
  resolve: (hostname: string) => Promise<{ address: string }[]>,
  allowLoopback: boolean,
): Promise<void> {
  const url = new URL(canonicalDb(database));
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  // An IP literal needs no resolver, and must not get one: `lookup` on one returns it unchanged,
  // which would read as a confirmation rather than as the check being skipped.
  const literal = /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":");
  const addresses = literal ? [{ address: hostname }] : await resolve(hostname);
  if (addresses.length === 0) throw new PrivateAddress(database, "no address");
  for (const { address } of addresses) {
    if (isPublicAddress(address)) continue;
    if (allowLoopback && isLoopback(address)) continue;
    throw new PrivateAddress(database, address);
  }
}

const isLoopback = (address: string): boolean =>
  address === "::1" || address.startsWith("127.") || /^::(?:ffff:)?127\./i.test(address);
