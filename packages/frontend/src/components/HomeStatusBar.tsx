/**
 * v0.8.4 item 1: 首页状态栏 — 折叠面板
 *
 * v0.8.5: 把原 SyncBanner (右上角浮动进度) 合并进 pill。
 * - 扫描中:   pill = "⟳ 扫描中…" (蓝点 spin)
 * - 同步中:   pill = "⟳ 同步 N/M"  (蓝点 spin)
 * - 完成:     pill 短暂 "✓ 同步完成 N/M" (绿点), 2s 后回落
 * - 出错:     pill 持续 "✗ 同步失败" (红点)
 * - idle:     pill = "5s ago · 50/50 synced" (按新鲜度染色)
 *
 * 展开面板保留 重建数据库 / DB 路径 / 文件计数 / last error。
 */

import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSessionsStore } from "../state/sessionsStore";
import { apiGetSyncStatus, apiGetDbPath, apiRebuildDb } from "../lib/overridesApi";
import type { SyncStatus } from "../lib/overridesApi";
import { REBUILD_CONFIRM_TEXT } from "../lib/rebuild";
import "./HomeStatusBar.css";

interface ProgressPayload {
  phase: "scanning" | "syncing" | "done" | "partial_error" | "error";
  total?: number;
  done?: number;
  failed?: number;
  current_file?: string | null;
  message?: string;
}

/** 实时进度状态 — 来自 sync-progress 事件 */
type LivePhase =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "syncing"; total: number; done: number; failed: number; currentFile: string | null }
  | { kind: "done"; total: number; done: number; failed: number; expiresAt: number }
  | { kind: "partial_error"; total: number; done: number; failed: number; expiresAt: number }
  | { kind: "error"; message: string };

type Freshness =
  | "ok"
  | "stale"
  | "error"
  | "syncing"
  | "scanning"
  | "done"
  | "partial_error"
  | "live-error";

function computeFreshness(s: SyncStatus | null, live: LivePhase): Freshness {
  if (live.kind === "error") return "live-error";
  if (live.kind === "scanning") return "scanning";
  if (live.kind === "syncing") return "syncing";
  if (live.kind === "done") return "done";
  if (live.kind === "partial_error") return "partial_error";
  if (!s) return "stale";
  if (s.inProgress) return "syncing";
  if (s.lastError) return "error";
  if (s.filesSynced < s.filesSeen) return "error";
  if (!s.lastRunAt) return "stale";
  const ageMs = Date.now() - s.lastRunAt;
  if (ageMs < 60_000) return "ok";
  if (ageMs < 10 * 60_000) return "stale";
  return "error";
}

