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
import { useLivePids } from "../hooks/useLivePids";
import { useSearchInSessionStore } from "../state/searchInSessionStore";
import { useTranscriptPipeline } from "../hooks/useTranscriptPipeline";
import { useTranscriptScroll } from "../hooks/useTranscriptScroll";
import { useSessionUrlSync } from "../hooks/useSessionUrlSync";
import { TranscriptView } from "../views/TranscriptView";
import { SearchInSessionBar } from "../views/SearchInSessionBar";
import { useKey } from "../lib/keymap";
import { formatBytes, formatNumber, formatTimeExact } from "../lib/format";
import { useFormatOpts } from "../hooks/useFormatOpts";
import { apiRevealInFinder } from "../lib/api";
import type { SessionMeta } from "@ocsv/shared";
import "./SessionDetailRoute.css";

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

  const meta = (location.state as { session?: SessionMeta } | null)?.session;
  const targetPath = meta?.jsonlPath;

  // 流式加载 transcript
  useMemo(() => {
    if (targetPath) void start(targetPath);
  }, [targetPath, start]);

  // 实时 PID(从 livePids 找本会话)
  const liveInfo = useMemo(
    () => (meta?.sessionId ? livePids.find((p) => p.sessionId === meta.sessionId) : undefined),
    [meta, livePids]
  );

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
    await apiRevealInFinder(out);
  };

  if (!meta) {
    return (
      <div className="session-detail">
        <div className="empty">{t("detail.notFound")}</div>
        <button onClick={() => navigate("/")}>{t("detail.back")}</button>
      </div>
    );
  }

  return (
    <div className="session-detail">
      <header className="session-header" data-testid="session-header">
        <button onClick={() => navigate("/")} className="back-btn">
          <ArrowLeft size={16} /> {t("detail.back")}
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
            {meta.subagentDir && <span>⎇ {t("detail.subagent")}</span>}
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

      {error && (
        <div className="error">
          {t("app.error")}: {error}
        </div>
      )}

      <TranscriptView />
    </div>
  );
}
