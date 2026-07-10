/**
 * SessionDetailRoute — Container 角色(slim)
 *
 * 重构后(v0.4.5):
 * - 删除 2 个空 useEffect(只剩注释,曾用于解析 path)
 * - 4 个 store 字段用 selector 分别订阅
 * - jumpToEntry 从 useTranscriptScroll 取(取代 DOM querySelector + scrollIntoView)
 * - URL sync 委托 useSessionUrlSync hook
 *   (修真实 bug: ?line=N 之前依赖 entries.length 永远首次为 0 时不触发)
 * - data-testid 给 E2E 用
 */

import { useMemo, useState, useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
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
  X,
  Tag as TagIcon,
} from "lucide-react";

import { useTranscriptStore } from "../state/transcriptStore";
import { useSessionsStore } from "../state/sessionsStore";
import { useOverrides } from "../state/overridesStore";
import { useLivePids } from "../hooks/useLivePids";
import { useSearchInSessionStore } from "../state/searchInSessionStore";
import { useTranscriptPipeline } from "../hooks/useTranscriptPipeline";
import { useTranscriptScroll } from "../hooks/useTranscriptScroll";
import { useSessionUrlSync } from "../hooks/useSessionUrlSync";
import { TranscriptView } from "../views/TranscriptView";
import { SearchInSessionBar } from "../views/SearchInSessionBar";
import { SubagentPanel } from "../components/SubagentPanel";
import { useKey } from "../lib/keymap";
import {
  formatBytes,
  formatNumber,
  formatTimeExact,
  formatDuration,
  formatLatency,
} from "../lib/format"; // v0.8.4 item 2/5
import { useFormatOpts } from "../hooks/useFormatOpts";
import { apiRevealInFinder } from "../lib/api";
// v0.8.4 item 2': SessionSummaryStrip 全部从 meta.* 读, 不再调 summarizeSession / findRepeatRuns / findIdleGaps
// 纯函数仍保留给 TrajectoryRoute / AnalyzeRoute / 未来 v0.8.5+ 复用, 不再 import
import type { SessionMeta } from "@ocsv/shared";
import "./SessionDetailRoute.css";

/** v0.5.0:从 location.state 读 subagentContext(由 SubagentPanel 跳来时填充) */
interface SubagentContext {
  parentSessionId: string;
  agentId: string;
  agentType?: string | null;
}

