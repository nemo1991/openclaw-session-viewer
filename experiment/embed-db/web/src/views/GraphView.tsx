/**
 * GraphView — S5 (G1 补强版)
 *
 * 关键改动:
 * - 节点半径 ∝ sqrt(token_total),clamp [4, 14]
 * - subagent 角色 (Explore/Design/Validate/Implement/Other) 配色区分
 * - 时序纵轴:subagent 按 first_timestamp_ms 沿 Y 排开,main 钉顶部
 * - 钻取模式:header 下拉选 main session → 画面只看该 session 子图
 * - 节点点击 → 右侧 GraphDetailPanel
 * - error badge:红圈在 main 节点旁,半径 ∝ error_count
 * - display_title:标题跟 useTitles 走,跨视图共享
 */

import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { GraphEntry, SessionNode } from "../types";
import type { GNode, SubagentRole } from "../graph-types";
import { buildForceGraph, loadNdjson } from "../loader";
import { GraphDetailPanel } from "./GraphDetailPanel";
import { useTitles } from "../titleStore";

const NDJSON_URL = "/sessions.ndjson";

const ROLE_COLORS: Record<SubagentRole, string> = {
  Explore: "#10b981",
  Design: "#6366f1",
  Validate: "#f59e0b",
  Implement: "#ef4444",
  Other: "#94a3b8",
};

