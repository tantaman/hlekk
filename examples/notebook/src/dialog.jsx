import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  Check,
  FileText,
  FolderClosed,
  GitCommitHorizontal,
  Layers2,
  Search,
  X,
  Text,
  Globe,
} from "lucide-react";
import { nodeTitle, allOf, parentsOf } from "./client";
const titles = {
  search: "Search notebook",
  createDoc: "New document",
  createCollection: "New collection",
  history: "Revision history",
  commit: "Commit revision",
  restore: "Restore revision",
  wiki: "Insert wikilink",
  web: "Insert web link",
  embed: "Embed a block",
  collect: "Add to collection",
  collectBlock: "Collect this block",
  addMember: "Add to collection",
  block: "Block",
};
const icons = { document: FileText, block: Text, url: Globe, collection: FolderClosed };
export function Dialog({ dialog: d, nodes, client, doc, close, go, setDialog, restored }) {
  const [value, setValue] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revisions, setRevisions] = useState(null);
  const modal = useRef(null);
  useEffect(() => {
    const el = modal.current;
    const old = document.activeElement;
    el.showModal();
    el.querySelector("input")?.focus();
    return () => {
      el.close();
      old?.focus();
    };
  }, []);
  useEffect(() => {
    if (d.mode === "history")
      client
        .history(doc.id)
        .then(setRevisions)
        .catch((e) => setError(e.message));
  }, [d.mode, doc?.id]);
  const mode = d.mode,
    action = (c) => client.action(c);
  const pickModes = ["wiki", "embed", "collect", "collectBlock", "addMember", "search"];
  async function perform(fn) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(e) {
    e.preventDefault();
    await perform(async () => {
      let id;
      if (mode === "createDoc" || mode === "createCollection") {
        id = await action({
          action: "create",
          kind: mode === "createDoc" ? "document" : "collection",
          title: value,
          collection: d.collection,
        });
        close();
        go(id);
        return;
      }
      if (mode === "commit") {
        await action({ action: "commit", id: doc.id, label: value });
        close();
        return;
      }
      if (mode === "web") {
        let url;
        try {
          url = new URL(value);
        } catch {}
        if (!url || !["https:", "http:"].includes(url.protocol))
          throw new Error("Enter an http or https URL.");
        close();
        d.apply(url.href);
        return;
      }
      if (mode === "restore") {
        await action({ action: "restore", id: doc.id, revision: d.revision.id });
        restored();
        close();
      }
    });
  }
  async function pick(n) {
    await perform(async () => {
      if (mode === "search") {
        close();
        go(n.id);
        return;
      }
      if (mode === "embed" || mode === "wiki") {
        close();
        d.apply(n);
        return;
      }
      if (mode === "collect" || mode === "collectBlock") {
        await action({ action: "member", collection: n.id, id: d.blockId || doc.id });
      } else await action({ action: "member", collection: d.collection, id: n.id });
      close();
    });
  }
  let options = [];
  if (mode === "search")
    options = Object.values(nodes).filter((n) => n.kind !== "block" || parentsOf(nodes, n.id).length);
  if (mode === "wiki") options = allOf(nodes, "document");
  if (mode === "embed")
    options = allOf(nodes, "block").filter(
      (b) => b.type !== "embed" && b.id !== d.blockId && parentsOf(nodes, b.id).length,
    );
  if (mode === "collect" || mode === "collectBlock")
    options = allOf(nodes, "collection").filter((c) => !c.members.includes(d.blockId || doc.id));
  if (mode === "addMember")
    options = Object.values(nodes).filter(
      (n) =>
        n.id !== d.collection &&
        !nodes[d.collection].members.includes(n.id) &&
        (n.kind !== "block" || parentsOf(nodes, n.id).length),
    );
  const match = value.trim().toLowerCase();
  options = options
    .filter((n) => nodeTitle(n).toLowerCase().includes(match))
    .sort((a, b) => (a.kind === "block") - (b.kind === "block") || nodeTitle(a).localeCompare(nodeTitle(b)));
  const caption = {
    createDoc: "Document title",
    createCollection: "Collection name",
    commit: "Revision name",
    web: "URL",
  };
  return (
    <dialog
      ref={modal}
      className="dialog"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
      onClick={(e) => {
        if (e.target === modal.current && !busy) close();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-head">
          <h2>{titles[mode]}</h2>
          <button className="icon" disabled={busy} aria-label="Close dialog" onClick={close}>
            <X size={18} />
          </button>
        </div>
        {pickModes.includes(mode) && (
          <>
            <div className="searchbox">
              <Search size={17} />
              <input
                aria-label="Filter results"
                placeholder={
                  mode === "search" ? "Search documents, blocks, and collections…" : "Filter by name or text…"
                }
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
            <div className="result-list">
              {options.slice(0, 100).map((n) => {
                const Icon = icons[n.kind];
                return (
                  <button key={n.id} disabled={busy} onClick={() => pick(n)}>
                    <Icon size={16} />
                    <span>
                      {nodeTitle(n)}
                      <small>
                        {n.kind === "block" ? (parentsOf(nodes, n.id)[0]?.title ?? "Block") : n.kind}
                      </small>
                    </span>
                    <ArrowUpRight size={14} />
                  </button>
                );
              })}
              {!options.length && (
                <p className="muted">No matching {mode.startsWith("collect") ? "collections" : "items"}.</p>
              )}
            </div>
          </>
        )}
        {caption[mode] && (
          <form onSubmit={submit}>
            <label>
              {caption[mode]}
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                required
                maxLength={mode === "web" ? 2048 : 240}
                placeholder={
                  {
                    createDoc: "Untitled document",
                    createCollection: "Collection name",
                    commit: "What do you want to remember?",
                    web: "https://…",
                  }[mode]
                }
              />
            </label>
            {mode === "commit" && (
              <p className="muted">Save the current title and blocks as a revision you can return to.</p>
            )}
            <div className="dialog-actions">
              <button type="button" className="button" onClick={close}>
                Cancel
              </button>
              <button className="button primary" disabled={busy || !value.trim()}>
                {mode === "commit" ? <GitCommitHorizontal size={16} /> : <Check size={15} />}{" "}
                {mode === "commit" ? "Commit revision" : mode === "web" ? "Insert link" : "Create"}
              </button>
            </div>
          </form>
        )}
        {mode === "history" && (
          <div className="history">
            {revisions === null ? (
              <p>Loading revisions…</p>
            ) : revisions.length ? (
              revisions.map((r) => (
                <div key={r.id} className="revision">
                  <GitCommitHorizontal size={17} />
                  <div>
                    <strong>{r.label}</strong>
                    <small>
                      {new Date(r.date).toLocaleString()} · {r.count} blocks
                    </small>
                  </div>
                  <button className="button" onClick={() => setDialog({ mode: "restore", revision: r })}>
                    Restore
                  </button>
                </div>
              ))
            ) : (
              <div className="empty-state">
                <GitCommitHorizontal />
                <h3>No commits yet</h3>
                <p>Commit the draft to keep a revision in history.</p>
                <button className="button primary" onClick={() => setDialog({ mode: "commit" })}>
                  Commit revision
                </button>
              </div>
            )}
          </div>
        )}
        {mode === "restore" && (
          <form onSubmit={submit}>
            <p>
              Replace the current draft with “{d.revision.label}”? Any edits since that revision will be
              replaced. Existing commits stay in history.
            </p>
            <div className="dialog-actions">
              <button className="button" type="button" onClick={close}>
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                Restore revision
              </button>
            </div>
          </form>
        )}
        {mode === "block" && (
          <div className="block-detail">
            <Layers2 size={18} />
            <p>{nodeTitle(nodes[d.blockId])}</p>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </dialog>
  );
}
