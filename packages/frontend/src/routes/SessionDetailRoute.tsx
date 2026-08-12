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

import { useMemo, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useTranscriptStore } from "../state/transcriptStore";
import { useSearchInSessionStore } from "../state/searchInSessionStore";
import { useTranscriptPipeline } from "../hooks/useTranscriptPipeline";
import { useTranscriptScroll } from "../hooks/useTranscriptScroll";
import { useSessionUrlSync } from "../hooks/useSessionUrlSync";
// v0.9.24 (M7-A): 抽 handleReload + handleExport + reloading + reloadModifier
// 到独立 hook, 消解 SessionHeader 提取时的 prop 压力。
// 注意: route 仍用 `handleReload` 给 cmd+r 键位 — 跟 cmd+f 同层。
import { useSessionActions } from "../hooks/useSessionActions";
import { TranscriptView } from "../views/TranscriptView";
import { SearchInSessionBar } from "../views/SearchInSessionBar";
// v0.9.22 (M4): SessionSummaryStrip + MetaBannerFold 抽到 <SessionOverview> (L1 layer)
import { SessionOverview } from "../components/meta/SessionOverview";
// v0.9.23 (M5): 6 chart blocks (context.apply_compaction / llm.tools_snapshot /
// usage.chart / request.chart / todos.chart / ai-title.chart) 从 transcript
// timeline 抽离到独立 <ChartsRegion> (L2 layer),位置在 SessionOverview 下、
// TranscriptView 上。
import { ChartsRegion } from "../components/meta/ChartsRegion";
// v0.9.24 (M7-B): header chrome + actions row 12 button 抽到 <SessionHeader>
// (L0 层 chrome)。SessionHeader 内部 useSessionActions 拿 reload/export,
// route 只剩 cmd+r/cmd+f 键位 + visibility (notesEditing) + meta 派生。
import { SessionHeader } from "../components/session/SessionHeader";
// v0.9.24 (M7-C): notes + links + link dialog 抽到 <SessionNotesPanel>
// (L0 层 notes/links region)。SessionNotesPanel 内部 useOverrides 调
// setNotes/addLink/removeLink mutation API, route 只剩 notesEditing 1 bit state。
import { SessionNotesPanel } from "../components/session/SessionNotesPanel";
import { useKey } from "../lib/keymap";
import type { SessionMeta } from "@ocsv/shared";
import "./SessionDetailRoute.css";

/** v0.5.0:从 location.state 读 subagentContext(由 SubagentPanel 跳来时填充)
 * v0.9.24 (M7-B): 改为 export,让 <SessionHeader> 也用 (BackButton 文案切换) */
export interface SubagentContext {
  parentSessionId: string;
  agentId: string;
  agentType?: string | null;
}

