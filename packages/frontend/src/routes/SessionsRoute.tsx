import { useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Settings, Search, RefreshCw, Filter } from "lucide-react";

import { useSessionsStore } from "../state/sessionsStore";
import { useSearchStore } from "../state/searchStore";
import { useKey } from "../lib/keymap";
import { formatBytes, formatTime } from "../lib/format";
import { SearchPalette } from "../views/SearchPalette";
import "./SessionsRoute.css";

export default function SessionsRoute() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const {
    sessions,
    loading,
    error,
    filter,
    setFilter,
    load,
    refresh,
    filteredSessions,
  } = useSessionsStore();
  const search = useSearchStore();

  useEffect(() => {
    void load();
  }, [load]);

  useKey("cmd+k", (e) => {
    e.preventDefault();
    search.show();
  });
  useKey("ctrl+k", (e) => {
    e.preventDefault();
    search.show();
  });

  const filtered = filteredSessions();

  // 按 workspace 分组
  const grouped = useMemo(() => {
    const m = new Map<string, typeof filtered>();
    for (const s of filtered) {
      const key = s.workspaceGuess || s.projectKey || "(未知)";
      const list = m.get(key) ?? [];
      list.push(s);
      m.set(key, list);
    }
    return Array.from(m.entries()).sort((a, b) => {
      const aLatest = Math.max(...a[1].map((s) => s.mtimeMs));
      const bLatest = Math.max(...b[1].map((s) => s.mtimeMs));
      return bLatest - aLatest;
    });
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
                checked={filter.source === "all"}
                onChange={() => setFilter({ source: "all" })}
              />
              全部
            </label>
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

            <input
              type="text"
              className="search-box"
              placeholder="搜索标题/路径…"
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
            <div className="empty">{sessions.length === 0 ? t("sessions.empty") : t("sessions.noMatch")}</div>
          )}

          <div className="sessions-count">
            {t("sessions.totalCount", { count: filtered.length })}
          </div>

          {grouped.map(([workspace, list]) => (
            <section key={workspace} className="workspace-group">
              <h2 className="workspace-title">
                {workspace}
                <span className="workspace-count">{list.length}</span>
              </h2>
              {list.map((s) => (
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
                    {s.subagentDir && (
                      <span className="subagent-badge" title="包含子代理">
                        ⎇
                      </span>
                    )}
                    <span className={`source-badge source-${s.source}`}>
                      {s.source === "claude" ? "Claude" : "OpenClaw"}
                    </span>
                  </div>
                  <div className="session-card-meta">
                    <span>{formatTime(s.lastTimestamp)}</span>
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
                  </div>
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
