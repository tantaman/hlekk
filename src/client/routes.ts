// A client's route cache. Chunks, not the map: what one reader holds is bounded by the vshards it
// routes to. A chunk it has never fetched costs one read; a chunk gone stale costs a refusal and one
// more round, which is the correction path either way.

import { Chunk, chunkOf } from "../directory/map.ts";
import type { Route } from "../directory/map.ts";
import type { Transport } from "./transport.ts";

export class Routes {
  readonly #transport: Transport;
  readonly #chunks = new Map<number, Chunk>();
  /** Routes learned from the directory, which override a chunk that has not caught up. */
  readonly #direct = new Map<bigint, Route>();
  readonly #loading = new Map<number, Promise<void>>();

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /** Routes every vshard, fetching what it is missing in as few reads as it can. */
  async routeAll(vshards: readonly bigint[]): Promise<Map<bigint, Route>> {
    const out = new Map<bigint, Route>();
    const missing: bigint[] = [];
    for (const v of new Set(vshards)) {
      const r = this.peek(v);
      if (r) out.set(v, r);
      else missing.push(v);
    }
    if (missing.length === 0) return out;

    // One chunk read per chunk the gap falls in, then the directory for whatever the chunks lack.
    await Promise.all([...new Set(missing.map(chunkOf))].map((i) => this.#load(i)));
    const stillMissing = missing.filter((v) => {
      const r = this.peek(v);
      if (r) out.set(v, r);
      return !r;
    });
    if (stillMissing.length > 0) {
      for (const [v, r] of await this.#transport.resolve(stillMissing)) {
        this.#direct.set(v, r);
        out.set(v, r);
      }
    }
    return out;
  }

  async route(vshard: bigint): Promise<Route | undefined> {
    return (await this.routeAll([vshard])).get(vshard);
  }

  /** What the cache already knows, without any read. */
  peek(vshard: bigint): Route | undefined {
    return this.#direct.get(vshard) ?? this.#chunks.get(chunkOf(vshard))?.lookup(vshard);
  }

  /** A host says it no longer serves this vshard at that epoch. Drop what we believed and ask the
   *  directory, which is authoritative; the published chunk may not have caught up. */
  async reroute(vshards: readonly bigint[]): Promise<Map<bigint, Route>> {
    for (const v of vshards) {
      this.#direct.delete(v);
      this.#chunks.delete(chunkOf(v));
    }
    const found = await this.#transport.resolve(vshards);
    for (const [v, r] of found) this.#direct.set(v, r);
    return found;
  }

  /** Chunks held, for tests and for reporting. */
  get held(): number {
    return this.#chunks.size;
  }

  #load(index: number): Promise<void> {
    let loading = this.#loading.get(index);
    if (!loading) {
      loading = (async () => {
        const bytes = await this.#transport.chunk(index);
        if (bytes) this.#chunks.set(index, new Chunk(bytes));
      })();
      this.#loading.set(index, loading);
      const forget = () => this.#loading.delete(index);
      loading.then(forget, forget);
    }
    return loading;
  }
}
