import React, { useLayoutEffect, useRef, useState } from "react";
import { Schema } from "prosemirror-model";
import { EditorState, Plugin, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { baseKeymap, chainCommands, setBlockType, toggleMark, splitBlockAs } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { history, undo, redo } from "prosemirror-history";
import { InputRule, inputRules, undoInputRule } from "prosemirror-inputrules";
import {
  Bold,
  Italic,
  Code2,
  Link2,
  List,
  Quote,
  Undo2,
  Redo2,
  ChevronDown,
  Plus,
  Brackets,
  Layers2,
  FolderPlus,
  Pilcrow,
} from "lucide-react";
import { blockText, emptyBlock } from "./client";

const attr = { key: { default: null } };
function block(tag, className) {
  return {
    group: "block",
    content: "inline*",
    attrs: attr,
    parseDOM: [{ tag: className ? tag + "." + className : tag }],
    toDOM: () => [tag, className ? { class: className } : {}, 0],
  };
}
export const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: block("p"),
    heading: block("h2"),
    subheading: block("h3"),
    bullet: {
      ...block("p", "bullet"),
      parseDOM: [
        { tag: "li", priority: 60 },
        { tag: "p.bullet", priority: 60 },
      ],
    },
    quote: block("blockquote"),
    embed: {
      group: "block",
      atom: true,
      attrs: { ...attr, target: {} },
      toDOM: () => ["aside", { class: "transclusion" }],
    },
    text: { group: "inline" },
    wiki: {
      group: "inline",
      inline: true,
      atom: true,
      attrs: { label: {}, target: { default: null } },
      toDOM: (node) => [
        "a",
        {
          class: "wikilink",
          "data-label": node.attrs.label,
          "data-target": node.attrs.target ?? "",
          href: node.attrs.target ? "?node=" + node.attrs.target : "#",
        },
        node.attrs.label,
      ],
      parseDOM: [
        {
          tag: "a.wikilink",
          getAttrs: (el) => ({ label: el.textContent, target: el.dataset.target || null }),
        },
      ],
    },
  },
  marks: {
    strong: { parseDOM: [{ tag: "strong" }, { tag: "b" }], toDOM: () => ["strong", 0] },
    em: { parseDOM: [{ tag: "em" }, { tag: "i" }], toDOM: () => ["em", 0] },
    code: { parseDOM: [{ tag: "code" }], toDOM: () => ["code", 0] },
    link: {
      attrs: { href: {} },
      inclusive: false,
      parseDOM: [
        { tag: "a[href]", getAttrs: (el) => (/^https?:\/\//i.test(el.href) ? { href: el.href } : false) },
      ],
      toDOM: (n) => ["a", { href: n.attrs.href, target: "_blank", rel: "noopener noreferrer" }, 0],
    },
  },
});
const labels = {
  paragraph: "Text",
  heading: "Heading",
  subheading: "Subheading",
  quote: "Quote",
  bullet: "Bullet list",
  embed: "Embed",
};
const { nodes, marks } = schema;
const wikiPat = /\[\[([^\[\]\n]{1,240})\]\]$/;
const markdownLink = /\[([^\[\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/;
function rule(regex, make) {
  return new InputRule(regex, (state, match, start, end) => state.tr.replaceWith(start, end, make(match)));
}
function parsedInline(text) {
  const parts = [],
    re = /\[\[([^\[\]\n]{1,240})\]\]|\[([^\[\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) parts.push(schema.text(text.slice(last, m.index)));
    if (m[1]) parts.push(nodes.wiki.create({ label: m[1] }));
    else parts.push(schema.text(m[2] || m[4], [marks.link.create({ href: m[3] || m[4] })]));
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(schema.text(text.slice(last)));
  return parts;
}
function moveBlock(direction) {
  return (state, dispatch) => {
    const { $from } = state.selection;
    const index = $from.index(0);
    const next = index + direction;
    if (next < 0 || next >= state.doc.childCount) return false;
    const block = state.doc.child(index);
    const start = $from.depth ? $from.before(1) : $from.pos;
    const neighbor = state.doc.child(next);
    const destination = start + direction * neighbor.nodeSize;
    if (dispatch) {
      const tr = state.tr.delete(start, start + block.nodeSize).insert(destination, block);
      tr.setSelection(TextSelection.near(tr.doc.resolve(destination + (block.isTextblock ? 1 : 0))));
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}
const plugins = [
  inputRules({
    rules: [
      ...[
        [/^# $/, "heading"],
        [/^## $/, "subheading"],
        [/^[-*] $/, "bullet"],
        [/^> $/, "quote"],
      ].map(
        ([pat, name]) =>
          new InputRule(pat, (state, _, start, end) =>
            state.tr
              .delete(start, end)
              .setBlockType(start, start, nodes[name], { key: state.selection.$from.parent.attrs.key }),
          ),
      ),
      rule(wikiPat, (m) => nodes.wiki.create({ label: m[1] })),
      rule(markdownLink, (m) => schema.text(m[1], [marks.link.create({ href: m[2] })])),
      rule(/\*\*([^*]+)\*\*$/, (m) => schema.text(m[1], [marks.strong.create()])),
      rule(/(?<!\*)\*([^*]+)\*$/, (m) => schema.text(m[1], [marks.em.create()])),
      rule(/`([^`]+)`$/, (m) => schema.text(m[1], [marks.code.create()])),
      new InputRule(/(https?:\/\/[^\s]+) $/, (state, m, start, end) =>
        state.tr.replaceWith(start, end, [
          schema.text(m[1], [marks.link.create({ href: m[1] })]),
          schema.text(" "),
        ]),
      ),
    ],
  }),
  keymap({
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
    "Mod-Shift-ArrowUp": moveBlock(-1),
    "Mod-Shift-ArrowDown": moveBlock(1),
    "Mod-b": toggleMark(marks.strong),
    "Mod-i": toggleMark(marks.em),
    Backspace: undoInputRule,
    Enter: chainCommands(
      (state, dispatch) => {
        const b = state.selection.$from.parent;
        if (b.type === nodes.paragraph || b.content.size) return false;
        return setBlockType(nodes.paragraph, { key: b.attrs.key })(state, dispatch);
      },
      splitBlockAs((node) =>
        node.type === nodes.bullet ? { type: nodes.bullet, attrs: { key: crypto.randomUUID() } } : null,
      ),
    ),
  }),
  keymap(baseKeymap),
  history(),
  new Plugin({
    appendTransaction(transactions, _, state) {
      if (!transactions.some((tr) => tr.docChanged)) return;
      const seen = new Set(),
        tr = state.tr;
      state.doc.forEach((n, pos) => {
        let key = n.attrs.key;
        if (!key || seen.has(key)) {
          key = crypto.randomUUID();
          tr.setNodeMarkup(pos, null, { ...n.attrs, key });
        }
        seen.add(key);
      });
      return tr.docChanged ? tr : undefined;
    },
  }),
];
function serialize(doc) {
  return doc.content.content.map((n) => ({
    key: n.attrs.key,
    type: n.type.name,
    content: n.content.toJSON() ?? [],
    ...(n.type === nodes.embed ? { target: n.attrs.target } : {}),
  }));
}
const makeDoc = (blocks) =>
  nodes.doc.create(
    null,
    blocks.map((b) =>
      nodes[b.type].create(
        { key: b.key, target: b.target },
        b.content.map((s) => schema.nodeFromJSON(s)),
      ),
    ),
  );
function Tool({ name, icon: Icon, onClick, active }) {
  return (
    <button
      type="button"
      className={"tool" + (active ? " active" : "")}
      title={name}
      aria-label={name}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon size={16} />
    </button>
  );
}
export function Editor({ initial, graph, onEdit, onLink, onDialog, jump, docId, readOnly }) {
  const mount = useRef(null),
    view = useRef(null),
    latest = useRef({});
  latest.current = { onEdit, onLink, graph };
  const [, tick] = useState(0),
    [menu, setMenu] = useState("");
  useLayoutEffect(() => {
    const editor = new EditorView(mount.current, {
      state: EditorState.create({ doc: makeDoc(initial), plugins }),
      editable: () => !readOnly,
      attributes: {
        role: "textbox",
        "aria-label": "Document blocks",
        "aria-multiline": "true",
        spellcheck: "true",
      },
      dispatchTransaction(tr) {
        const next = this.state.apply(tr);
        this.updateState(next);
        if (tr.docChanged) latest.current.onEdit(serialize(next.doc));
        tick((n) => n + 1);
      },
      handleClick(view, pos, evt) {
        const anchor = evt.target.closest("a");
        if (!anchor) return false;
        evt.preventDefault();
        if (anchor.classList.contains("wikilink"))
          latest.current.onLink(anchor.dataset.target, anchor.dataset.label);
        else if (/^https?:\/\//.test(anchor.href)) window.open(anchor.href, "_blank", "noopener,noreferrer");
        return true;
      },
      handlePaste(view, evt) {
        const value = evt.clipboardData?.getData("text/plain");
        if (!value || evt.clipboardData.getData("text/html") || !/\[\[|https?:\/\//.test(value)) return false;
        const lines = value.split(/\r?\n/);
        const content =
          lines.length === 1
            ? parsedInline(value)
            : lines.map((l) => nodes.paragraph.create({ key: crypto.randomUUID() }, parsedInline(l)));
        view.dispatch(
          view.state.tr
            .replaceWith(view.state.selection.from, view.state.selection.to, content)
            .scrollIntoView(),
        );
        return true;
      },
      nodeViews: {
        embed(node) {
          const dom = document.createElement("aside");
          dom.className = "transclusion";
          dom.contentEditable = "false";
          dom.dataset.target = node.attrs.target;
          dom.textContent = blockText(latest.current.graph[node.attrs.target]) || "Empty block";
          return { dom };
        },
      },
    });
    view.current = editor;
    tick((n) => n + 1);
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    mount.current.querySelectorAll("aside.transclusion").forEach((el) => {
      el.textContent = blockText(graph[el.dataset.target]) || "Empty block";
    });
  }, [graph]);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!jump || !editor) return;
    editor.state.doc.forEach((n, pos) => {
      if (n.attrs.key === jump && n.isTextblock) {
        editor.dispatch(
          editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos + 1)).scrollIntoView(),
        );
        editor.focus();
      }
    });
  }, [jump]);
  const editor = view.current,
    parent = editor?.state.selection.$from.parent;
  const run = (cmd) => {
    if (editor) {
      cmd(editor.state, editor.dispatch, editor);
      editor.focus();
    }
    setMenu("");
  };
  function chooseBlock(name) {
    run((state, dispatch) => {
      const { from, to } = state.selection;
      dispatch(state.tr.setBlockType(from, to, nodes[name], (block) => ({ key: block.attrs.key })));
    });
  }
  function insertInline(node) {
    const v = view.current;
    if (v) {
      v.dispatch(v.state.tr.replaceSelectionWith(node, false).scrollIntoView());
      v.focus();
    }
  }
  function launch(mode) {
    setMenu("");
    const v = view.current;
    const block = graph[docId]?.blocks
      .map((id) => graph[id])
      .find((b) => b.key === v.state.selection.$from.parent.attrs.key);
    onDialog({
      mode,
      blockId: block?.id,
      blockKey: v.state.selection.$from.parent.attrs.key,
      apply(value) {
        if (mode === "wiki") insertInline(nodes.wiki.create({ label: value.title, target: value.id }));
        if (mode === "web") {
          const { from, to } = v.state.selection;
          const label = v.state.doc.textBetween(from, to) || value;
          insertInline(schema.text(label, [marks.link.create({ href: value })]));
        }
        if (mode === "embed") {
          const at = v.state.selection.$from.depth ? v.state.selection.$from.after(1) : v.state.selection.to;
          v.dispatch(
            v.state.tr
              .insert(at, nodes.embed.create({ key: crypto.randomUUID(), target: value.id }))
              .scrollIntoView(),
          );
          v.focus();
        }
      },
    });
  }
  const activeMark = (name) =>
    !!editor &&
    (marks[name].isInSet(editor.state.storedMarks ?? editor.state.selection.$from.marks()) ||
      editor.state.doc.rangeHasMark(editor.state.selection.from, editor.state.selection.to, marks[name]));
  return (
    <>
      <div
        className="toolbar"
        inert={readOnly}
        role="toolbar"
        aria-label="Document formatting"
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setMenu("");
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setMenu("");
        }}
      >
        <div className="menubase">
          <button
            className="type-select"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMenu(menu === "type" ? "" : "type")}
          >
            {labels[parent?.type.name] || "Text"} <ChevronDown size={13} />
          </button>
          {menu === "type" && (
            <div className="popmenu">
              {Object.entries(labels)
                .filter(([k]) => k !== "embed")
                .map(([k, l]) => (
                  <button key={k} onMouseDown={(e) => e.preventDefault()} onClick={() => chooseBlock(k)}>
                    {l}
                  </button>
                ))}
              {[-1, 1].map((direction) => (
                <button
                  key={direction}
                  disabled={!editor || !moveBlock(direction)(editor.state)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => run(moveBlock(direction))}
                >
                  Move block {direction === -1 ? "up" : "down"}
                </button>
              ))}
            </div>
          )}
        </div>
        <i />
        <Tool
          name="Bold (⌘/Ctrl B)"
          icon={Bold}
          active={activeMark("strong")}
          onClick={() => run(toggleMark(marks.strong))}
        />
        <Tool
          name="Italic (⌘/Ctrl I)"
          icon={Italic}
          active={activeMark("em")}
          onClick={() => run(toggleMark(marks.em))}
        />
        <Tool
          name="Inline code"
          icon={Code2}
          active={activeMark("code")}
          onClick={() => run(toggleMark(marks.code))}
        />
        <i />
        <Tool
          name="Bullet list"
          icon={List}
          onClick={() => chooseBlock(parent?.type === nodes.bullet ? "paragraph" : "bullet")}
        />
        <Tool
          name="Block quote"
          icon={Quote}
          onClick={() => chooseBlock(parent?.type === nodes.quote ? "paragraph" : "quote")}
        />
        <Tool name="Insert web link" icon={Link2} onClick={() => launch("web")} />
        <i />
        <div className="menubase">
          <button
            className="insert"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setMenu(menu === "insert" ? "" : "insert")}
          >
            <Plus size={15} /> Insert
          </button>
          {menu === "insert" && (
            <div className="popmenu">
              {[
                [Brackets, "Wikilink", "wiki"],
                [Layers2, "Embed a block", "embed"],
                [FolderPlus, "Collect this block", "collectBlock"],
              ].map(([Icon, label, key]) => (
                <button key={key} onMouseDown={(e) => e.preventDefault()} onClick={() => launch(key)}>
                  <Icon size={15} />
                  {label}
                </button>
              ))}
              <button
                onClick={() => {
                  const v = view.current;
                  const tr = v.state.tr.insert(
                    v.state.doc.content.size,
                    nodes.paragraph.create({ key: emptyBlock().key }),
                  );
                  v.dispatch(tr.setSelection(TextSelection.atEnd(tr.doc)).scrollIntoView());
                  v.focus();
                  setMenu("");
                }}
              >
                <Pilcrow size={15} />
                Paragraph
              </button>
            </div>
          )}
        </div>
        <span className="spacer" />
        <Tool name="Undo" icon={Undo2} onClick={() => run(undo)} />
        <Tool name="Redo" icon={Redo2} onClick={() => run(redo)} />
      </div>
      <div className="editor-mount" ref={mount} />
    </>
  );
}
