/**
 * v0.8.10: DatabasePanel 抽到独立 component (从 SettingsRoute.tsx 拆出)
 *
 * v0.8.0 数据库管理面板:
 * - 上次同步时间 + 同步文件数
 * - 一键 Rebuild DB (清空 session_meta / override / tag / link, 重跑 sync)
 * - Export overrides → 选 JSON 路径
 * - Import overrides → 选 JSON 路径 + 冲突模式 (KeepBoth/Overwrite/Merge)
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface SyncStatusRow {
  lastRunAt: number | null;
  lastError: string | null;
  filesSeen: number;
  filesSynced: number;
  inProgress: boolean;
}

export function DatabasePanel() {
  const [status, setStatus] = useState<SyncStatusRow | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const s = await invoke<SyncStatusRow>("get_sync_status");
      setStatus(s);
    } catch (e) {
      console.error("get_sync_status failed", e);
    }
  };

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const handleRebuild = async () => {
    if (!confirm("确认重建数据库?会清空所有 session_meta / override / tag / link,然后重新同步。"))
      return;
    setRebuilding(true);
    try {
      await invoke("rebuild_db");
      setHint("数据库已重建");
      await refresh();
    } catch (e) {
      setHint(`重建失败: ${String(e)}`);
    } finally {
      setRebuilding(false);
      setTimeout(() => setHint(null), 3000);
    }
  };

  const handleExport = async () => {
    setBusy(true);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const out = await save({
        defaultPath: "overrides.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!out) return;
      const n = await invoke<number>("export_overrides", { path: out });
      setHint(`已导出 ${n} 条`);
    } catch (e) {
      setHint(`导出失败: ${String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setHint(null), 3000);
    }
  };

  const handleImport = async (mode: "keepboth" | "overwrite" | "merge") => {
    setBusy(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path || typeof path !== "string") return;
      const n = await invoke<number>("import_overrides", { path, mode });
      setHint(`已导入 ${n} 条(${mode})`);
    } catch (e) {
      setHint(`导入失败: ${String(e)}`);
    } finally {
      setBusy(false);
      setTimeout(() => setHint(null), 3000);
    }
  };

  const lastRun = status?.lastRunAt ? new Date(status.lastRunAt).toLocaleString() : "—";

  return (
    <div className="db-panel" data-testid="db-panel">
      <div className="db-stats">
        <div>
          <span className="db-label">上次同步</span>
          <span className="db-value">{lastRun}</span>
        </div>
        <div>
          <span className="db-label">本次扫描</span>
          <span className="db-value">{status?.filesSeen ?? 0} 个文件</span>
        </div>
        <div>
          <span className="db-label">本次同步</span>
          <span className="db-value">{status?.filesSynced ?? 0} 个</span>
        </div>
        <div>
          <span className="db-label">状态</span>
          <span className="db-value">
            {status?.inProgress
              ? "同步中…"
              : status?.lastError
                ? `错误: ${status.lastError}`
                : "正常"}
          </span>
        </div>
      </div>
      <div className="db-actions">
        <button
          type="button"
          disabled={rebuilding}
          onClick={handleRebuild}
          data-testid="db-rebuild"
        >
          {rebuilding ? "重建中…" : "重建数据库"}
        </button>
        <button type="button" disabled={busy} onClick={handleExport} data-testid="db-export">
          导出 overrides
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => handleImport("merge")}
          data-testid="db-import-merge"
        >
          导入 (合并)
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => handleImport("keepboth")}
          data-testid="db-import-keepboth"
        >
          导入 (保留)
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => handleImport("overwrite")}
          data-testid="db-import-overwrite"
        >
          导入 (覆盖)
        </button>
      </div>
      {hint && (
        <div className="db-hint" data-testid="db-hint">
          {hint}
        </div>
      )}
    </div>
  );
}
