import { WorkspaceCache } from "./cache.js";
import { applyChanges, parseCursor } from "../workspace.js";

export const emptyBlock = () => ({ key: crypto.randomUUID(), type: "paragraph", content: [] });
export const blockText = (b) =>
  (b?.content ?? []).map((s) => (s.type === "wiki" ? s.attrs.label : s.text)).join("");
export const allOf = (nodes, kind) => Object.values(nodes).filter((n) => n.kind === kind);
export const parentsOf = (nodes, block) => allOf(nodes, "document").filter((d) => d.blocks.includes(block));
export const nodeTitle = (n) => n?.title || blockText(n) || "Empty block";
async function request(path, init) {
  const response = await fetch("/api/" + path, init);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw Object.assign(new Error(data?.error || `Notebook request failed (HTTP ${response.status}).`), {
      status: response.status,
    });
  }
  return response.json();
}
function post(command, cursor) {
  const headers = { "Content-Type": "application/json" };
  const feed = parseCursor(cursor);
  if (feed) headers["X-Folio-Notebook"] = feed.feedId;
  return request("command", { method: "POST", headers, body: JSON.stringify(command) });
}

export class NotebookClient {
  constructor(cache) {
    try {
      this.cache = cache ?? new WorkspaceCache(globalThis.indexedDB);
    } catch {
      // Some browser privacy settings prevent even accessing indexedDB.
      this.cache = null;
    }
  }
  drafts = new Map();
  queue = Promise.resolve();
  listeners = new Set();
  state = { workspace: null, status: "Loading", verified: false, error: "" };
  listen = (fn) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  snapshot = () => this.state;
  emit(patch) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }
  async refresh() {
    const before = this.state.workspace;
    let next, changedIds;
    if (parseCursor(before?.cursor)) {
      try {
        const delta = await request("changes?after=" + encodeURIComponent(before.cursor));
        next = applyChanges(before, delta);
        changedIds = Object.keys(delta.patches);
      } catch (error) {
        // A previous server may still serve the full workspace during an upgrade.
        if (![404, 409].includes(error.status) || this.drafts.size) throw error;
      }
    }
    if (!next) next = await request("workspace");
    if (next !== before) {
      try {
        await this.cache?.write(before?.cursor ?? null, next, changedIds);
      } catch {
        this.cache = null; // A storage/quota failure must not turn a successful server write into a retry.
      }
    }
    this.needsRefresh = false;
    this.emit({ workspace: next, verified: true });
  }
  load() {
    return this.serialize(async () => {
      try {
        if (!this.state.workspace) {
          const cached = await this.cache?.read().catch(() => null);
          if (cached) this.emit({ workspace: cached, status: "Syncing…", verified: false });
        }
        await this.refresh();
        this.emit({ status: "Saved", error: "" });
      } catch (error) {
        this.emit({ status: "Offline", error: error.message });
      }
    });
  }
  serialize(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  draft(doc) {
    if (this.drafts.has(doc.id)) return this.drafts.get(doc.id).session;
    const nodes = this.state.workspace.nodes;
    const blocks = doc.blocks.map((id) => nodes[id]);
    return { title: doc.title, version: doc.version, blocks: blocks.length ? blocks : [emptyBlock()] };
  }
  change(id, patch, session) {
    if (!this.state.verified) return;
    Object.assign(session, patch);
    this.drafts.set(id, { session });
    this.emit({ status: "Unsaved changes", error: "" });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(() => {}), 500);
  }
  async writeDrafts() {
    if (this.needsRefresh) await this.refresh();
    while (this.drafts.size) {
      const [id, pending] = this.drafts.entries().next().value;
      const draft = { ...pending.session };
      this.emit({ status: "Saving…" });
      try {
        await post({ action: "save", id, ...draft }, this.state.workspace.cursor);
        // A second edit may arrive while this request is in flight.
        pending.session.version = draft.version + 1;
        if (this.drafts.get(id) === pending) this.drafts.delete(id);
        this.needsRefresh = true;
        await this.refresh();
      } catch (error) {
        this.emit({ status: "Save failed", error: error.message });
        throw error;
      }
    }
    this.emit({ status: "Saved", error: "" });
  }
  flush() {
    return this.serialize(() => this.writeDrafts());
  }
  action(command) {
    if (!this.state.verified)
      return Promise.reject(new Error("Reconnect to the notebook before making changes."));
    const cursor = this.state.workspace.cursor;
    return this.serialize(async () => {
      await this.writeDrafts();
      const doc = this.state.workspace.nodes[command.id];
      const result = await post({ ...command, version: doc?.version }, cursor);
      this.needsRefresh = true;
      try {
        await this.refresh();
      } catch (error) {
        this.emit({ error: "Change saved. Could not sync the workspace: " + error.message });
      }
      return result.id;
    });
  }
  activity(before) {
    return request(before ? "activity?before=" + encodeURIComponent(before) : "activity");
  }
  history(id) {
    return request("history/" + id);
  }
}
