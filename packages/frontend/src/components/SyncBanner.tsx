/**
 * v0.8.0 SyncBanner — 后台同步进度 toast
 *
 * 监听 Tauri 事件 "sync-progress",显示:
 * - scanning: 文件扫描中
 * - syncing: N/M 完成 + 当前文件名
 * - done: 完成后 2s 自动消失
 * - error: 持续显示
 *
 * 设计:不抢戏,右上角小 toast,深浅模式都用主题色。
 */

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import "./SyncBanner.css";

interface ProgressPayload {
  phase: "scanning" | "syncing" | "done" | "error";
  total: number;
  done: number;
  failed: number;
  currentFile?: string | null;
}

export function SyncBanner() {
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    listen<ProgressPayload>("sync-progress", (e) => {
      const p = e.payload;
      setProgress(p);
      if (p.phase === "scanning" || p.phase === "syncing") {
        setVisible(true);
      } else if (p.phase === "done") {
        setVisible(true);
        setTimeout(() => setVisible(false), 2000);
      } else if (p.phase === "error") {
        setVisible(true);
      }
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  if (!progress || !visible) return null;

  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className={`sync-banner sync-banner-${progress.phase}`}>
      {progress.phase === "syncing" || progress.phase === "scanning" ? (
        <>
          <Loader2 size={14} className="sync-spin" />
          <span className="sync-text">
            {progress.phase === "scanning"
              ? "扫描中…"
              : `同步中 ${progress.done}/${progress.total}`}
          </span>
          {progress.total > 0 && <span className="sync-pct">{pct}%</span>}
          {progress.currentFile && progress.phase === "syncing" && (
            <span className="sync-file" title={progress.currentFile}>
              {progress.currentFile.split("/").slice(-2).join("/")}
            </span>
          )}
        </>
      ) : progress.phase === "done" ? (
        <>
          <CheckCircle2 size={14} />
          <span className="sync-text">
            同步完成({progress.done}/{progress.total}
            {progress.failed > 0 ? `,失败 ${progress.failed}` : ""})
          </span>
        </>
      ) : (
        <>
          <AlertCircle size={14} />
          <span className="sync-text">同步出错</span>
        </>
      )}
    </div>
  );
}
