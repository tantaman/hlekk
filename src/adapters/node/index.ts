// hlekk on Node: a directory of SQLite files, one process, and the protocol on a port.
//
// "Spin up your own with no account anywhere", and the proof that the protocol is implementable off
// the platform it was designed on. See `database.ts` for what it swaps and what it does not.

export { open } from "./database.ts";
export type { NodeHlekk, OpenOptions } from "./database.ts";
export { listen } from "./http.ts";
export type { ListenOptions, NodeDatabase } from "./http.ts";
export { PrivateAddress, isPublicAddress, privateAddressGuard } from "./guard.ts";
export type { GuardOptions } from "./guard.ts";
export { connect, reader } from "./reader.ts";
export type { NodeReaderOptions } from "./reader.ts";
export { main as serve, parse as parseArgs } from "./serve.ts";
export type { Args } from "./serve.ts";