function formatAge(ageMs: number): string {
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatTimestamp(ms: number | null): string {
  if (!ms) return "(never)";
  return new Date(ms).toLocaleString();
}

/** pill 文字 + 前缀图标 — live 状态优先, 回落用 status */
function buildPillText(status: SyncStatus | null, live: LivePhase): { icon: string; text: string } {
  switch (live.kind) {
    case "scanning":
      return { icon: "⟳", text: "扫描中…" };
    case "syncing": {
      const total = live.total;
      const done = live.done;
      const tail = live.currentFile ? ` · ${live.currentFile.split("/").slice(-2).join("/")}` : "";
      return { icon: "⟳", text: `同步 ${done}/${total}${tail}` };
    }
    case "done": {
      const failedNote = live.failed > 0 ? ` · ${live.failed} failed` : "";
      return { icon: "✓", text: `同步完成 ${live.done}/${live.total}${failedNote}` };
    }
    // v0.8.13 item E: failed > 0 时 phase 是 partial_error,渲染 ⚠ + "完成 X/Y · N 失败"
    // 避免把部分失败误判为同步成功 (之前 done case 仍 fallback 显示 failed,但用户第一眼
    // 看绿色 ✓ + done text,2s 后才看到 failed 提示 — 误导)
    case "partial_error": {
      return {
        icon: "⚠",
        text: `同步完成 ${live.done}/${live.total} · ${live.failed} 失败`,
      };
    }
    case "error":
      return { icon: "✗", text: `同步失败: ${truncate(live.message, 40)}` };
    case "idle":
      break;
  }
  if (!status) return { icon: "●", text: "syncing…" };
  if (status.inProgress) {
    return { icon: "⟳", text: `syncing ${status.filesSynced}/${status.filesSeen}` };
  }
  const ageMs = status.lastRunAt ? Date.now() - status.lastRunAt : null;
  const ageLabel = ageMs !== null ? formatAge(ageMs) : "—";
  const failedCount = status.filesSeen - status.filesSynced;
  const failedNote = failedCount > 0 ? ` · ${failedCount} failed` : "";
  return {
    icon: "●",
    text: `${ageLabel} · ${status.filesSynced}/${status.filesSeen} synced${failedNote}`,
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function HomeStatusBar() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [dbPath, setDbPath] = useState<string>("");
  const [expanded, setExpanded] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);
  const [live, setLive] = useState<LivePhase>({ kind: "idle" });

  const refresh = useSessionsStore((s) => s.refresh);
  const load = useSessionsStore((s) => s.load);
  const freshness = computeFreshness(status, live);
  const pillContent = buildPillText(status, live);

  // 完成态 2s 自动回落 — 用 ref 持有 timer id, 避免每帧重建
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
    };
  }, []);

  // mount: 拉一次 status + dbPath
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [s, p] = await Promise.all([apiGetSyncStatus(), apiGetDbPath()]);
        if (!cancelled) {
          setStatus(s);
          setDbPath(p);
        }
      } catch (e) {
        console.warn("[HomeStatusBar] init load failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 监听 sync-progress + sessions-updated
  useEffect(() => {
    let unlistenProgress: (() => void) | null = null;
    let unlistenUpdated: (() => void) | null = null;

    listen<ProgressPayload>("sync-progress", (e) => {
      const p = e.payload;
      // 取消上一次的 done 回落 timer
      if (doneTimerRef.current) {
        clearTimeout(doneTimerRef.current);
        doneTimerRef.current = null;
      }
      switch (p.phase) {
        case "scanning":
          setLive({ kind: "scanning" });
          break;
        case "syncing": {
          setLive({
            kind: "syncing",
            total: p.total ?? 0,
            done: p.done ?? 0,
            failed: p.failed ?? 0,
            currentFile: p.current_file ?? null,
          });
          break;
        }
        case "done": {
          const total = p.total ?? 0;
          const done = p.done ?? 0;
          const failed = p.failed ?? 0;
          setLive({ kind: "done", total, done, failed, expiresAt: Date.now() + 2000 });
          // 2s 后回落 + 拉一次最新 status
          doneTimerRef.current = setTimeout(() => {
            setLive({ kind: "idle" });
            void apiGetSyncStatus()
              .then(setStatus)
              .catch(() => {});
          }, 2000);
          break;
        }
        // v0.8.13 item E: failed > 0 时后端发 partial_error phase,
        // 渲染黄色 ⚠ 而不是绿色 ✓ (避免误导用户部分失败 = 同步成功)
        case "partial_error": {
          const total = p.total ?? 0;
          const done = p.done ?? 0;
          const failed = p.failed ?? 0;
          setLive({
            kind: "partial_error",
            total,
            done,
            failed,
            expiresAt: Date.now() + 5000, // 5s 让用户看清失败计数
          });
          doneTimerRef.current = setTimeout(() => {
            setLive({ kind: "idle" });
            void apiGetSyncStatus()
              .then(setStatus)
              .catch(() => {});
          }, 5000);
          break;
        }
        case "error":
          setLive({ kind: "error", message: p.message ?? "sync error" });
          break;
      }
    }).then((u) => {
      unlistenProgress = u;
    });

    // v0.8.3 fix: 用 load() 断 refresh storm; 这里只 listen sessions-updated 拿最新 mtime
    listen("sessions-updated", () => {
      void apiGetSyncStatus()
        .then(setStatus)
        .catch(() => {});
      void load();
    }).then((u) => {
      unlistenUpdated = u;
    });

    return () => {
      if (unlistenProgress) unlistenProgress();
      if (unlistenUpdated) unlistenUpdated();
    };
  }, [load]);

  const handleManualRefresh = () => {
    void refresh();
  };

  const handleRebuild = async () => {
    // v0.8.14 item A: 共享文案 — DatabasePanel 也用同一个常量
    if (!window.confirm(REBUILD_CONFIRM_TEXT)) return;
    setRebuilding(true);
    setRebuildError(null);
    try {
      await apiRebuildDb();
      const s = await apiGetSyncStatus();
      setStatus(s);
    } catch (e: unknown) {
      setRebuildError(e instanceof Error ? e.message : String(e));
    } finally {
      setRebuilding(false);
    }
  };

  const isLive = live.kind === "scanning" || live.kind === "syncing";

  return (
    <div className="home-status-bar" data-freshness={freshness} data-live={live.kind}>
      <button
        type="button"
        className="home-status-pill"
        onClick={() => setExpanded((v) => !v)}
        data-testid="home-status-pill"
        title={expanded ? "收起" : "展开 sync 状态"}
      >
        <span className={`home-status-dot home-status-dot-${freshness}`} aria-hidden />
        <span className="home-status-pill-icon" aria-hidden>
          {isLive || live.kind === "done" || live.kind === "partial_error" || live.kind === "error"
            ? pillContent.icon
            : ""}
        </span>
        <span className="home-status-pill-text" data-testid="home-status-pill-text">
          {pillContent.text}
        </span>
        <span
          className="home-status-pill-btn"
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            handleManualRefresh();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              handleManualRefresh();
            }
          }}
          title="手动刷新"
        >
          ↻
        </span>
        <span className="home-status-pill-btn" aria-hidden title={expanded ? "收起" : "展开"}>
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div className="home-status-panel" data-testid="home-status-panel">
          <table className="home-status-table">
            <tbody>
              <tr>
                <th>Last sync</th>
                <td>{formatTimestamp(status?.lastRunAt ?? null)}</td>
              </tr>
              <tr>
                <th>Status</th>
                <td>
                  {live.kind === "scanning"
                    ? "Scanning…"
                    : live.kind === "syncing"
                      ? `Syncing ${live.done}/${live.total}`
                      : live.kind === "done"
                        ? `Done (${live.done}/${live.total})`
                        : live.kind === "partial_error"
                          ? `Partial error (${live.done}/${live.total}, ${live.failed} failed)`
                          : live.kind === "error"
                            ? `Error: ${live.message}`
                            : status?.inProgress
                              ? "Syncing…"
                              : status?.lastError
                                ? `Error: ${status.lastError}`
                                : "Idle"}
                </td>
              </tr>
              <tr>
                <th>Files</th>
                <td>
                  seen {status?.filesSeen ?? 0} · synced {status?.filesSynced ?? 0}
                  {(status?.filesSeen ?? 0) - (status?.filesSynced ?? 0) > 0 && (
                    <> · failed {(status?.filesSeen ?? 0) - (status?.filesSynced ?? 0)}</>
                  )}
                </td>
              </tr>
              <tr>
                <th>Last error</th>
                <td>{status?.lastError ?? "(none)"}</td>
              </tr>
              <tr>
                <th>DB path</th>
                <td className="home-status-mono">{dbPath}</td>
              </tr>
            </tbody>
          </table>
          <div className="home-status-actions">
            <button
              type="button"
              className="home-status-btn"
              onClick={handleRebuild}
              disabled={rebuilding}
              data-testid="home-status-rebuild"
            >
              {rebuilding ? "重建中…" : "重建数据库"}
            </button>
            {rebuildError && (
              <span className="home-status-error" role="alert">
                {rebuildError}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
