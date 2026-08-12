/**
 * v0.9.24 (M7-B): SessionHeader — L0 层 chrome
 *
 * 抽出 SessionDetailRoute.tsx 头部 4 个职责:
 * 1. **BackButton** — subCtx 时 "返回父会话" 否则 "返回列表",
 *    复用同一按钮 (避免视觉重复)。handleBack 子会话走
 *    handleBackToParent (loadSessions + find parent jsonlPath + ?path= 持久化),
 *    否则 navigate("/")
 * 2. **HeaderInfo** — title 编辑 (双击 / Enter / Escape / blur 保存) +
 *    archived/pinned/hidden/agentName badge + tags chip +
 *    workspaceGuess/projectKey + primaryModel pill + live PID pill +
 *    SubagentPanel mount + stats row (messages / bytes / firstTimestamp /
 *    totalTokens / duration / latency / user-assistant counts / errorCount /
 *    toolError / meta-counts)
 * 3. **ActionsRow** — 12 个 button:reload (⌘R) / search (⌘F) / pin / hide /
 *    archive / rename / notes / links / trajectory (claude) /
 *    export MD / export HTML / analyze
 *
 * 数据流:
 * - props `meta` 必填,route 已做 notFound 早 return
 * - props `navigate` 用于 back-to-parent / trajectory / analyze 跳转
 * - props `onNotesToggle` 用于 actions row 第 8 个 button (sticky note)
 *   toggle notes 面板可见性 (state 在 route 层)
 * - props `subagentContext` 从 location.state.subagentContext 透传,
 *   决定 back button 是 "返回父会话" 还是 "返回"
 * - props `loadingProgress` (entries/totalCount) 用于 stats row "messages
 *   (loaded/total)" 进度显示
 *
 * 内部 hooks:
 * - `useOverrides()` 读 snap (renames/notes/tags/pinned/hidden/archived) +
 *   调 mutation API
 * - `useLivePids()` 轮询 live PID (5s) 拿本会话 pid/status
 * - `useSessionActions(meta)` 拿 handleReload / handleExport / reloading /
 *   reloadModifier (M7-A 抽好的 hook, 组件内 0 prop drilling)
 * - `useTranslation()` i18n
 * - `useFormatOpts()` 时区解析
 *
 * CSS: 跟 SessionDetailRoute 共享 .session-header* class (子组件 import
 * 父 CSS file, 后续 v0.9.25+ 风险收敛再迁到 session/session.css)。
 *
 * titleEditing state 由 SessionHeader 自身统管: HeaderInfo 是 controlled
 * 子组件, 接受 `titleEditing` + `onTitleEditingChange` props; ActionsRow
 * 的 "重命名" 按钮调 `onStartTitleEdit` 把 header 切到编辑态。这样 2 个
 * 子组件 share 同一份 state, 无 prop drilling。
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NavigateFunction } from "react-router-dom";
import {
  ArrowLeft,
  Download,
  Sparkles,
  Search,
  Activity,
  Pin,
  EyeOff,
  Archive,
  Edit2,
  Link2,
  StickyNote,
  RefreshCw,
} from "lucide-react";

import type { SessionMeta } from "@ocsv/shared";
import { useOverrides } from "../../state/overridesStore";
import { useSessionsStore } from "../../state/sessionsStore";
import { useLivePids } from "../../hooks/useLivePids";
import { useFormatOpts } from "../../hooks/useFormatOpts";
import { useSessionActions } from "../../hooks/useSessionActions";
import { useSearchInSessionStore } from "../../state/searchInSessionStore";
import { SubagentPanel } from "../SubagentPanel";
import {
  formatBytes,
  formatNumber,
  formatTimeExact,
  formatDuration,
  formatLatency,
} from "../../lib/format";
import type { SubagentContext } from "../../routes/SessionDetailRoute";
import "../../routes/SessionDetailRoute.css";

export interface SessionHeaderProps {
  meta: SessionMeta;
  navigate: NavigateFunction;
  /** notes panel 可见性 toggle (state 在 route 层) */
  onNotesToggle: () => void;
  /** link dialog 打开 (state 在 route 层 / SessionNotesPanel 内部) */
  onLinkAdd?: () => void;
  /** 从 location.state.subagentContext 透传, 决定 back button 文案 */
  subagentContext?: SubagentContext;
  /** transcript 加载进度 (entries/totalCount) 给 stats row 显示 */
  loadingProgress?: { loaded: number; total: number } | null;
}

// ===== Sub-component: BackButton =====

