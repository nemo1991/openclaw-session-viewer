/**
 * Vitest 全局 setup
 *
 * - 引入 @testing-library/jest-dom matchers (toBeInTheDocument / toHaveTextContent 等)
 * - 全局 mock @tauri-apps/api/* — 测试环境没有 Tauri runtime
 * - 全局 afterEach cleanup — 防止 component test 间 DOM 残留
 * - 加载 i18n 资源 — 组件用了 useTranslation
 */

import { vi, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

// ---- 每个 test 后自动 cleanup DOM ----
afterEach(() => {
  cleanup();
});

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
