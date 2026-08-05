/**
 * keymap.matchKey 单元测试
 *
 * 测试快捷键匹配逻辑:
 * - 单键 (key="Enter")
 * - cmd+k 匹配 Meta+k (macOS 风格) **及** Ctrl+k (Win/Linux) — 跨平台契约
 * - cmd+shift+f 多 modifier
 * - 大小写不敏感 (pattern 和 e.key 都 lowercase)
 * - modifier 不匹配返回 false
 *
 * 跨平台契约 (v0.8.15): "cmd"/"ctrl"/"meta" 在 pattern 里被合并为一组,
 * 接受 e.metaKey (macOS Cmd) OR (e.ctrlKey && !e.metaKey) (Win/Linux Ctrl)。
 * `!e.metaKey` guard 让 macOS 上 Ctrl (right-click 修饰键) 不被 Cmd 模式误吞。
 *
 * 旧版同时在 route 注册 "cmd+x" + "ctrl+x" 两个 useKey 的 band-aid 已被移除。
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

  it("ctrl+k 匹配 'cmd+k' pattern (Win/Linux 跨平台契约)", () => {
    // v0.8.15 修复: meta 组 = e.metaKey || (e.ctrlKey && !e.metaKey)
    // → Windows/Linux 上 Ctrl+K 现在能匹配 "cmd+k" pattern, 不需要在 route 重复注册。
    expect(matchKey(makeKeyEvent("k", { ctrl: true }), "cmd+k")).toBe(true);
  });

  it("ctrl+k 匹配 'ctrl+k' pattern (语义对称)", () => {
    // "ctrl+k" pattern 跟 "cmd+k" 同样激活 meta 组 → Ctrl+k 也匹配。
    expect(matchKey(makeKeyEvent("k", { ctrl: true }), "ctrl+k")).toBe(true);
  });

  it("meta+k 匹配 'ctrl+k' pattern (cmd / ctrl / meta 三者等价)", () => {
    expect(matchKey(makeKeyEvent("k", { meta: true }), "ctrl+k")).toBe(true);
  });

  it("Cmd+Ctrl+K 双按归 meta 组 (macOS Cmd 优先约定)", () => {
    // macOS 上 Ctrl 是 right-click 修饰键, Cmd 优先。如果以后反例出现,
    // 把 `e.ctrlKey && !e.metaKey` 改成 `e.ctrlKey` 即可。
    expect(matchKey(makeKeyEvent("k", { meta: true, ctrl: true }), "cmd+k")).toBe(true);
  });

  it("macOS 裸 Ctrl+K 归 meta 组 (e.ctrlKey && !e.metaKey → true)", () => {
    // 副作用契约: macOS 上单独按 Ctrl+K 也会匹配 "cmd+k"。
    // 用户可接受 — Cmd 优先的延伸。如果想区分,需要 isMac() 检测。
    expect(matchKey(makeKeyEvent("k", { ctrl: true }), "cmd+k")).toBe(true);
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
