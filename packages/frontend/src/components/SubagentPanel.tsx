/**
 * SubagentPanel — 主会话详情页"子代理面板"
 *
 * v0.5.0 新增。展示主会话派出哪些子代理、按时间排、提供"打开子会话详情"按钮。
 *
 * 数据流:
 * 1. props.parentSession.subagentCount > 0 → 父组件渲染 trigger
 * 2. 用户点 trigger 展开 → 本组件渲染
 * 3. useEffect 调 apiListSubagentsByMeta(parentSession) 拿详情
 * 4. 渲染 N 行(每行:agentType badge + description + 时间 + 大小 + 打开按钮)
 *
 * 关键设计:
 * - 只在展开时调 list_subagents(轻量级) — 不在主会话 mount 时调
 * - apiListSubagentsByMeta 自动 fallback 到 [] 如果 subagentDir 不存在
 * - 点击"打开"按钮 → navigate 到 /session/<agentId>,带 state.session + state.subagentContext
 *   让子会话 SessionDetailRoute 显示"返回父会话"按钮
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, ExternalLink, Users } from "lucide-react";

import { apiListSubagentsByMeta } from "../lib/api";
import { formatBytes, formatTimeShort } from "../lib/format";
import { useFormatOpts } from "../hooks/useFormatOpts";
import type { SessionMeta, SubagentMeta } from "@ocsv/shared";
import "./SubagentPanel.css";

export interface SubagentPanelProps {
  /** 主会话的 SessionMeta(用 subagentDir + primaryModel + projectKey) */
  parentSession: SessionMeta;
}

/** 展开后渲染的内嵌 panel 主体 */
function SubagentPanelBody({
  parentSession,
  onClose,
}: {
  parentSession: SessionMeta;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const fmtOpts = useFormatOpts();
  const navigate = useNavigate();

  const [subs, setSubs] = useState<SubagentMeta[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 按 firstTimestamp 升序排(早派出 → 后派出)
  const sortedSubs = (subs ?? []).slice().sort((a, b) => {
    const ta = a.firstTimestamp ?? "";
    const tb = b.firstTimestamp ?? "";
    return ta.localeCompare(tb);
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiListSubagentsByMeta(parentSession)
      .then((result) => {
        if (cancelled) return;
        setSubs(result);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e?.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [parentSession]);

  const handleOpenSubagent = (s: SubagentMeta) => {
    // 跳到子会话详情页。
    //
    // ⚠️ 关键修复 (v0.5.0): 子代理 **不在 list_sessions 里**(只有主 session 在),
    // 详情页 `location.state.session` 必须是构造的虚拟 session(否则走 list_sessions 路径找不到)。
    // 同时把 path 用 URL query `?path=...` 持久化,作为 location.state 丢失时的 fallback,
    // 并让 F5 刷新后仍能定位子代理 jsonl。
    navigate(`/session/${encodeURIComponent(s.agentId)}?path=${encodeURIComponent(s.jsonlPath)}`, {
      state: {
        session: {
          sessionId: s.agentId,
          jsonlPath: s.jsonlPath,
          title: s.description ?? s.agentId,
          workspaceGuess: parentSession.workspaceGuess ?? parentSession.projectKey,
          projectKey: parentSession.projectKey,
          primaryModel: parentSession.primaryModel ?? null,
          messageCount: s.messageCount ?? 0,
          sizeBytes: 0, // 子代理不直接展示
          firstTimestamp: s.firstTimestamp ?? null,
          hasTrajectory: false,
          subagentDir: null,
          totalTokens: undefined,
          source: "claude",
        },
        subagentContext: {
          parentSessionId: parentSession.sessionId,
          agentId: s.agentId,
          agentType: s.agentType ?? null,
        },
      },
    });
  };

  return (
    <div className="subagent-panel" data-testid="subagent-panel">
      <div className="subagent-panel-header">
        <Users size={14} />
        <span className="subagent-panel-title">
          {t("detail.subagentPanel.title", {
            count: parentSession.subagentCount ?? subs?.length ?? 0,
          })}
        </span>
        <button
          className="subagent-panel-close"
          onClick={onClose}
          aria-label={t("detail.subagentPanel.close")}
          title={t("detail.subagentPanel.close")}
        >
          <ChevronUp size={14} />
        </button>
      </div>

      <div className="subagent-panel-body">
        {loading && <div className="subagent-loading">{t("app.loading")}</div>}
        {error && <div className="subagent-error">{error}</div>}
        {!loading && !error && sortedSubs.length === 0 && (
          <div className="subagent-empty">{t("detail.subagentPanel.empty")}</div>
        )}
        {!loading && !error && sortedSubs.length > 0 && (
          <ul className="subagent-list">
            {sortedSubs.map((s, i) => {
              const dur =
                s.firstTimestamp && s.lastTimestamp
                  ? `${formatTimeShort(s.firstTimestamp, fmtOpts)} → ${formatTimeShort(
                      s.lastTimestamp,
                      fmtOpts
                    )}`
                  : formatTimeShort(s.firstTimestamp ?? undefined, fmtOpts);
              return (
                <li
                  key={s.agentId}
                  className="subagent-row"
                  data-testid="subagent-row"
                  data-agent-id={s.agentId}
                >
                  <span className="subagent-idx">#{i + 1}</span>
                  <code className="subagent-id" title={s.agentId}>
                    agent-{s.agentId.slice(0, 16)}
                    {s.agentId.length > 16 ? "…" : ""}
                  </code>
                  {s.agentType && (
                    <span
                      className="subagent-type-badge"
                      data-testid="subagent-type"
                      data-agent-type={s.agentType}
                    >
                      {s.agentType}
                    </span>
                  )}
                  {s.description && (
                    <span className="subagent-desc" title={s.description}>
                      {s.description}
                    </span>
                  )}
                  <span className="subagent-meta">
                    {dur}
                    {s.messageCount != null && <> · {s.messageCount} 条</>}
                  </span>
                  <button
                    className="subagent-open-btn"
                    data-testid="subagent-open-btn"
                    onClick={() => handleOpenSubagent(s)}
                    title={t("detail.subagentPanel.openChild")}
                  >
                    <ExternalLink size={11} /> {t("detail.subagentPanel.openChild")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * SubagentPanel — trigger + body 组合。
 * - count > 0 时渲染 trigger(显示 ⎇ 子代理 (N) [展开])
 * - 点击 trigger 切换展开/收起
 */
export function SubagentPanel({ parentSession }: SubagentPanelProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const count = parentSession.subagentCount ?? 0;

  if (count <= 0) return null;

  return (
    <div className="subagent-trigger-wrap">
      <button
        type="button"
        className="subagent-trigger"
        data-testid="subagent-trigger"
        data-count={count}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Users size={12} />
        <span>{t("detail.subagentTrigger", { count })}</span>
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open && <SubagentPanelBody parentSession={parentSession} onClose={() => setOpen(false)} />}
    </div>
  );
}

// 注:formatBytes 引入为后续扩展(展示子代理大小)保留
void formatBytes;
