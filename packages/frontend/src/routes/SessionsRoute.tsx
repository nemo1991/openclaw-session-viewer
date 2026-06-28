import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Settings, Search, RefreshCw, Filter, Bot, MessageSquare } from "lucide-react";
import { listen } from "@tauri-apps/api/event";

import { useSessionsStore } from "../state/sessionsStore";
import { useSearchStore } from "../state/searchStore";
import { useKey } from "../lib/keymap";
import { formatBytes, formatTime } from "../lib/format";
import { useFormatOpts } from "../hooks/useFormatOpts";
import { SearchPalette } from "../views/SearchPalette";
import type { SessionMeta } from "@ocsv/shared";
import "./SessionsRoute.css";

interface Group {
  /** 二级分组 key(workspace 或 agentId) */
  key: string;
  /** 顶层标题:对 OpenClaw 是 agent,带 label;对 Claude 是 workspace 路径 */
  title: string;
  /** 副标题(channel / target / workspaceGuess) */
  subtitle?: string;
  /** 顶层 icon:Bot (agent) | MessageSquare (workspace) */
  kind: "agent" | "workspace";
  /** 该组下的 session 列表 */
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

  useEffect(() => {
    void load();
  }, [load]);

  // v0.2.5: 监听 sessions-updated 事件(custom_roots 变更后后端热重载会发)
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen("sessions-updated", () => {
      void refresh();
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
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
  const agents = availableAgentIds();

  // 二级分组:OpenClaw 按 agentId(顶层)→ workspaceGuess(二级,可空);Claude 按 workspaceGuess(顶层)
  const grouped = useMemo<Group[]>(() => {
    const byAgent = new Map<string, Group>();
    const byWorkspace = new Map<string, Group>();

    for (const s of filtered) {
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

    // 按该组最近 mtime 倒序
    const sortByLatest = (a: Group, b: Group) => {
      const aLatest = Math.max(...a.sessions.map((s) => s.mtimeMs));
      const bLatest = Math.max(...b.sessions.map((s) => s.mtimeMs));
      return bLatest - aLatest;
    };
    return [...Array.from(byAgent.values()), ...Array.from(byWorkspace.values())].sort(
      sortByLatest
    );
  }, [filtered]);

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
          <button onClick={() => navigate("/settings")} title={t("settings.title")}>
            <Settings size={16} />
          </button>
        </div>
      </header>

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

            {/* v0.2.4: 按 agent 过滤 */}
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
          {!loading && filtered.length === 0 && (
            <div className="empty">
              {sessions.length === 0 ? t("sessions.empty") : t("sessions.noMatch")}
            </div>
          )}

          <div className="sessions-count">
            {t("sessions.totalCount", { count: filtered.length })}
          </div>

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
                <article
                  key={`${s.source}-${s.sessionId}`}
                  className="session-card"
                  onClick={() =>
                    navigate(`/session/${encodeURIComponent(s.sessionId)}`, {
                      state: { session: s },
                    })
                  }
                >
                  <div className="session-card-title">
                    {s.title || s.sessionId.slice(0, 8)}
                    {s.livePid && (
                      <span className="live-badge" title="运行中">
                        ● {t("sessions.liveBadge")}
                      </span>
                    )}
                    {s.subagentDir && s.subagentCount && s.subagentCount > 0 && (
                      <span
                        className="subagent-badge"
                        title={`包含 ${s.subagentCount} 个子代理`}
                        data-testid="subagent-count-badge"
                        data-count={s.subagentCount}
                      >
                        ⎇ {s.subagentCount}
                      </span>
                    )}
                    {s.subagentDir && (!s.subagentCount || s.subagentCount === 0) && (
                      // Fallback:subagentDir 存在但 count 缺失(老 backend / 旧 meta)
                      <span className="subagent-badge" title="包含子代理">
                        ⎇
                      </span>
                    )}
                    <span className={`source-badge source-${s.source}`}>
                      {s.source === "claude" ? "Claude" : "OpenClaw"}
                    </span>
                  </div>
                  <div className="session-card-meta">
                    <span title={s.lastMessageAt ?? s.lastTimestamp ?? ""}>
                      {formatTime(s.lastMessageAt ?? s.lastTimestamp, fmtOpts)}
                    </span>
                    <span>·</span>
                    <span>{formatBytes(s.sizeBytes)}</span>
                    <span>·</span>
                    <span>{t("sessions.messages", { count: s.messageCount })}</span>
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
                </article>
              ))}
            </section>
          ))}
        </main>
      </div>

      {search.open && <SearchPalette />}
    </div>
  );
}
