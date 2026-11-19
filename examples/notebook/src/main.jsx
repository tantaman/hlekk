import React, { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createRootRoute, createRoute, createRouter, RouterProvider, Outlet } from "@tanstack/react-router";
import {
  BookOpen,
  Search,
  Plus,
  Files,
  FileText,
  Network,
  FolderClosed,
  FolderOpen,
  ChevronRight,
  GitCommitHorizontal,
  History,
  PanelRight,
  X,
  CheckCheck,
  Blocks,
  Feather,
  Menu,
  Minus,
  Text,
} from "lucide-react";
import "@fontsource-variable/dm-sans";
import "@fontsource/spectral/latin-400.css";
import "@fontsource/spectral/latin-400-italic.css";
import "@fontsource/spectral/latin-500.css";
import "@fontsource/spectral/latin-600.css";
import { parseCursor } from "../workspace.js";
import { NotebookClient, allOf, nodeTitle, blockText, parentsOf } from "./client";
import { Editor } from "./editor";
import { Dialog } from "./dialog";
import { Inspector, FullGraph } from "./graph";
import "./style.css";

const client = new NotebookClient();
const rootRoute = createRootRoute({ component: Outlet });
const page = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  validateSearch: (search) => ({
    ...(search.node ? { node: String(search.node) } : {}),
    ...(search.view ? { view: String(search.view) } : {}),
    ...(search.block ? { block: String(search.block) } : {}),
  }),
  component: Notebook,
});
const router = createRouter({
  routeTree: rootRoute.addChildren([page]),
  parseSearch: (str) => Object.fromEntries(new URLSearchParams(str)),
  stringifySearch: (obj) => {
    const s = new URLSearchParams(Object.entries(obj).filter(([, v]) => v !== undefined));
    return s.size ? "?" + s : "";
  },
});
function IconButton({ label, children, onClick, className = "" }) {
  return (
    <button className={"icon " + className} aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}
function SectionLabel({ label, onClick }) {
  return (
    <div className="section-cap sidebar-label">
      {label}
      <IconButton label={label === "Collections" ? "New collection" : "New document"} onClick={onClick}>
        <Plus size={15} />
      </IconButton>
    </div>
  );
}
function Sidebar({ verified, workspace, selected, view, nav, go, openDialog, mobile, close }) {
  const { nodes, home } = workspace;
  const docs = allOf(nodes, "document").sort((a, b) =>
    a.id === home ? -1 : b.id === home ? 1 : b.edited - a.edited || a.title.localeCompare(b.title),
  );
  const collections = allOf(nodes, "collection").sort((a, b) => a.title.localeCompare(b.title));
  return (
    <>
      <aside className={"sidebar" + (mobile ? " mobile-open" : "")}>
        <div className="brand">
          <img src="/mark.svg" width="37" height="37" alt="" />
          <span>Folio</span>
          <IconButton className="mobile-only" label="Close navigation" onClick={close}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="sidebar-scroll">
          <button className="new-doc" onClick={() => openDialog({ mode: "createDoc" })}>
            <Plus size={17} />
            New document
          </button>
          <button className="search-trigger" onClick={() => openDialog({ mode: "search" })}>
            <Search size={16} /> Search notebook <kbd>⌘ K</kbd>
          </button>
          <div className="nav-top">
            <button className={view === "documents" ? "sel" : ""} onClick={() => nav({ view: "documents" })}>
              <Files /> All documents
            </button>
            <button className={view === "graph" ? "sel" : ""} onClick={() => nav({ view: "graph" })}>
              <Network /> Graph view
            </button>
          </div>
          <SectionLabel label="Collections" onClick={() => openDialog({ mode: "createCollection" })} />
          <div className="side-list">
            {collections.map((c) => (
              <button key={c.id} className={selected?.id === c.id ? "sel" : ""} onClick={() => go(c.id)}>
                <FolderClosed
                  className={
                    "folder folder-" + (c.title === "Observations" ? 0 : c.title === "Ideas" ? 1 : 2)
                  }
                  size={16}
                />
                <span>{c.title}</span>
                <small>{c.members.length}</small>
              </button>
            ))}
          </div>
          <SectionLabel label="Documents" onClick={() => openDialog({ mode: "createDoc" })} />
          <div className="side-list docs">
            {docs.map((n) => (
              <button key={n.id} className={selected?.id === n.id ? "sel" : ""} onClick={() => go(n.id)}>
                <FileText size={15} />
                <span>{n.title}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="side-footer">
          <div className="workspace-icon">
            <BookOpen size={18} />
          </div>
          <span>
            <strong>Personal workspace</strong>
            <small>
              <i /> {verified ? "Hlekk connected" : "Cached notebook"}
            </small>
          </span>
        </div>
      </aside>
      {mobile && <button className="scrim" aria-label="Close navigation" onClick={close} />}
    </>
  );
}
function DocumentView(props) {
  const [open, setOpen] = useState(() => ({ session: client.draft(props.doc), generation: 0 }));
  // Own saves advance this session in place. A newer remote version needs a
  // fresh editor only when the user has no outstanding edits to preserve.
  if (open.session.version < props.doc.version && !client.drafts.has(props.doc.id)) {
    setOpen({ session: client.draft(props.doc), generation: open.generation + 1 });
  }
  return <DocumentEditor key={open.generation} {...props} initial={open.session} />;
}
function DocumentEditor({ initial, doc, nodes, go, showDialog, jump, status, readOnly }) {
  const [title, setTitle] = useState(initial.title),
    [blocks, setBlocks] = useState(initial.blocks);
  const collection = allOf(nodes, "collection").find((n) => n.members.includes(doc.id));
  const words = blocks
    .map((b) => blockText(b.type === "embed" ? nodes[b.target] : b))
    .join(" ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  async function follow(target, label) {
    try {
      if (client.drafts.size) await client.flush();
      const next = client.state.workspace.nodes;
      const saved = next[doc.id].blocks
        .flatMap((id) => next[id].content)
        .find((s) => s.type === "wiki" && s.attrs.label === label);
      const id =
        target ||
        saved?.attrs.target ||
        allOf(next, "document").find((d) => d.title.toLowerCase() === label.toLowerCase())?.id;
      if (id) go(id);
    } catch {
      /* The persistent save status shows the failure. */
    }
  }
  async function editorDialog(d) {
    if (d.mode === "collectBlock") {
      try {
        await client.flush();
      } catch {
        return;
      }
      const graph = client.state.workspace.nodes;
      const b = graph[doc.id].blocks.map((id) => graph[id]).find((n) => n.key === d.blockKey);
      if (!b) {
        client.emit({ error: "Write in this block before adding it to a collection." });
        return;
      }
      d.blockId = b.id;
    }
    showDialog(d);
  }
  return (
    <main className="document-scroll">
      <article className="document">
        {doc.cover && (
          <div className="cover">
            <img src="/fern.webp" alt="Botanical ink study of fern fronds" />
          </div>
        )}
        <div className="doc-kicker">
          <Feather size={14} />
          {collection?.title || "Notebook"}
        </div>
        <h1
          className="editable-title"
          contentEditable={!readOnly}
          suppressContentEditableWarning
          role="textbox"
          aria-label="Document title"
          aria-multiline="false"
          data-placeholder="Untitled document"
          ref={(el) => {
            if (el && el !== document.activeElement && el.textContent !== title) el.textContent = title;
          }}
          onInput={(e) => {
            const value = e.currentTarget.textContent;
            setTitle(value);
            client.change(doc.id, { title: value }, initial);
          }}
          onPaste={(e) => {
            e.preventDefault();
            document.execCommand(
              "insertText",
              false,
              e.clipboardData.getData("text/plain").replace(/[\r\n]+/g, " "),
            );
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              document.querySelector(".ProseMirror")?.focus();
            }
          }}
        />
        <div className="doc-meta">
          <span>
            <Blocks /> {blocks.length} {blocks.length === 1 ? "block" : "blocks"}
          </span>
          <b>·</b>
          <span>
            {words} {words === 1 ? "word" : "words"}
          </span>
          <b>·</b>
          <span>
            <CheckCheck /> {status === "Saved" ? "Saved to Hlekk" : status}
          </span>
        </div>
        <Editor
          readOnly={readOnly}
          initial={initial.blocks}
          docId={doc.id}
          graph={nodes}
          onEdit={(b) => {
            setBlocks(b);
            client.change(doc.id, { blocks: b }, initial);
          }}
          onLink={follow}
          onDialog={editorDialog}
          jump={jump}
        />
      </article>
    </main>
  );
}
function Listing({ view, collection, nodes, go, showDialog, remove }) {
  const items = collection
    ? collection.members.map((id) => nodes[id]).filter(Boolean)
    : allOf(nodes, "document").sort((a, b) => b.edited - a.edited);
  const title = collection?.title || (view === "graph" ? "Graph view" : "All documents");
  return (
    <main className="listing">
      <div className="doc-kicker">
        {collection ? <FolderOpen size={15} /> : <BookOpen size={15} />}{" "}
        {collection ? "Collection" : "Notebook"}
      </div>
      <div className="listing-title">
        <h1>{title}</h1>
        {view !== "graph" && (
          <button
            className="button"
            onClick={() =>
              showDialog(
                collection ? { mode: "addMember", collection: collection.id } : { mode: "createDoc" },
              )
            }
          >
            <Plus size={15} />
            {collection ? "Add item" : "New document"}
          </button>
        )}
      </div>
      {view === "graph" ? (
        <FullGraph nodes={nodes} go={go} />
      ) : (
        <>
          <div className="section-cap count-label">
            {items.length} {collection ? "items" : "documents"}
          </div>
          <div className="library-list">
            {items.map((n) => (
              <div key={n.id}>
                <button onClick={() => go(n.id)}>
                  {n.kind === "block" ? (
                    <Text size={19} />
                  ) : n.kind === "collection" ? (
                    <FolderOpen size={19} />
                  ) : (
                    <FileText size={19} />
                  )}
                  <span>
                    <strong>{nodeTitle(n)}</strong>
                    <small>{n.kind === "document" ? n.blocks.length + " blocks" : n.kind}</small>
                  </span>
                  <ChevronRight size={16} />
                </button>
                {collection && (
                  <IconButton
                    label={"Remove " + nodeTitle(n) + " from collection"}
                    onClick={() => remove(n.id)}
                  >
                    <Minus size={15} />
                  </IconButton>
                )}
              </div>
            ))}
          </div>
          {!items.length && <p className="muted">Add a document, block, or collection to get started.</p>}
        </>
      )}
    </main>
  );
}
function Notebook() {
  const state = useSyncExternalStore(client.listen, client.snapshot);
  const search = page.useSearch(),
    navigate = page.useNavigate();
  const [dialog, setDialog] = useState(null),
    [mobile, setMobile] = useState(false),
    [inspecting, setInspecting] = useState(() => window.innerWidth >= 1150),
    [generation, setGeneration] = useState(0);
  useEffect(() => {
    client.load();
    const keys = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDialog({ mode: "search" });
      }
    };
    const unload = (e) => {
      if (client.drafts.size) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    const hidden = () => {
      if (document.hidden && client.drafts.size) client.flush().catch(() => {});
    };
    document.addEventListener("keydown", keys);
    window.addEventListener("beforeunload", unload);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      document.removeEventListener("keydown", keys);
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  const w = state.workspace;
  if (!w)
    return (
      <main className="loading">
        <img src="/mark.svg" width="44" alt="" />
        <h1>Folio</h1>
        <p>{state.error || "Opening notebook…"}</p>
        {state.error && (
          <button className="button" onClick={() => client.load()}>
            Retry
          </button>
        )}
      </main>
    );
  const nodes = w.nodes,
    view = search.view;
  const selected = view ? null : nodes[search.node || w.home],
    doc = selected?.kind === "document" ? selected : null,
    collection = selected?.kind === "collection" ? selected : null;
  const groups = doc ? allOf(nodes, "collection").filter((n) => n.members.includes(doc.id)) : [];
  const nav = (q) => {
    setMobile(false);
    if (window.innerWidth < 1150) setInspecting(false);
    navigate({ search: q });
  };
  function go(id, key) {
    const n = nodes[id] || client.state.workspace.nodes[id];
    if (!n) return;
    if (n.kind === "url") {
      window.open(n.href, "_blank", "noopener,noreferrer");
      return;
    }
    if (n.kind === "block") {
      const owner = parentsOf(nodes, id)[0];
      if (owner) nav({ node: owner.id, block: n.key });
      else setDialog({ mode: "block", blockId: id });
      return;
    }
    nav({ node: id, block: key });
  }
  return (
    <div className="app">
      <Sidebar
        workspace={w}
        verified={state.verified}
        selected={selected}
        view={view}
        nav={nav}
        go={go}
        openDialog={setDialog}
        mobile={mobile}
        close={() => setMobile(false)}
      />
      <div className="workarea">
        <header className="topbar">
          <IconButton label="Open navigation" className="mobile-nav" onClick={() => setMobile(true)}>
            <Menu size={20} />
          </IconButton>
          <nav className="crumbs" aria-label="Breadcrumb">
            <BookOpen size={16} />
            <button onClick={() => nav({ view: "documents" })}>Notebook</button>
            <ChevronRight />
            {groups[0] && (
              <>
                <button onClick={() => go(groups[0].id)}>{groups[0].title}</button>
                <ChevronRight />
              </>
            )}
            <strong>
              {doc?.title || collection?.title || (view === "graph" ? "Graph view" : "All documents")}
            </strong>
          </nav>
          <div className="top-actions">
            {doc && (
              <>
                <button className="history-btn" onClick={() => setDialog({ mode: "history" })}>
                  <History size={16} /> <span>History</span>
                </button>
                <button
                  className="button primary commit"
                  disabled={!state.verified}
                  onClick={() => setDialog({ mode: "commit" })}
                >
                  <GitCommitHorizontal size={17} /> Commit
                </button>
                <span className="divider" />
                <IconButton
                  label={inspecting ? "Hide connections" : "Show connections"}
                  onClick={() => setInspecting((v) => !v)}
                >
                  <PanelRight size={18} />
                </IconButton>
              </>
            )}
          </div>
        </header>
        {state.error && (
          <div className="error-banner" role="alert">
            {state.error}{" "}
            <button onClick={() => (client.drafts.size ? client.flush().catch(() => {}) : client.load())}>
              {client.drafts.size ? "Retry save" : "Retry sync"}
            </button>
          </div>
        )}
        <div className="panes">
          {doc ? (
            <DocumentView
              key={[parseCursor(w.cursor)?.feedId ?? w.home, doc.id, state.verified, generation].join("/")}
              readOnly={!state.verified}
              {...{ doc, nodes, go }}
              showDialog={setDialog}
              jump={search.block}
              status={state.status}
            />
          ) : (
            <Listing
              view={view}
              collection={collection}
              nodes={nodes}
              go={go}
              showDialog={setDialog}
              remove={(id) =>
                client
                  .action({ action: "member", collection: collection.id, id, remove: true })
                  .catch((e) => client.emit({ error: e.message }))
              }
            />
          )}
          {doc && inspecting && (
            <>
              <button
                className="inspect-scrim"
                aria-label="Close connections"
                onClick={() => setInspecting(false)}
              />
              <Inspector
                {...{ nodes, doc, go }}
                expand={() => nav({ view: "graph" })}
                close={() => setInspecting(false)}
                collect={() => setDialog({ mode: "collect" })}
              />
            </>
          )}
        </div>
      </div>
      {dialog && (
        <Dialog
          key={dialog.mode}
          {...{ dialog, nodes, doc, client, go, setDialog }}
          close={() => setDialog(null)}
          restored={() => setGeneration((n) => n + 1)}
        />
      )}
    </div>
  );
}
createRoot(document.getElementById("root")).render(<RouterProvider router={router} />);
