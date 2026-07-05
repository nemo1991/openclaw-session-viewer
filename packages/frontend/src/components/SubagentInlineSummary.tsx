/**
 * SubagentInlineSummary — Agent 卡片内嵌子代理摘要 (v0.6.0)
 *
 * 设计:
 * - 取代 v0.5.0 那种"点按钮 → navigate 跳走"的交互
 * - Agent 卡片 mount 时,此组件 inline 展开在卡片底部
 * - 调 apiGetSubagentSummary 拉: 消息数 / 工具分布 / 时间段
 * - 用户看完后,仍可点 "打开独立页面" 跳到子 session 详情
 *
 * 性能:
 * - 后端扫描头部 500 行 ≈ 几 ms
 * - 默认展开状态(用户主动看 Agent 卡片就意味着想看子代理信息)
 * - 数据不可用 (文件不存在/IO 错误) 时降级显示描述文字
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BarChart3, Clock, ExternalLink, Loader2, MessageSquare, XCircle } from "lucide-react";

import { apiGetSubagentSummary } from "../lib/api";
import { formatTimeShort } from "../lib/format";
import { useFormatOpts } from "../hooks/useFormatOpts";
import type { SubagentSummary } from "@ocsv/shared";
import "./SubagentInlineSummary.css";

export interface SubagentInlineSummaryProps {
  /** 主 session 的目录路径(不是 subagents/ 路径) */
  parentSessionDir: string;
  /** 子代理 id (e.g. "a1d924c184a57a7da") */
  agentId: string;
  /** 点 "打开子会话详情" 按钮 → 父级 navigate 跳独立页 */
  onOpenChildPage: () => void;
}

export function SubagentInlineSummary({
  parentSessionDir,
  agentId,
  onOpenChildPage,
}: SubagentInlineSummaryProps) {
  const { t } = useTranslation();
  const fmtOpts = useFormatOpts();

  const [summary, setSummary] = useState<SubagentSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiGetSubagentSummary(parentSessionDir, agentId)
      .then((result) => {
        if (cancelled) return;
        setSummary(result);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e?.message ?? e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [parentSessionDir, agentId]);

  // 加载状态
  if (loading) {
    return (
      <div className="subagent-inline-summary is-loading" data-testid="subagent-inline-summary">
        <Loader2 size={12} className="spin" />
        <span>{t("app.loading")}</span>
      </div>
    );
  }

  // 错误或空(子代理文件被删等)
  if (error || !summary) {
    return (
      <div className="subagent-inline-summary is-error" data-testid="subagent-inline-summary">
        <XCircle size={12} />
        <span>{t("detail.subagentPanel.empty")}</span>
        <button
          className="subagent-inline-open-btn"
          onClick={onOpenChildPage}
          title={t("detail.subagentPanel.openChild")}
        >
          <ExternalLink size={11} /> {t("detail.subagentPanel.openChild")}
        </button>
      </div>
    );
  }

  // 工具分布 chip 化(top 3,跟列表保持一致)
  const topTools = summary.toolDistribution.slice(0, 3);
  const remainingTools = summary.toolDistribution.length - topTools.length;

  // 持续时间格式化
  const durStr = summary.durationSeconds != null ? formatDuration(summary.durationSeconds) : null;

  return (
    <div className="subagent-inline-summary" data-testid="subagent-inline-summary">
      <div className="subagent-inline-stats">
        {summary.messageCount != null && (
          <span
            className="subagent-inline-stat"
            title={t("detail.subagentInlineSummary.messageCount", { n: summary.messageCount })}
          >
            <MessageSquare size={11} /> {summary.messageCount}{" "}
            {t("detail.subagentInlineSummary.messages")}
          </span>
        )}
        {durStr && (
          <span
            className="subagent-inline-stat"
            title={`${summary.firstTimestamp} → ${summary.lastTimestamp}`}
          >
            <Clock size={11} /> {durStr}
          </span>
        )}
      </div>

      {topTools.length > 0 && (
        <div className="subagent-inline-tools" data-testid="subagent-inline-tools">
          <BarChart3 size={11} />
          {topTools.map(([name, count]) => (
            <span key={name} className="subagent-inline-tool-chip" title={`${name} × ${count}`}>
              {name}
              <span className="subagent-inline-tool-count">×{count}</span>
            </span>
          ))}
          {remainingTools > 0 && (
            <span
              className="subagent-inline-tool-chip is-muted"
              title={t("detail.subagentInlineSummary.moreTools", { n: remainingTools })}
            >
              +{remainingTools}
            </span>
          )}
        </div>
      )}

      <div className="subagent-inline-meta">
        {summary.firstTimestamp && (
          <span className="subagent-inline-time">
            {formatTimeShort(summary.firstTimestamp, fmtOpts)}
            {summary.lastTimestamp && summary.lastTimestamp !== summary.firstTimestamp && (
              <> → {formatTimeShort(summary.lastTimestamp, fmtOpts)}</>
            )}
          </span>
        )}
        <button
          className="subagent-inline-open-btn"
          onClick={onOpenChildPage}
          data-testid="subagent-inline-open-btn"
          title={t("detail.subagentPanel.openChild")}
        >
          <ExternalLink size={11} /> {t("detail.subagentPanel.openChild")}
        </button>
      </div>
    </div>
  );
}

/** 秒数 → "1m 23s" / "12s" / "1h 5m" */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
