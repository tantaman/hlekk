import React from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  FileText,
  Globe,
  Link2,
  Network,
  PanelRightClose,
  Maximize2,
  Plus,
  ChevronRight,
  FolderClosed,
} from "lucide-react";
import { allOf, blockText, nodeTitle, parentsOf } from "./client";

export function connections(nodes, doc) {
  const out = new Map(),
    back = [];
  for (const id of doc.blocks) {
    const block = nodes[id];
    for (const target of [...block.links, ...block.embeds]) {
      if (nodes[target]) out.set(target, nodes[target]);
    }
  }
  const own = new Set([doc.id, ...doc.blocks]);
  for (const b of allOf(nodes, "block")) {
    if (![...b.links, ...b.embeds].some((id) => own.has(id))) continue;
    for (const parent of parentsOf(nodes, b.id)) back.push({ parent, block: b });
  }
  return { out: [...out.values()], back };
}
const positions = [
  [64, 38],
  [206, 46],
  [54, 132],
  [205, 130],
  [134, 150],
  [132, 22],
];
function pointLabel(n, max = 19) {
  const label = nodeTitle(n);
  return label.length > max ? label.slice(0, max - 1).trimEnd() + "…" : label;
}
export function LocalGraph({ nodes, doc, go, expand }) {
  const { out, back } = connections(nodes, doc);
  const neighbors = [
    ...new Map(
      [...out, ...back.map((b) => b.parent)].filter((n) => n.id !== doc.id).map((n) => [n.id, n]),
    ).values(),
  ].slice(0, positions.length);
  return (
    <div className="graph-preview">
      <button className="graph-expand" title="Open graph view" aria-label="Open graph view" onClick={expand}>
        <Maximize2 size={13} />
      </button>
      <svg viewBox="0 0 268 168" role="img" aria-label={"Local graph for " + doc.title}>
        {neighbors.map((n, i) => (
          <line
            key={n.id}
            x1="134"
            y1="82"
            x2={positions[i][0]}
            y2={positions[i][1]}
            stroke={i % 2 ? "#a7b69d" : "#849e85"}
            strokeWidth="1.1"
            strokeDasharray={out.includes(n) ? undefined : "3 3"}
          />
        ))}
        {neighbors.map((n, i) => (
          <g
            key={n.id}
            role="link"
            tabIndex="0"
            aria-label={nodeTitle(n)}
            onClick={() => go(n.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go(n.id);
            }}
          >
            <title>{nodeTitle(n)}</title>
            <circle cx={positions[i][0]} cy={positions[i][1]} r="11" fill="transparent" />
            <circle
              cx={positions[i][0]}
              cy={positions[i][1]}
              r={i % 2 ? 4.7 : 5.8}
              fill={out.includes(n) ? "#89a783" : "#b4bba5"}
              stroke="#fcfcf8"
              strokeWidth="1.5"
            />
            <text x={positions[i][0]} y={positions[i][1] + 17} textAnchor="middle">
              {pointLabel(n, 16)}
            </text>
          </g>
        ))}
        <circle cx="134" cy="82" r="12" fill="#d5e3cf" />
        <circle cx="134" cy="82" r="7.7" fill="#406b4d" stroke="#fff" strokeWidth="1.5" />
        <text x="134" y="103" textAnchor="middle" className="central-label">
          {pointLabel(doc)}
        </text>
      </svg>
    </div>
  );
}
export function Inspector({ nodes, doc, go, close, expand, collect }) {
  const { out, back } = connections(nodes, doc);
  const groups = allOf(nodes, "collection").filter((c) => c.members.includes(doc.id));
  return (
    <aside className="inspector">
      <div className="inspector-head">
        <Network size={17} />
        <h2>Connections</h2>
        <button className="icon mobile-only" onClick={close} aria-label="Close connections">
          <PanelRightClose size={16} />
        </button>
      </div>
      <div className="inspect-section map-section">
        <div className="section-cap">Local graph</div>
        <LocalGraph {...{ nodes, doc, go, expand }} />
      </div>
      <section className="inspect-section">
        <h3>
          <ArrowUpRight size={16} /> Outgoing links <em>{out.length}</em>
        </h3>
        {out.map((n) => (
          <button key={n.id} className="link-row" onClick={() => go(n.id)}>
            {n.kind === "url" ? <Globe /> : <FileText />}
            <span>{nodeTitle(n)}</span>
            <ChevronRight className="end" />
          </button>
        ))}
        {!out.length && <p className="muted">Type [[a document title]] to link a thought.</p>}
      </section>
      <section className="inspect-section">
        <h3>
          <ArrowDownLeft size={16} /> Backlinks <em>{back.length}</em>
        </h3>
        {back.map(({ parent, block }) => (
          <button key={parent.id + block.id} className="backlink" onClick={() => go(parent.id, block.key)}>
            <strong>
              <FileText size={14} />
              {parent.title}
            </strong>
            <span>{blockText(block)}</span>
          </button>
        ))}
        {!back.length && <p className="muted">Links to this document will appear here.</p>}
      </section>
      <section className="inspect-section">
        <h3>
          <FolderClosed size={15} /> Collections{" "}
          <button className="icon" title="Add to collection" aria-label="Add to collection" onClick={collect}>
            <Plus size={15} />
          </button>
        </h3>
        {groups.map((c) => (
          <button className="collection-tag" key={c.id} onClick={() => go(c.id)}>
            <span className="group-dot" />
            {c.title}
          </button>
        ))}
        {!groups.length && (
          <button className="text-btn" onClick={collect}>
            <Link2 size={13} /> Add to a collection
          </button>
        )}
      </section>
    </aside>
  );
}
export function FullGraph({ nodes, go }) {
  const docs = allOf(nodes, "document"),
    urls = allOf(nodes, "url"),
    list = [...docs, ...urls];
  const h = Math.max(420, list.length * 38),
    center = { x: 420, y: h / 2 };
  const coords = new Map(
    list.map((d, i) => [
      d.id,
      {
        x: center.x + Math.cos((i * 2 * Math.PI) / list.length - 1.4) * 266,
        y: center.y + Math.sin((i * 2 * Math.PI) / list.length - 1.4) * (h / 2 - 62),
      },
    ]),
  );
  return (
    <svg className="full-graph" viewBox={"0 0 840 " + h} aria-label="Document link graph">
      {docs.flatMap((d) =>
        connections(nodes, d).out.map((n) => {
          const a = coords.get(d.id),
            b = coords.get(n.id);
          return (
            b && (
              <line key={d.id + n.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#a5b69d" strokeWidth="2" />
            )
          );
        }),
      )}
      {list.map((n) => {
        const p = coords.get(n.id);
        return (
          <g
            key={n.id}
            tabIndex="0"
            role="link"
            aria-label={nodeTitle(n)}
            onClick={() => go(n.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter") go(n.id);
            }}
          >
            <circle cx={p.x} cy={p.y} r="14" fill="#dbe8d5" />
            <circle cx={p.x} cy={p.y} r="8" fill="#527458" />
            <text x={p.x} y={p.y + 32} textAnchor="middle">
              {pointLabel(n, 32)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