export default function SessionDetailRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();

  // 4 个独立 selector(避免任一字段变化触发整页重渲染)
  const start = useTranscriptStore((s) => s.start);
  const entries = useTranscriptStore((s) => s.entries);
  // v0.9.23 (M5): charts — 6 chart meta blocks 抽离后的 L2 数据源
  const charts = useTranscriptStore((s) => s.charts);
  const loading = useTranscriptStore((s) => s.loading);
  const totalCount = useTranscriptStore((s) => s.totalCount);
  const error = useTranscriptStore((s) => s.error);

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

  // v0.8.15: 跨平台 — Cmd+F (macOS) / Ctrl+F (Win/Linux) 统一一个 useKey。
  useKey(
    "cmd+f",
    (e) => {
      e.preventDefault();
      showSearchBar();
    },
    []
  );

  // v0.9.24 (M7-B): route 只剩 cmd+r keybind 用 handleReload —
  // handleExport / reloading / reloadModifier 已迁到 <SessionHeader>
  // (内部 useSessionActions 调一次)。这样 route 跟 SessionHeader 都用
  // 同一份 hook,reload 触发的 store mutation 跟 meta reload 完全一致。
  const { handleReload } = useSessionActions({
    meta,
    targetPath,
    sessionId,
    navigate,
    pathnameSearch: location.pathname + location.search,
  });

  // v0.8.15: 跨平台 — Cmd+R / Ctrl+R 统一一个 useKey, 不再需要 band-aid。
  useKey(
    "cmd+r",
    (e) => {
      e.preventDefault();
      void handleReload();
    },
    [handleReload]
  );

  if (!meta) {
    return (
      <div className="session-detail">
        <div className="empty">{t("detail.notFound")}</div>
        <button onClick={() => navigate("/")}>{t("detail.back")}</button>
      </div>
    );
  }

  // v0.5.0:子会话识别 — 从 location.state 读 subagentContext (传给 <SessionHeader>)
  const subCtx = (location.state as { subagentContext?: SubagentContext } | null)?.subagentContext;

  // v0.9.24 (M7-C): notes panel + link dialog 可见性 toggle — actions row
  // sticky note / link button 调用对应 handler。state 在 route 层
  // (1 bit each, 跟 region 显隐强相关, route 管 "现在显示哪些 region" 的
  // 职责清晰)。<SessionNotesPanel> 内部管 notesDraft / linkTarget / linkNote,
  // route 只剩 visibility toggles。
  const [notesEditing, setNotesEditing] = useState(false);
  const toggleNotesEditing = () => setNotesEditing((v) => !v);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const openLinkDialog = () => setLinkDialogOpen(true);
  const closeLinkDialog = () => setLinkDialogOpen(false);

  // v0.9.24 (M7-B): transcript 加载进度, 给 <SessionHeader> stats row 显示
  // "messages (loaded/total)"。loading=true 才传, 否则 null (无 progress 显示)
  const loadingProgress = loading ? { loaded: entries.length, total: totalCount } : null;

  return (
    <div className="session-detail">
      {/* v0.9.24 (M7-B): header chrome + actions row 12 button 全部迁到
       * <SessionHeader> (L0 层 chrome)。route 只剩 cmd+r keybind +
       * visibility (notesEditing) + meta 派生 + TranscriptView mount。
       * SessionHeader 内部 useSessionActions(meta) 拿 reload/export。 */}
      <SessionHeader
        meta={meta}
        navigate={navigate}
        onNotesToggle={toggleNotesEditing}
        onLinkAdd={openLinkDialog}
        subagentContext={subCtx}
        loadingProgress={loadingProgress}
      />

      <SearchInSessionBar />

      {/* v0.9.22 (M4): L1 SessionOverview — 聚合 chip 行 + kimi meta banner fold
       * 之前 v0.4.5 — v0.9.21 这两块是 SessionSummaryStrip + MetaBannerFold 两个
       * 内联函数 + formatIdleGapFromMs helper, 全部 inline 在 SessionDetailRoute,
       * 抽出到 <SessionOverview> 后 route 减到 < 500 行 */}
      <SessionOverview meta={meta} />

      {/* v0.9.23 (M5): L2 ChartsRegion — 6 chart blocks (compaction / tools /
       * usage / request / todos / ai-title) 之前是塞在 transcript timeline 末尾
       * 跟普通 meta event 混排,视觉混排语义不清。现在抽到独立区域,位置在
       * Overview 下、TranscriptView 上。0 chart 时由 ChartsRegion 内部不渲染
       * (老 wire / openclaw / 无 chart session 不显示占位)。
       * 后端 StreamBatch 字段 `charts` 兜底 []:老 wire 兼容。 */}
      <ChartsRegion charts={charts} />

      {/* v0.9.24 (M7-C): notes + links + link dialog 全部迁到 <SessionNotesPanel>
       * (L0 层 notes/links region)。内部 useOverrides 调 setNotes/addLink/removeLink,
       * route 只剩 notesEditing 1 bit visibility toggle。 */}
      <SessionNotesPanel
        meta={meta}
        notesEditing={notesEditing}
        onNotesToggle={toggleNotesEditing}
        linkDialogOpen={linkDialogOpen}
        onLinkAdd={openLinkDialog}
        onLinkDialogClose={closeLinkDialog}
      />

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
