import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Search,
  RefreshCw,
  Filter,
  Bot,
  MessageSquare,
  Pin,
  EyeOff,
  Archive,
  AlertTriangle,
  ChevronRight,
  RotateCcw,
  Pencil,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";

import { useSessionsStore, type SourceFilter } from "../state/sessionsStore";
import { useSearchStore } from "../state/searchStore";
import { useOverrides } from "../state/overridesStore";
import { useSettingsStore } from "../state/settingsStore";
import { useGraphStore } from "../views/graph/graphStore";
import { normalizeHealthRules } from "../views/graph/health";
import type { FlaggedSession } from "../views/graph/health";
import { buildRiskIndex } from "../views/graph/healthBridge";
import { useKey } from "../lib/keymap";
import { formatBytes, formatDuration, formatNumber, formatTime } from "../lib/format";
import { useFormatOpts } from "../hooks/useFormatOpts";
import { SearchPalette } from "../views/SearchPalette";
import { HomeStatusBar } from "../components/HomeStatusBar"; // v0.8.4 item 1
import type { SessionMeta } from "@ocsv/shared";
import { selectStatChips, type RankedChip } from "./sessionCardChips";
import "./SessionsRoute.css";

/** v0.12 (B1 / FR-F1): 5 个 source 选项,「全部」为默认 */
const SOURCE_OPTIONS: SourceFilter[] = ["all", "claude", "openclaw", "kimi", "dsh"];

/** v0.12 (FR-F4): 高级筛选展开态本地持久化 key(无网络、无账号) */
const ADVANCED_FILTERS_KEY = "ocsv.filter.advancedOpen.v1";

/** v0.12 (C1 / FR-C1): 卡片默认最多露 3 个高信号 chip */
const MAX_VISIBLE_CHIPS = 3;

function readAdvancedOpen(): boolean {
  try {
    return window.localStorage.getItem(ADVANCED_FILTERS_KEY) === "1";
  } catch {
    // localStorage 可能被隐私策略禁用,默认折叠即可
    return false;
  }
}

interface SessionCardProps {
  s: SessionMeta;
  navigate: ReturnType<typeof useNavigate>;
  overrides: ReturnType<typeof useOverrides.getState>;
  fmtOpts: ReturnType<typeof useFormatOpts>;
  editingSid: string | null;
  draftTitle: string;
  setDraftTitle: (v: string) => void;
  startRename: (s: SessionMeta) => void;
  commitRename: (s: SessionMeta) => Promise<void>;
  /** v0.8.14 item G: Escape 取消编辑 */
  cancelRename: (s: SessionMeta) => void;
  /** v0.12 (C2): 该会话命中的体检结果;undefined = 未命中或数据未就绪 */
  flagged?: FlaggedSession;
}

interface Group {
  key: string;
  title: string;
  subtitle?: string;
  kind: "agent" | "workspace";
  sessions: SessionMeta[];
}

