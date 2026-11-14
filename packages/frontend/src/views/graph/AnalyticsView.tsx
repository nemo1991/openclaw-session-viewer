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
 * v0.10 (FR-I1/I2/I3):
 * - chart 5 由 error 分桶 pie 换成真实重试率数值卡 (Rust 聚合的 retry_count / tool_call_count)
 * - 全局汇总先折叠 subagent→parent,列表/ KPI 不重复计入;tokenTop 标注"含 N 个子会话"
 * - 新增"同模型跨 source"对齐表;chart 1 按 4 个 source 独立堆叠,不再把 Kimi/dsh 算进 Claude
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { GraphEntry, SessionNode } from "./types";
import {
  crossSourceByModel,
  errorsByWorkspace,
  foldGraphEntries,
  formatDate,
  formatNum,
  modelAvgThinking,
  modelsAcrossSources,
  retryRateBySource,
  retryRateSummary,
  sessionsByDay,
  sessionsBySource,
  sourceKey,
  subagentChainDist,
  summary,
  tokenTopN,
  toolsByCategory,
  topToolsBar,
  type DayBucket,
  type Range,
} from "./analytics";
import { useTitleStore } from "./titleStore";
import { useGraphStore } from "./graphStore";
// v0.11 (A1/A3): 本地事件日志 + 首屏性能断言(零上传)
import { trackLocalEvent } from "../../lib/eventsApi";
import { checkP95Budget, PERF_P95_BUDGET_MS } from "./perf";
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
  /** v0.11 (A1): source 维度选择,null = 全部 */
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const titles = useTitleStore();
  const navigate = useNavigate();

  /** A3: mount 时刻,与首屏可交互时刻相减得到耗时样本 */
  const mountAtRef = useRef<number>(typeof performance !== "undefined" ? performance.now() : 0);
  /** 防止 StrictMode / 重复 render 造成同一事件重复落库 */
  const reportedRef = useRef({ open: false, ready: false, retryKey: "" });

  // 数据源:跟 GraphView 共享 graphStore.entries
  const entries = useGraphStore((s) => s.entries);
  const error = useGraphStore((s) => s.error);
  const graphLoad = useGraphStore((s) => s.load);

  useEffect(() => {
    if (!entries) void graphLoad();
  }, [entries, graphLoad]);

  /** v0.10 (FR-I2): 先折叠 subagent→parent,后续所有汇总都只吃折叠后的 nodes/entries */
  const fold = useMemo(() => (entries ? foldGraphEntries(entries) : null), [entries]);
  const nodes = useMemo(() => fold?.nodes ?? [], [fold]);
  const foldedEntries = useMemo(() => fold?.entries ?? [], [fold]);

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
  const topTools = useMemo(() => topToolsBar(foldedEntries, 10), [foldedEntries]);
  const modelRows = useMemo(() => modelAvgThinking(inRange), [inRange]);
  const retry = useMemo(() => retryRateSummary(inRange), [inRange]);
  const retryBySource = useMemo(() => retryRateBySource(inRange), [inRange]);
  const chainRows = useMemo(() => subagentChainDist(inRange), [inRange]);
  const errByWs = useMemo(() => errorsByWorkspace(inRange), [inRange]);
  const toolCats = useMemo(() => toolsByCategory(foldedEntries), [foldedEntries]);
  // v0.10 (FR-I3): 同模型跨 source 对齐 — 只展示出现在 ≥2 个 source 的 model
  const crossRows = useMemo(() => crossSourceByModel(inRange), [inRange]);
  const alignedModels = useMemo(() => modelsAcrossSources(crossRows), [crossRows]);
  const alignedRows = useMemo(
    () => crossRows.filter((r) => alignedModels.includes(r.primary_model)),
    [crossRows, alignedModels]
  );
  const sourceRows = useMemo(() => sessionsBySource(inRange), [inRange]);

  // ===== v0.11 (A1/A3): 本地事件日志,三个 v0.10 PRD 第十章事件 + 首屏耗时 =====
  // 事件 1 analytics_view_open:打开 Analytics 即写,sessionCount 取当次折叠后节点数
  useEffect(() => {
    if (reportedRef.current.open) return;
    reportedRef.current.open = true;
    trackLocalEvent({
      eventName: "analytics_view_open",
      sessionCount: nodes.length,
      realMetric: true,
    });
  }, [nodes.length]);

  // A3:数据首次可渲染 = 首屏可交互,把「打开 → 首屏」耗时写入本地 event_log
  useEffect(() => {
    if (!entries || reportedRef.current.ready) return;
    reportedRef.current.ready = true;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const elapsed = Math.max(0, Math.round(now - mountAtRef.current));
    trackLocalEvent({
      eventName: "analytics_ready",
      durationMs: elapsed,
      sessionCount: nodes.length,
      realMetric: true,
    });
    // 可选性能断言:仅 DEV 模式按单次样本给提示;真实 P95 / 门槛由 Rust 侧
    // check_p95_budget 用 event_log 的多样本计算,生产环境不硬失败。
    if (import.meta.env.DEV) {
      const verdict = checkP95Budget([elapsed], PERF_P95_BUDGET_MS);
      if (!verdict.ok) console.warn(`[perf] ${verdict.reason}`);
    }
  }, [entries, nodes.length]);

  // 事件 3 retry_rate_displayed:真实重试率数值卡口径变化时记一条
  const retryKey = `${retry.retry_count}/${retry.tool_call_count}/${retry.sessions_with_tool_calls}`;
  useEffect(() => {
    if (!entries || reportedRef.current.retryKey === retryKey) return;
    reportedRef.current.retryKey = retryKey;
    trackLocalEvent({
      eventName: "retry_rate_displayed",
      sessionCount: retry.sessions_with_tool_calls,
      realMetric: true,
      detail: retryKey,
    });
  }, [entries, retryKey, retry.sessions_with_tool_calls]);

  /** 事件 2 的过滤效果:点选 source 后只展示该 source 的跨 source 对比行 */
  const visibleAlignedRows = useMemo(
    () => alignedRows.filter((r) => selectedSource === null || r.source === selectedSource),
    [alignedRows, selectedSource]
  );

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
          {sum.total_subagents} subagents · {sum.total_errors} errors · 真实重试率{" "}
          {(sum.retry_rate * 100).toFixed(1)}%
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

      <div className="kpi-row kpi-row-9">
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
        <Kpi
          label="真实重试率"
          value={`${(sum.retry_rate * 100).toFixed(1)}%`}
          tone={sum.retry_rate >= 0.2 ? "bad" : sum.retry_rate > 0 ? "warn" : "good"}
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

      {fold && (fold.folded.length > 0 || fold.independent_subagents > 0) && (
        <div className="fold-note" data-testid="subagent-fold-note">
          已折叠 {fold.folded.length} 个 subagent 到
          parent(用量/错误/工具调用归并,不重复计入全局汇总)
          {fold.independent_subagents > 0 &&
            `;${fold.independent_subagents} 个孤儿或 dsh subagent 按独立会话计`}
          {fold.folded.length > 0 && (
            <span className="fold-pairs">
              {" "}
              ·{" "}
              {fold.folded
                .slice(0, 3)
                .map(
                  (f) => `${f.child_session_id.slice(0, 8)} → ${f.parent_session_id.slice(0, 8)}`
                )
                .join(" / ")}
              {fold.folded.length > 3 ? " …" : ""}
            </span>
          )}
        </div>
      )}

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
              <Bar dataKey="Kimi" stackId="s" fill="#22c55e" />
              <Bar dataKey="DeepSeekHarness" stackId="s" fill="#f59e0b" />
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

        <Panel title="5. 真实重试率 (Rust 聚合口径,非 error 分桶估值)">
          <div className="retry-stat">
            <div className="retry-stat-main">
              <span className="retry-stat-value">{(retry.retry_rate * 100).toFixed(1)}%</span>
              <span className="retry-stat-label">真实重试率</span>
            </div>
            <div className="retry-stat-side">
              <div>
                重试次数 <b>{formatNum(retry.retry_count)}</b>
              </div>
              <div>
                tool 调用总数 <b>{formatNum(retry.tool_call_count)}</b>
              </div>
              <div>
                发生重试的会话 <b>{retry.sessions_with_retry}</b> / {retry.sessions_with_tool_calls}
              </div>
              <div className="retry-stat-note">
                口径:tool 调用失败后,紧随其后出现同名 tool 的下一次调用计 1 次重试;重试率 = 重试次数
                ÷ tool 调用总数。按 source 分组时数据不串源。
              </div>
            </div>
          </div>
          <table className="token-table retry-by-source">
            <thead>
              <tr>
                <th>source</th>
                <th>sessions</th>
                <th>重试 / 调用</th>
                <th>重试率</th>
              </tr>
            </thead>
            <tbody>
              {retryBySource.length === 0 ? (
                <tr>
                  <td colSpan={4}>当前范围内无会话</td>
                </tr>
              ) : (
                retryBySource.map((r) => (
                  <tr key={r.source}>
                    <td>{r.source}</td>
                    <td>{r.sessions_count}</td>
                    <td>
                      {r.retry_count} / {r.tool_call_count}
                    </td>
                    <td>{(r.retry_rate * 100).toFixed(1)}%</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </Panel>

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

      <Panel
        title={`9. 同模型跨 source 对比 · ${alignedModels.length} 个 model 出现在 ≥2 个 source${
          selectedSource ? ` · 已筛选 ${selectedSource}` : ""
        }`}
        wide
      >
        <table className="token-table source-compare">
          <thead>
            <tr>
              <th>model</th>
              <th>source</th>
              <th>sessions</th>
              <th>tokens</th>
              <th>errors</th>
              <th>真实重试率</th>
            </tr>
          </thead>
          <tbody>
            {visibleAlignedRows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  {selectedSource
                    ? `${selectedSource} 在当前范围没有跨 source 对齐行(点该 source 可取消筛选)`
                    : "当前范围没有同一 model 出现在多个 source 的会话(分组仍按 source 独立统计,无串源)"}
                </td>
              </tr>
            ) : (
              visibleAlignedRows.map((r) => (
                <tr key={`${r.primary_model}-${r.source}`}>
                  <td>{r.primary_model}</td>
                  <td>{r.source}</td>
                  <td>{r.sessions_count}</td>
                  <td className="num">{formatNum(r.total_tokens)}</td>
                  <td className="num">{r.total_errors}</td>
                  <td className="num">{(r.retry_rate * 100).toFixed(1)}%</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <div className="source-dimension">
          <span>source 维度(可点选,独立分组):</span>
          {sourceRows.length === 0
            ? " 无会话"
            : sourceRows.map((r) => (
                <button
                  type="button"
                  key={r.source}
                  className={`source-chip source-chip-btn ${
                    selectedSource === r.source ? "active" : ""
                  }`}
                  title={`按 ${r.source} 过滤上方对比表,再次点击取消 · 会写入本地事件日志`}
                  onClick={() => {
                    const next = selectedSource === r.source ? null : r.source;
                    setSelectedSource(next);
                    // 事件 2 source_dimension_select
                    trackLocalEvent({
                      eventName: "source_dimension_select",
                      source: next ?? "all",
                      sessionCount: r.sessions_count,
                      realMetric: true,
                    });
                  }}
                >
                  {r.source} {r.sessions_count} sessions / {formatNum(r.total_tokens)} tokens /{" "}
                  {r.total_errors} errors
                </button>
              ))}
        </div>
      </Panel>

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
              <th>折叠 subagent</th>
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
                  <td>
                    {(n?.folded_subagent_count ?? 0) > 0 ? (
                      <span
                        className="fold-badge"
                        title="该会话的用量/错误/工具调用已含归并进来的 subagent"
                      >
                        含 {n?.folded_subagent_count} 个
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
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
function SingleSourcePerDay({ data, source }: { data: DayBucket[]; source: string }) {
  const key = sourceKey(source);
  const seriesData = data.map((d) => ({
    day: d.day,
    // 用规范化 key 读列,避免 "DeepSeek Harness"/"DeepSeekHarness" 两种拼写串源
    sessions: d[key],
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

/** 非图表卡片(数值卡 / 对齐表) — 不套 ResponsiveContainer */
function Panel({ title, children, wide }: { title: string; children: any; wide?: boolean }) {
  return (
    <div className={`chart-card ${wide ? "wide" : ""}`}>
      <h3>{title}</h3>
      <div className="panel-body">{children}</div>
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
