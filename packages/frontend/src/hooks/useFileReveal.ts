/**
 * useFileReveal — 文件路径 reveal 集中处理 hook (v0.6.x)
 *
 * 封装:
 * - 调 apiRevealInFinder, 透传 workspaceRoot + allowRelaxed
 * - 错误不再静默 fail — console.warn 完整信息 + 让 UI 显示反馈
 *
 * v0.6.x fix (用户报 '一键设置并未生效'):
 * 之前直接用 settings.defaultExportDir 当 workspaceRoot, 但 plan 文件在
 * ~/.claude/plans/ 不在 projectsDir (settings.defaultExportDir), 永远越界。
 * 修复:
 * - hook 接受 options.sessionJsonlPath → 自动从 jsonl 路径提取
 *   '.claude/projects/<encoded-cwd>/', 作为兜底 workspaceRoot (满足后端 assert_within_any_root)
 * - 同时保留 settings.defaultExportDir override (用户显式设的优先)
 * - hook 还接受 options.workspaceRoot per-call override, 用于 Settings 一键 'setClaudeHome'
 *
 * 用法:
 *   const { reveal, revealAndNotify } = useFileReveal({ sessionJsonlPath });
 *   <span onClick={() => reveal(filePath)}>{filePath}</span>
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { apiRevealInFinder } from "../lib/api";
import { useSettingsStore } from "../state/settingsStore";
import { extractErrorMessage } from "../lib/api";

export interface UseFileRevealOptions {
  /** 当前 session 的 jsonl 路径, e.g. /Users/foo/.claude/projects/<encoded-cwd>/abc.jsonl
   *  hook 会提取父目录 ~/.claude/projects/<encoded-cwd>/ 作为兜底 workspaceRoot */
  sessionJsonlPath?: string;
}
export interface RevealCallOptions {
  /** 临时 override workspaceRoot (跳过 settings.defaultExportDir + sessionJsonlPath 推断) */
  workspaceRoot?: string | null;
}

export interface FileRevealResult {
  /**
   * reveal 文件, 失败 → console.warn + 派发 'openclaw:reveal-error' CustomEvent
   * (App 可在 window 上 addEventListener 弹 toast)
   */
  reveal: (path: string, opts?: RevealCallOptions) => Promise<void>;
  /** 直接拿错误消息(给 UI 弹 inline error 用) */
  revealAndNotify: (
    path: string,
    opts?: RevealCallOptions
  ) => Promise<{ ok: true; error?: undefined } | { ok: false; error: string }>;
}

/** 自定义事件名 — App.tsx 可以 addEventListener 弹 toast */
export const REVEAL_ERROR_EVENT = "openclaw:reveal-error";

/**
 * v0.6.x: 从 session jsonl path 提取 parent dir 作 fallback workspaceRoot
 * ~/.claude/projects/<encoded-cwd>/abc.jsonl → ~/.claude/projects/<encoded-cwd>/
 *
 * 这个 dir 是后端 assert_within_any_root 认可的 known root (default_root.claude.projects_dir
 * 是 ~/.claude/projects/, 子目录都在里面)。
 */
function deriveWorkspaceRootFromSession(sessionJsonlPath?: string): string | null {
  if (!sessionJsonlPath) return null;
  // 取父目录
  const sep = sessionJsonlPath.includes("\\") ? "\\" : "/";
  const idx = sessionJsonlPath.lastIndexOf(sep);
  if (idx <= 0) return null;
  return sessionJsonlPath.slice(0, idx + 1);
}

export function useFileReveal(options: UseFileRevealOptions = {}): FileRevealResult {
  const { t } = useTranslation();
  const allowRelaxed = useSettingsStore((s) => s.settings.pathSecurity?.allowRelaxed ?? false);
  const defaultExportDir = useSettingsStore((s) => s.settings.defaultExportDir);

  // 每调用 resolve workspaceRoot:
  // 1. opts.workspaceRoot override (per-call)
  // 2. settings.defaultExportDir (用户显式配置)
  // 3. deriveWorkspaceRootFromSession(sessionJsonlPath) (兜底, 让 Claude 路径默认通过)
  // 4. null (无 workspaceRoot, lock-down 模式会被拒 → 提示用户去 settings)
  const resolveWorkspaceRoot = useCallback(
    (opts?: RevealCallOptions): string | null => {
      if (opts?.workspaceRoot !== undefined) return opts.workspaceRoot;
      if (defaultExportDir) return defaultExportDir;
      const derived = deriveWorkspaceRootFromSession(options.sessionJsonlPath);
      return derived;
    },
    [defaultExportDir, options.sessionJsonlPath]
  );

  const revealAndNotify = useCallback(
    async (path: string, opts?: RevealCallOptions) => {
      try {
        const root = resolveWorkspaceRoot(opts);
        await apiRevealInFinder(path, root, allowRelaxed);
        return { ok: true as const };
      } catch (e) {
        const msg = extractErrorMessage(e);
        return { ok: false as const, error: msg };
      }
    },
    [resolveWorkspaceRoot, allowRelaxed]
  );

  const reveal = useCallback(
    async (path: string, opts?: RevealCallOptions) => {
      const result = await revealAndNotify(path, opts);
      if (!result.ok) {
        // v0.6.x fix: 不再静默 (用户报 'reveal 按钮无效')
        console.warn(`[reveal] failed for ${path}:`, result.error);
        window.dispatchEvent(
          new CustomEvent(REVEAL_ERROR_EVENT, {
            detail: { path, error: result.error },
          })
        );
        void t;
      }
    },
    [revealAndNotify, t]
  );

  return { reveal, revealAndNotify };
}
