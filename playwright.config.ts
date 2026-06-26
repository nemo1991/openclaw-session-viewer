/**
 * Playwright E2E 配置
 *
 * 测的是 vite preview (纯前端) — Tauri webview 走相同 React bundle
 * 不需要 Tauri runtime;@tauri-apps/api 的 invoke 全 mock
 *
 * 命令:pnpm test:e2e (顶层) / pnpm --filter @ocsv/frontend test:e2e
 *
 * 注意:这是 smoke 测试。Tauri 完整 E2E 需要起 tauri dev + WebDriver,
 * 见 docs/CROSS_PLATFORM_BUILD.md。
 *
 * 踩坑(2026-06-27):
 * - 不要加 --proxy-server=direct:// / proxy: { server: "direct://" } —
 *   chromium 启起来后会强制 IPv4 路径,vite preview 在 macOS 默认只 listen ::1
 * - 不要改 proxy 配置绕过 env — 直接用默认参数即可
 * - baseURL 必须用 localhost(macOS 解析到 ::1),不要 127.0.0.1
 * - 如果 dev env 设了 http_proxy=127.0.0.1:8001,Chromium 会读 env
 *   → ERR_PROXY_CONNECTION_FAILED,需要 unset http_proxy 后再跑
 */

import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-setup.ts",
});
