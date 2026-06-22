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

function matchKey(e: KeyboardEvent, pattern: string): boolean {
  const parts = pattern.split("+").map((p) => p.trim().toLowerCase());
  const meta = parts.includes("cmd") || parts.includes("ctrl") || parts.includes("meta");
  const shift = parts.includes("shift");
  const alt = parts.includes("alt");
  const main = parts[parts.length - 1];

  if (e.metaKey !== meta) return false;
  if (e.shiftKey !== shift) return false;
  if (e.altKey !== alt) return false;
  if (main && e.key.toLowerCase() !== main) return false;
  return true;
}
