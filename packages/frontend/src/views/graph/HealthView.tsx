/**
 * HealthView — v0.11 (B2 / FR-H2) 全局会话体检报告
 *
 * 数据口径:与 G2 Analytics 共用 `foldGraphEntries()` 折叠后的 nodes ——
 * subagent 的用量/错误/工具调用已归并到 parent,不会出现两套汇总数字。
 * 规则引擎在 `health.ts`(纯函数),阈值来自设置页 `settings.json`(B3)。
 *
 * 所有标记都带可解释标签(label + 实际值 + 阈值),不做黑盒评分 (RK-V1)。
 * 零上传:本页只写本地 event_log(`health_view_open`),无任何网络请求 (D-2)。
 */

import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { foldGraphEntries, formatDate, formatNum } from "./analytics";
import { evaluateHealth, HEALTH_RULE_LABELS, normalizeHealthRules } from "./health";
import { useGraphStore } from "./graphStore";
import { useSettingsStore } from "../../state/settingsStore";
import { useTitleStore } from "./titleStore";
import { trackLocalEvent } from "../../lib/eventsApi";
import "./AnalyticsView.css";
import "./HealthView.css";

const tooltipStyle = {
  background: "var(--color-panel)",
  border: "1px solid var(--color-panel-border)",
  color: "var(--color-text)",
  fontSize: 12,
};

