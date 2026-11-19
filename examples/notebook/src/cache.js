import { parseCursor } from "../workspace.js";

// One cache per origin. The server-issued cursor also identifies the notebook.
export class WorkspaceCache {
  constructor(factory) {
    this.factory = factory;
  }

  async open() {
    if (!this.factory) return null;
    if (!this.connection) {
      this.connection = new Promise((resolve, reject) => {
        const req = this.factory.open("folio-workspace", 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore("meta");
          req.result.createObjectStore("nodes", { keyPath: "id" });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.connection;
  }

  async read() {
    const db = await this.open();
    if (!db) return null;
    const tx = db.transaction(["meta", "nodes"], "readonly");
    const meta = tx.objectStore("meta").get("workspace");
    const rows = tx.objectStore("nodes").getAll();
    return new Promise((resolve, reject) => {
      tx.oncomplete = () =>
        resolve(
          meta.result
            ? {
                ...meta.result,
                nodes: Object.fromEntries(rows.result.map((node) => [node.id, node])),
              }
            : null,
        );
      tx.onabort = () => reject(tx.error);
    });
  }

  // A slower tab can finish its HTTP request after a faster tab persisted a
  // newer cursor. Only advance a cache whose base matches this response.
  async write(before, workspace, changedIds) {
    const db = await this.open();
    if (!db) return;
    const tx = db.transaction(["meta", "nodes"], "readwrite");
    const meta = tx.objectStore("meta");
    const nodes = tx.objectStore("nodes");
    const req = meta.get("workspace");
    req.onsuccess = () => {
      const current = req.result?.cursor ?? null;
      if (current !== before) {
        const incoming = parseCursor(workspace.cursor);
        const stored = parseCursor(current);
        if (
          stored &&
          (!incoming || stored.feedId !== incoming.feedId || stored.sequence >= incoming.sequence)
        )
          return;
        // Another tab advanced independently, or browser storage was cleared.
        // Rebuild from our coherent in-memory snapshot if the bases differ.
        changedIds = null;
      }
      if (!changedIds) nodes.clear();
      for (const id of changedIds ?? Object.keys(workspace.nodes)) nodes.put(workspace.nodes[id]);
      meta.put({ cursor: workspace.cursor ?? null, home: workspace.home }, "workspace");
    };
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }
}
