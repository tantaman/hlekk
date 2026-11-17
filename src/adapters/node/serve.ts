// Serves one hlekk database from a directory.
//
//   node src/adapters/node/serve.ts --dir ./my-database --port 8080 --path /db
//
// The whole of "spin up your own with no account anywhere": a directory of SQLite files, one process,
// and the protocol on a port. A second one of these on another machine, with an edge drawn at its
// URI, is a federation.
//
// The URI is the database's identity, so it is recorded on first open and never changed — and it has
// to be the name other databases will reach this one by, not the one this process happens to bind.
// `--uri` is how a deployment behind a name says so; without it the listening origin is used, which
// is right for development and wrong for anything another database will draw an edge into.

import { readFileSync } from "node:fs";

import type { Lock } from "../../catalog/catalog.ts";
import { open } from "./database.ts";
import { listen } from "./http.ts";

export interface Args {
  dir: string;
  port: number;
  host: string;
  path: string;
  uri?: string;
  lock?: string;
  /** Signs outgoing requests and verifies incoming ones. */
  identity: boolean;
  /** Allows a loopback URI, which `privateAddressGuard` refuses otherwise. */
  allowLoopback: boolean;
}

export function parse(argv: readonly string[]): Args {
  const args: Args = { dir: "./hlekk", port: 0, host: "127.0.0.1", path: "", identity: true, allowLoopback: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i]!.split("=", 2) as [string, string | undefined];
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new TypeError(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "--dir":
        args.dir = value();
        break;
      case "--port":
        args.port = Number(value());
        break;
      case "--host":
        args.host = value();
        break;
      case "--path":
        args.path = value();
        break;
      case "--uri":
        args.uri = value();
        break;
      case "--lock":
        args.lock = value();
        break;
      case "--no-identity":
        args.identity = false;
        break;
      case "--allow-loopback":
        args.allowLoopback = true;
        break;
      default:
        throw new TypeError(`unknown argument ${flag}`);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
    throw new TypeError(`--port must be a port, got ${args.port}`);
  }
  return args;
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parse(argv);
  const lock = args.lock === undefined ? undefined : (JSON.parse(readFileSync(args.lock, "utf8")) as Lock);
  const database = await open({
    dir: args.dir,
    uri: args.uri,
    lock,
    identity: args.identity,
    allowLoopback: args.allowLoopback,
  });

  const node = await listen(database.binding, { path: args.path, port: args.port, host: args.host, database: args.uri });

  const keys = database.binding.keys ?? [];
  console.log(`hlekk: serving ${node.database} from ${args.dir}`);
  console.log(`  catalog version ${database.catalog.version}, storage format ${database.cluster.directory.storageFormat()}`);
  console.log(`  ${keys.length === 0 ? "no published key: every caller is the anonymous one" : `key ${keys[keys.length - 1]!.id}`}`);

  const stop = async (): Promise<void> => {
    await node.close();
    database.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

// `import.meta.main` is Node 24's; this is the form that works on 22 as well.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ""))) {
  await main(process.argv.slice(2));
}