export default function SessionsRoute() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const fmtOpts = useFormatOpts();
  const {
    sessions,
    loading,
    error,
    filter,
    setFilter,
    resetFilter,
    load,
    refresh,
    filteredSessions,
    availableAgentIds,
  } = useSessionsStore();
  const search = useSearchStore();
  const overrides = useOverrides();
  const [showHidden, setShowHidden] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [editingSid, setEditingSid] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  // v0.12 (FR-F2/F4): 高级筛选默认折叠,展开态重启保留
  const [advancedOpen, setAdvancedOpen] = useState(readAdvancedOpen);

  useEffect(() => {
    try {
      window.localStorage.setItem(ADVANCED_FILTERS_KEY, advancedOpen ? "1" : "0");
    } catch {
      // ignore quota / privacy
    }
  }, [advancedOpen]);

  // ---- v0.12 (C2 / FR-C2): 首页风险徽标数据桥 ----
  // 强制复用 v0.11 的 foldGraphEntries + evaluateHealth,零第二套口径。
  // graph 数据懒加载(仅 entries 为空时一次),不阻塞首屏;计算用 useMemo 缓存。
  const graphEntries = useGraphStore((s) => s.entries);
  const graphLoad = useGraphStore((s) => s.load);
  const rawHealthRules = useSettingsStore((s) => s.settings.healthRules);
  const healthRules = useMemo(() => normalizeHealthRules(rawHealthRules), [rawHealthRules]);
  useEffect(() => {
    if (!graphEntries) void graphLoad();
  }, [graphEntries, graphLoad]);
  const riskIndex = useMemo(
    () => buildRiskIndex(graphEntries, healthRules),
    [graphEntries, healthRules]
  );

  useEffect(() => {
    void load();
  }, [load]);

  // v0.2.5: 监听 sessions-updated 事件
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen("sessions-updated", () => {
      // v0.8.3: 必须用 load() (apiListSessions) 而非 refresh() (apiRefreshSessions).
      // refresh_sessions 后端会 notify refresh_requested → sync_loop 再跑 → 再
      // emit sessions-updated → 无限循环(已观测 364 次/90s,CPU 飙升)。
      // load() 走只读 list_sessions,不触发 sync,断回路。
      void load();
    }).then((u) => {
      // v0.9.28 (M11.1): 修启动 race — listener 注册完成后强制 load() 一次,
      // 防止 sync_loop 在 listener 未注册前 emit "sessions-updated" 事件被丢
      // (用户感知:"打开应用后没有自动同步,需要手动同步")。
      if (cancelled) u();
      else {
        unlisten = u;
        void load();
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refresh]);

  // v0.8.15: 跨平台 — matchKey 的 meta 组同时接受 macOS Cmd 和 Win/Linux Ctrl,
  // 不再需要分别注册两个 useKey。
  useKey("cmd+k", (e) => {
    e.preventDefault();
    search.show();
  });

  const filtered = filteredSessions();

  // 应用 override 过滤:hidden 默认隐藏(除非勾 showHidden),archived 默认隐藏
  const visible = useMemo(() => {
    return filtered.filter((s) => {
      if (!showHidden && overrides.snap.hidden[s.sessionId]) return false;
      if (!showArchived && overrides.snap.archived[s.sessionId]) return false;
      return true;
    });
  }, [filtered, showHidden, showArchived, overrides.snap.hidden, overrides.snap.archived]);

  // Pinned 顶部独立分组
  const pinned = useMemo(
    () => visible.filter((s) => overrides.snap.pinned[s.sessionId]),
    [visible, overrides.snap.pinned]
  );
  const nonPinned = useMemo(
    () => visible.filter((s) => !overrides.snap.pinned[s.sessionId]),
    [visible, overrides.snap.pinned]
  );

  // 二级分组:OpenClaw 按 agentId → workspaceGuess;Claude 按 workspaceGuess
  const grouped = useMemo<Group[]>(() => {
    const byAgent = new Map<string, Group>();
    const byWorkspace = new Map<string, Group>();

    for (const s of nonPinned) {
      if (s.source === "openclaw") {
        const agentId = s.agentId ?? "(未知 agent)";
        let g = byAgent.get(agentId);
        if (!g) {
          g = {
            key: `agent:${agentId}`,
            title: agentId,
            subtitle: [s.agentChannel, s.agentLabel].filter(Boolean).join(" · ") || undefined,
            kind: "agent",
            sessions: [],
          };
          byAgent.set(agentId, g);
        }
        g.sessions.push(s);
      } else {
        const wsKey = s.workspaceGuess || s.projectKey || "(未知工作区)";
        let g = byWorkspace.get(wsKey);
        if (!g) {
          g = {
            key: `ws:${wsKey}`,
            title: wsKey,
            subtitle: undefined,
            kind: "workspace",
            sessions: [],
          };
          byWorkspace.set(wsKey, g);
        }
        g.sessions.push(s);
      }
    }

    const sortByLatest = (a: Group, b: Group) => {
      const aLatest = Math.max(...a.sessions.map((s) => s.mtimeMs));
      const bLatest = Math.max(...b.sessions.map((s) => s.mtimeMs));
      return bLatest - aLatest;
    };
    return [...Array.from(byAgent.values()), ...Array.from(byWorkspace.values())].sort(
      sortByLatest
    );
  }, [nonPinned]);

  const agents = availableAgentIds();

  // title 显示优先级:display_title > title > sessionId.slice(0,8)
  const displayTitleOf = (s: SessionMeta) =>
    overrides.snap.renames[s.sessionId] ?? s.title ?? s.sessionId.slice(0, 8);

  // v0.8.14 item G: Enter + blur 双触发场景的 inFlight guard。
  // 用 useRef 而不是 useState — Enter 和 blur 在同一 tick 触发时
  // setEditingSid(null) 还没 flush,闭包持有的 editingSid 仍是旧值,
  // 两个 commitRename 都会 past `if (!editingSid) return` 进入。
  // ref 同步设置,第二次 commit 看到 inFlight=true 直接 bail。
  const renameInFlightRef = useRef(false);

  const startRename = (s: SessionMeta) => {
    renameInFlightRef.current = false;
    setEditingSid(s.sessionId);
    setDraftTitle(displayTitleOf(s));
  };

  const commitRename = async (s: SessionMeta) => {
    if (renameInFlightRef.current) return;
    if (!editingSid || s.sessionId !== editingSid) return;
    renameInFlightRef.current = true;

    const trimmed = draftTitle.trim();
    setEditingSid(null);
    if (!trimmed || trimmed === displayTitleOf(s)) {
      renameInFlightRef.current = false;
      return;
    }
    try {
      await overrides.rename(s.sessionId, trimmed);
    } catch (e) {
      console.error("rename failed", e);
    } finally {
      renameInFlightRef.current = false;
    }
  };

  // v0.8.14 item G: Escape 也清 editing state,之前只重置 draftTitle,
  // 用户按 Esc 后输入框还在(只改了文本内容),不点 Enter/blur 就退不出。
  const cancelRename = (s: SessionMeta) => {
    if (renameInFlightRef.current) return;
    renameInFlightRef.current = true; // 防止后续 blur 再触发 commit
    setEditingSid(null);
    setDraftTitle(displayTitleOf(s));
  };

  /** v0.12 (FR-F3): 一步回到默认 —— store filter + 组件本地 hidden/archived 同步归位 */
  const handleResetFilter = () => {
    resetFilter();
    setShowHidden(false);
    setShowArchived(false);
  };

  const cardProps = (s: SessionMeta) => ({
    s,
    navigate,
    overrides,
    fmtOpts,
    editingSid,
    draftTitle,
    setDraftTitle,
    startRename,
    commitRename,
    cancelRename,
    flagged: riskIndex.get(s.sessionId),
  });

  return (
    <div className="sessions-page">
      {/* v0.12 (A1 / FR-N1): graph/tools/settings 图标已由全局 SideNav 承担,
          仅保留 search(全局搜索面板) 与 refresh(同步) 两个首页上下文操作。 */}
      <header className="topbar">
        <div className="topbar-title">
          <h1>{t("sessions.title")}</h1>
        </div>
        <div className="topbar-actions">
          <button onClick={() => search.show()} data-testid="home-search">
            <Search size={16} /> {t("search.placeholder")}
          </button>
          <button onClick={() => void refresh()} title="刷新" data-testid="home-refresh">
            <RefreshCw size={16} />
          </button>
        </div>
      </header>

      {/* v0.8.4 item 1: 首页状态栏 */}
      <HomeStatusBar />

      <div className="sessions-layout">
        <aside className="sessions-sidebar">
          <div className="filter-section">
            <h3>
              <Filter size={14} /> {t("sessions.filter.title")}
            </h3>

            {/* ---- 常驻区(FR-F2):5 个 source radio + 搜索框 = 6 个控件 ---- */}
            <h4>{t("sessions.filter.source")}</h4>
            <div className="filter-source-group" data-testid="source-filter-group">
              {SOURCE_OPTIONS.map((value) => (
                <label key={value}>
                  <input
                    type="radio"
                    name="source"
                    value={value}
                    checked={filter.source === value}
                    onChange={() => setFilter({ source: value, agentId: undefined })}
                    data-testid={`source-${value}`}
                  />
                  {t(`sessions.source.${value}`)}
                </label>
              ))}
            </div>

            <input
              type="text"
              className="search-box"
              placeholder={t("sessions.searchPlaceholder")}
              value={filter.query}
              onChange={(e) => setFilter({ query: e.target.value })}
              data-testid="session-search"
            />

            {/* ---- 高级筛选(默认折叠,FR-F2/F4) ---- */}
            <button
              type="button"
              className="advanced-filter-toggle"
              aria-expanded={advancedOpen}
              aria-controls="advanced-filters"
              title={t("sessions.filter.expandHint")}
              data-testid="advanced-filter-toggle"
              onClick={() => setAdvancedOpen((v) => !v)}
            >
              <ChevronRight
                size={12}
                className={advancedOpen ? "rotated" : ""}
                aria-hidden="true"
              />
              {t("sessions.filter.advanced")}
            </button>

            {advancedOpen && (
              <div
                id="advanced-filters"
                className="advanced-filters"
                data-testid="advanced-filters"
              >
                <h4>{t("sessions.filter.title")}</h4>
                <label>
                  <input
                    type="checkbox"
                    checked={filter.liveOnly}
                    onChange={(e) => setFilter({ liveOnly: e.target.checked })}
                    data-testid="filter-liveOnly"
                  />
                  {t("sessions.filter.liveOnly")}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={filter.hasSubagents}
                    onChange={(e) => setFilter({ hasSubagents: e.target.checked })}
                    data-testid="filter-hasSubagents"
                  />
                  {t("sessions.filter.hasSubagents")}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={filter.last7Days}
                    onChange={(e) => setFilter({ last7Days: e.target.checked })}
                    data-testid="filter-last7Days"
                  />
                  {t("sessions.filter.last7Days")}
                </label>

                {agents.length > 1 && (
                  <>
                    <h4 title={t("sessions.filter.agentHint")}>{t("sessions.filter.agent")}</h4>
                    <label>
                      <input
                        type="radio"
                        name="agent"
                        checked={!filter.agentId}
                        onChange={() => setFilter({ agentId: undefined })}
                      />
                      {t("sessions.filter.allAgents")}
                    </label>
                    {agents.map((id) => (
                      <label key={id}>
                        <input
                          type="radio"
                          name="agent"
                          checked={filter.agentId === id}
                          onChange={() => setFilter({ agentId: id })}
                        />
                        {id}
                      </label>
                    ))}
                  </>
                )}

                <h4>{t("sessions.show")}</h4>
                <label>
                  <input
                    type="checkbox"
                    checked={showHidden}
                    onChange={(e) => setShowHidden(e.target.checked)}
                    data-testid="filter-showHidden"
                  />
                  {t("sessions.showHidden")}
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={showArchived}
                    onChange={(e) => setShowArchived(e.target.checked)}
                    data-testid="filter-showArchived"
                  />
                  {t("sessions.showArchived")}
                </label>
              </div>
            )}

            {/* ---- 重置筛选(FR-F3):任意态一步回默认 ---- */}
            <button
              type="button"
              className="filter-reset"
              data-testid="filter-reset"
              onClick={handleResetFilter}
            >
              <RotateCcw size={12} aria-hidden="true" />
              {t("sessions.filter.reset")}
            </button>
          </div>
        </aside>

        <main className="sessions-main">
          {loading && <div className="loading">{t("app.loading")}</div>}
          {error && (
            <div className="error">
              {t("app.error")}: {error}
            </div>
          )}
          {!loading && visible.length === 0 && (
            <div className="empty">
              {sessions.length === 0 ? t("sessions.empty") : t("sessions.noMatch")}
            </div>
          )}

          <div className="sessions-count" data-testid="sessions-count">
            {t("sessions.totalCount", { count: visible.length })}
            {(overrides.snap.hidden &&
              Object.keys(overrides.snap.hidden).length > 0 &&
              !showHidden) ||
            (overrides.snap.archived &&
              Object.keys(overrides.snap.archived).length > 0 &&
              !showArchived)
              ? t("sessions.filteredNote")
              : ""}
          </div>

          {pinned.length > 0 && (
            <section className="pinned-section" data-testid="pinned-section">
              <h3 className="pinned-section-title">
                <Pin size={12} /> {t("sessions.pinned", { count: pinned.length })}
              </h3>
              {pinned.map((s) => (
                <SessionCard key={`${s.source}-${s.sessionId}`} {...cardProps(s)} />
              ))}
            </section>
          )}

          {grouped.map((group) => (
            <section key={group.key} className={`workspace-group group-${group.kind}`}>
              <h2 className="workspace-title">
                {group.kind === "agent" ? <Bot size={16} /> : <MessageSquare size={16} />}
                <span className="group-title-main">{group.title}</span>
                {group.subtitle && <span className="group-title-sub"> · {group.subtitle}</span>}
                <span className="workspace-count">
                  {t("sessions.perGroupCount", { count: group.sessions.length })}
                </span>
              </h2>
              {group.sessions.map((s) => (
                <SessionCard key={`${s.source}-${s.sessionId}`} {...cardProps(s)} />
              ))}
            </section>
          ))}
        </main>
      </div>

      {search.open && <SearchPalette />}
    </div>
  );
}

