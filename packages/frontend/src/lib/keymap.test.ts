/**
 * keymap.matchKey 单元测试
 *
 * 测试快捷键匹配逻辑:
 * - 单键 (key="Enter")
 * - cmd+k 匹配 Meta+k (macOS 风格)
 * - cmd+shift+f 多 modifier
 * - 大小写不敏感 (pattern 和 e.key 都 lowercase)
 * - modifier 不匹配返回 false
 *
 * 已知限制:  "cmd"/"ctrl"/"meta" 在 pattern 里被合并为一组,
 * 但只检查 e.metaKey, 不检查 e.ctrlKey / e.altKey。
 * 后果: Windows/Linux 上 Ctrl+K 不匹配 "cmd+k" pattern。
 * 调用方在 SessionsRoute.tsx 同时注册 "cmd+k" + "ctrl+k" 两个 useKey 绕过。
 * TODO: 修复 — 让 "meta 组" 同时接受 e.metaKey OR (e.ctrlKey && !e.metaKey)
 */

import { describe, it, expect } from "vitest";
import { matchKey } from "./keymap";

function makeKeyEvent(
  key: string,
  opts: { meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}
): KeyboardEvent {
  return {
    key,
    metaKey: !!opts.meta,
    ctrlKey: !!opts.ctrl,
    shiftKey: !!opts.shift,
    altKey: !!opts.alt,
  } as KeyboardEvent;
}

describe("matchKey", () => {
  it("单键 'Enter' 匹配 Enter", () => {
    expect(matchKey(makeKeyEvent("Enter"), "Enter")).toBe(true);
  });

  it("单键 'Escape' 匹配 Escape", () => {
    expect(matchKey(makeKeyEvent("Escape"), "Escape")).toBe(true);
  });

  it("单键 'k' 不区分大小写", () => {
    expect(matchKey(makeKeyEvent("k"), "k")).toBe(true);
    expect(matchKey(makeKeyEvent("K"), "k")).toBe(true); // 内部 lowercase
  });

  it("单键 'n' 不需要任何 modifier (但多按了 cmd 就不匹配)", () => {
    expect(matchKey(makeKeyEvent("n"), "n")).toBe(true);
    expect(matchKey(makeKeyEvent("n", { meta: true }), "n")).toBe(false);
  });

  it("cmd+k 匹配 Meta+k (macOS 风格)", () => {
    expect(matchKey(makeKeyEvent("k", { meta: true }), "cmd+k")).toBe(true);
  });

  it("ctrl+k 匹配 'ctrl+k' pattern (因为 meta 组 = true, e.metaKey = false,不一致?)", () => {
    // 实际行为:  pattern "ctrl+k" → meta=true, e.ctrlKey=true 但 e.metaKey=false
    // → e.metaKey (false) !== meta (true) → false
    // 已知 bug,Windows 上 Ctrl+K 不工作
    expect(matchKey(makeKeyEvent("k", { ctrl: true }), "ctrl+k")).toBe(false);
  });

  it("cmd+shift+f 多 modifier", () => {
    expect(matchKey(makeKeyEvent("f", { meta: true, shift: true }), "cmd+shift+f")).toBe(true);
    // 少按 shift 不匹配
    expect(matchKey(makeKeyEvent("f", { meta: true }), "cmd+shift+f")).toBe(false);
    // 多按 alt 不匹配
    expect(matchKey(makeKeyEvent("f", { meta: true, shift: true, alt: true }), "cmd+shift+f")).toBe(
      false
    );
  });

  it("shift+enter 多键 (shift + main key)", () => {
    expect(matchKey(makeKeyEvent("Enter", { shift: true }), "shift+enter")).toBe(true);
    // 不按 shift 不匹配
    expect(matchKey(makeKeyEvent("Enter"), "shift+enter")).toBe(false);
  });

  it("大小写不敏感:pattern 'CMD+K' 等价 'cmd+k'", () => {
    expect(matchKey(makeKeyEvent("k", { meta: true }), "CMD+K")).toBe(true);
  });

  it("key 不匹配:cmd+k 不匹配 cmd+f", () => {
    expect(matchKey(makeKeyEvent("f", { meta: true }), "cmd+k")).toBe(false);
  });

  it("全 modifier 没按:cmd+k 需要 meta=true", () => {
    expect(matchKey(makeKeyEvent("k"), "cmd+k")).toBe(false);
  });

  it("extra modifier 多按:cmd+k 不应匹配 cmd+alt+k", () => {
    expect(matchKey(makeKeyEvent("k", { meta: true, alt: true }), "cmd+k")).toBe(false);
  });
});
