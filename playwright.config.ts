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
 */

import { defineConfig, devices } from "@playwright/test";

const PORT = 4173; // vite preview 默认端口

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
    // 强制直连,绕开某些 dev 环境的 http_proxy
    proxy: { server: "direct://" },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          // chromium 走 system proxy 检测 = 走 system http_proxy env,
          // 强制设 direct:// 走直连 (注意:不能是 --no-proxy-server,
          // 那个 flag 会被 system env 覆盖;proxy-server 设成 "direct://"
          // 才是 chromium 协议意义上的 "不走任何代理")
          proxy: {
            server: "direct://",
          },
        },
      },
    },
  ],
  // globalSetup 起 preview server (见 e2e/global-setup.ts),
  // 不用 webServer: 它走系统代理 check URL,在某些 dev 环境下不可用
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-setup.ts",
});
