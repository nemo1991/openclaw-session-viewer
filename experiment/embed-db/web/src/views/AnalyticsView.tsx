/**
 * AnalyticsView — S2 G2 PoC
 *
 * 6 个 chart + 时间范围切换 (24h/7d/30d/all)
 *
 * 数据:NDJSON in-memory;recharts 渲染
 */

import { useEffect, useMemo, useState } from "react";
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
import type { GraphEntry, SessionNode } from "../types";
import { loadNdjson } from "../loader";
import {
  formatDate,
  formatNum,
  modelAvgThinking,
  retryRateDistribution,
  sessionsByDay,
  subagentChainDist,
  summary,
  tokenTopN,
  topToolsBar,
  type Range,
} from "../analytics";
import { useTitles } from "../titleStore";

const NDJSON_URL = "/sessions.ndjson";
const RANGES: { key: Range; label: string }[] = [
  { key: "all", label: "all" },
  { key: "24h", label: "最近 24h" },
  { key: "7d", label: "最近 7 天" },
  { key: "30d", label: "最近 30 天" },
];

const PIE_COLORS = ["#3b82f6", "#a855f7", "#f59e0b", "#22c55e", "#ef4444", "#06b6d4"];

export function AnalyticsView() {
  const [entries, setEntries] = useState<GraphEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("all");
  const titles = useTitles();

  useEffect(() => {
    loadNdjson(NDJSON_URL)
      .then(setEntries)
      .catch((e) => setError(String(e)));
  }, []);

  const nodes = useMemo(() => {
    if (!entries) return [];
    return entries.map((e) => e.node);
  }, [entries]);

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

  /** session_id → SessionNode 索引,供 titles.get 用(node_id 在 types.ts 里就是 session_id 不可逆的话要另想) */
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

  if (error) return <div className="error">❌ {error}</div>;
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
              {r.label}
            </button>
          ))}
        </div>
      </header>

      <div className="kpi-row">
        <Kpi label="总 token" value={formatNum(sum.total_tokens)} />
        <Kpi label="总 sessions" value={String(sum.total_sessions)} />
        <Kpi
          label="平均 token / session"
          value={formatNum(
            sum.total_sessions ? Math.round(sum.total_tokens / sum.total_sessions) : 0
          )}
        />
        <Kpi label="subagent 调用数" value={String(sum.total_subagents)} />
        <Kpi label="错误总数" value={String(sum.total_errors)} />
        <Kpi
          label="日期范围"
          value={
            sum.date_range.from_ms > 0
              ? `${formatDate(sum.date_range.from_ms)} → ${formatDate(sum.date_range.to_ms)}`
              : "—"
          }
        />
      </div>

      <div className="grid">
        <Chart title="1. sessions_per_day × source (stacked bar)">
          <BarChart data={byDay} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#1e293b" />
            <XAxis dataKey="day" stroke="#94a3b8" fontSize={10} />
            <YAxis stroke="#94a3b8" fontSize={10} />
            <Tooltip contentStyle={tooltipStyle} />
            <Legend wrapperStyle={legendStyle} />
            <Bar dataKey="Claude" stackId="s" fill="#3b82f6" />
            <Bar dataKey="OpenClaw" stackId="s" fill="#a855f7" />
          </BarChart>
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

        <Chart title="4. model_avg_thinking (avg per session, bar)">
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
      </div>

      <Chart title={`Token Top ${tokenTopTitled.length} sessions · ✏️ = 已自定义名`} wide>
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
            {tokenTopTitled.map((r) => (
              <tr key={r.session_id}>
                <td title={r.session_id}>
                  {r.display_title}
                  {titles.hasOverride(r.session_id) && (
                    <span className="title-override-badge" title="已自定义">
                      ✏️
                    </span>
                  )}
                </td>
                <td>{r.workspace ?? "—"}</td>
                <td>{r.source}</td>
                <td>{r.primary_model ?? "—"}</td>
                <td className="num">{formatNum(r.tokens)}</td>
                <td>{formatDate(r.when_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Chart>
    </div>
  );
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

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
    </div>
  );
}
