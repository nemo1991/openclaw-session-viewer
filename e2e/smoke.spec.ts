/**
 * Smoke E2E 测试 — 跑 vite preview
 *
 * 验证前端能加载 + 关键 UI 元素存在。
 * 因为 vite preview 跑的是静态 build,Tauri 的 IPC 全不可用,
 * 只测"渲染到首屏"的路径。
 *
 * 完整 Tauri E2E (含 IPC / 真实会话数据) 见 docs/CROSS_PLATFORM_BUILD.md。
 */

import { test, expect } from "@playwright/test";

test.describe("Smoke", () => {
  test("首页加载", async ({ page }) => {
    await page.goto("/");

    // 等待 root 元素挂载
    const root = page.locator("#root");
    await expect(root).toBeVisible();

    // 任何子元素渲染出来即视为"挂载成功"
    await expect(root).not.toBeEmpty();
  });

  test("无 JS 错误", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/");
    // 等待 React mount
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(500);

    // 过滤已知的 Tauri 缺失警告(测试环境没 Tauri runtime)
    const realErrors = errors.filter(
      (e) =>
        !e.includes("__TAURI__") &&
        !e.includes("tauri") &&
        !e.includes("window.__TAURI_INTERNALS__")
    );
    expect(realErrors).toEqual([]);
  });
});
