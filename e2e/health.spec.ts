/**
 * v0.11 (B2/B3): 会话体检 E2E smoke
 *
 * vite preview 跑静态 build,Tauri IPC 全 mock(实际是没有 runtime,invoke 被
 * eventsApi / graphStore 各自 catch)。因此这里验证的是:
 * 1. ?view=health 深链能打开 G4 体检 tab,容器渲染、空数据不报错
 * 2. 设置页体检规则阈值可编辑、可恢复默认值(B3 的 UI 部分)
 * 3. 无新增 JS 错误
 *
 * 真实带数据的标记 / 下钻由 `health.test.ts` 纯函数单测覆盖,需要 Tauri runtime。
 */

import { test, expect } from "@playwright/test";

/** 与其余 spec 一致:过滤无 Tauri runtime 造成的已知警告 */
function realErrors(errors: string[]): string[] {
  return errors.filter(
    (e) =>
      !e.includes("__TAURI__") &&
      !e.includes("tauri") &&
      !e.includes("__TAURI_INTERNALS__") &&
      !e.includes("transformCallback")
  );
}

test.describe("Session Health Check (v0.11)", () => {
  test("?view=health 深链打开体检 tab,空数据展示空状态而非报错", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/#/graph?view=health");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(700);

    const tab = page.locator('[data-testid="health-tab"]');
    await expect(tab).toHaveCount(1);
    await expect(tab).toHaveClass(/active/);
    await expect(page.locator('[data-testid="health-view"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="health-empty"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="health-risk-row"]')).toHaveCount(0);

    expect(realErrors(errors)).toEqual([]);
  });

  test("设置页体检阈值默认 20,可改为 30,并可一键恢复默认值", async ({ page }) => {
    await page.goto("/#/settings");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(700);

    const section = page.locator('[data-testid="settings-health-rules"]');
    await expect(section).toHaveCount(1);

    const threshold = page.locator('[data-testid="settings-health-high-errors-value"]');
    await expect(threshold).toHaveValue("20");
    await threshold.fill("30");
    await expect(threshold).toHaveValue("30");

    await page.locator('[data-testid="settings-health-reset"]').click();
    await expect(threshold).toHaveValue("20");
  });
});
