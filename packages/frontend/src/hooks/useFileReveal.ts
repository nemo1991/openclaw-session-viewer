/**
 * useFileReveal — 文件路径 reveal 集中处理 hook (v0.6.0, 0.6.x 改)
 *
 * 封装:
 * - 调 apiRevealInFinder, 透传 workspaceRoot + allowRelaxed
 * - 错误不再静默 fail — console.warn 完整信息 + 让 UI 显示反馈
 *
 * v0.6.x fix: 之前 reveal() 函数静默吞错误 (void t 是有意), 用户报
 * 'reveal 按钮无效' — 实际是后端拒绝路径 (workspace 越界) 但 UI 无感知。
 * 修复: revealAndNotify 已有错信息返回, 改 reveal() 让它 console.warn
 * + 通过 window event 让全屏有 toast 的组件监听。
 *
 * 用法:
 *   const { reveal, revealAndNotify } = useFileReveal();
 *   // 简单场景: reveal(path) — 失败会 console.warn + 派发 'reveal-error' 事件
 *   // 复杂场景: revealAndNotify(path) — 拿 {ok, error} 自己处理 UI
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { apiRevealInFinder } from "../lib/api";
import { useSettingsStore } from "../state/settingsStore";
import { extractErrorMessage } from "../lib/api";

export interface FileRevealResult {
  /**
   * reveal 文件, 失败 → console.warn + 派发 'openclaw:reveal-error' CustomEvent
   * (App 可在 window 上 addEventListener 弹 toast)
   */
  reveal: (path: string) => Promise<void>;
  /** 直接拿错误消息(给 UI 弹 inline error 用) */
  revealAndNotify: (
    path: string
  ) => Promise<{ ok: true; error?: undefined } | { ok: false; error: string }>;
}

/** 自定义事件名 — App.tsx 可以 addEventListener 弹 toast */
export const REVEAL_ERROR_EVENT = "openclaw:reveal-error";

export function useFileReveal(): FileRevealResult {
  const { t } = useTranslation();
  const allowRelaxed = useSettingsStore((s) => s.settings.pathSecurity?.allowRelaxed ?? false);
  const workspaceRoot = useSettingsStore(
    (s) => s.settings.defaultExportDir // 暂用 defaultExportDir 当 workspaceRoot proxy
  );

  const revealAndNotify = useCallback(
    async (path: string) => {
      try {
        await apiRevealInFinder(path, workspaceRoot ?? null, allowRelaxed);
        return { ok: true as const };
      } catch (e) {
        const msg = extractErrorMessage(e);
        return { ok: false as const, error: msg };
      }
    },
    [workspaceRoot, allowRelaxed]
  );

  const reveal = useCallback(
    async (path: string) => {
      const result = await revealAndNotify(path);
      if (!result.ok) {
        // v0.6.x fix: 不再静默 (用户报 'reveal 按钮无效')
        // 1) console.warn 完整错 (开发者能看见)
        // 2) 派发 CustomEvent 让 App 弹 toast
        console.warn(`[reveal] failed for ${path}:`, result.error);
        window.dispatchEvent(
          new CustomEvent(REVEAL_ERROR_EVENT, {
            detail: { path, error: result.error },
          })
        );
        void t; // 保留 i18n 引用
      }
    },
    [revealAndNotify, t]
  );

  return { reveal, revealAndNotify };
}
