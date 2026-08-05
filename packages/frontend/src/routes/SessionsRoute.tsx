import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Settings,
  Search,
  RefreshCw,
  Filter,
  Bot,
  MessageSquare,
  Network,
  Pin,
  EyeOff,
  Archive,
  Wrench, // v0.8.5 B: 工具分析页
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";

import { useSessionsStore } from "../state/sessionsStore";
import { useSearchStore } from "../state/searchStore";
import { useOverrides } from "../state/overridesStore";
import { useKey } from "../lib/keymap";
import { formatBytes, formatTime } from "../lib/format";
import { useFormatOpts } from "../hooks/useFormatOpts";
import { SearchPalette } from "../views/SearchPalette";
import { HomeStatusBar } from "../components/HomeStatusBar"; // v0.8.4 item 1
import type { SessionMeta } from "@ocsv/shared";
import "./SessionsRoute.css";

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
      if (cancelled) u();
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refresh]);

  useKey("cmd+k", (e) => {
    e.preventDefault();
    search.show();
  });
  useKey("ctrl+k", (e) => {
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

  return (
    <div className="sessions-page">
      <header className="topbar">
        <div className="topbar-title">
          <h1>{t("app.title")}</h1>
        </div>
        <div className="topbar-actions">
          <button onClick={() => search.show()}>
            <Search size={16} /> {t("search.placeholder")}
          </button>
          <button onClick={() => void refresh()} title="刷新">
            <RefreshCw size={16} />
          </button>
          <button onClick={() => navigate("/graph?view=graph")} title="Graph Explorer (G1/G2/G3)">
            <Network size={16} />
          </button>
          {/* v0.8.5 B: 全局 tool 聚合页 */}
          <button
            onClick={() => navigate("/tools")}
            title="工具分析 (跨 session tool 排行)"
            data-testid="nav-tools"
          >
            <Wrench size={16} />
          </button>
          <button onClick={() => navigate("/settings")} title={t("settings.title")}>
            <Settings size={16} />
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
            <label>
              <input
                type="checkbox"
                checked={filter.liveOnly}
                onChange={(e) => setFilter({ liveOnly: e.target.checked })}
              />
              {t("sessions.filter.liveOnly")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={filter.hasSubagents}
                onChange={(e) => setFilter({ hasSubagents: e.target.checked })}
              />
              {t("sessions.filter.hasSubagents")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={filter.last7Days}
                onChange={(e) => setFilter({ last7Days: e.target.checked })}
              />
              {t("sessions.filter.last7Days")}
            </label>

            <h4 style={{ marginTop: 16 }}>{t("sessions.filter.source")}</h4>
            <label>
              <input
                type="radio"
                name="source"
                checked={filter.source === "claude"}
                onChange={() => setFilter({ source: "claude" })}
              />
              {t("sessions.source.claude")}
            </label>
            <label>
              <input
                type="radio"
                name="source"
                checked={filter.source === "openclaw"}
                onChange={() => setFilter({ source: "openclaw" })}
              />
              {t("sessions.source.openclaw")}
            </label>

            {agents.length > 1 && (
              <>
                <h4 style={{ marginTop: 16 }}>{t("sessions.filter.agent")}</h4>
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

            <h4 style={{ marginTop: 16 }}>显示</h4>
            <label>
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
              />
              显示隐藏项
            </label>
            <label>
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              显示归档
            </label>

            <input
              type="text"
              className="search-box"
              placeholder="搜索标题/路径/agent…"
              value={filter.query}
              onChange={(e) => setFilter({ query: e.target.value })}
            />
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

          <div className="sessions-count">
            共 {visible.length} 个
            {(overrides.snap.hidden &&
              Object.keys(overrides.snap.hidden).length > 0 &&
              !showHidden) ||
            (overrides.snap.archived &&
              Object.keys(overrides.snap.archived).length > 0 &&
              !showArchived)
              ? " (已过滤)"
              : ""}
          </div>

          {pinned.length > 0 && (
            <section className="pinned-section" data-testid="pinned-section">
              <h3 className="pinned-section-title">
                <Pin size={12} /> 置顶 ({pinned.length})
              </h3>
              {pinned.map((s) => (
                <SessionCard
                  key={`${s.source}-${s.sessionId}`}
                  s={s}
                  navigate={navigate}
                  overrides={overrides}
                  fmtOpts={fmtOpts}
                  editingSid={editingSid}
                  draftTitle={draftTitle}
                  setDraftTitle={setDraftTitle}
                  startRename={startRename}
                  commitRename={commitRename}
                  cancelRename={cancelRename}
                />
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
                <SessionCard
                  key={`${s.source}-${s.sessionId}`}
                  s={s}
                  navigate={navigate}
                  overrides={overrides}
                  fmtOpts={fmtOpts}
                  editingSid={editingSid}
                  draftTitle={draftTitle}
                  setDraftTitle={setDraftTitle}
                  startRename={startRename}
                  commitRename={commitRename}
                  cancelRename={cancelRename}
                />
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
}: SessionCardProps) {
  const displayTitle = overrides.snap.renames[s.sessionId] ?? s.title ?? s.sessionId.slice(0, 8);
  const isEditing = editingSid === s.sessionId;
  const isPinned = overrides.snap.pinned[s.sessionId];
  const isHidden = overrides.snap.hidden[s.sessionId];
  const isArchived = overrides.snap.archived[s.sessionId];
  const sessionTags = overrides.snap.tags[s.sessionId] ?? [];

  return (
    <article
      className={`session-card${isHidden ? " is-hidden" : ""}${isPinned ? " is-pinned" : ""}${
        isArchived ? " is-archived" : ""
      }`}
      onClick={() => {
        if (!isEditing) {
          navigate(`/session/${encodeURIComponent(s.sessionId)}`, { state: { session: s } });
        }
      }}
    >
      {isArchived && (
        <div className="archived-banner">
          <Archive size={12} /> 已归档
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
            title="双击重命名"
          >
            {displayTitle}
          </span>
        )}
        {s.livePid && (
          <span className="live-badge" title="运行中">
            ● {t_live()}
          </span>
        )}
        {s.subagentDir && s.subagentCount && s.subagentCount > 0 && (
          <span className="subagent-badge" title={`包含 ${s.subagentCount} 个子代理`}>
            ⎇ {s.subagentCount}
          </span>
        )}
        <span className={`source-badge source-${s.source}`}>
          {s.source === "claude" ? "Claude" : "OpenClaw"}
        </span>
        <span className="override-badges">
          {isPinned && <span className="badge-pinned">📌</span>}
          {isHidden && <span className="badge-hidden">隐藏</span>}
        </span>
      </div>
      <div className="session-card-meta">
        <span title={s.lastMessageAt ?? s.lastTimestamp ?? ""}>
          {formatTime(s.lastMessageAt ?? s.lastTimestamp, fmtOpts)}
        </span>
        <span>·</span>
        <span>{formatBytes(s.sizeBytes)}</span>
        <span>·</span>
        <span>{s.messageCount} 条</span>
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
          {sessionTags.map((t: { id: number; name: string; color: string | null }) => (
            <span key={t.id} className="tag-chip" title={`tag: ${t.name}`}>
              {t.name}
            </span>
          ))}
        </div>
      )}
      {(s.thinkingCount || s.toolUseCount || (s.topTools && s.topTools.length > 0)) && (
        <div className="session-stats">
          {s.thinkingCount && s.thinkingCount > 0 && (
            <span className="stat-chip stat-thinking" title="思考块">
              🧠 {s.thinkingCount}
            </span>
          )}
          {s.toolUseCount && s.toolUseCount > 0 && (
            <span className="stat-chip stat-tools" title="工具调用">
              🔧 {s.toolUseCount}
            </span>
          )}
          {s.topTools?.map((t) => (
            <span key={t} className="tool-chip" title={t}>
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="session-card-actions" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => overrides.togglePinned(s.sessionId, !isPinned)}
          className={isPinned ? "is-active" : ""}
          title={isPinned ? "取消置顶" : "置顶"}
        >
          <Pin size={11} />
        </button>
        <button
          onClick={() => overrides.toggleHide(s.sessionId, !isHidden)}
          className={isHidden ? "is-active" : ""}
          title={isHidden ? "取消隐藏" : "隐藏"}
        >
          <EyeOff size={11} />
        </button>
        <button
          onClick={() => overrides.setArchived(s.sessionId, !isArchived)}
          className={isArchived ? "is-active" : ""}
          title={isArchived ? "取消归档" : "归档"}
        >
          <Archive size={11} />
        </button>
        <button onClick={() => startRename(s)} title="重命名">
          ✎
        </button>
      </div>
    </article>
  );
}

function t_live(): string {
  return "运行中";
}
