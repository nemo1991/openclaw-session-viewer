/**
 * AnalyticsView — G2 Analytics (搬自 experiment/embed-db/web)
 *
 * 6 个 chart + 时间范围切换 (24h/7d/30d/all)
 *
 * 数据源:useGraphStore (zustand) — 跟 GraphView 共享 entries
 * 标题:useTitleStore (zustand) — 跟 GraphView/RagChat 共享 override
 *
 * 改进(本轮优化):
 * - 加 success rate / avg duration KPI
 * - 加 chart 7 (errors_by_workspace) + chart 8 (tools_by_category)
 * - token top 表行可点击 → 跳 /session/:id
 * - chart 1 (per day × source) 当只有 1 个 source 时给提示
 * - 范围切 24h/7d/30d/all 加每个范围的命中数 badge
 * - 去 emoji (❌)
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { GraphEntry, SessionNode } from "./types";
import {
  errorsByWorkspace,
  formatDate,
  formatNum,
  modelAvgThinking,
  retryRateDistribution,
  sessionsByDay,
  subagentChainDist,
  summary,
  tokenTopN,
  toolsByCategory,
  topToolsBar,
  type Range,
} from "./analytics";
import { useTitleStore } from "./titleStore";
import { useGraphStore } from "./graphStore";
import "./AnalyticsView.css";

const RANGES: { key: Range; label: string }[] = [
  { key: "all", label: "all" },
  { key: "24h", label: "最近 24h" },
  { key: "7d", label: "最近 7 天" },
  { key: "30d", label: "最近 30 天" },
];

const PIE_COLORS = ["#3b82f6", "#a855f7", "#f59e0b", "#22c55e", "#ef4444", "#06b6d4"];

export function AnalyticsView() {
  const [range, setRange] = useState<Range>("all");
  const titles = useTitleStore();
  const navigate = useNavigate();

  // 数据源:跟 GraphView 共享 graphStore.entries
  const entries = useGraphStore((s) => s.entries);
  const error = useGraphStore((s) => s.error);
  const graphLoad = useGraphStore((s) => s.load);

  useEffect(() => {
    if (!entries) void graphLoad();
  }, [entries, graphLoad]);

  const nodes = useMemo(() => {
    if (!entries) return [];
    return entries.map((e) => e.node);
  }, [entries]);

  /** 各范围的命中数(预先算好给 range badge 用)— 跟 inRange 用同样的 filter 逻辑 */
  const rangeCounts = useMemo(() => {
    const counts: Record<Range, number> = { "24h": 0, "7d": 0, "30d": 0, all: nodes.length };
    const now = Date.now();
    for (const n of nodes) {
      const ts = n.last_timestamp_ms ?? n.first_timestamp_ms ?? n.mtime_ms;
      if (!ts) continue;
      if (ts >= now - 24 * 3600_000) counts["24h"] += 1;
      if (ts >= now - 7 * 24 * 3600_000) counts["7d"] += 1;
      if (ts >= now - 30 * 24 * 3600_000) counts["30d"] += 1;
    }
    return counts;
  }, [nodes]);

  const inRange = useMemo(() => {
    const cutoff =
      range === "24h"
        ? Date.now() - 24 * 3600_000
        : range === "7d"
          ? Date.now() - 7 * 24 * 3600_000
          : range === "30d"
            ? Date.now() - 30 * 24 * 3600_000
            : null;
    if (cutoff === null) return nodes;
    return nodes.filter((n) => {
      const ts = n.last_timestamp_ms ?? n.first_timestamp_ms ?? n.mtime_ms;
      return ts >= cutoff;
    });
  }, [nodes, range]);

  const sum = useMemo(() => summary(inRange), [inRange]);
  const byDay = useMemo(() => sessionsByDay(inRange), [inRange]);
  const tokenTop = useMemo(() => tokenTopN(inRange, 10), [inRange]);
  const topTools = useMemo(() => (entries ? topToolsBar(entries, 10) : []), [entries]);
  const modelRows = useMemo(() => modelAvgThinking(inRange), [inRange]);
  const retryRows = useMemo(() => retryRateDistribution(inRange), [inRange]);
  const chainRows = useMemo(() => subagentChainDist(inRange), [inRange]);
  const errByWs = useMemo(() => errorsByWorkspace(inRange), [inRange]);
  const toolCats = useMemo(() => (entries ? toolsByCategory(entries) : []), [entries]);

  /** session_id → SessionNode 索引,供 titles.get 用 */
  const nodeById = useMemo(() => {
    const m = new Map<string, SessionNode>();
    for (const n of nodes) m.set(n.node_id, n);
    return m;
  }, [nodes]);

  /** 给 tokenTop 加 display_title (override > auto) */
  const tokenTopTitled = useMemo(() => {
    return tokenTop.map((r) => {
      const n = nodeById.get(r.session_id);
      return {
        ...r,
        display_title: n
          ? titles.get(n.node_id, titles.auto(n))
          : r.label || r.session_id.slice(0, 8),
      };
    });
  }, [tokenTop, nodeById, titles]);

  /** 检测 chart 1 是否只有 1 个 source — 决定是否显示"all 1 source"提示 */
  const uniqueSources = useMemo(() => {
    return new Set(inRange.map((n) => n.source));
  }, [inRange]);
  const singleSource = uniqueSources.size === 1 ? Array.from(uniqueSources)[0] : null;

  const successRate = sum.total_sessions
    ? Math.round((sum.clean_sessions / sum.total_sessions) * 100)
    : 0;

  const avgDurationLabel = useMemo(() => {
    if (sum.avg_duration_ms <= 0) return "—";
    const min = sum.avg_duration_ms / 60_000;
    if (min < 60) return `${Math.round(min)} 分钟`;
    if (min < 60 * 24) return `${(min / 60).toFixed(1)} 小时`;
    return `${(min / 1440).toFixed(1)} 天`;
  }, [sum.avg_duration_ms]);

  if (error) return <div className="error">{error}</div>;
  if (!entries) return <div className="loading">加载 sessions.ndjson ...</div>;

  return (
    <div className="analytics-view">
      <header className="analytics-header">
        <h2>
          G2 Analytics — {sum.total_sessions} sessions · {formatNum(sum.total_tokens)} tokens ·{" "}
          {sum.total_subagents} subagents · {sum.total_errors} errors
        </h2>
        <div className="range-buttons">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className={`range-btn ${range === r.key ? "active" : ""}`}
              onClick={() => setRange(r.key)}
            >
              {r.label} <span className="range-count">{rangeCounts[r.key]}</span>
            </button>
          ))}
        </div>
      </header>

      <div className="kpi-row kpi-row-8">
        <Kpi label="总 token" value={formatNum(sum.total_tokens)} />
        <Kpi label="总 sessions" value={String(sum.total_sessions)} />
        <Kpi
          label="平均 token / session"
          value={formatNum(
            sum.total_sessions ? Math.round(sum.total_tokens / sum.total_sessions) : 0
          )}
        />
        <Kpi
          label="成功率 (0 errors)"
          value={`${successRate}%`}
          tone={successRate >= 70 ? "good" : successRate >= 40 ? "warn" : "bad"}
        />
        <Kpi label="subagent 调用数" value={String(sum.total_subagents)} />
        <Kpi label="平均 session 持续" value={avgDurationLabel} />
        <Kpi
          label="错误总数"
          value={String(sum.total_errors)}
          tone={sum.total_errors === 0 ? "good" : "bad"}
        />
        <Kpi
          label="日期范围"
          value={
            sum.date_range.from_ms > 0
              ? `${formatDate(sum.date_range.from_ms).slice(0, 10)} → ${formatDate(sum.date_range.to_ms).slice(0, 10)}`
              : "—"
          }
        />
      </div>

      <div className="grid">
        <Chart
          title={
            singleSource
              ? `1. sessions_per_day · 全部 ${singleSource} (本地数据只有 1 个 source,无堆叠意义)`
              : "1. sessions_per_day × source (stacked bar)"
          }
        >
          {singleSource ? (
            <SingleSourcePerDay data={byDay} source={singleSource} />
          ) : (
            <BarChart data={byDay} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#1e293b" />
              <XAxis dataKey="day" stroke="#94a3b8" fontSize={10} />
              <YAxis stroke="#94a3b8" fontSize={10} />
              <Tooltip contentStyle={tooltipStyle} />
              <Legend wrapperStyle={legendStyle} />
              <Bar dataKey="Claude" stackId="s" fill="#3b82f6" />
              <Bar dataKey="OpenClaw" stackId="s" fill="#a855f7" />
            </BarChart>
          )}
        </Chart>

        <Chart title="2. token_top_10 session (horizontal bar)">
          <BarChart
            data={tokenTopTitled.slice().reverse()}
            layout="vertical"
            margin={{ top: 10, right: 16, bottom: 0, left: 96 }}
          >
            <CartesianGrid stroke="#1e293b" />
            <XAxis type="number" stroke="#94a3b8" fontSize={10} tickFormatter={formatNum} />
            <YAxis
              type="category"
              dataKey="display_title"
              stroke="#94a3b8"
              fontSize={10}
              width={92}
            />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: any) => formatNum(Number(v))} />
            <Bar dataKey="tokens" fill="#3b82f6">
              {tokenTopTitled.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </Chart>

        <Chart title="3. top_tools (bar — sessions_count)">
          <BarChart
            data={topTools.slice().reverse()}
            layout="vertical"
            margin={{ top: 10, right: 16, bottom: 0, left: 96 }}
          >
            <CartesianGrid stroke="#1e293b" />
            <XAxis type="number" stroke="#94a3b8" fontSize={10} />
            <YAxis type="category" dataKey="tool" stroke="#94a3b8" fontSize={10} width={92} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="total_calls" fill="#a855f7" />
          </BarChart>
        </Chart>

        <Chart
          title={
            modelRows.length === 1
              ? `4. model_avg_thinking · 单一 model (${modelRows[0]?.primary_model})`
              : "4. model_avg_thinking (avg per session, bar)"
          }
        >
          <BarChart data={modelRows} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#1e293b" />
            <XAxis dataKey="primary_model" stroke="#94a3b8" fontSize={10} />
            <YAxis stroke="#94a3b8" fontSize={10} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="avg_thinking" fill="#22c55e" />
          </BarChart>
        </Chart>

        <Chart title="5. retry_rate (error_count 分桶, pie)">
          <PieChart>
            <Pie
              data={retryRows}
              dataKey="sessions_count"
              nameKey="bucket"
              cx="50%"
              cy="50%"
              outerRadius={80}
              label={(p: any) => `${p.bucket} ${p.sessions_count}`}
              labelLine={false}
            >
              {retryRows.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={tooltipStyle} />
          </PieChart>
        </Chart>

        <Chart title="6. subagent_chain_distribution (bar)">
          <BarChart data={chainRows} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#1e293b" />
            <XAxis dataKey="bucket" stroke="#94a3b8" fontSize={10} />
            <YAxis stroke="#94a3b8" fontSize={10} />
            <Tooltip contentStyle={tooltipStyle} />
            <Bar dataKey="sessions_count" fill="#06b6d4" />
          </BarChart>
        </Chart>

        {errByWs.length > 1 && (
          <Chart title="7. errors_by_workspace (bar)">
            <BarChart
              data={errByWs.slice(0, 8).map((r) => ({
                ...r,
                workspace_short: r.workspace.split("/").slice(-2).join("/") || r.workspace,
              }))}
              layout="vertical"
              margin={{ top: 10, right: 16, bottom: 0, left: 120 }}
            >
              <CartesianGrid stroke="#1e293b" />
              <XAxis type="number" stroke="#94a3b8" fontSize={10} />
              <YAxis
                type="category"
                dataKey="workspace_short"
                stroke="#94a3b8"
                fontSize={10}
                width={110}
              />
              <Tooltip
                contentStyle={tooltipStyle}
                labelFormatter={(_: any, p: any) => {
                  const row = p?.[0]?.payload as WorkspaceRow | undefined;
                  return row?.workspace ?? "";
                }}
                formatter={(v: any, name: string) => {
                  if (name === "total_errors") return [`${v} errors`, "错误"];
                  if (name === "err_per_session") return [Number(v).toFixed(1), "错误/会话"];
                  return [v, name];
                }}
              />
              <Bar dataKey="total_errors" fill="#ef4444" />
            </BarChart>
          </Chart>
        )}

        {toolCats.length > 1 && (
          <Chart title="8. tools_by_category (调用次数)">
            <BarChart
              data={toolCats}
              layout="vertical"
              margin={{ top: 10, right: 16, bottom: 0, left: 80 }}
            >
              <CartesianGrid stroke="#1e293b" />
              <XAxis type="number" stroke="#94a3b8" fontSize={10} />
              <YAxis type="category" dataKey="category" stroke="#94a3b8" fontSize={10} width={70} />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={(v: any, name: string) => {
                  if (name === "total_calls") return [`${v} 次调用`, "调用"];
                  if (name === "sessions_count") return [v, "会话"];
                  return [v, name];
                }}
              />
              <Bar dataKey="total_calls" fill="#22c55e" />
            </BarChart>
          </Chart>
        )}
      </div>

      <Chart
        title={`Token Top ${tokenTopTitled.length} sessions · 点击行跳会话详情 · 已自定义名标记`}
        wide
      >
        <table className="token-table">
          <thead>
            <tr>
              <th>session</th>
              <th>workspace</th>
              <th>source</th>
              <th>model</th>
              <th>tokens</th>
              <th>last active</th>
            </tr>
          </thead>
          <tbody>
            {tokenTopTitled.map((r) => {
              const n = nodeById.get(r.session_id);
              return (
                <tr
                  key={r.session_id}
                  onClick={() => {
                    if (n) {
                      navigate(`/session/${encodeURIComponent(n.session_id)}`);
                    }
                  }}
                  className={n ? "token-row-clickable" : ""}
                  title={n ? "跳转到该 session 详情" : ""}
                >
                  <td title={r.session_id}>
                    {r.display_title}
                    {titles.hasOverride(r.session_id) && (
                      <span className="title-override-badge" title="已自定义">
                        已重命名
                      </span>
                    )}
                  </td>
                  <td>{r.workspace ?? "—"}</td>
                  <td>{r.source}</td>
                  <td>{r.primary_model ?? "—"}</td>
                  <td className="num">{formatNum(r.tokens)}</td>
                  <td>{formatDate(r.when_ms)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Chart>
    </div>
  );
}

/** 单一 source 时的"按日 sessions"展示 — 简单 line/bar,避免堆叠欺骗 */
function SingleSourcePerDay({
  data,
  source,
}: {
  data: { day: string; Claude: number; OpenClaw: number }[];
  source: string;
}) {
  const seriesData = data.map((d) => ({
    day: d.day,
    sessions: (d as any)[source] ?? d.Claude + d.OpenClaw,
  }));
  return (
    <BarChart data={seriesData} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
      <CartesianGrid stroke="#1e293b" />
      <XAxis dataKey="day" stroke="#94a3b8" fontSize={10} />
      <YAxis stroke="#94a3b8" fontSize={10} allowDecimals={false} />
      <Tooltip contentStyle={tooltipStyle} />
      <Bar dataKey="sessions" fill="#3b82f6" />
    </BarChart>
  );
}

interface WorkspaceRow {
  workspace: string;
  sessions_count: number;
  total_errors: number;
  err_per_session: number;
}

const tooltipStyle = {
  background: "#0f172a",
  border: "1px solid #334155",
  fontSize: 12,
};
const legendStyle = {
  fontSize: 11,
};

function Chart({ title, children, wide }: { title: string; children: any; wide?: boolean }) {
  return (
    <div className={`chart-card ${wide ? "wide" : ""}`}>
      <h3>{title}</h3>
      <div className="chart-canvas">
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "warn" | "bad";
}) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ""}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
    </div>
  );
}
