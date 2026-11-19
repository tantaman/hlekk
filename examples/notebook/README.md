# Folio

Folio is a single-user writing notebook built with TanStack Router, React, ProseMirror, and Hlekk’s file-backed Node adapter.

## Run locally

Use Node.js 24 or newer. From the repository root, run:

```sh
cd examples/notebook
npm ci
npm run dev
```

Open [the notebook](http://127.0.0.1:5173). The first run creates a small linked notebook. Drafts, graph edges, and commits persist in `.local/notebook/` inside this example. Set `NOTEBOOK_DIR` to choose a different directory and `PORT` to change the port. Run one server per directory.

To serve a production build locally, run `npm run build` followed by `npm start`. Run `npm test` for persistence, concurrency, and revision checks.

## Write and connect

- Edit the title or write directly in the document. Enter splits a block. The block-type menu lets you move a block up or down while keeping its links and collection memberships. The toolbar supports headings, lists, quotes, inline formatting, and links.
- At the start of a block, type `# `, `## `, `- `, or `> ` for a heading, subheading, bullet, or quote. Use `**bold**`, `*italic*`, or backticks for inline formatting.
- Type `[[Document title]]` to link a document. A new title creates a document when the draft saves. Use `[label](https://example.com)` or the link button for a web link.
- Open **Connections** to follow outbound links and backlinks. A backlink opens the source block. **Graph view** shows connections across documents. Search with ⌘K or Ctrl+K.
- Use **Insert → Embed a block** to transclude an existing text block. **Collect this block** adds the selected block to a collection. Collections can also hold documents, URLs, and other collections.
- Use **Commit** to name a revision. **History → Restore** replaces the draft with that revision’s title, block identities, order, formatting, and links. An embed retains its reference and continues to show the source block’s current contents.

## Quick thoughts and activity

Open **Quick thoughts**, write with the same Markdown shortcuts and wikilinks as the document editor, then press **Post thought** or ⌘/Ctrl+Enter. The first nonempty block supplies the title. **Open document** lets you rename, expand, collect, or commit the same document. The composer keeps unfinished text in the current browser tab.

**Activity feed** shows recent posts, document edits, commits, restores, and collection changes. Select an entry to open its document or collection. Consecutive autosaves to the same document share one entry while they are less than five minutes apart. Upgrading an existing notebook imports each document’s last recorded edit and its named commits.

The navigation toggle beside the breadcrumb collapses or expands the desktop sidebar. Folio remembers the preference in this browser.

## Hlekk model

The catalog in [server/store.mjs](server/store.mjs) uses a common notebook node type with a kind and a structured payload. This allows a collection’s membership edge to target different kinds of node. Each text or embed block has a stable Hlekk ID.

| Edge | From | To |
| --- | --- | --- |
| `blocks` | Document | Block, ordered by position |
| `links` | Block | Linked document or URL |
| `embeds` | Embed block | Source block |
| `members` | Collection | Collected node |
| `history` | Document | Named revision |
| `activity` | Workspace | Timestamped activity entry |
| `registry` | Workspace | Notebook content node |

Removing a block from a document detaches the composition edge. A collection, embed, or restored revision can still use the block’s identity. A commit stores an immutable copy of the document’s block values on a revision node. Autosave updates the working nodes and reconciles their edges.

The local server serializes commands and checks the document version before applying a save or restore. A pending multi-write operation is recorded in Hlekk and replayed on recovery. The browser loads the notebook graph into memory for search, backlinks, and navigation. This example is sized for a personal notebook.

## Incremental sync

The first visit fetches `GET /api/workspace`. It returns the current graph and an opaque `cursor` from the same serialized read. Folio stores the nodes and cursor in IndexedDB. On a return visit, the cached graph opens immediately for reading and search. Editing becomes available once the server confirms the workspace. Autosaves and other commands refresh through the same feed. Unsynced edits live in memory.

`GET /api/changes?after=<encoded cursor>` returns `{ cursor, patches }`. Each patch is keyed by node ID. A `value` field replaces that node’s payload. A `blocks`, `links`, `embeds`, or `members` field replaces the entire ordered list, including an empty list. Omitted fields keep their cached values. New nodes start with empty lists. The browser persists changed nodes and the new cursor together in one transaction. An up-to-date cursor yields empty patches. A cursor belonging to a different notebook or ahead of the server returns HTTP 409 and triggers a fresh snapshot.

Hlekk keeps one timestamped marker edge per changed node value or outgoing list. A later edit moves its marker, so catching up after many edits to the same block transfers its current contents once. The recovery journal publishes the sequence after both the graph mutations and their markers land. Existing notebooks acquire a cursor on first open after upgrading. Named revisions continue to load through the history endpoint.
