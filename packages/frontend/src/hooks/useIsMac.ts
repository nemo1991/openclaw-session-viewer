/**
 * v0.9.7: 跨平台修饰键检测 hook — Tauri 桌面应用场景下用 navigator.userAgent
 * 推断 macOS,返回 "⌘"/"Ctrl" 修饰键 symbol 跟"Cmd"/"Ctrl" 文本。
 *
 * 之前 `title="重新解析 jsonl + 触发后端 sync (Cmd/Ctrl+R)"` 在 macOS 用户看
 * 来不专业(应该 ⌘R 不是 Cmd+R),在 Windows 用户看冗余(应该 Ctrl+R)。
 * 用 useIsMac().modifier 让 UI 文案跟 platform 对齐。
 *
 * 未来 useKey 提示、菜单 accelerator 都能复用。
 */
export function useIsMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** 跟 useIsMac 配对: 返回 "⌘" (mac) / "Ctrl" (其他) */
export function useModifierSymbol(): "⌘" | "Ctrl" {
  return useIsMac() ? "⌘" : "Ctrl";
}

/** 跟 useIsMac 配对: 返回 "Cmd" (mac) / "Ctrl" (其他) — 给 title 等长文本用 */
export function useModifierLabel(): "Cmd" | "Ctrl" {
  return useIsMac() ? "Cmd" : "Ctrl";
}
