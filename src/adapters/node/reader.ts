// A reader on Node: `reader/reader.ts`, with the one thing a platform has to add.
//
// A reference is written by whoever wrote the edge, so a reader that follows one is being told where
// to connect, and a Node process can reach whatever its network can. `spec/protocol.md` §10 makes
// refusing a private address a MUST for exactly this case. The check needs DNS, which is why it is
// here and not in a file that runs wherever `fetch` does — and why this is the entry point a Node
// process should reach for, rather than building a `Reader` with no guard and meaning to add one.

import { Reader } from "../../reader/reader.ts";
import type { Database, ReaderOptions } from "../../reader/reader.ts";
import { privateAddressGuard } from "./guard.ts";
import type { GuardOptions } from "./guard.ts";

/** A reader that refuses a database URI resolving to a private address. `allowLoopback` is for
 *  databases on this machine, which is development and tests. */
export function reader(opts: ReaderOptions & GuardOptions = {}): Reader {
  const { allowLoopback, resolve, ...rest } = opts;
  return new Reader({ guard: privateAddressGuard({ allowLoopback, resolve }), ...rest });
}

/** Meets one database with a guarded reader made for it. */
export function connect(uri: string, opts: ReaderOptions & GuardOptions = {}): Promise<Database> {
  return reader(opts).database(uri);
}
