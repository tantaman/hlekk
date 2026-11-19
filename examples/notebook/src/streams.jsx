import React, { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  FilePenLine,
  FilePlus2,
  FolderPlus,
  FolderMinus,
  GitCommitHorizontal,
  History,
  MessageSquareText,
  RefreshCw,
} from "lucide-react";
import { allOf, blockText, emptyBlock } from "./client";
import { BlockPreview, Editor } from "./editor";

const day = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const eventTypes = {
  captured: [MessageSquareText, "Posted a thought"],
  edited: [FilePenLine, "Edited document"],
  committed: [GitCommitHorizontal, "Committed revision"],
  restored: [History, "Restored revision"],
  createdDocument: [FilePlus2, "Created document"],
  createdCollection: [FolderPlus, "Created collection"],
  addedMember: [FolderPlus, "Added to collection"],
  removedMember: [FolderMinus, "Removed from collection"],
};
export function ActivityFeed({ client, cursor, go }) {
  const [result, setResult] = useState({ items: [], next: null }),
    [busy, setBusy] = useState(true),
    [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const requestNumber = useRef(0);
  async function fetchPage(before) {
    const number = ++requestNumber.current;
    setBusy(true);
    setError("");
    try {
      const page = await client.activity(before);
      if (number !== requestNumber.current) return;
      setResult((prev) => ({ items: before ? [...prev.items, ...page.items] : page.items, next: page.next }));
    } catch (e) {
      if (number === requestNumber.current) setError(e.message);
    } finally {
      if (number === requestNumber.current) setBusy(false);
    }
  }
  useEffect(() => {
    fetchPage();
    return () => {
      requestNumber.current++;
    };
  }, [cursor, refresh]);
  return (
    <main className="listing stream-page">
      <div className="stream-inner">
        <div className="doc-kicker">
          <Activity size={15} /> Notebook
        </div>
        <div className="listing-title">
          <h1>Activity feed</h1>
          <button className="button" onClick={() => setRefresh((v) => v + 1)} disabled={busy}>
            <RefreshCw size={15} />
            Refresh
          </button>
        </div>
        {result.items.map((event, i) => {
          const [Icon, verb] = eventTypes[event.verb];
          const label = day.format(event.date);
          return (
            <React.Fragment key={event.id}>
              {(!i || day.format(result.items[i - 1].date) !== label) && (
                <h2 className="stream-date">{label}</h2>
              )}
              <button className="activity-row" onClick={() => go(event.target)}>
                <span className="activity-icon">
                  <Icon size={17} />
                </span>
                <span className="event-body">
                  <span>{verb}</span>
                  <strong>{event.title}</strong>
                  {event.detail && <small>{event.detail}</small>}
                </span>
                <time dateTime={new Date(event.date).toISOString()}>{time.format(event.date)}</time>
              </button>
            </React.Fragment>
          );
        })}
        {busy && (
          <p className="muted" role="status">
            Loading activity…
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!busy && !error && !result.items.length && (
          <p className="muted">Your notebook activity will appear here.</p>
        )}
        {result.next && (
          <button className="button more-activity" disabled={busy} onClick={() => fetchPage(result.next)}>
            Older activity
          </button>
        )}
      </div>
    </main>
  );
}
function freshDraft() {
  return { key: crypto.randomUUID(), blocks: [emptyBlock()] };
}
function readDraft(storageKey) {
  try {
    const draft = JSON.parse(sessionStorage.getItem(storageKey));
    if (draft?.key && draft.blocks?.length) return draft;
  } catch {}
  return freshDraft();
}
export function Thoughts({ client, nodes, go, verified, notebookKey }) {
  const storageKey = "folio:thought:" + notebookKey;
  const [draft, setDraft] = useState(() => readDraft(storageKey)),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const posting = useRef(false);
  const [composerVersion, setComposerVersion] = useState(0);
  const thoughts = allOf(nodes, "document")
    .filter((n) => n.capturedAt)
    .sort((a, b) => b.capturedAt - a.capturedAt || b.id.localeCompare(a.id));
  const hasText = draft.blocks.some((b) => blockText(b).trim());
  function edit(blocks) {
    const next = { key: crypto.randomUUID(), blocks };
    setDraft(next);
    setError("");
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(next));
    } catch {}
  }
  async function post() {
    if (!verified || !hasText || posting.current) return;
    posting.current = true;
    setBusy(true);
    setError("");
    try {
      await client.action({ action: "capture", ...draft });
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey));
        if (saved?.key === draft.key) sessionStorage.removeItem(storageKey);
      } catch {}
      setDraft(freshDraft());
      setComposerVersion((n) => n + 1);
    } catch (e) {
      setError(e.message);
    } finally {
      posting.current = false;
      setBusy(false);
    }
  }
  return (
    <main className="listing stream-page">
      <div className="stream-inner">
        <div className="doc-kicker">
          <MessageSquareText size={15} /> Notebook
        </div>
        <div className="listing-title">
          <h1>Quick thoughts</h1>
        </div>
        <form
          className="thought-composer"
          onSubmit={(e) => {
            e.preventDefault();
            post();
          }}
          onKeyDownCapture={(e) => {
            // ProseMirror handles Enter first unless the submit shortcut is intercepted here.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.stopPropagation();
              post();
            }
          }}
        >
          <Editor
            compose
            key={composerVersion}
            initial={draft.blocks}
            graph={nodes}
            readOnly={!verified || busy}
            onEdit={edit}
            onLink={(id) => {
              if (id) go(id);
            }}
          />
          <div className="composer-footer">
            <span>
              Markdown <span aria-hidden="true">·</span> [[wikilinks]]
            </span>
            <button
              type="submit"
              className="button primary"
              title="Post thought (⌘/Ctrl + Enter)"
              disabled={!verified || busy || !hasText}
            >
              {busy ? "Posting…" : "Post thought"}
            </button>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
        {thoughts.length > 0 && <h2 className="stream-date">Recent thoughts</h2>}
        {thoughts.map((doc) => (
          <article className="thought-card" key={doc.id}>
            <div className="thought-meta">
              <time dateTime={new Date(doc.capturedAt).toISOString()}>
                {day.format(doc.capturedAt)} · {time.format(doc.capturedAt)}
              </time>
              <button
                className="text-btn"
                aria-label={"Open document: " + doc.title}
                onClick={() => go(doc.id)}
              >
                Open document <ArrowUpRight size={14} />
              </button>
            </div>
            <BlockPreview blocks={doc.blocks.slice(0, 4).map((id) => nodes[id])} graph={nodes} />
          </article>
        ))}
        {!thoughts.length && (
          <p className="muted">Posted thoughts appear here. Open one as a document to keep writing.</p>
        )}
      </div>
    </main>
  );
}
