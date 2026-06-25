import { useEffect, useMemo } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Download, Sparkles, Search } from "lucide-react";

import { useTranscriptStore } from "../state/transcriptStore";
import { useLivePids } from "../hooks/useLivePids";
import { useSearchInSessionStore } from "../state/searchInSessionStore";
import { useTranscriptFilterStore } from "../state/transcriptFilterStore";
import { TranscriptView } from "../views/TranscriptView";
import { SearchInSessionBar } from "../views/SearchInSessionBar";
import { useKey } from "../lib/keymap";
import { formatBytes, formatNumber, formatTimeExact } from "../lib/format";
import { apiRevealInFinder } from "../lib/api";
import type { SessionMeta } from "@ocsv/shared";
import "./SessionDetailRoute.css";

export default function SessionDetailRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { start, entries, loading, totalCount, error, path } = useTranscriptStore();
  const { livePids } = useLivePids();
  const showSearchBar = useSearchInSessionStore((s) => s.show);

  const meta = (location.state as { session?: SessionMeta } | null)?.session;

  useEffect(() => {
    if (path && sessionId) {
      // 已经加载了,无需重启
    } else if (sessionId) {
      // 重新打开:从 meta 拿 jsonlPath
    }
  }, [sessionId, path]);

  // 通过 sessionId 找到 jsonlPath
  useEffect(() => {
    if (sessionId && !path) {
      // 我们需要从 session 列表里找
      // 但页面进入时通常 location.state 已有 session meta
      // 如果没有,从列表里找
    }
  }, [sessionId, path]);

  // 优先用 state 里的 meta
  const targetPath = meta?.jsonlPath;

  useEffect(() => {
    if (targetPath) {
      void start(targetPath);
    }
  }, [targetPath, start]);

  // 实时 PID
  const liveInfo = useMemo(
    () => (meta?.sessionId ? livePids.find((p) => p.sessionId === meta.sessionId) : undefined),
    [meta, livePids]
  );

  // 跳转到指定 entry (用于搜索结果/URL ?line=N)
  const jumpToEntry = (entryIndex: number) => {
    const el = document.querySelector(`[data-entry-index="${entryIndex}"]`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  // Cmd+F:会话内搜索 (handler 引用稳定,deps 用 [])
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

  // 处理 URL ?line=N (Phase 12 — URL 跳转) + ?from=ISO&to=ISO 时间筛选
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const line = params.get("line");
    if (line && entries.length > 0) {
      const target = parseInt(line, 10);
      if (!isNaN(target)) {
        // 等下一个 microtask,确保 DOM 已渲染
        setTimeout(() => jumpToEntry(target), 100);
      }
    }
    const from = params.get("from");
    const to = params.get("to");
    if (from || to) {
      useTranscriptFilterStore.getState().setRange(from ?? undefined, to ?? undefined);
    }
  }, [entries.length, location.search]);

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
      <header className="session-header">
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
                <span title={formatTimeExact(meta.firstTimestamp)}>
                  {formatTimeExact(meta.firstTimestamp)}
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
          <button onClick={() => handleExport("md")} title={t("detail.exportMd")}>
            <Download size={14} /> MD
          </button>
          <button onClick={() => handleExport("html")} title={t("detail.exportHtml")}>
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

      <SearchInSessionBar onJump={jumpToEntry} />

      {error && (
        <div className="error">
          {t("app.error")}: {error}
        </div>
      )}

      <TranscriptView />
    </div>
  );
}
