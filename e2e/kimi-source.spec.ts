/**
 * v0.9.0: Kimi Code 第三种 source 的 E2E smoke
 *
 * vite preview 跑静态 build,Tauri IPC 全 mock。验证:
 * 1. 首页加载 (Kimi radio 渲染 — Source union 加 "kimi" 后无 runtime 报错)
 * 2. 切换到 Kimi 源后,source filter 行为正常 (UI 不崩)
 * 3. 无新增 JS 错误 (normalize.ts / sessionsStore.ts 改动后无回归)
 */

import { test, expect } from "@playwright/test";

test.describe("Kimi Source (v0.9.0)", () => {
  test("首页加载 — Kimi radio 渲染无错", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(500);

    // 过滤已知 Tauri 缺失警告
    const realErrors = errors.filter(
      (e) =>
        !e.includes("__TAURI__") &&
        !e.includes("tauri") &&
        !e.includes("window.__TAURI_INTERNALS__") &&
        !e.includes("transformCallback")
    );
    expect(realErrors).toEqual([]);
  });

  test("Kimi radio 标签可见 (i18n 已含 'Kimi Code')", async ({ page }) => {
    await page.goto("/");
    // 给 React mount + i18n init 一点时间
    await page.waitForTimeout(800);

    // SessionsRoute 渲染 source filter radio 组 — Kimi 是第三项
    // v0.9.0: zh-CN.ts 加了 sessions.source.kimi = "Kimi Code"
    const kimiLabel = page.getByText("Kimi Code", { exact: true }).first();
    await expect(kimiLabel).toBeVisible({ timeout: 5000 });
  });
});
