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

import { useMemo } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Download, Sparkles, Search, Activity } from "lucide-react";

import { useTranscriptStore } from "../state/transcriptStore";
import { useSessionsStore } from "../state/sessionsStore";
import { useLivePids } from "../hooks/useLivePids";
import { useSearchInSessionStore } from "../state/searchInSessionStore";
import { useTranscriptPipeline } from "../hooks/useTranscriptPipeline";
import { useTranscriptScroll } from "../hooks/useTranscriptScroll";
import { useSessionUrlSync } from "../hooks/useSessionUrlSync";
import { TranscriptView } from "../views/TranscriptView";
import { SearchInSessionBar } from "../views/SearchInSessionBar";
import { SubagentPanel } from "../components/SubagentPanel";
import { useKey } from "../lib/keymap";
import { formatBytes, formatNumber, formatTimeExact } from "../lib/format";
import { useFormatOpts } from "../hooks/useFormatOpts";
import { apiRevealInFinder } from "../lib/api";
import {
  summarizeSession,
  findRepeatRuns,
  findIdleGaps,
  formatIdleGap,
  type SessionSummary,
  type RepeatRun,
  type IdleGap,
} from "../components/sessionInsights";
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

  // ===== 聚合 + 去噪(从已加载 entries 派生) =====
  const sessionInsights = useMemo(() => {
    const summary: SessionSummary = summarizeSession(entries);
    const repeats: RepeatRun[] = findRepeatRuns(entries, 3);
    const idles: IdleGap[] = findIdleGaps(entries, 5 * 60_000);
    return { summary, repeats, idles };
  }, [entries]);

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
          <h1>{meta.title || meta.sessionId.slice(0, 8)}</h1>
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
          </div>
        </div>
        <div className="session-header-actions">
          <button onClick={() => showSearchBar()} title={t("search.inSession")}>
            <Search size={14} />
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

      {/* 聚合 chip 行 — 一眼看到 session 结构 */}
      <SessionSummaryStrip
        summary={sessionInsights.summary}
        repeats={sessionInsights.repeats}
        idles={sessionInsights.idles}
      />

      {error && (
        <div className="error">
          {t("app.error")}: {error}
        </div>
      )}

      <TranscriptView />
    </div>
  );
}

/**
 * SessionSummaryStrip — 一行聚合 chip
 *
 * 数据来源:summarizeSession / findRepeatRuns / findIdleGaps
 * (纯函数,见 components/sessionInsights.ts)
 *
 * 设计:不抢戏 — 1 行,小字号,色块编码。空数据不渲染。
 */
function SessionSummaryStrip({
  summary,
  repeats,
  idles,
}: {
  summary: SessionSummary;
  repeats: RepeatRun[];
  idles: IdleGap[];
}) {
  // 空 entries 或空 tool 都不显示(避免加载中闪烁)
  if (summary.textMessageCount === 0) return null;
  if (summary.toolUsage.length === 0 && summary.textMessageCount < 3) return null;

  // 取 top 5 tool,剩余合 "其他" 显示计数
  const topTools = summary.toolUsage.slice(0, 5);
  const otherTools = summary.toolUsage.slice(5);
  const otherCount = otherTools.reduce((a, b) => a + b.count, 0);

  return (
    <div className="session-summary-strip" data-testid="session-summary-strip">
      <span className={`ss-phase ss-phase-${summary.phaseHint}`} title={summary.phaseDetail}>
        {summary.phaseHint === "explore" && "探索"}
        {summary.phaseHint === "implement" && "实施"}
        {summary.phaseHint === "mixed" && "混合"}
        {summary.phaseHint === "short" && "短会话"}
        {summary.phaseDetail && <span className="ss-phase-detail"> · {summary.phaseDetail}</span>}
      </span>
      <span className="ss-sep" />
      {topTools.map((t) => (
        <span key={t.tool} className="ss-tool" title={`${t.tool} × ${t.count}`}>
          {t.tool} <span className="ss-tool-count">{t.count}</span>
        </span>
      ))}
      {otherCount > 0 && (
        <span
          className="ss-tool ss-tool-other"
          title={otherTools.map((t) => `${t.tool} × ${t.count}`).join("; ")}
        >
          +{otherTools.length} 其他 <span className="ss-tool-count">{otherCount}</span>
        </span>
      )}
      {summary.subagentCount > 0 && (
        <>
          <span className="ss-sep" />
          <span className="ss-subagent">subagent × {summary.subagentCount}</span>
        </>
      )}
      {summary.thinkingCount > 0 && (
        <>
          <span className="ss-sep" />
          <span className="ss-thinking">thinking × {summary.thinkingCount}</span>
        </>
      )}
      {summary.errorCount > 0 && (
        <>
          <span className="ss-sep" />
          <span className="ss-error" title="包含 stopReason=error 的 assistant message">
            错误 × {summary.errorCount}
          </span>
        </>
      )}
      {repeats.length > 0 && (
        <>
          <span className="ss-sep" />
          <span
            className="ss-repeat"
            title={repeats.map((r) => `${r.tool} × ${r.count}`).join("; ")}
          >
            连续重复 {repeats.length} 段
          </span>
        </>
      )}
      {idles.length > 0 && (
        <>
          <span className="ss-sep" />
          <span
            className="ss-idle"
            title={idles.map((g) => formatIdleGap(g.durationMs)).join("; ")}
          >
            {idles.length} 长间隔 · 最长{" "}
            {formatIdleGap(Math.max(...idles.map((g) => g.durationMs)))}
          </span>
        </>
      )}
    </div>
  );
}
