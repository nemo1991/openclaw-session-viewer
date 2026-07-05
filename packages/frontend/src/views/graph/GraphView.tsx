/**
 * GraphView — G1 Graph 视图 (搬自 experiment/embed-db/web/src/views/GraphView.tsx)
 *
 * 关键改动 (vs 实验 web 原版):
 * - imports 调整:../* → @/views/graph/* (主项目 @ 别名 + 同目录)
 * - onJumpToRag 改为 useNavigate + 读 ?view= 切到 RAG 子 tab
 * - 新增 onJumpToSession (main/subagent 都跳主项目 /session/:id)
 * - useTitles() 改读 useTitleStore() (zustand)
 * - 数据源:useGraphStore() (zustand) 替代直接 fetch
 *
 * 关键功能保留 (S5 后的 G1 补强):
 * - 节点半径 ∝ sqrt(token_total), clamp [4, 14]
 * - subagent 角色 (Explore/Design/Validate/Implement/Other) 配色
 * - 全图模式:只画 main session,subagent 折叠进详情面板
 * - 钻取模式:横轴时间线 + top-5 tool 节点
 * - error badge:红圈 + 数字显示 error_count
 * - display_title:跨视图共享
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ForceGraph2D from "react-force-graph-2d";
import type { GraphEntry, SessionNode } from "./types";
import type { GNode, GLink, SubagentRole } from "./graph-types";
import { buildForceGraph } from "./loader";
import { GraphDetailPanel } from "./GraphDetailPanel";
import { useTitleStore } from "./titleStore";
import { useGraphStore } from "./graphStore";

const ROLE_COLORS: Record<SubagentRole, string> = {
  Explore: "#10b981",
  Design: "#6366f1",
  Validate: "#f59e0b",
  Implement: "#ef4444",
  Other: "#94a3b8",
};

export function GraphView() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<GraphEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  /** 钻取:null = 全图模式;否则是 main session 的 node_id */
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const fgRef = useRef<any>(null);
  const titles = useTitleStore();

  const graphEntries = useGraphStore((s) => s.entries);
  const graphLoading = useGraphStore((s) => s.loading);
  const graphError = useGraphStore((s) => s.error);
  const graphLoad = useGraphStore((s) => s.load);

  // entries 从 zustand store 派生;store 没数据时触发 load
  useEffect(() => {
    if (graphEntries === null) {
      void graphLoad().then(() => {
        const latest = useGraphStore.getState().entries;
        if (latest) setEntries(latest);
      });
    } else {
      setEntries(graphEntries);
    }
  }, [graphEntries, graphLoad]);

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

  /** 钻取过滤:聚焦一个 main → 只显示该 main + 它的 subagent + 工具节点
   *  全图模式:只画 main session(subagent 折叠进 main 详情面板,不占 G1 视觉)
   */
  const visible = useMemo(() => {
    if (!titledNodes || !fullGraph) return null;
    if (!focusedNodeId) {
      const mainOnly = titledNodes.filter((n) => n.type !== "subagent");
      const mainIds = new Set(mainOnly.map((n) => n.id));
      const mainLinks = fullGraph.links.filter((l) => {
        const srcId = typeof l.source === "object" ? (l.source as any).id : l.source;
        const tgtId = typeof l.target === "object" ? (l.target as any).id : l.target;
        return mainIds.has(srcId) && mainIds.has(tgtId);
      });
      return {
        nodes: mainOnly,
        links: mainLinks,
        drillTime: null as null | { minTs: number; maxTs: number },
      };
    }
    const keep = new Set<string>([focusedNodeId]);
    for (const e of entries!) {
      if (e.node.node_id === focusedNodeId) {
        for (const sa of e.node.subagent_ids) keep.add(`subagent:${sa}`);
      }
    }
    const baseNodes = titledNodes.filter((n) => keep.has(n.id));
    const baseNodeIds = new Set(baseNodes.map((n) => n.id));
    const baseLinks = fullGraph.links.filter((l) => {
      const srcId = typeof l.source === "object" ? (l.source as any).id : l.source;
      const tgtId = typeof l.target === "object" ? (l.target as any).id : l.target;
      return baseNodeIds.has(srcId) && baseNodeIds.has(tgtId);
    });

    const focusedEntry = entries!.find((e) => e.node.node_id === focusedNodeId);
    const toolUsage = new Map<string, number>();
    if (focusedEntry) {
      for (const e of focusedEntry.edges) {
        if (e.type === "UsedTool") {
          toolUsage.set(e.tool_name, (toolUsage.get(e.tool_name) ?? 0) + e.count);
        }
      }
    }
    const topTools = Array.from(toolUsage.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const toolNodes: GNode[] = topTools.map(([tool, count]) => ({
      id: `tool:${focusedNodeId}:${tool}`,
      type: "tool" as any,
      label: `${tool} · ${count}`,
      radius: Math.min(6, 2 + Math.log(count + 1)),
      role: "Other" as any,
      first_timestamp_ms: focusedEntry?.node.last_timestamp_ms ?? undefined,
      token_total: count,
    }));
    const toolLinks: GLink[] = topTools.map(([tool, count]) => ({
      source: focusedNodeId,
      target: `tool:${focusedNodeId}:${tool}`,
      label: `${count}`,
      weight: Math.log(count + 1),
      edgeType: "UsedTool" as any,
    }));

    const allTs = baseNodes
      .map((n: any) => n.first_timestamp_ms)
      .filter((t: any): t is number => typeof t === "number");
    const minTs = allTs.length ? Math.min(...allTs) : 0;
    const maxTs = allTs.length ? Math.max(...allTs) : 0;

    return {
      nodes: [...baseNodes, ...toolNodes],
      links: [...baseLinks, ...toolLinks],
      drillTime: { minTs, maxTs },
    };
  }, [titledNodes, fullGraph, entries, focusedNodeId]);

  /** 布局 force 配置 */
  useEffect(() => {
    if (!fgRef.current || !visible || !entries) return;
    const d3Force = (fgRef.current as any).d3Force;
    if (!d3Force) return;

    const innerH = typeof window !== "undefined" ? window.innerHeight - 220 : 480;
    const innerW = typeof window !== "undefined" ? window.innerWidth - 32 : 800;

    if (focusedNodeId && visible.drillTime) {
      const { minTs, maxTs } = visible.drillTime;
      const span = Math.max(maxTs - minTs, 1);
      const xLeft = -innerW / 2 + 110;
      const xRight = innerW / 2 - 40;
      const xScale = (ts: number) => xLeft + ((ts - minTs) / span) * (xRight - xLeft);

      const yMain = -innerH / 2 + 90;
      const yMid = 0;
      const yTools = innerH / 2 - 70;

      d3Force("forceX", ((d: any) => {
        if (d.id === focusedNodeId) return xLeft;
        if (d.type === "tool") return null;
        const ts = d.first_timestamp_ms;
        if (typeof ts !== "number") return 0;
        return xScale(ts);
      }) as any);
      d3Force("forceY", ((d: any) => {
        if (d.id === focusedNodeId) return yMain;
        if (d.type === "tool") return yTools;
        if (d.type === "subagent") return yMid;
        return yMain;
      }) as any);
    } else {
      const allTs = visible.nodes
        .map((n: any) => n.first_timestamp_ms)
        .filter((t: any): t is number => typeof t === "number");
      if (allTs.length === 0) return;
      const minTs = Math.min(...allTs);
      const maxTs = Math.max(...allTs);
      const span = Math.max(maxTs - minTs, 1);
      const yTop = -innerH / 2 + 50;
      const yBot = innerH / 2 - 50;
      const yScale = (ts: number) => yBot - ((ts - minTs) / span) * (yBot - yTop);

      d3Force("forceX", null);
      d3Force("forceY", ((d: any) => {
        if (d.type === "main") return yTop;
        const ts = d.first_timestamp_ms;
        if (typeof ts !== "number") return yTop + 30;
        return yScale(ts);
      }) as any);
    }
    fgRef.current?.reheatSimulation?.();
  }, [visible, entries, focusedNodeId]);

  const selectedNode = useMemo(() => {
    if (!selectedId || !visible) return null;
    return visible.nodes.find((n) => n.id === selectedId) ?? null;
  }, [selectedId, visible]);

  const mainOptions = useMemo(() => {
    if (!entries) return [];
    return entries
      .filter((e) => !e.node.is_subagent_root)
      .map((e) => ({ id: e.node.node_id, node: e.node }))
      .sort((a, b) => (b.node.token_total ?? 0) - (a.node.token_total ?? 0));
  }, [entries]);

  // -------- rendering --------

  if (error) return <div className="error">{error}</div>;
  if (graphError) return <div className="error">{graphError}</div>;
  if (graphLoading || !entries || !visible || !fullGraph) {
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
            <option value="">全部 sessions ({mainOptions.length})</option>
            {mainOptions.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {titles.get(opt.id, titles.auto(opt.node))}
              </option>
            ))}
          </select>
          {focusedNodeId && (
            <button className="back-btn" onClick={() => setFocusedNodeId(null)} title="返回全图">
              全图
            </button>
          )}
        </div>
        <div className="legend">
          <span className="lg lg-main">main session</span>
          <span className="lg lg-error">节点大小 ∝ log(tokens), 红环 = 错误数</span>
          {focusedNodeId && (
            <>
              <span className="lg" style={{ color: ROLE_COLORS.Explore }}>
                Explore
              </span>
              <span className="lg" style={{ color: ROLE_COLORS.Design }}>
                Design
              </span>
              <span className="lg" style={{ color: ROLE_COLORS.Validate }}>
                Validate
              </span>
              <span className="lg" style={{ color: ROLE_COLORS.Implement }}>
                Implement
              </span>
              <span className="lg" style={{ color: ROLE_COLORS.Other }}>
                Other
              </span>
              <span className="lg" style={{ color: "#facc15" }}>
                tool(钻取内)
              </span>
            </>
          )}
        </div>
      </header>

      <div className="graph-canvas">
        <ForceGraph2D
          ref={fgRef}
          graphData={visible}
          width={typeof window !== "undefined" ? window.innerWidth - 32 : 800}
          height={typeof window !== "undefined" ? window.innerHeight - 220 : 480}
          nodeRelSize={1}
          linkColor={(l: any) => {
            if (l.edgeType === "Spawned") return "rgba(124, 58, 237, 0.55)";
            if (l.edgeType === "UsedTool") return "rgba(234, 179, 8, 0.45)";
            return "rgba(148, 163, 184, 0.4)";
          }}
          linkWidth={(l: any) => {
            if (l.edgeType === "Spawned") return 1.2;
            if (l.edgeType === "UsedTool") return Math.min(3.5, 0.5 + (l.weight ?? 1));
            return 0.6;
          }}
          cooldownTicks={120}
          enableNodeDrag={false}
          onNodeHover={(n: any) => setHover(n?.id ?? null)}
          onNodeClick={(n: any) => {
            setSelectedId(n.id);
            fgRef.current?.centerAt?.(n.x, n.y, 600);
          }}
          nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, scale: number) => {
            const r = node.radius ?? (node.type === "main" ? 6 : 4);
            let fill = "#3b82f6";
            if (node.type === "subagent") {
              const role: SubagentRole = (node.role ?? "Other") as SubagentRole;
              fill = ROLE_COLORS[role];
            } else if (node.type === "tool") {
              fill = "#facc15";
            }
            if (node.type === "tool") {
              const sz = r * 1.8;
              ctx.beginPath();
              ctx.roundRect?.(node.x - sz / 2, node.y - sz / 2, sz, sz, 4);
              if (!ctx.roundRect) ctx.rect(node.x - sz / 2, node.y - sz / 2, sz, sz);
              ctx.fillStyle = fill;
              ctx.fill();
              ctx.strokeStyle = focusedNodeId === node.id ? "#fbbf24" : "rgba(255,255,255,0.55)";
              ctx.lineWidth = focusedNodeId === node.id ? 3 : 1;
              ctx.stroke();
            } else {
              ctx.beginPath();
              ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
              ctx.fillStyle = fill;
              ctx.fill();
              ctx.strokeStyle = focusedNodeId === node.id ? "#fbbf24" : "rgba(255,255,255,0.55)";
              ctx.lineWidth = focusedNodeId === node.id ? 3 : 1;
              ctx.stroke();

              if (node.type === "main" && (node.error_count ?? 0) > 0) {
                const ec = node.error_count ?? 0;
                const errR = Math.min(5, 1.5 + Math.sqrt(ec / 8));
                const bx = node.x + r * 0.75;
                const by = node.y + r * 0.85;
                ctx.beginPath();
                ctx.arc(bx, by, errR, 0, 2 * Math.PI);
                ctx.fillStyle = "#ef4444";
                ctx.fill();
                ctx.strokeStyle = "rgba(255,255,255,0.95)";
                ctx.lineWidth = 1.5;
                ctx.stroke();
                if (errR >= 2.5) {
                  const text = ec >= 1000 ? "≥1k" : String(ec);
                  ctx.font = `bold ${Math.max(3, errR * 1.15)}px sans-serif`;
                  ctx.fillStyle = "#fff";
                  ctx.textAlign = "center";
                  ctx.textBaseline = "middle";
                  ctx.fillText(text, bx, by);
                  ctx.textAlign = "start";
                  ctx.textBaseline = "alphabetic";
                }
              }
            }

            if (node.id === hover || focusedNodeId === node.id || scale > 0.9) {
              ctx.font = `${10 / scale}px monospace`;
              ctx.fillStyle = "rgba(226, 232, 240, 0.85)";
              ctx.textBaseline = "middle";
              ctx.fillText(String(node.label).slice(0, 28), node.x + r + 3, node.y);
            }
          }}
          nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
            let r = (node.radius ?? 6) + 2;
            if (node.type === "main" && (node.error_count ?? 0) > 0) {
              const errR = Math.min(5, 1.5 + Math.sqrt((node.error_count ?? 0) / 8));
              const badgeDist = Math.hypot(r * 0.75, r * 0.85);
              r = Math.max(r, badgeDist + errR + 2);
            }
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
            ctx.fill();
          }}
        />

        <div className="time-axis-hint">
          {focusedNodeId ? (
            <span>钻取模式: main 锚定左上 · subagent 沿 X 轴按时序展开 · 工具节点(黄)在底部</span>
          ) : (
            <span>
              全图模式只显示 main session,subagent 折叠进详情面板 · 点节点 → 钻取查看子图 · 时序沿 Y
              轴自上而下
            </span>
          )}
        </div>
      </div>

      <footer className="graph-footer">
        点击节点 → 右侧详情 · 编辑可重命名(跨 G1/G2/G3 同步) · 钻取可独立显示 · G3 RAG / 会话详情
        一键跳转
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