export default function SessionDetailRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const fmtOpts = useFormatOpts();

  // 4 个独立 selector(避免任一字段变化触发整页重渲染)
  const start = useTranscriptStore((s) => s.start);
  const entries = useTranscriptStore((s) => s.entries);
  const loading = useTranscriptStore((s) => s.loading);
  const totalCount = useTranscriptStore((s) => s.totalCount);
  const error = useTranscriptStore((s) => s.error);
  const path = useTranscriptStore((s) => s.path);

  const { livePids } = useLivePids();
  const showSearchBar = useSearchInSessionStore((s) => s.show);

  // v0.5.0:子代理跳转用 ?path=... 持久化(子代理不在 list_sessions 里,
  // F5 后 state 丢失 → 仍能从 URL 找到 jsonl)。
  // 优先 URL ?path= → fallback location.state.session.jsonlPath
  const pathFromQuery = useMemo(() => {
    const sp = new URLSearchParams(location.search);
    return sp.get("path");
  }, [location.search]);
  const metaFromState = (location.state as { session?: SessionMeta } | null)?.session;

  // v0.5.0 修复:从子代理跳转时,若 location.state 因 F5/直链丢失,
  // 用 ?path= 构造一个最小 meta,避免走 notFound 分支。
  // 这个 meta 字段少(没 messageCount/sizeBytes 等),仅够 TranscriptView 加载
  // 和 header 显示"返回父会话"按钮用。
  const meta: SessionMeta | undefined = useMemo(() => {
    if (metaFromState) return metaFromState;
    if (!pathFromQuery || !sessionId) return undefined;
    // basename(去掉 .jsonl)就是子代理 id 形式 (e.g. "agent-a1d92" → "a1d92")
    // 但我们的 sessionId 就是 agentId(panel navigate 时直接用的)
    return {
      sessionId,
      projectKey: "(subagent)",
      workspaceGuess: null,
      source: "claude",
      jsonlPath: pathFromQuery,
      sizeBytes: 0,
      mtimeMs: 0,
      messageCount: 0,
      title: sessionId.slice(0, 16),
      hasTrajectory: false,
    };
  }, [metaFromState, pathFromQuery, sessionId]);

  const targetPath = pathFromQuery ?? meta?.jsonlPath;

  // 流式加载 transcript
  useMemo(() => {
    if (targetPath) void start(targetPath);
  }, [targetPath, start]);

  // 实时 PID(从 livePids 找本会话)
  const liveInfo = useMemo(
    () => (meta?.sessionId ? livePids.find((p) => p.sessionId === meta.sessionId) : undefined),
    [meta, livePids]
  );

  // ===== 聚合 + 去噪: v0.8.4 item 2' 起全部从 meta.* 读, 不再 O(n) 扫 entries =====

  // 当前搜索命中(传给 useTranscriptScroll)
  const currentHit = useSearchInSessionStore(
    (s) => (s.currentHitIndex >= 0 ? s.hits[s.currentHitIndex] : null) ?? null
  );
  const { sortedEntries } = useTranscriptPipeline();
  const { jumpToEntry } = useTranscriptScroll({ sortedEntries, currentHit });

  // URL → store / scroll 同步(修 ?line=N 首次 entries 为 0 不触发的 bug)
  useSessionUrlSync({
    search: location.search,
    entriesLoaded: entries.length > 0,
    jumpToEntry,
  });

  // Cmd+F:会话内搜索(handler 引用稳定,deps 用 [])
  useKey(
    "cmd+f",
    (e) => {
      e.preventDefault();
      showSearchBar();
    },
    []
  );
  useKey(
    "ctrl+f",
    (e) => {
      e.preventDefault();
      showSearchBar();
    },
    []
  );

  const handleExport = async (format: "md" | "html") => {
    if (!targetPath) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const ext = format === "md" ? "md" : "html";
    const out = await save({
      defaultPath: `${meta?.title ?? sessionId}.${ext}`,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    });
    if (!out) return;
    const { apiExportMarkdown, apiExportHtml } = await import("../lib/api");
    if (format === "md") {
      await apiExportMarkdown(targetPath, out);
    } else {
      await apiExportHtml(targetPath, out);
    }
    await apiRevealInFinder(out, null, true);
  };

  if (!meta) {
    return (
      <div className="session-detail">
        <div className="empty">{t("detail.notFound")}</div>
        <button onClick={() => navigate("/")}>{t("detail.back")}</button>
      </div>
    );
  }

  // v0.5.0:子会话识别 — 从 location.state 读 subagentContext
  const subCtx = (location.state as { subagentContext?: SubagentContext } | null)?.subagentContext;

  // v0.5.0 修复:back-to-parent 跳转时,从 sessionsStore 找父 jsonlPath,
  // 通过 ?path= 持久化,避免父页 meta=undefined → notFound。
  // sessions 可能在子会话详情页打开时尚未加载,此时 click 触发一次 load 再 navigate。
  const sessions = useSessionsStore((s) => s.sessions);
  const loadSessions = useSessionsStore((s) => s.load);

  // v0.8.0: override (rename/hide/pin/archive/notes/tags/links)
  const overrides = useOverrides();
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [notesEditing, setNotesEditing] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState("");
  const [linkNote, setLinkNote] = useState("");

  // sessionId 切换时重置 notes 草稿
  useEffect(() => {
    if (meta) {
      setNotesDraft(overrides.snap.notes[meta.sessionId] ?? "");
    }
  }, [meta?.sessionId, overrides.snap.notes]);

  const currentTitle = meta
    ? (overrides.snap.renames[meta.sessionId] ?? meta.title ?? meta.sessionId.slice(0, 8))
    : "";

  const startTitleEdit = () => {
    setTitleDraft(currentTitle);
    setTitleEditing(true);
  };
  const commitTitle = async () => {
    setTitleEditing(false);
    if (!meta) return;
    const trimmed = titleDraft.trim();
    if (!trimmed || trimmed === currentTitle) return;
    try {
      await overrides.rename(meta.sessionId, trimmed);
    } catch (e) {
      console.error("rename failed", e);
    }
  };

  const commitNotes = async () => {
    setNotesEditing(false);
    if (!meta) return;
    try {
      await overrides.setNotes(meta.sessionId, notesDraft);
    } catch (e) {
      console.error("setNotes failed", e);
    }
  };

  const addLink = async () => {
    if (!meta || !linkTarget.trim()) return;
    try {
      await overrides.addLink(meta.sessionId, linkTarget.trim(), linkNote.trim() || undefined);
      setLinkDialogOpen(false);
      setLinkTarget("");
      setLinkNote("");
    } catch (e) {
      console.error("addLink failed", e);
    }
  };

  const sessionTags = meta ? (overrides.snap.tags[meta.sessionId] ?? []) : [];
  const linksTo = meta ? (overrides.snap.linksTo[meta.sessionId] ?? []) : [];
  const linksFrom = meta ? (overrides.snap.linksFrom[meta.sessionId] ?? []) : [];
  const handleBackToParent = async () => {
    if (!subCtx) return;
    // 先确保 sessions 列表有数据(若没 mount 过,load 一次)
    let allSessions = sessions;
    if (allSessions.length === 0) {
      await loadSessions();
      allSessions = useSessionsStore.getState().sessions;
    }
    const parent = allSessions.find((s) => s.sessionId === subCtx.parentSessionId);
    if (parent) {
      // 走 ?path= 持久化路径 — 父页能正常加载
      navigate(
        `/session/${encodeURIComponent(parent.sessionId)}?path=${encodeURIComponent(parent.jsonlPath)}`,
        { state: { session: parent } }
      );
    } else {
      // 父 session 不在 list_sessions 里(罕见,如被删) — 至少 navigate 不带 state,
      // 父页会显示 notFound,但 URL 至少是合理的
      navigate(`/session/${encodeURIComponent(subCtx.parentSessionId)}`);
    }
  };

  // v0.5.0:返回按钮逻辑 — 子会话场景下"返回"回父会话,否则回列表。
  // 复用同一按钮,不再单独渲染顶部 back-to-parent 条,避免视觉重复。
  const handleBack = () => {
    if (subCtx) {
      void handleBackToParent();
    } else {
      navigate("/");
    }
  };

  return (
    <div className="session-detail">
      <header className="session-header" data-testid="session-header">
        <button
          onClick={handleBack}
          className="back-btn"
          data-testid={subCtx ? "back-to-parent" : "back-to-list"}
          title={subCtx ? t("detail.subagentPanel.backToParent") : t("detail.back")}
        >
          <ArrowLeft size={16} />{" "}
          {subCtx ? (
            <>
              {t("detail.subagentPanel.backToParent")} ({subCtx.parentSessionId.slice(0, 12)}…)
            </>
          ) : (
            t("detail.back")
          )}
        </button>
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
                  if (e.key === "Escape") setTitleEditing(false);
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
              {sessionTags.map((t: { id: number; name: string; color: string | null }) => (
                <span key={t.id} className="tag-chip" title={`tag: ${t.name}`}>
                  {t.name}
                </span>
              ))}
            </div>
          )}
          <div className="session-header-meta">
            <span>{meta.workspaceGuess || meta.projectKey}</span>
            {meta.primaryModel && <span className="model-pill">{meta.primaryModel}</span>}
            {liveInfo && (
              <span className="live-pill">
                ● {t("detail.pid", { pid: liveInfo.pid })} · {liveInfo.status}
              </span>
            )}
            {meta.subagentDir && meta.subagentCount && meta.subagentCount > 0 && (
              <SubagentPanel parentSession={meta} />
            )}
          </div>
          <div className="session-header-stats">
            <span>
              {t("detail.messages", { count: meta.messageCount })}
              {loading && ` (${entries.length}/${totalCount})`}
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
                          .map(([t, c]) => `${t} × ${c}`)
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
        <div className="session-header-actions">
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
          <button onClick={startTitleEdit} title="重命名">
            <Edit2 size={14} />
          </button>
          <button onClick={() => setNotesEditing((v) => !v)} title="笔记">
            <StickyNote size={14} />
          </button>
          <button onClick={() => setLinkDialogOpen(true)} title="链接到其他 session">
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
      </header>

      <SearchInSessionBar />

      {/* 聚合 chip 行 — 一眼看到 session 结构 (v0.8.4 item 2' 全部从 meta.* 读) */}
      <SessionSummaryStrip meta={meta} />

      {/* v0.8.0: notes 编辑面板 + links 列表 */}
      {(notesEditing || overrides.snap.notes[meta.sessionId]) && (
        <div className="session-notes-panel" data-testid="session-notes-panel">
          <div className="notes-header">
            <StickyNote size={14} />
            <span>笔记</span>
            {notesEditing && (
              <button onClick={() => void commitNotes()} className="notes-save">
                保存
              </button>
            )}
            {!notesEditing && (
              <button
                onClick={() => {
                  setNotesDraft(overrides.snap.notes[meta.sessionId] ?? "");
                  setNotesEditing(true);
                }}
              >
                编辑
              </button>
            )}
          </div>
          {notesEditing ? (
            <textarea
              autoFocus
              value={notesDraft}
              onChange={(e) => setNotesDraft(e.target.value)}
              placeholder="Markdown 笔记..."
              rows={6}
            />
          ) : (
            <pre className="notes-display">{overrides.snap.notes[meta.sessionId]}</pre>
          )}
        </div>
      )}

      {(linksTo.length > 0 || linksFrom.length > 0) && (
        <div className="session-links-panel">
          {linksTo.length > 0 && (
            <div className="links-group">
              <h4>链接到 →</h4>
              {linksTo.map((l: any) => (
                <div key={l.toSession} className="link-item">
                  <span>{l.toSession.slice(0, 12)}…</span>
                  {l.note && <span className="link-note">({l.note})</span>}
                  <button
                    onClick={() => overrides.removeLink(meta.sessionId, l.toSession)}
                    title="删除链接"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {linksFrom.length > 0 && (
            <div className="links-group">
              <h4>被链接 ←</h4>
              {linksFrom.map((l: any) => (
                <div key={l.fromSession} className="link-item">
                  <span>{l.fromSession.slice(0, 12)}…</span>
                  {l.note && <span className="link-note">({l.note})</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {linkDialogOpen && (
        <div className="link-dialog-backdrop" onClick={() => setLinkDialogOpen(false)}>
          <div className="link-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>链接到其他 session</h3>
            <input
              autoFocus
              placeholder="目标 session id"
              value={linkTarget}
              onChange={(e) => setLinkTarget(e.target.value)}
            />
            <input
              placeholder="备注(可选)"
              value={linkNote}
              onChange={(e) => setLinkNote(e.target.value)}
            />
            <div className="link-dialog-actions">
              <button onClick={() => setLinkDialogOpen(false)}>取消</button>
              <button onClick={() => void addLink()} className="primary">
                添加
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="error">
          {t("app.error")}: {error}
        </div>
      )}

      {/* v0.8.4 item 2'': meta 传给 TranscriptView 给 ContentFilterPanel 派生 availableTools */}
      <TranscriptView meta={meta} />
    </div>
  );
}

/**
 * SessionSummaryStrip — 一行聚合 chip
 *
 * v0.8.4 item 2': 全部从 `meta.*` 读 (DB 算好的派生数据), 不再调
 * `summarizeSession` / `findRepeatRuns` / `findIdleGaps` 实时 O(n) 扫 entries。
 *
 * 数据流:
 * - 后端 sync 二阶段 enrich: `build_meta_full` 算 9 个字段 → 写 session_meta
 * - 前端打开详情: 读 meta.* → 显示 chip
 * - 第一次 sync 走 quick path (50 行), `textMessageCount` + `toolUsage` 即可拿到
 *   (用户立刻看到); `phaseHint` / `repeatRun*` / `idleGap*` 走 enrich, 略等 ~1s
 *
 * 设计: 不抢戏 — 1 行, 小字号, 色块编码. 空数据不渲染。
 */
function SessionSummaryStrip({ meta }: { meta: SessionMeta }) {
  const textMsg = meta.textMessageCount ?? 0;
  const toolUsage = meta.toolUsage ?? [];
  const phaseHint = meta.phaseHint;
  const phaseDetail = meta.phaseDetail;
  const repeatRunCount = meta.repeatRunCount ?? 0;
  const idleGapCount = meta.idleGapCount ?? 0;
  const subagentCount = meta.subagentCount ?? 0;
  const thinkingCount = meta.thinkingCount ?? 0;
  const errorCount = meta.errorCount ?? 0;

  // 空数据不显示(避免加载中闪烁 / 完全没 scan 过的旧 session)
  if (textMsg === 0) return null;
  if (toolUsage.length === 0 && textMsg < 3) return null;
  // 没 phaseHint 说明 enrich 还没跑完 — 等一下
  if (!phaseHint) return null;

  // 取 top 5 tool, 剩余合 "其他" 显示计数
  const topTools = toolUsage.slice(0, 5);
  const otherTools = toolUsage.slice(5);
  const otherCount = otherTools.reduce((a, [, c]) => a + c, 0);
  // v0.8.5 D: 工具占比 % — 总调用数算分母, top 5 每条显示 (count/totalCalls * 100)%
  const totalCalls = toolUsage.reduce((a, [, c]) => a + c, 0);

  return (
    <div className="session-summary-strip" data-testid="session-summary-strip">
      <span className={`ss-phase ss-phase-${phaseHint}`} title={phaseDetail}>
        {phaseHint === "explore" && "探索"}
        {phaseHint === "implement" && "实施"}
        {phaseHint === "mixed" && "混合"}
        {phaseHint === "short" && "短会话"}
        {phaseDetail && <span className="ss-phase-detail"> · {phaseDetail}</span>}
      </span>
      <span className="ss-sep" />
      {topTools.map(([tool, count]) => {
        const pct = totalCalls > 0 ? Math.round((count / totalCalls) * 100) : 0;
        return (
          <span
            key={tool}
            className="ss-tool"
            title={`${tool} × ${count} (${pct}%)`}
            data-testid={`ss-tool-${tool}`}
          >
            {tool} <span className="ss-tool-count">{count}</span>
            <span className="ss-tool-pct">{pct}%</span>
          </span>
        );
      })}
      {otherCount > 0 && (
        <span
          className="ss-tool ss-tool-other"
          title={otherTools.map(([t, c]) => `${t} × ${c}`).join("; ")}
        >
          +{otherTools.length} 其他 <span className="ss-tool-count">{otherCount}</span>
        </span>
      )}
      {subagentCount > 0 && (
        <>
          <span className="ss-sep" />
          <span className="ss-subagent">subagent × {subagentCount}</span>
        </>
      )}
      {thinkingCount > 0 && (
        <>
          <span className="ss-sep" />
          <span className="ss-thinking">thinking × {thinkingCount}</span>
        </>
      )}
      {errorCount > 0 && (
        <>
          <span className="ss-sep" />
          <span className="ss-error" title="包含 stopReason=error 的 assistant message">
            错误 × {errorCount}
          </span>
        </>
      )}
      {repeatRunCount > 0 && (
        <>
          <span className="ss-sep" />
          <span
            className="ss-repeat"
            title={
              meta.repeatRunMaxTool && meta.repeatRunMaxCount
                ? `${meta.repeatRunMaxTool} × ${meta.repeatRunMaxCount} (最大段)`
                : `${repeatRunCount} 段连续重复`
            }
          >
            连续重复 {repeatRunCount} 段
            {meta.repeatRunMaxTool && meta.repeatRunMaxCount && (
              <>
                {" · "}
                <span className="ss-repeat-max">
                  {meta.repeatRunMaxTool} × {meta.repeatRunMaxCount}
                </span>
              </>
            )}
          </span>
        </>
      )}
      {idleGapCount > 0 && meta.idleGapMaxMs && (
        <>
          <span className="ss-sep" />
          <span className="ss-idle" title={`最长间隔 ${formatIdleGapFromMs(meta.idleGapMaxMs)}`}>
            {idleGapCount} 长间隔 · 最长 {formatIdleGapFromMs(meta.idleGapMaxMs)}
          </span>
        </>
      )}
    </div>
  );
}

/** ms → "5 分钟" / "2 小时" / "3 天" — SST 自带, 不依赖 sessionInsights 模块 */
function formatIdleGapFromMs(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return min % 60 > 0 ? `${hr} 小时 ${min % 60} 分` : `${hr} 小时`;
  const day = Math.floor(hr / 24);
  return hr % 24 > 0 ? `${day} 天 ${hr % 24} 小时` : `${day} 天`;
}
