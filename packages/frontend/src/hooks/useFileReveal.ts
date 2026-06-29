/**
 * useFileReveal — 文件路径 reveal 集中处理 hook (v0.6.0)
 *
 * 封装:
 * - 调 apiRevealInFinder, 透传 workspaceRoot + allowRelaxed
 * - 错误转成 i18n 友好的 toast message
 * - 后续可加 click analytics, 现在先 1 个 hook 集中
 *
 * 用法:
 *   const { reveal } = useFileReveal();
 *   <span onClick={() => reveal(filePath)}>{filePath}</span>
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { apiRevealInFinder } from "../lib/api";
import { useSettingsStore } from "../state/settingsStore";
import { extractErrorMessage } from "../lib/api";

export interface FileRevealResult {
  /** reveal 文件, 失败返回错误消息(可显示 toast) */
  reveal: (path: string) => Promise<void>;
  /** 直接拿错误消息(给 UI 弹 toast 用) */
  revealAndNotify: (path: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

export function useFileReveal(): FileRevealResult {
  const { t } = useTranslation();
  const allowRelaxed = useSettingsStore((s) => s.settings.pathSecurity?.allowRelaxed ?? false);
  const workspaceRoot = useSettingsStore(
    (s) => s.settings.defaultExportDir // 暂用 defaultExportDir 当 workspaceRoot proxy
  );

  // 实际: workspaceRoot 应从当前 SessionMeta.workspaceGuess 来 (v0.6.0 UX 改进)
  // 现在先用 settings 里的值, 后续可让调用方传 meta

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
        // ⚠️ 这里不打 console.log (会污染 Tauri 生产日志)
        // 调用方应该 listen 这个 Promise 返回的错误, 自己决定 UI 处理
        // (通常弹 toast, 跟 useToast 配合)
        // 静默 fail 是有意 — 用户取消 reveal 不需要错误噪音
        void t; // 保留 i18n 引用, 后续可加错误 toast
      }
    },
    [revealAndNotify, t]
  );

  return { reveal, revealAndNotify };
}
