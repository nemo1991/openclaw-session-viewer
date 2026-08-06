/**
 * Content filter E2E 测试(v0.7.0)
 *
 * 覆盖会话详情页新增的 ContentFilterPanel:
 * 1. DOM 渲染:tool chips / role buttons / has-* buttons / clear button
 * 2. data-active 反射 store 状态
 * 3. URL round-trip:?tool/role/has 解析 → DOM 高亮
 * 4. URL 组合:?from&tool&role&has 同时存在
 *
 * 限制(vite preview 模式,见 docs/E2E_TESTING.md):
 * - 没有 Tauri runtime,entries 不流入,filter 是"无数据可筛"状态
 * - 测的是 URL → store → DOM 同步,以及用户点击 → DOM 状态变化
 * - 真正的"点了 chip 后 entries 计数变化"需要 Tauri runtime(参见 detail-page.spec.ts 同病)
 */

import { test, expect } from "@playwright/test";

test.describe("ContentFilterPanel", () => {
  test("DOM 渲染:role 3 选项 + has 4 选项 + clear 隐藏(初始无 active)", async ({ page }) => {
    // v0.9.2: ?path= 让 SessionDetailRoute 构造最小 meta,绕过 notFound;
    // ContentFilterPanel 仍然 mount(TranscriptView render 时挂载,跟 transcript 加载无关)
    await page.goto("/#/session/abc123?path=/tmp/abc123.jsonl");
    await page.waitForTimeout(300);

    // Role buttons
    await expect(page.locator('[data-testid="filter-role-all"]').first()).toHaveCount(1);
    await expect(page.locator('[data-testid="filter-role-user"]').first()).toHaveCount(1);
    await expect(page.locator('[data-testid="filter-role-assistant"]').first()).toHaveCount(1);

    // Has-* buttons
    await expect(page.locator('[data-testid="content-filter-has-thinking"]').first()).toHaveCount(
      1
    );
    await expect(page.locator('[data-testid="content-filter-has-tool_use"]').first()).toHaveCount(
      1
    );
    await expect(page.locator('[data-testid="content-filter-has-error"]').first()).toHaveCount(1);
    await expect(page.locator('[data-testid="content-filter-has-subagent"]').first()).toHaveCount(
      1
    );

    // 初始无 active → clear 按钮不渲染
    await expect(page.locator('[data-testid="content-filter-clear"]')).toHaveCount(0);
  });

  test("role:点 user → onSetRole → chip data-active=true", async ({ page }) => {
    await page.goto("/#/session/abc123?path=/tmp/abc123.jsonl");
    await page.waitForTimeout(300);

    await page.locator('[data-testid="filter-role-user"]').first().click();
    await page.waitForTimeout(150);

    const userBtn = page.locator('[data-testid="filter-role-user"]').first();
    expect(await userBtn.getAttribute("data-active")).toBe("true");
    // 切到 assistant 后 user 失活
    await page.locator('[data-testid="filter-role-assistant"]').first().click();
    await page.waitForTimeout(150);
    expect(await userBtn.getAttribute("data-active")).toBe("false");
  });

  test("has 多选:点 thinking 后 chip 高亮 + clear 按钮出现", async ({ page }) => {
    await page.goto("/#/session/abc123?path=/tmp/abc123.jsonl");
    await page.waitForTimeout(300);

    const thinkingChip = page.locator('[data-testid="content-filter-has-thinking"]').first();
    await thinkingChip.click();
    await page.waitForTimeout(150);

    expect(await thinkingChip.getAttribute("data-active")).toBe("true");
    await expect(page.locator('[data-testid="content-filter-clear"]').first()).toHaveCount(1);
  });

  test("clear 按钮 → 重置 content filter,clear 按钮消失", async ({ page }) => {
    await page.goto("/#/session/abc123?path=/tmp/abc123.jsonl");
    await page.waitForTimeout(300);

    // 激活一个 has → clear 出现
    await page.locator('[data-testid="content-filter-has-error"]').first().click();
    await page.waitForTimeout(150);
    await expect(page.locator('[data-testid="content-filter-clear"]').first()).toHaveCount(1);

    // 点 clear
    await page.locator('[data-testid="content-filter-clear"]').first().click();
    await page.waitForTimeout(150);

    const errorChip = page.locator('[data-testid="content-filter-has-error"]').first();
    expect(await errorChip.getAttribute("data-active")).toBe("false");
    await expect(page.locator('[data-testid="content-filter-clear"]')).toHaveCount(0);
  });

  test("URL ?role=user → store setRole → DOM chip active=true", async ({ page }) => {
    await page.goto("/#/session/abc123?path=/tmp/abc123.jsonl&role=user");
    await page.waitForTimeout(400);

    const userBtn = page.locator('[data-testid="filter-role-user"]').first();
    expect(await userBtn.getAttribute("data-active")).toBe("true");
    const allBtn = page.locator('[data-testid="filter-role-all"]').first();
    expect(await allBtn.getAttribute("data-active")).toBe("false");
  });

  test("URL ?has=thinking,error → 2 个 chip 同时高亮", async ({ page }) => {
    await page.goto("/#/session/abc123?path=/tmp/abc123.jsonl&has=thinking,error");
    await page.waitForTimeout(400);

    const thinking = page.locator('[data-testid="content-filter-has-thinking"]').first();
    const error = page.locator('[data-testid="content-filter-has-error"]').first();
    const toolUse = page.locator('[data-testid="content-filter-has-tool_use"]').first();

    expect(await thinking.getAttribute("data-active")).toBe("true");
    expect(await error.getAttribute("data-active")).toBe("true");
    expect(await toolUse.getAttribute("data-active")).toBe("false");
  });

  test("URL ?tool=Bash,Read → tool chip 高亮(无 tool chip 数据时,不渲染 tool 行 — 已知限制)", async ({
    page,
  }) => {
    // vite preview 无 entries → availableTools 为空 → tool 行不渲染
    // 但 URL 解析会把 store.tools=["Bash","Read"],只是 DOM 上没 chip 显示
    await page.goto("/#/session/abc123?path=/tmp/abc123.jsonl&tool=Bash,Read");
    await page.waitForTimeout(400);

    // 验证 hook 已读 URL(通过 clear 按钮出现间接证明 store.tools 非空)
    await expect(page.locator('[data-testid="content-filter-clear"]').first()).toHaveCount(1);
  });

  test("URL 组合 ?from&role&has → 同时生效,clear 出现", async ({ page }) => {
    await page.goto(
      "/#/session/abc123?path=/tmp/abc123.jsonl&from=2026-06-25T00:00:00Z&role=assistant&has=thinking"
    );
    await page.waitForTimeout(400);

    // time:preset='custom' → datetime 输入可见
    await expect(page.locator('[data-testid="filter-from-input"]').first()).toHaveCount(1);

    // role
    const assistant = page.locator('[data-testid="filter-role-assistant"]').first();
    expect(await assistant.getAttribute("data-active")).toBe("true");

    // has
    const thinking = page.locator('[data-testid="content-filter-has-thinking"]').first();
    expect(await thinking.getAttribute("data-active")).toBe("true");

    // clear(content 维度有 active → 出现)
    await expect(page.locator('[data-testid="content-filter-clear"]').first()).toHaveCount(1);
  });

  test("URL ?has=evil(非法值) → 静默跳过", async ({ page }) => {
    await page.goto("/#/session/abc123?path=/tmp/abc123.jsonl&has=evil,bogus");
    await page.waitForTimeout(400);

    // 非法值不进 store → clear 按钮不应出现
    await expect(page.locator('[data-testid="content-filter-clear"]')).toHaveCount(0);
  });

  test("URL ?has=thinking 后点 clear → store 清空,URL 不变(单向同步,reverse 在另一个 effect)", async ({
    page,
  }) => {
    await page.goto("/#/session/abc123?path=/tmp/abc123.jsonl&has=thinking");
    await page.waitForTimeout(400);
    await expect(page.locator('[data-testid="content-filter-clear"]').first()).toHaveCount(1);

    await page.locator('[data-testid="content-filter-clear"]').first().click();
    await page.waitForTimeout(150);

    // store 清空,但 URL 仍是初始值(useSessionUrlSync 只单向 URL → store)
    // 验证 chip 不再 active
    const thinking = page.locator('[data-testid="content-filter-has-thinking"]').first();
    expect(await thinking.getAttribute("data-active")).toBe("false");
  });
});
