// Choosing which pages a low-scale run loads, shared by the in-process and the deployed ingest.
//
// Shared rather than copied because the two runs are only worth comparing while they load the *same*
// pages. A subset selected two ways drifts, and then a difference between a LocalCluster result and
// a deployed one cannot be told apart from a difference in what was selected.

import { records } from "./import-enwiki.mjs";
import { linkedFrom } from "../examples/wiki/wiki.ts";

export interface Rec {
  key: string;
  affinity: string;
  fields: { ns: number; title: string; redirect: boolean; len: number; extract?: string };
  edges: { type: string; to: string; time?: number }[];
}

export interface Subset {
  subset: Map<string, Rec>;
  /** Edges whose target is also in the subset, and so can be written. */
  kept: number;
  /** Edges pointing outside it, which have no id to reference. */
  dropped: number;
}

/**
 * Scans a window of the record stream and keeps the `pages` most-linked pages in it.
 *
 * **Most-linked, not first by id.** A subset of a link graph keeps very few of its edges — measured
 * at 1.2% for the first 400 pages by id against 33.9% for the 10,000 most-linked — because hub pages
 * interlink densely while peripheral ones point outward. That is an artifact of subsetting and not
 * data loss, and no figure from here should be read as a red-link share; `report.json` has that.
 *
 * Continuation records are folded back as they arrive: a page whose edge list exceeded the importer's
 * cap arrives as several records repeating the same key, and treating a repeat as a second page would
 * both lose edges and count the page twice.
 */
export async function selectSubset(opts: {
  work: string;
  pages: number;
  window?: number;
  maxEdges?: number;
}): Promise<Subset> {
  const window = opts.window ?? Math.min(200_000, opts.pages * 40);
  const scanned = new Map<string, Rec>();
  for await (const r of records({ work: opts.work, maxEdges: opts.maxEdges ?? 100_000 })) {
    const rec = r as Rec;
    const held = scanned.get(rec.key);
    if (held) held.edges.push(...rec.edges);
    else {
      if (scanned.size >= window) break;
      scanned.set(rec.key, { ...rec, edges: [...rec.edges] });
    }
  }

  const indegree = (rec: Rec) => rec.edges.reduce((n, e) => n + (e.type === linkedFrom.name ? 1 : 0), 0);
  const subset = new Map([...scanned.entries()].sort((a, b) => indegree(b[1]) - indegree(a[1])).slice(0, opts.pages));
  scanned.clear();

  // Only an edge whose target is also in the subset can be written, since the other end has no id.
  // Both directions are filtered by the same rule, so the two stay symmetric.
  let kept = 0;
  let dropped = 0;
  for (const rec of subset.values()) {
    const inside = rec.edges.filter((e) => subset.has(e.to));
    dropped += rec.edges.length - inside.length;
    kept += inside.length;
    rec.edges = inside;
  }
  return { subset, kept, dropped };
}