function SessionCard({
  s,
  navigate,
  overrides,
  fmtOpts,
  editingSid,
  draftTitle,
  setDraftTitle,
  startRename,
  commitRename,
  cancelRename,
  flagged,
}: SessionCardProps) {
  const { t } = useTranslation();
  // v0.12 (C1): 每张卡独立展开态;默认只露 ≤3 个高信号 chip
  const [expanded, setExpanded] = useState(false);
  const displayTitle = overrides.snap.renames[s.sessionId] ?? s.title ?? s.sessionId.slice(0, 8);
  const isEditing = editingSid === s.sessionId;
  const isPinned = overrides.snap.pinned[s.sessionId];
  const isHidden = overrides.snap.hidden[s.sessionId];
  const isArchived = overrides.snap.archived[s.sessionId];
  const sessionTags = overrides.snap.tags[s.sessionId] ?? [];

  // ---- v0.12 (C1 / FR-C1): 把原有 9 类 chip + topTools 收进有序数组 ----
  // 优先级:error > repeat > duration 为高信号前三,其余折叠;展开后全部可见。
  const chips: RankedChip<ReactNode>[] = [];
  const push = (key: string, priority: number, node: ReactNode) =>
    chips.push({ key, priority, node });

  if (s.thinkingCount && s.thinkingCount > 0) {
    push(
      "thinking",
      3,
      <span
        key="thinking"
        className="stat-chip stat-thinking"
        title={t("sessions.statThinking")}
        data-testid="stats-chip"
      >
        🧠 {s.thinkingCount}
      </span>
    );
  }
  if (s.toolUseCount && s.toolUseCount > 0) {
    push(
      "tools",
      4,
      <span
        key="tools"
        className="stat-chip stat-tools"
        title={t("sessions.statTools")}
        data-testid="stats-chip"
      >
        🔧 {s.toolUseCount}
      </span>
    );
  }
  if (s.durationSeconds != null && s.durationSeconds > 0) {
    push(
      "duration",
      2,
      <span
        key="duration"
        className="stat-chip stat-duration"
        title={t("sessions.statDuration")}
        data-testid="stats-chip"
      >
        ⏱ {formatDuration(s.durationSeconds)}
      </span>
    );
  }
  if (s.errorCount != null && s.errorCount > 0) {
    push(
      "error",
      0,
      <span
        key="error"
        className="stat-chip stat-error"
        title={
          s.toolError && s.toolError.length > 0
            ? t("sessions.statErrorDetail", {
                list: s.toolError.map(([n, c]) => `${n}×${c}`).join(", "),
              })
            : t("sessions.statError")
        }
        data-testid="stats-chip"
      >
        ⚠ {s.errorCount}
      </span>
    );
  }
  if (s.repeatRunCount != null && s.repeatRunCount > 0) {
    push(
      "repeat",
      1,
      <span
        key="repeat"
        className="stat-chip stat-repeat"
        title={
          s.repeatRunMaxTool && s.repeatRunMaxCount
            ? t("sessions.statRepeatDetail", {
                tool: s.repeatRunMaxTool,
                count: s.repeatRunMaxCount,
              })
            : t("sessions.statRepeat")
        }
        data-testid="stats-chip"
      >
        🔁 {s.repeatRunCount}
      </span>
    );
  }
  if (s.idleGapCount != null && s.idleGapCount > 0) {
    push(
      "idle",
      5,
      <span
        key="idle"
        className="stat-chip stat-idle"
        title={
          s.idleGapMaxMs
            ? t("sessions.statIdleDetail", { min: (s.idleGapMaxMs / 60000).toFixed(1) })
            : t("sessions.statIdle")
        }
        data-testid="stats-chip"
      >
        💤 {s.idleGapCount}
      </span>
    );
  }
  if (s.todoSummary) {
    push(
      "todo",
      6,
      <span
        key="todo"
        className="stat-chip stat-todo"
        title={
          s.todoSummary.current
            ? t("sessions.statTodoDetail", {
                current: s.todoSummary.current,
                done: s.todoSummary.done,
                total: s.todoSummary.total,
              })
            : t("sessions.statTodo", {
                done: s.todoSummary.done,
                total: s.todoSummary.total,
              })
        }
        data-testid="stats-chip"
      >
        📋 {s.todoSummary.done}/{s.todoSummary.total}
      </span>
    );
  }
  if (
    s.kimiTokenUsage &&
    (s.kimiTokenUsage.input > 0 || s.kimiTokenUsage.output > 0 || s.kimiTokenUsage.cacheRead > 0)
  ) {
    push(
      "tokens",
      7,
      <span
        key="tokens"
        className="stat-chip stat-tokens"
        title={t("sessions.statTokens", {
          input: formatNumber(s.kimiTokenUsage.input),
          output: formatNumber(s.kimiTokenUsage.output),
          cache: formatNumber(s.kimiTokenUsage.cacheRead),
        })}
        data-testid="stats-chip"
      >
        🪙 {formatNumber(s.kimiTokenUsage.input + s.kimiTokenUsage.cacheRead)}
      </span>
    );
  }
  if (s.metaBanner && s.metaBanner.compactionCount > 0) {
    push(
      "compaction",
      8,
      <span
        key="compaction"
        className="stat-chip stat-compaction"
        title={
          s.metaBanner.lastCompactionDurationMs
            ? t("sessions.statCompactionDetail", {
                count: s.metaBanner.compactionCount,
                sec: (s.metaBanner.lastCompactionDurationMs / 1000).toFixed(1),
              })
            : t("sessions.statCompaction", { count: s.metaBanner.compactionCount })
        }
        data-testid="stats-chip"
      >
        🗜 {s.metaBanner.compactionCount}
      </span>
    );
  }
  s.topTools?.forEach((toolName, i) => {
    push(
      `toptool-${i}`,
      9 + i,
      <span key={`toptool-${i}`} className="tool-chip" title={toolName} data-testid="stats-chip">
        {toolName}
      </span>
    );
  });

  const { shown, hasMore, hiddenCount } = selectStatChips(chips, expanded, MAX_VISIBLE_CHIPS);

  return (
    <article
      className={`session-card${isHidden ? " is-hidden" : ""}${isPinned ? " is-pinned" : ""}${
        isArchived ? " is-archived" : ""
      }`}
      data-testid="session-card"
      onClick={() => {
        if (!isEditing) {
          navigate(`/session/${encodeURIComponent(s.sessionId)}`, { state: { session: s } });
        }
      }}
    >
      {isArchived && (
        <div className="archived-banner">
          <Archive size={12} /> {t("sessions.archivedBanner")}
        </div>
      )}
      <div className="session-card-title">
        {isEditing ? (
          <input
            className="title-rename-input"
            autoFocus
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename(s);
              if (e.key === "Escape") cancelRename(s);
            }}
            onBlur={() => void commitRename(s)}
            maxLength={80}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename(s);
            }}
            title={t("sessions.renameHint")}
            data-testid="card-title"
          >
            {displayTitle}
          </span>
        )}
        {s.livePid && (
          <span className="live-badge" title={t("sessions.liveBadge")}>
            ● {t("sessions.liveBadge")}
          </span>
        )}
        {s.subagentDir && s.subagentCount && s.subagentCount > 0 && (
          <span
            className="subagent-badge"
            title={t("sessions.subagentBadgeTitle", { count: s.subagentCount })}
          >
            ⎇ {s.subagentCount}
          </span>
        )}
        <span className={`source-badge source-${s.source}`}>
          {t(`sessions.source.${s.source}`)}
        </span>
        {/* v0.12 (C2 / FR-C2): 风险徽标前置 —— hover 显示命中规则 + 实际值/阈值,
            点击直达体检(stopPropagation 防止触发卡片跳详情)。 */}
        {flagged && (
          <button
            type="button"
            className="risk-badge"
            data-testid="risk-badge"
            aria-label={t("sessions.riskBadgeAria", { count: flagged.score })}
            title={[
              t("sessions.riskBadgeHint"),
              ...flagged.flags.map((f) => `${f.label}｜${f.detail}`),
            ].join("\n")}
            onClick={(e) => {
              e.stopPropagation();
              navigate("/graph?view=health");
            }}
          >
            <AlertTriangle size={11} aria-hidden="true" />
            {t("sessions.riskBadge", { count: flagged.score })}
          </button>
        )}
        <span className="override-badges">
          {isPinned && <span className="badge-pinned">📌</span>}
          {isHidden && <span className="badge-hidden">{t("sessions.hiddenBadge")}</span>}
        </span>
      </div>
      <div className="session-card-meta">
        <span title={s.lastMessageAt ?? s.lastTimestamp ?? ""}>
          {formatTime(s.lastMessageAt ?? s.lastTimestamp, fmtOpts)}
        </span>
        <span>·</span>
        <span>{formatBytes(s.sizeBytes)}</span>
        <span>·</span>
        <span>{t("sessions.messageCount", { count: s.messageCount })}</span>
        {s.primaryModel && (
          <>
            <span>·</span>
            <span className="model-badge">{s.primaryModel}</span>
          </>
        )}
        {s.agentChannel && (
          <>
            <span>·</span>
            <span className="agent-channel-badge">{s.agentChannel}</span>
          </>
        )}
      </div>
      {s.firstPrompt && (
        <div className="session-preview" title={s.firstPrompt}>
          {s.firstPrompt}
        </div>
      )}
      {sessionTags.length > 0 && (
        <div className="session-tags-row">
          {sessionTags.map((tag: { id: number; name: string; color: string | null }) => (
            <span key={tag.id} className="tag-chip" title={`tag: ${tag.name}`}>
              {tag.name}
            </span>
          ))}
        </div>
      )}
      {chips.length > 0 && (
        <div className="session-stats" data-testid="session-stats">
          {shown.map((c) => c.node)}
          {hasMore && (
            <button
              type="button"
              className="stats-toggle"
              data-testid="stats-toggle"
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
            >
              {expanded
                ? t("sessions.statsCollapse")
                : t("sessions.statsExpand", { count: hiddenCount })}
            </button>
          )}
        </div>
      )}
      <div className="session-card-actions" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => overrides.togglePinned(s.sessionId, !isPinned)}
          className={isPinned ? "is-active" : ""}
          title={isPinned ? t("sessions.unpin") : t("sessions.pin")}
        >
          <Pin size={11} />
        </button>
        <button
          onClick={() => overrides.toggleHide(s.sessionId, !isHidden)}
          className={isHidden ? "is-active" : ""}
          title={isHidden ? t("sessions.unhide") : t("sessions.hide")}
        >
          <EyeOff size={11} />
        </button>
        <button
          onClick={() => overrides.setArchived(s.sessionId, !isArchived)}
          className={isArchived ? "is-active" : ""}
          title={isArchived ? t("sessions.unarchive") : t("sessions.archive")}
        >
          <Archive size={11} />
        </button>
        {/* v0.12 (FR-C3): 显式重命名入口(此前仅一个无文字的 ✎,可发现性差);
            双击标题仍保留,不破坏老用户肌肉记忆。 */}
        <button
          onClick={() => startRename(s)}
          title={t("sessions.rename")}
          aria-label={t("sessions.rename")}
          data-testid="card-rename"
        >
          <Pencil size={11} aria-hidden="true" /> {t("sessions.rename")}
        </button>
      </div>
    </article>
  );
}
