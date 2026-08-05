/** 快捷键管理 */

import { useEffect } from "react";

export type KeyHandler = (e: KeyboardEvent) => void;

export function useKey(key: string, handler: KeyHandler, deps: unknown[] = []) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matchKey(e, key)) {
        handler(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

// 跨平台契约 (v0.8.15):
//   pattern 里出现 cmd / ctrl / meta 任一标记 → "meta 组"激活。
//   真实匹配: e.metaKey (macOS Cmd) OR (e.ctrlKey && !e.metaKey) (Win/Linux Ctrl)。
//   `!e.metaKey` guard 让 macOS 上 Ctrl (right-click 修饰键) 不会跟 Cmd 模式混淆。
//   alt 保留字面 e.altKey (codebase 无 alt+* pattern,无 remap 必要)。
//   shift 也是字面 e.shiftKey。
function matchKey(e: KeyboardEvent, pattern: string): boolean {
  const parts = pattern.split("+").map((p) => p.trim().toLowerCase());
  const metaGroupWanted = parts.some((p) => p === "cmd" || p === "ctrl" || p === "meta");
  const metaPressed = e.metaKey || (e.ctrlKey && !e.metaKey);
  const shift = parts.includes("shift");
  const alt = parts.includes("alt");
  const main = parts[parts.length - 1];

  if (metaGroupWanted !== metaPressed) return false;
  if (e.shiftKey !== shift) return false;
  if (e.altKey !== alt) return false;
  if (main && e.key.toLowerCase() !== main) return false;
  return true;
}

export { matchKey };
