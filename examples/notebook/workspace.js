// The graph exposed by /api/workspace. Revisions are fetched on demand.
export const edgeLists = {
  document: ["blocks"],
  collection: ["members"],
  block: ["links", "embeds"],
  url: [],
};

export function parseCursor(cursor) {
  const match = typeof cursor === "string" && /^([a-f0-9-]{36}):(0|[1-9]\d*)$/.exec(cursor);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return { feedId: match[1], sequence: Number(match[2]) };
}

export function applyChanges(workspace, { cursor, patches }) {
  if (workspace.cursor === cursor) return workspace;
  const nodes = { ...workspace.nodes };
  for (const [id, { value, ...edges }] of Object.entries(patches)) {
    const previous = nodes[id];
    const node = { ...(value ?? previous) };
    for (const name of edgeLists[node.kind]) node[name] = edges[name] ?? previous?.[name] ?? [];
    nodes[id] = node;
  }
  return { ...workspace, nodes, cursor };
}
