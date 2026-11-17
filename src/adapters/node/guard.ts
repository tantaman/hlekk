import { lookup } from "node:dns/promises";

import { BlockList, isIP } from "node:net";
import { request as http } from "node:http";
import { request as https } from "node:https";
import { Readable } from "node:stream";

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

// BlockList compares numeric addresses and also applies IPv4 subnets to mapped IPv6.
const reserved = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) reserved.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32],
] as const) reserved.addSubnet(network, prefix, "ipv6");

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && !reserved.check(address, family === 4 ? "ipv4" : "ipv6");
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
export function privateAddressGuard(opts: GuardOptions = {}) {
  const resolve = opts.resolve ?? ((name: string) => lookup(name, { all: true, verbatim: true }));
  async function addresses(url: URL) {
    const name = url.hostname.replace(/^\[|\]$/g, "");
    const records = isIP(name) ? [{ address: name }] : await resolve(name);
    if (!records.length) throw new PrivateAddress(url.href, "no address");
    return records.map(({ address }) => {
      const family = isIP(address);
      if (!isPublicAddress(address) && !(family && opts.allowLoopback && loopback.check(address, family === 4 ? "ipv4" : "ipv6"))) {
        throw new PrivateAddress(url.href, address);
      }
      return { address, family };
    });
  }

  async function guard(database: string) {
    await addresses(new URL(canonicalDb(database)));
  }

  // Keep the hostname for Host, TLS SNI and certificate verification. Supply the
  // checked records directly to the socket's lookup, including on later requests.
  async function guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const records = await addresses(url);
    request.signal.throwIfAborted();
    const payload = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
    return new Promise((resolve, reject) => {
      const connect = url.protocol === "https:" ? https : http;
      const req = connect(url, {
        method: request.method,
        headers: Object.fromEntries(request.headers as unknown as Iterable<[string, string]>),
        signal: request.signal,
        agent: false,
        lookup: (_name, options, callback) => {
          if (options.all) callback(null, records);
          else callback(null, records[0]!.address, records[0]!.family);
        },
      }, (res) => {
        const headers = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
        const status = res.statusCode!;
        if ([204, 205, 304].includes(status) || request.method === "HEAD") {
          res.resume();
          resolve(new Response(null, { status, headers }));
        } else {
          resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, headers }));
        }
      });
      req.on("error", reject);
      req.end(payload);
    });
  }
  return Object.assign(guard, { fetch: guardedFetch });
}
