/**
 * v0.8.5 B: /tools 路由 — 全局 tool 聚合页
 *
 * 3 tab:
 * 1. 总览排行 — 全局工具按 calls / sessions / errors 排序
 * 2. 单 tool 时间线 — 选 tool → 显示调用次数时间分布 (简单按 session last_ts 散点)
 * 3. 单 tool 跨 session — 选 tool → 列出用过的 session + call_count desc
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useToolStatsStore, startToolStatsListener } from "../state/toolStatsStore";
import { apiGetToolSessions, type ToolSessionRef } from "../lib/overridesApi";
import "./ToolsRoute.css";

type SortBy = "calls" | "sessions" | "errors";

export function ToolsRoute() {
  const { t } = useTranslation();
  const { aggregate, sortBy, loading, loadedAt, setSortBy, load } = useToolStatsStore();
  const [selectedTool, setSelectedTool] = useState<string | null>(null);

  // 启动 listener + 首次加载
  useEffect(() => {
    startToolStatsListener();
    void load();
  }, [load]);

  if (loading && !aggregate) {
    return (
      <div className="tools-route" data-testid="tools-route-loading">
        <h1>🔧 工具分析</h1>
        <p>加载中…</p>
      </div>
    );
  }
  if (!aggregate || aggregate.length === 0) {
    return (
      <div className="tools-route" data-testid="tools-route-empty">
        <h1>🔧 工具分析</h1>
        <p>暂无工具数据。等 sync 完成后刷新。</p>
        {loadedAt && <p className="muted">最后加载: {new Date(loadedAt).toLocaleString()}</p>}
      </div>
    );
  }

  return (
    <div className="tools-route" data-testid="tools-route">
      <header className="tools-header">
        <h1>🔧 工具分析</h1>
        <div className="tools-sort" data-testid="tools-sort">
          <span>排序:</span>
          {(["calls", "sessions", "errors"] as const).map((s) => (
            <button
              key={s}
              data-testid={`tools-sort-${s}`}
              data-active={sortBy === s}
              className={`content-chip ${sortBy === s ? "content-chip-active" : ""}`}
              onClick={() => setSortBy(s)}
            >
              {s === "calls" ? "调用次数" : s === "sessions" ? "跨 session" : "失败次数"}
            </button>
          ))}
        </div>
      </header>

      <section className="tools-aggregate" data-testid="tools-aggregate">
        <h2>总览排行 (top 100)</h2>
        <table className="tools-table">
          <thead>
            <tr>
              <th>Tool</th>
              <th>调用次数</th>
              <th>跨 session</th>
              <th>失败</th>
              <th>失败率</th>
            </tr>
          </thead>
          <tbody>
            {aggregate.map((row) => (
              <tr
                key={row.toolName}
                data-testid={`tools-row-${row.toolName}`}
                className={selectedTool === row.toolName ? "selected" : ""}
                onClick={() => setSelectedTool(row.toolName)}
              >
                <td className="tool-name">{row.toolName}</td>
                <td className="num">{row.totalCalls}</td>
                <td className="num">{row.sessionCount}</td>
                <td className="num error">{row.errorCount}</td>
                <td className="num">{(row.errorRate * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {selectedTool && (
        <ToolSessionsSection toolName={selectedTool} onClose={() => setSelectedTool(null)} t={t} />
      )}

      <p className="tools-footer muted">
        最后加载: {loadedAt ? new Date(loadedAt).toLocaleString() : "未知"} ·{" "}
        <Link to="/">← 返回首页</Link>
      </p>
    </div>
  );
}

function ToolSessionsSection({
  toolName,
  onClose,
  t: _t,
}: {
  toolName: string;
  onClose: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const [rows, setRows] = useState<ToolSessionRef[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setErr(null);
    apiGetToolSessions(toolName, 20)
      .then((data) => {
        setRows(data);
        setLoading(false);
      })
      .catch((e) => {
        setErr(String(e));
        setLoading(false);
      });
  }, [toolName]);

  return (
    <section className="tools-sessions" data-testid="tools-sessions">
      <header>
        <h2>"{toolName}" 跨 session (top 20)</h2>
        <button onClick={onClose} className="tools-close" data-testid="tools-sessions-close">
          关闭
        </button>
      </header>
      {loading && <p>加载中…</p>}
      {err && <p className="error">错误: {err}</p>}
      {rows && rows.length > 0 && (
        <table className="tools-table">
          <thead>
            <tr>
              <th>Session ID</th>
              <th>调用次数</th>
              <th>失败</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sessionId} data-testid={`tools-sessions-row-${r.sessionId}`}>
                <td>
                  <Link to={`/session/${r.sessionId}`} className="session-link">
                    {r.sessionId.slice(0, 16)}…
                  </Link>
                </td>
                <td className="num">{r.callCount}</td>
                <td className="num error">{r.errorCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows && rows.length === 0 && <p>无 session 用过此 tool</p>}
    </section>
  );
}
