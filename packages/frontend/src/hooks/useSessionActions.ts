/**
 * v0.9.24 (M7): useSessionActions — 重载+导出 2 个最重的 cross-cutting
 * 关注点抽到独立 hook。
 *
 * 之前 `SessionDetailRoute.tsx` inline 的 `handleReload` + `handleExport`
 * 2 个 callback 里都有:
 * - `useState` / `useCallback` 状态
 * - `useModifierLabel` 平台检测
 * - dynamic import `@tauri-apps/plugin-dialog` + `apiExportMarkdown/HTML`
 * - 多 store mutation (`useSessionsStore.refresh` + `useTranscriptStore.reset/start`)
 * - router `navigate` + `location` 引用
 *
 * 抽到 hook 后:
 * - `<SessionHeader>` 内部调用 `useSessionActions(meta)` 拿 `{ handleReload,
 *   handleExport, reloading, reloadModifier }` 直接用,无 prop drilling
 * - `useKey("cmd+r", ...)` 留在 route 层 (跟 cmd+f 同层),handler 引用
 *   hook 返回的 `handleReload`
 * - `useSessionActions` 完全独立,只依赖 `meta` (避免 hook 间的隐式依赖)
 *
 * 数据契约 (跟 v0.8.11 一致):
 * - handleReload: 后端 sync + sessions 列表刷新 + 找当前 sid 新 meta
 *   + navigate 替换 location.state + transcript store reset + start
 * - handleExport: save dialog → apiExportMarkdown/HTML → reveal in finder
 *
 * 错误边界:
 * - handleExport: save dialog canceled → `if (!out) return` (no error)
 * - handleReload: 任何 throw → `console.error` (no rethrow)
 */

import { useCallback, useState } from "react";
import type { NavigateFunction } from "react-router-dom";
import type { SessionMeta } from "@ocsv/shared";

import { useSessionsStore } from "../state/sessionsStore";
import { useTranscriptStore } from "../state/transcriptStore";
import { useModifierLabel } from "./useIsMac";
import { apiRevealInFinder } from "../lib/api";

export interface SessionActionsContext {
  /** 当前 session meta (来自 SessionDetailRoute useMemo) */
  meta: SessionMeta | undefined;
  /** jsonlPath 用于 export (跟 meta.jsonlPath 一致, 但作为独立参数兼容 sub-agent 跳转) */
  targetPath: string | undefined;
  /** session id (used as export default filename) */
  sessionId: string | undefined;
  /** react-router navigate (让 hook 不依赖 useLocation, 路由信息由 caller 提供) */
  navigate: NavigateFunction;
  /** 当前 pathname + search (用于 reload 替换 location.state) */
  pathnameSearch: string;
}

export interface SessionActions {
  reloading: boolean;
  reloadModifier: "Cmd" | "Ctrl";
  handleReload: () => Promise<void>;
  handleExport: (format: "md" | "html") => Promise<void>;
}

export function useSessionActions(ctx: SessionActionsContext): SessionActions {
  const { meta, targetPath, sessionId, navigate, pathnameSearch } = ctx;
  const [reloading, setReloading] = useState(false);
  const reloadModifier = useModifierLabel();

  const handleReload = useCallback(async () => {
    if (!meta || reloading) return;
    setReloading(true);
    try {
      await useSessionsStore.getState().refresh();
      // sessions list 已更新 — 找当前 sid 对应新 meta
      const refreshed = useSessionsStore
        .getState()
        .sessions.find((s) => s.sessionId === meta.sessionId);
      if (refreshed) {
        // 用新 meta 替换 location.state 触发 useMemo 重新派生
        navigate(pathnameSearch, {
          state: { session: refreshed },
          replace: true,
        });
      }
      // 重解析 transcript (必须先 reset 再 start, start 短路同 path)
      const currentPath = useTranscriptStore.getState().path;
      if (currentPath) {
        useTranscriptStore.getState().reset();
        await useTranscriptStore.getState().start(currentPath);
      }
    } catch (e) {
      console.error("reload failed", e);
    } finally {
      setReloading(false);
    }
  }, [meta, reloading, navigate, pathnameSearch]);

  const handleExport = useCallback(
    async (format: "md" | "html") => {
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
      await apiRevealInFinder(out, null, true);
    },
    [meta, targetPath, sessionId]
  );

  return { reloading, reloadModifier, handleReload, handleExport };
}
