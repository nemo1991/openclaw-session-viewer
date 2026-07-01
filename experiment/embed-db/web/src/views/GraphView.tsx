/**
 * GraphView — S1 G1 PoC
 *
 * 数据流:
 * 1. fetch /sessions.ndjson
 * 2. buildForceGraph → {nodes, links}
 * 3. react-force-graph-2d 渲染
 *
 * 节点配色:
 * - main session: 蓝
 * - subagent: 紫 (Explore) / 绿 (Plan) / 橙 (general-purpose) / 灰 (其他)
 *
 * 边:
 * - Spawned: 实线(主→子)
 *
 * 交互:
 * - hover: 显示完整 prompt + token + workspace
 * - click: console.log 节点 (后续接跳转到 main 项目的 subagent 详情)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { GraphEntry } from "../types";
import { buildForceGraph, loadNdjson } from "../loader";

const NDJSON_URL = "/sessions.ndjson";

export function GraphView() {
  const [entries, setEntries] = useState<GraphEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const fgRef = useRef<any>(null);

  useEffect(() => {
    loadNdjson(NDJSON_URL)
      .then(setEntries)
      .catch((e) => setError(String(e)));
  }, []);

  const graph = useMemo(() => {
    if (!entries) return null;
    const g = buildForceGraph(entries);
    return g;
  }, [entries]);

  if (error) {
    return <div className="error">❌ {error}</div>;
  }
  if (!entries || !graph) {
    return <div className="loading">加载 sessions.ndjson ...</div>;
  }

  return (
    <div className="graph-view">
      <header className="graph-header">
        <h2>
          G1 Graph — {graph.nodes.length} 节点 / {graph.links.length} 边
        </h2>
        <div className="legend">
          <span className="lg lg-main">● main session</span>
          <span className="lg lg-sub">● subagent</span>
        </div>
      </header>
      <div className="graph-canvas">
        <ForceGraph2D
          ref={fgRef}
          graphData={graph}
          width={typeof window !== "undefined" ? window.innerWidth - 32 : 800}
          height={typeof window !== "undefined" ? window.innerHeight - 180 : 600}
          nodeLabel={(n: any) =>
            `<div style="font-size:12px">
              <b>${n.label}</b><br/>
              ${
                n.type === "main"
                  ? `model: ${n.primary_model ?? "?"} · tokens: ${n.token_total?.toLocaleString() ?? "?"} · subagents: ${n.subagent_count ?? 0}<br/>`
                  : ""
              }
              ${n.workspace ? `workspace: ${n.workspace}<br/>` : ""}
              ${n.description ? `desc: ${n.description}` : ""}
            </div>`
          }
          linkColor={(l: any) => {
            return l.edgeType === "Spawned" ? "#7c3aed" : "#94a3b8";
          }}
          linkWidth={(l: any) => (l.edgeType === "Spawned" ? 1.2 : 0.6)}
          nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, scale: number) => {
            const r = node.type === "main" ? 6 : 4;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            ctx.fillStyle =
              node.type === "main" ? "#3b82f6" : node.description ? "#a855f7" : "#94a3b8";
            ctx.fill();
            ctx.strokeStyle = "rgba(255,255,255,0.5)";
            ctx.lineWidth = 1;
            ctx.stroke();

            // label
            if (node.id === hover) {
              ctx.font = `${12 / scale}px monospace`;
              ctx.fillStyle = "#fff";
              ctx.fillText(node.label, node.x + r + 2, node.y + 4);
            }
          }}
          onNodeHover={(n: any) => {
            setHover(n?.id ?? null);
          }}
        />
      </div>
      <footer className="graph-footer">
        鼠标 hover 节点 → 看完整 prompt / token 数 / description
        <br />
        节点配色:蓝=main / 紫=有 description 的 subagent / 灰=其他 subagent / 紫边=Spawned
      </footer>
    </div>
  );
}