export function GraphView() {
  const [entries, setEntries] = useState<GraphEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  /** 钻取:null = 全图模式;否则是 main session 的 node_id */
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const fgRef = useRef<any>(null);
  const titles = useTitles();

  useEffect(() => {
    loadNdjson(NDJSON_URL)
      .then(setEntries)
      .catch((e) => setError(String(e)));
  }, []);

  /** 全图 — 全 node / 全 link */
  const fullGraph = useMemo(() => {
    if (!entries) return null;
    return buildForceGraph(entries);
  }, [entries]);

  /** 给 nodes 写 display_title (override > auto) */
  const titledNodes = useMemo<GNode[] | null>(() => {
    if (!fullGraph || !entries) return null;
    const sessionById = new Map<string, SessionNode>();
    for (const e of entries) sessionById.set(e.node.node_id, e.node);
    return fullGraph.nodes.map((n) => {
      const sess = sessionById.get(n.id);
      if (!sess) return n;
      return {
        ...n,
        label: titles.get(n.id, titles.auto(sess)),
      };
    });
  }, [fullGraph, entries, titles]);

  /** 钻取过滤:聚焦一个 main → 只显示该 main + 它的 subagent */
  const visible = useMemo(() => {
    if (!titledNodes || !fullGraph) return null;
    if (!focusedNodeId) {
      return { nodes: titledNodes, links: fullGraph.links };
    }
    const keep = new Set<string>([focusedNodeId]);
    for (const e of entries!) {
      if (e.node.node_id === focusedNodeId) {
        for (const sa of e.node.subagent_ids) keep.add(`subagent:${sa}`);
      }
    }
    const nodes = titledNodes.filter((n) => keep.has(n.id));
    const nodeIds = new Set(nodes.map((n) => n.id));
    const links = fullGraph.links.filter((l) => {
      const srcId = typeof l.source === "object" ? (l.source as any).id : l.source;
      const tgtId = typeof l.target === "object" ? (l.target as any).id : l.target;
      return nodeIds.has(srcId) && nodeIds.has(tgtId);
    });
    return { nodes, links };
  }, [titledNodes, fullGraph, entries, focusedNodeId]);

  /** 布局 force 配置 — 时序纵轴 + focused 钉中心 */
  useEffect(() => {
    if (!fgRef.current || !visible || !entries) return;
    const allTs = visible.nodes
      .map((n: any) => n.first_timestamp_ms)
      .filter((t: any): t is number => typeof t === "number");
    if (allTs.length === 0) return;
    const minTs = Math.min(...allTs);
    const maxTs = Math.max(...allTs);
    const span = Math.max(maxTs - minTs, 1);
    const innerH = typeof window !== "undefined" ? window.innerHeight - 220 : 480;
    const yTop = -innerH / 2 + 50;
    const yBot = innerH / 2 - 50;
    const yScale = (ts: number) => yBot - ((ts - minTs) / span) * (yBot - yTop);

    const focalY = focusedNodeId ? 0 : yTop;

    // 用 d3-force 的 forceX / forceY — react-force-graph 暴露 d3Force(name, fn)
    // 引用 d3-force (依赖已存在,通过 react-force-graph-2d)
    const d3Force = (fgRef.current as any).d3Force;
    if (!d3Force) return;
    // forceX — focused 钉 0,其他 弱拉力
    d3Force("forceX", ((d: any) => {
      if (d.id === focusedNodeId) return 0;
      return null;
    }) as any);
    // forceY — main 在顶部 / focused 在中央;subagent 按 timestamp
    d3Force("forceY", ((d: any) => {
      if (d.id === focusedNodeId) return 0;
      if (d.type === "main") return focalY;
      const ts = d.first_timestamp_ms;
      if (typeof ts !== "number") return focalY + 30;
      return yScale(ts);
    }) as any);
    // 重新加热让新 force 生效
    fgRef.current?.reheatSimulation?.();
  }, [visible, entries, focusedNodeId]);

  /** 选中节点的 entry (供详情面板用) */
  const selectedNode = useMemo(() => {
    if (!selectedId || !visible) return null;
    return visible.nodes.find((n) => n.id === selectedId) ?? null;
  }, [selectedId, visible]);

  /** main session 选项(下拉)— 按 token_total desc */
  const mainOptions = useMemo(() => {
    if (!entries) return [];
    return entries
      .filter((e) => !e.node.is_subagent_root)
      .map((e) => ({ id: e.node.node_id, node: e.node }))
      .sort((a, b) => (b.node.token_total ?? 0) - (a.node.token_total ?? 0));
  }, [entries]);

  // -------- rendering --------

  if (error) return <div className="error">❌ {error}</div>;
  if (!entries || !visible || !fullGraph) {
    return <div className="loading">加载 sessions.ndjson ...</div>;
  }

  return (
    <div className="graph-view">
      <header className="graph-header">
        <h2>
          G1 Graph · {visible.nodes.length} 节点 / {visible.links.length} 边
          {focusedNodeId &&
            ` · 钻取「${titles.get(
              focusedNodeId,
              titles.auto(entries.find((e) => e.node.node_id === focusedNodeId)!.node)
            )}」`}
        </h2>
        <div className="graph-header-right">
          <select
            className="session-select"
            value={focusedNodeId ?? ""}
            onChange={(e) => setFocusedNodeId(e.target.value === "" ? null : e.target.value)}
            aria-label="选择钻取的 session"
          >
            <option value="">📍 全部 sessions ({mainOptions.length})</option>
            {mainOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {titles.get(opt.id, titles.auto(opt.node))}
              </option>
            ))}
          </select>
          {focusedNodeId && (
            <button className="back-btn" onClick={() => setFocusedNodeId(null)} title="返回全图">
              ↩️ 全图
            </button>
          )}
        </div>
        <div className="legend">
          <span className="lg lg-main">● main session</span>
          <span className="lg" style={{ color: ROLE_COLORS.Explore }}>
            ● Explore
          </span>
          <span className="lg" style={{ color: ROLE_COLORS.Design }}>
            ● Design
          </span>
          <span className="lg" style={{ color: ROLE_COLORS.Validate }}>
            ● Validate
          </span>
          <span className="lg" style={{ color: ROLE_COLORS.Implement }}>
            ● Implement
          </span>
          <span className="lg" style={{ color: ROLE_COLORS.Other }}>
            ● Other
          </span>
          <span className="lg lg-error">● ∝ token·err</span>
        </div>
      </header>

      <div className="graph-canvas">
        <ForceGraph2D
          ref={fgRef}
          graphData={visible}
          width={typeof window !== "undefined" ? window.innerWidth - 32 : 800}
          height={typeof window !== "undefined" ? window.innerHeight - 220 : 480}
          nodeRelSize={1}
          linkColor={(l: any) =>
            l.edgeType === "Spawned" ? "rgba(124, 58, 237, 0.55)" : "rgba(148, 163, 184, 0.4)"
          }
          linkWidth={(l: any) => (l.edgeType === "Spawned" ? 1.2 : 0.6)}
          cooldownTicks={120}
          enableNodeDrag={false}
          onNodeHover={(n: any) => setHover(n?.id ?? null)}
          onNodeClick={(n: any) => {
            setSelectedId(n.id);
            fgRef.current?.centerAt?.(n.x, n.y, 600);
          }}
          nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, scale: number) => {
            const r = node.radius ?? (node.type === "main" ? 6 : 4);
            // 颜色
            let fill = "#3b82f6"; // main
            if (node.type === "subagent") {
              const role: SubagentRole = (node.role ?? "Other") as SubagentRole;
              fill = ROLE_COLORS[role];
            }
            // 主体圆
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            ctx.fillStyle = fill;
            ctx.fill();
            ctx.strokeStyle = focusedNodeId === node.id ? "#fbbf24" : "rgba(255,255,255,0.55)";
            ctx.lineWidth = focusedNodeId === node.id ? 3 : 1;
            ctx.stroke();

            // error badge — 只对 main,error_count > 0 才画
            if (node.type === "main" && (node.error_count ?? 0) > 0) {
              const errR = Math.min(8, 2 + Math.sqrt((node.error_count ?? 0) / 4));
              ctx.beginPath();
              ctx.arc(node.x + r, node.y - r, errR, 0, 2 * Math.PI);
              ctx.fillStyle = "#ef4444";
              ctx.fill();
              ctx.strokeStyle = "rgba(255,255,255,0.7)";
              ctx.lineWidth = 1;
              ctx.stroke();
            }

            // label
            if (node.id === hover || focusedNodeId === node.id || scale > 1.4) {
              ctx.font = `${11 / scale}px monospace`;
              ctx.fillStyle = "#fff";
              ctx.textBaseline = "middle";
              ctx.fillText(String(node.label).slice(0, 32), node.x + r + 4, node.y);
            }
          }}
          nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
            const r = (node.radius ?? 6) + 2;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            ctx.fill();
          }}
        />

        <div className="time-axis-hint">
          {focusedNodeId ? (
            <span>⏱ 聚焦中央 · 子任务沿 Y 轴按时序展开</span>
          ) : (
            <span>⏱ main 在顶部 · subagent 沿 Y 轴按时序展开</span>
          )}
        </div>
      </div>

      <footer className="graph-footer">
        👆 点击节点 → 右侧面板 · ✏️ 可重命名(跨 G1/G2/G3 同步) · 🔍 可独立显示该 session
      </footer>

      {selectedNode && (
        <GraphDetailPanel
          node={selectedNode}
          entries={entries}
          onClose={() => setSelectedId(null)}
          onDrillDown={(id) => setFocusedNodeId(id)}
          isDrilledIntoThis={focusedNodeId === selectedNode.id}
        />
      )}
    </div>
  );
}
