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

/** A reader's options, without the one this entry point exists to supply. */
export type NodeReaderOptions = Omit<ReaderOptions, "guard"> & GuardOptions;

/**
 * A reader that refuses a database URI resolving to a private address. `allowLoopback` is for
 * databases on this machine, which is development and tests.
 *
 * The guard is not an option here, and it is set last, so nothing passed beside it can take its
 * place. It was once set first, under the caller's options: any `guard` key among them replaced
 * it, an `undefined` one included — which is what a caller forwarding its own configuration
 * passes — and the reader that came back checked nothing and said nothing. A caller with a
 * different policy builds a `Reader` with it. One that hands a guard to this function is told so,
 * rather than getting one of the two without knowing which.
 */
export function reader(opts: NodeReaderOptions = {}): Reader {
  const { allowLoopback, resolve, ...rest } = opts;
  if ((rest as ReaderOptions).guard !== undefined) {
    throw new TypeError(
      "a Node reader's guard is the private-address check, and it is not replaced here:" +
        " build a `Reader` with your own guard instead",
    );
  }
  return new Reader({ ...rest, guard: privateAddressGuard({ allowLoopback, resolve }) });
}

/** Meets one database with a guarded reader made for it. */
export function connect(uri: string, opts: NodeReaderOptions = {}): Promise<Database> {
  return reader(opts).database(uri);
}
