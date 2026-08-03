/**
 * Vitest 全局 setup
 *
 * - 引入 @testing-library/jest-dom matchers (toBeInTheDocument / toHaveTextContent 等)
 * - 全局 mock @tauri-apps/api/* — 测试环境没有 Tauri runtime
 * - 全局 afterEach cleanup — 防止 component test 间 DOM 残留
 * - 加载 i18n 资源 — 组件用了 useTranslation
 * - polyfill globalThis.localStorage — vitest 2.1.9 + jsdom 29 走 setupVM 路径,
 *   populateGlobal 用 vm.context 不会把 window.localStorage 挂到 globalThis,
 *   overridesStore 等直接用 `localStorage.xxx` 的测试会炸。手动挂一个共享实例。
 */

import { vi, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ---- 每个 test 后自动 cleanup DOM ----
afterEach(() => {
  cleanup();
});

// ---- jsdom 没实现 scrollIntoView,useTranscriptScroll 需要 ----
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function () {};
}

// ---- polyfill globalThis.localStorage (vitest 2.1.9 + jsdom 29 setupVM 路径不挂载) ----
// 用同一个 jsdom window 的 localStorage 给所有 test 用,带 http://localhost URL 避开
// "localStorage is not available for opaque origins"。
if (typeof (globalThis as { localStorage?: unknown }).localStorage === "undefined") {
  // jsdom 没有官方 @types,运行时拿 JSDOM class,类型层用 unknown 兜底。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const jsdom = require("jsdom") as {
    JSDOM: new (
      html: string,
      opts?: { url?: string }
    ) => { window: { localStorage: Storage; sessionStorage: Storage } };
  };
  const dom = new jsdom.JSDOM("<!DOCTYPE html>", { url: "http://localhost:3000/" });
  (globalThis as unknown as { localStorage: Storage }).localStorage = dom.window.localStorage;
  (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = dom.window.sessionStorage;
}

// ---- Tauri API mock ----
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

// i18n 在 component 里 import 即跑 (副作用),无需显式 init
import "../i18n";