export function HealthView() {
  const navigate = useNavigate();
  const titles = useTitleStore();
  const entries = useGraphStore((s) => s.entries);
  const error = useGraphStore((s) => s.error);
  const graphLoad = useGraphStore((s) => s.load);
  /** B3: 设置页保存后 store 变化 → rules 变化 → report 自动重算 */
  const rawRules = useSettingsStore((s) => s.settings.healthRules);
  const rules = useMemo(() => normalizeHealthRules(rawRules), [rawRules]);
  const reportedRef = useRef(false);

  useEffect(() => {
    if (!entries) void graphLoad();
  }, [entries, graphLoad]);

  /** B2: 打开体检 tab 写一条本地事件(为「标记有用率」留数据底座),只记一次 */
  useEffect(() => {
    if (reportedRef.current) return;
    reportedRef.current = true;
    trackLocalEvent({
      eventName: "health_view_open",
      sessionCount: entries?.length ?? 0,
      realMetric: true,
    });
  }, [entries?.length]);

  const fold = useMemo(() => (entries ? foldGraphEntries(entries) : null), [entries]);
  const nodes = useMemo(() => fold?.nodes ?? [], [fold]);
  const report = useMemo(() => evaluateHealth(nodes, rules), [nodes, rules]);

  const ruleRows = useMemo(
    () => report.byRule.map((b) => ({ name: b.label, count: b.count })),
    [report]
  );
  const sourceRows = useMemo(
    () =>
      report.bySource.map((b) => ({
        name: b.source,
        total: b.total,
        flagged: b.flagged,
      })),
    [report]
  );
  const topRows = useMemo(() => report.flagged.slice(0, 20), [report]);

  const flaggedPct = report.totalSessions
    ? ((report.flaggedCount / report.totalSessions) * 100).toFixed(1)
    : "0.0";

  const ruleSummary = [
    rules.highErrorsEnabled ? `错误数 ≥ ${rules.highErrorsThreshold}` : "错误数规则关闭",
    rules.tokenOutlierEnabled ? `token 离群 μ+${rules.tokenSigma}σ` : "token 离群关闭",
    rules.subagentsEnabled ? `子会话 ≥ ${rules.subagentsThreshold}` : "子会话规则关闭",
    rules.modelDriftEnabled ? `模型数 ≥ ${rules.modelDriftMinModels}` : "模型漂移关闭",
  ].join(" · ");

  return (
    <div className="analytics-view health-view" data-testid="health-view">
      <header className="analytics-header">
        <h2>
          会话体检 — {report.totalSessions} sessions · {report.flaggedCount} 异常 ·{" "}
          {report.cleanCount} 未标记
        </h2>
        <span className="health-rule-summary" title="规则阈值为估算默认值,可在设置页修改">
          {ruleSummary}
        </span>
      </header>

      <div className="kpi-row health-kpi-row">
        <Kpi
          label="异常会话"
          value={String(report.flaggedCount)}
          tone={report.flaggedCount > 0 ? "warn" : "good"}
        />
        <Kpi label="异常占比" value={`${flaggedPct}%`} />
        <Kpi label="未标记会话" value={String(report.cleanCount)} tone="good" />
        <Kpi
          label="token 判定线"
          value={report.tokenCutoff === null ? "不判定" : formatNum(report.tokenCutoff)}
        />
      </div>

      <div className="health-note">
        口径:与 G2 Analytics 共用折叠后的会话节点(subagent 已归并到 parent);token 离群用全体会话
        均值 μ = {formatNum(report.tokenMean)}、总体标准差 σ = {formatNum(report.tokenStdDev)} 计算,
        样本不足或 σ = 0 时不判定。阈值为估算默认值,可在「设置 → 会话体检」修改;标记只写本地,
        不上传。
      </div>

      {report.totalSessions === 0 ? (
        <div className="health-empty" data-testid="health-empty">
          <h3>暂无会话数据</h3>
          <p>
            同步本地会话后即可体检。当前按空数据处理,不会报错。
            {error ? `（数据源提示:${error}）` : ""}
          </p>
        </div>
      ) : report.flaggedCount === 0 ? (
        <div className="health-empty" data-testid="health-empty">
          <h3>当前 {report.totalSessions} 个会话均未命中体检规则</h3>
          <p>可在设置页降低阈值,或关闭不需要的规则。</p>
        </div>
      ) : (
        <>
          <div className="grid">
            <div className="chart-card">
              <h3>异常分布 · 按规则类型</h3>
              <div className="chart-canvas">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={ruleRows} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--color-panel-border)" />
                    <XAxis
                      dataKey="name"
                      stroke="var(--color-text-subtle)"
                      fontSize={10}
                      interval={0}
                    />
                    <YAxis stroke="var(--color-text-subtle)" fontSize={10} allowDecimals={false} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Bar dataKey="count" name="命中会话数" fill="#f59e0b" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="chart-card">
              <h3>异常分布 · 按 source</h3>
              <div className="chart-canvas">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={sourceRows} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="var(--color-panel-border)" />
                    <XAxis
                      dataKey="name"
                      stroke="var(--color-text-subtle)"
                      fontSize={10}
                      interval={0}
                    />
                    <YAxis stroke="var(--color-text-subtle)" fontSize={10} allowDecimals={false} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="total" name="会话总数" fill="#3b82f6" />
                    <Bar dataKey="flagged" name="异常会话" fill="#ef4444" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div className="chart-card wide health-table-card">
            <h3>
              Top 风险会话 ({topRows.length}/{report.flaggedCount}) · 点击行跳会话详情 · 标签 hover
              查看判定依据
            </h3>
            <div className="panel-body">
              <table className="token-table">
                <thead>
                  <tr>
                    <th>session</th>
                    <th>source</th>
                    <th>命中规则(可解释标签)</th>
                    <th>命中数</th>
                    <th>errors</th>
                    <th>tokens</th>
                    <th>subagents</th>
                    <th>last active</th>
                  </tr>
                </thead>
                <tbody>
                  {topRows.map(({ node, flags, score }) => {
                    const when = node.last_timestamp_ms ?? node.first_timestamp_ms ?? node.mtime_ms;
                    return (
                      <tr
                        key={node.node_id}
                        className="token-row-clickable"
                        data-testid="health-risk-row"
                        title="跳转到该 session 详情"
                        onClick={() => navigate(`/session/${encodeURIComponent(node.session_id)}`)}
                      >
                        <td title={node.session_id}>
                          {titles.get(node.node_id, titles.auto(node))}
                        </td>
                        <td>{node.source}</td>
                        <td>
                          <div className="health-flags">
                            {flags.map((f) => (
                              <span
                                key={f.rule}
                                className="health-flag"
                                data-testid="health-rule-badge"
                                title={`${HEALTH_RULE_LABELS[f.rule]}:${f.detail}`}
                              >
                                {f.label}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="num">{score}</td>
                        <td className="num">{formatNum(node.error_count)}</td>
                        <td className="num">{formatNum(node.token_total)}</td>
                        <td className="num">{formatNum(node.subagent_count)}</td>
                        <td>{when ? formatDate(when) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
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