function BackButton({
  subCtx,
  onBack,
  parentLabel,
  defaultLabel,
}: {
  subCtx: SubagentContext | undefined;
  onBack: () => void;
  parentLabel: string;
  defaultLabel: string;
}) {
  return (
    <button
      onClick={onBack}
      className="back-btn"
      data-testid={subCtx ? "back-to-parent" : "back-to-list"}
      title={subCtx ? parentLabel : defaultLabel}
    >
      <ArrowLeft size={16} />{" "}
      {subCtx ? (
        <>
          {parentLabel} ({subCtx.parentSessionId.slice(0, 12)}…)
        </>
      ) : (
        defaultLabel
      )}
    </button>
  );
}

// ===== Sub-component: HeaderInfo =====

interface HeaderInfoProps {
  meta: SessionMeta;
  livePidInfo: { pid: number; status: string } | undefined;
  loadingProgress: { loaded: number; total: number } | null;
  titleEditing: boolean;
  onTitleEditingChange: (v: boolean) => void;
}

function HeaderInfo({
  meta,
  livePidInfo,
  loadingProgress,
  titleEditing,
  onTitleEditingChange,
}: HeaderInfoProps) {
  const { t } = useTranslation();
  const fmtOpts = useFormatOpts();
  const overrides = useOverrides();
  const [titleDraft, setTitleDraft] = useState("");

  // 派生: 当前显示 title (override.renames > meta.title > sessionId 前 8)
  const currentTitle =
    overrides.snap.renames[meta.sessionId] ?? meta.title ?? meta.sessionId.slice(0, 8);

  // sessionId 变化时, 如果不在编辑态, 同步 draft (防止 stale draft)
  useEffect(() => {
    if (!titleEditing) {
      setTitleDraft(currentTitle);
    }
  }, [currentTitle, titleEditing]);

  const startTitleEdit = () => {
    setTitleDraft(currentTitle);
    onTitleEditingChange(true);
  };
  const commitTitle = async () => {
    onTitleEditingChange(false);
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === currentTitle) return;
    try {
      await overrides.rename(meta.sessionId, trimmed);
    } catch (e) {
      console.error("rename failed", e);
    }
  };

  const sessionTags = overrides.snap.tags[meta.sessionId] ?? [];

  return (
    <div className="session-header-info">
      <h1>
        {titleEditing ? (
          <input
            className="title-rename-input"
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitTitle();
              if (e.key === "Escape") onTitleEditingChange(false);
            }}
            onBlur={() => void commitTitle()}
            maxLength={80}
          />
        ) : (
          <span onDoubleClick={startTitleEdit} title="双击重命名">
            {currentTitle}
          </span>
        )}
        {meta.archived && (
          <span className="badge-archived" title="已归档">
            🗄️ 已归档
          </span>
        )}
        {meta.pinned && (
          <span className="badge-pinned" title="已置顶">
            📌
          </span>
        )}
        {meta.hidden && (
          <span className="badge-hidden" title="已隐藏">
            🙈
          </span>
        )}
        {/* v0.8.4 item 5: agent-name 静态 pill, 无跳转 (本会话自己的别名) */}
        {meta.agentName && (
          <span
            className="agent-name-pill"
            title={`jsonl agent-name envelope: ${meta.agentName}`}
            data-testid="agent-name-pill"
          >
            🤖 {meta.agentName}
          </span>
        )}
      </h1>
      {sessionTags.length > 0 && (
        <div className="session-tags-row">
          {sessionTags.map((tag: { id: number; name: string; color: string | null }) => (
            <span key={tag.id} className="tag-chip" title={`tag: ${tag.name}`}>
              {tag.name}
            </span>
          ))}
        </div>
      )}
      <div className="session-header-meta">
        <span>{meta.workspaceGuess || meta.projectKey}</span>
        {meta.primaryModel && <span className="model-pill">{meta.primaryModel}</span>}
        {livePidInfo && (
          <span className="live-pill">
            ● {t("detail.pid", { pid: livePidInfo.pid })} · {livePidInfo.status}
          </span>
        )}
        {meta.subagentDir && meta.subagentCount && meta.subagentCount > 0 && (
          <SubagentPanel parentSession={meta} />
        )}
      </div>
      <div className="session-header-stats">
        <span>
          {t("detail.messages", { count: meta.messageCount })}
          {loadingProgress && ` (${loadingProgress.loaded}/${loadingProgress.total})`}
        </span>
        <span>·</span>
        <span>{formatBytes(meta.sizeBytes)}</span>
        {meta.firstTimestamp && (
          <>
            <span>·</span>
            <span title={formatTimeExact(meta.firstTimestamp, fmtOpts)}>
              {formatTimeExact(meta.firstTimestamp, fmtOpts)}
            </span>
          </>
        )}
        {meta.totalTokens && (
          <>
            <span>·</span>
            <span>
              Tokens{" "}
              {formatNumber(
                meta.totalTokens.input +
                  meta.totalTokens.output +
                  meta.totalTokens.cacheRead +
                  meta.totalTokens.cacheWrite
              )}
            </span>
          </>
        )}
        {/* v0.8.4 item 2: 固化指标直接从 meta.* 读, 不再 recompute */}
        {meta.durationSeconds !== undefined && meta.durationSeconds !== null && (
          <>
            <span>·</span>
            <span title="last_ts - first_ts">{formatDuration(meta.durationSeconds)}</span>
          </>
        )}
        {meta.firstResponseLatencyMs !== undefined && meta.firstResponseLatencyMs !== null && (
          <>
            <span>·</span>
            <span title="first assistant - first user">
              first↔resp {formatLatency(meta.firstResponseLatencyMs)}
            </span>
          </>
        )}
        {meta.userMessageCount !== undefined &&
          meta.userMessageCount !== null &&
          meta.assistantMessageCount !== undefined && (
            <>
              <span>·</span>
              <span title="user / assistant 顶层消息计数 (排除 sidechain)">
                {meta.userMessageCount}u / {meta.assistantMessageCount}a
              </span>
            </>
          )}
        {meta.errorCount !== undefined && meta.errorCount !== null && meta.errorCount > 0 && (
          <>
            <span>·</span>
            <span className="stat-error" title="assistant stop_reason==error 或 is_error==true">
              ❌ {meta.errorCount} errors
            </span>
          </>
        )}
        {/* v0.8.5 A: per-tool 失败 — 取 toolError[0] 显示"失败最多: Bash × 5"
         * 跟上面 errorCount 是 message 级不同,这里是 tool-level(单个 tool_result.is_error) */}
        {meta.toolError && meta.toolError.length > 0 && (
          <>
            <span>·</span>
            <span
              className="stat-tool-error"
              title={
                meta.toolError.length === 1
                  ? `${meta.toolError[0]?.[0] ?? "?"} 失败 ${meta.toolError[0]?.[1] ?? 0} 次 (tool_result.is_error)`
                  : `${meta.toolError[0]?.[0] ?? "?"} 失败最多 (${meta.toolError[0]?.[1] ?? 0} 次); 其它: ${meta.toolError
                      .slice(1)
                      .map(([tool, c]) => `${tool} × ${c}`)
                      .join(", ")}`
              }
              data-testid="stat-tool-error"
            >
              🔴 失败最多: {meta.toolError[0]?.[0] ?? "?"} × {meta.toolError[0]?.[1] ?? 0}
            </span>
          </>
        )}
        {/* v0.8.4 item 4: meta 计数 (skills / plans / compact / files / queued) */}
        {(meta.invokedSkillsCount ||
          meta.planFileRefCount ||
          meta.compactFileRefCount ||
          meta.attachedFileCount ||
          meta.queuedCommandCount) && (
          <>
            <span>·</span>
            <span className="meta-counts">
              {meta.invokedSkillsCount ? `⚙${meta.invokedSkillsCount} skills ` : ""}
              {meta.planFileRefCount ? `📋${meta.planFileRefCount} plans ` : ""}
              {meta.compactFileRefCount ? `📦${meta.compactFileRefCount} compact ` : ""}
              {meta.attachedFileCount ? `🗂${meta.attachedFileCount} files ` : ""}
              {meta.queuedCommandCount ? `📤${meta.queuedCommandCount} queued ` : ""}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ===== Sub-component: ActionsRow =====

interface ActionsRowProps {
  meta: SessionMeta;
  navigate: NavigateFunction;
  onNotesToggle: () => void;
  onLinkAdd: () => void;
  onStartTitleEdit: () => void;
}

function ActionsRow({
  meta,
  navigate,
  onNotesToggle,
  onLinkAdd = () => {},
  onStartTitleEdit,
}: ActionsRowProps) {
  const { t } = useTranslation();
  const overrides = useOverrides();
  const showSearchBar = useSearchInSessionStore((s) => s.show);
  const { handleReload, handleExport, reloading, reloadModifier } = useSessionActions({
    meta,
    targetPath: meta.jsonlPath,
    sessionId: meta.sessionId,
    navigate,
    pathnameSearch: `/session/${encodeURIComponent(meta.sessionId)}`,
  });

  return (
    <div className="session-header-actions">
      <button
        onClick={() => void handleReload()}
        disabled={reloading}
        className={reloading ? "reloading" : ""}
        data-testid="reload-btn"
        title={`重新解析 jsonl + 触发后端 sync (${reloadModifier}+R)`}
      >
        <RefreshCw size={14} className={reloading ? "spin" : ""} />
      </button>
      <button onClick={() => showSearchBar()} title={t("search.inSession")}>
        <Search size={14} />
      </button>
      <button
        onClick={() => overrides.togglePinned(meta.sessionId, !meta.pinned)}
        className={meta.pinned ? "primary" : ""}
        title={meta.pinned ? "取消置顶" : "置顶"}
      >
        <Pin size={14} />
      </button>
      <button
        onClick={() => overrides.toggleHide(meta.sessionId, !meta.hidden)}
        className={meta.hidden ? "primary" : ""}
        title={meta.hidden ? "取消隐藏" : "隐藏"}
      >
        <EyeOff size={14} />
      </button>
      <button
        onClick={() => overrides.setArchived(meta.sessionId, !meta.archived)}
        className={meta.archived ? "primary" : ""}
        title={meta.archived ? "取消归档" : "归档"}
      >
        <Archive size={14} />
      </button>
      <button onClick={onStartTitleEdit} title="重命名">
        <Edit2 size={14} />
      </button>
      <button onClick={onNotesToggle} title="笔记">
        <StickyNote size={14} />
      </button>
      <button onClick={onLinkAdd} title="链接到其他 session">
        <Link2 size={14} />
      </button>
      {meta.hasTrajectory && (
        <button
          onClick={() =>
            navigate(`/session/${encodeURIComponent(meta.sessionId)}/trajectory`, {
              state: { session: meta },
            })
          }
          title={t("detail.trajectory")}
        >
          <Activity size={14} /> {t("detail.trajectory")}
        </button>
      )}
      <button
        onClick={() => handleExport("md")}
        data-testid="export-md"
        title={t("detail.exportMd")}
      >
        <Download size={14} /> MD
      </button>
      <button
        onClick={() => handleExport("html")}
        data-testid="export-html"
        title={t("detail.exportHtml")}
      >
        <Download size={14} /> HTML
      </button>
      <button
        onClick={() =>
          navigate(`/analyze/${encodeURIComponent(meta.sessionId)}`, {
            state: { session: meta },
          })
        }
        className="primary"
      >
        <Sparkles size={14} /> {t("detail.analyze")}
      </button>
    </div>
  );
}

// ===== Main component: SessionHeader =====

export function SessionHeader({
  meta,
  navigate,
  onNotesToggle,
  onLinkAdd,
  subagentContext,
  loadingProgress,
}: SessionHeaderProps) {
  const { t } = useTranslation();
  const { livePids } = useLivePids();

  // 实时 PID (从 livePids 找本会话)
  const livePidInfo = useMemo(() => {
    const info = livePids.find((p) => p.sessionId === meta.sessionId);
    return info ? { pid: info.pid, status: info.status } : undefined;
  }, [meta.sessionId, livePids]);

  // handleBack — 子会话场景下"返回"回父会话,否则回列表
  const sessions = useSessionsStore((s) => s.sessions);
  const loadSessions = useSessionsStore((s) => s.load);
  const handleBackToParent = async () => {
    if (!subagentContext) return;
    let allSessions = sessions;
    if (allSessions.length === 0) {
      await loadSessions();
      allSessions = useSessionsStore.getState().sessions;
    }
    const parent = allSessions.find((s) => s.sessionId === subagentContext.parentSessionId);
    if (parent) {
      // 走 ?path= 持久化路径 — 父页能正常加载
      navigate(
        `/session/${encodeURIComponent(parent.sessionId)}?path=${encodeURIComponent(parent.jsonlPath)}`,
        { state: { session: parent } }
      );
    } else {
      // 父 session 不在 list_sessions 里 (罕见, 如被删) — 至少 navigate 不带 state,
      // 父页会显示 notFound, 但 URL 至少是合理的
      navigate(`/session/${encodeURIComponent(subagentContext.parentSessionId)}`);
    }
  };
  const handleBack = () => {
    if (subagentContext) {
      void handleBackToParent();
    } else {
      navigate("/");
    }
  };

  // titleEditing state 由 SessionHeader 自身统管: HeaderInfo 是 controlled,
  // ActionsRow 的 "重命名" 按钮调 onStartTitleEdit 把 header 切到编辑态
  const [titleEditing, setTitleEditing] = useState(false);
  const startTitleEdit = () => {
    setTitleEditing(true);
  };

  return (
    <header className="session-header" data-testid="session-header">
      <BackButton
        subCtx={subagentContext}
        onBack={handleBack}
        parentLabel={t("detail.subagentPanel.backToParent")}
        defaultLabel={t("detail.back")}
      />
      <HeaderInfo
        meta={meta}
        livePidInfo={livePidInfo}
        loadingProgress={loadingProgress ?? null}
        titleEditing={titleEditing}
        onTitleEditingChange={setTitleEditing}
      />
      <ActionsRow
        meta={meta}
        navigate={navigate}
        onNotesToggle={onNotesToggle}
        onLinkAdd={onLinkAdd ?? (() => {})}
        onStartTitleEdit={startTitleEdit}
      />
    </header>
  );
}
