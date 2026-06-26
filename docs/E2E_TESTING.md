# E2E 测试 (Playwright)

本文档说明 OpenClaw Session Viewer 的端到端 (E2E) 测试方案 —— Playwright 配置、用法、如何写新 case、已知坑。

---

## 📖 是什么 / 为什么

**Playwright** 是 Microsoft 出品的浏览器自动化框架,装 `@playwright/test` 后用 TypeScript 写测试,自动启真实 Chromium 跑用户场景。

### 跟现有测试的分工

| 维度     | vitest + jsdom (现有) | Playwright E2E (本文)                 |
| -------- | --------------------- | ------------------------------------- |
| 运行环境 | Node 模拟 DOM         | 真实 Chromium (Tauri webview 同内核)  |
| 速度     | 极快 (~3s 全跑)       | 慢 (启浏览器,~1s/case)                |
| 覆盖     | 单组件 DOM 输出       | 整页交互 / 路由跳转 / 用户场景 / 截图 |
| 调试     | `console.log`         | trace viewer / screenshot / video     |
| 适合     | 组件正确性            | 端到端流程                            |

**两者互补不替代**。本次会话加了 **77 个组件测试**(覆盖 v0.4.x 主要新功能),E2E 补的是组件测试覆盖不到的部分:

- 路由跳转 (`/session/:id` → `/session/:id/trajectory`)
- 键盘快捷键真实触发 (`Cmd+K` / `Cmd+F` / `n` / `p` / `Esc`)
- 跨页状态保留(会话列表 → 详情 → 返回列表)
- 真实时间筛选交互(点 preset / 改 datetime-local)
- 视觉回归 (screenshot 对比)

---

## 🛠 当前配置 (e2e/)

| 文件                   | 作用                                                    |
| ---------------------- | ------------------------------------------------------- |
| `playwright.config.ts` | 顶层配置:chromium / port 4173 / 代理绕开 / globalSetup  |
| `e2e/global-setup.ts`  | 启动 `vite preview` server,用 `env -u` 清掉坏的代理 env |
| `e2e/smoke.spec.ts`    | 2 个 smoke case:首屏挂载 + 无 JS 错误                   |

### 关键配置点

```ts
// playwright.config.ts
{
  testDir: "./e2e",
  use: {
    baseURL: "http://localhost:4173",  // vite preview 默认端口
    trace: "on-first-retry",           // 失败时录 trace
    screenshot: "only-on-failure",     // 失败时截图
    proxy: { server: "direct://" },    // 强制直连,绕开系统代理
  },
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      launchOptions: {
        // chromium 协议层 direct://, 彻底绕开 system env
        proxy: { server: "direct://" },
      },
    },
  }],
  // 用 globalSetup 自己起 server, 不用 webServer (见下方"已知坑")
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-setup.ts",
}
```

---

## 🚀 怎么用

### 命令

```bash
# 跑全部 e2e (顶层)
pnpm test:e2e

# 跑单个文件
pnpm exec playwright test e2e/smoke.spec.ts

# 跑匹配名字的
pnpm exec playwright test -g "首页"

# UI 模式 — 本地调试用,看每步 + 时间线
pnpm exec playwright test --ui

# Debug 模式 — 一步步执行
pnpm exec playwright test --debug

# 查看上次失败 trace
pnpm exec playwright show-report
pnpm exec playwright show-trace test-results/<name>/trace.zip

# 列出所有 case
pnpm exec playwright test --list
```

### 跑之前

```bash
# 1. 先 build (preview 跑的是 dist)
pnpm --filter @ocsv/frontend build

# 2. 装浏览器 (首次需要)
pnpm exec playwright install chromium

# 3. 跑
pnpm test:e2e
```

### npm scripts (顶层)

```json
{
  "test": "pnpm -r test", // 跑所有单元 + 组件测试
  "test:e2e": "playwright test", // 只跑 e2e
  "test:all": "pnpm test && pnpm test:e2e" // 全部
}
```

---

## ✍️ 写新 E2E

### 模板 (基于真实用例)

```ts
// e2e/sessions.spec.ts
import { test, expect } from "@playwright/test";

test.describe("会话列表", () => {
  test("加载并显示会话", async ({ page }) => {
    await page.goto("/");

    // 等待某个文本/元素出现
    await expect(page.getByText("会话")).toBeVisible({ timeout: 5000 });

    // 断言 URL
    expect(page.url()).toMatch(/\/$/);
  });

  test("全局搜索快捷键 Cmd+K 打开搜索面板", async ({ page }) => {
    await page.goto("/");

    // 触发快捷键 (macOS 用 Meta, Windows/Linux 用 Control)
    await page.keyboard.press("Meta+k");

    // 断言面板出现
    await expect(page.getByPlaceholder(/搜索/)).toBeVisible();
  });

  test("点击会话卡片进入详情页", async ({ page }) => {
    await page.goto("/");

    // 找第一个会话卡片 (实际项目要更具体选择器)
    const firstCard = page.locator("[data-session-id]").first();
    await firstCard.click();

    // 断言 URL 变化
    await expect(page).toHaveURL(/\/session\//);
  });
});
```

### 推荐的 selector 策略

```ts
// ✅ 优先 — 跟用户视角一致, 无障碍友好
page.getByRole("button", { name: "搜索" });
page.getByText("保存");
page.getByPlaceholder("搜索会话");
page.getByLabel("主题");

// ✅ 稳定 — 项目约定 data-testid
page.locator("[data-testid='session-card']");

// ❌ 避免 — CSS class 容易变
page.locator(".session-card");

// ❌ 避免 — 嵌套位置不稳
page.locator("div > div > div");
```

### 常用 API 速查

```ts
// 导航
await page.goto("/sessions");
await page.goBack();
await page.reload();

// 交互
await page.locator("button").click();
await page.locator("input").fill("hello");
await page.locator("select").selectOption("dark");
await page.keyboard.press("Enter");
await page.keyboard.press("Control+k");

// 等待
await page.waitForLoadState("networkidle");
await page.waitForTimeout(500); // 不推荐, 用条件等待
await expect(el).toBeVisible({ timeout: 5000 });

// 截图
await page.screenshot({ path: "screenshots/home.png", fullPage: true });

// 网络拦截
await page.route("**/api/**", (route) =>
  route.fulfill({
    status: 200,
    body: JSON.stringify({
      /* mock 数据 */
    }),
  })
);

// localStorage / sessionStorage
await page.evaluate(() => localStorage.setItem("key", "value"));
```

---

## ⚠️ 已知坑 & 解决

### 1. dev 环境的 `http_proxy` 不可用

**症状**:

- `curl http://localhost:4173/` 返回 `503 Service Unavailable` (走代理)
- Playwright 报 `net::ERR_PROXY_CONNECTION_FAILED`
- `pnpm preview` 自己能起,但 Playwright 调不通

**根因**: dev 环境的 `http_proxy` env 指向不存在的代理 (例如 `http://127.0.0.1:8001`),所有 HTTP 请求都被劫持去那里。

**缓解**(按推荐度):

1. **临时去掉**:`unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY`
2. **curl 加 flag**:`curl --noproxy localhost ...`
3. **Playwright 配置**:已用 `proxy: { server: "direct://" }` + `globalSetup` 自己起 server (绕开 webServer 的 URL check)
4. **CI 环境**:通常是干净的,直接跑就行

### 2. `webServer` 不灵,用 `globalSetup` 替代

**原因**: Playwright 的 `webServer.url` 检查走系统代理,在 dev 环境会失败。

**解法** (e2e/global-setup.ts):

```ts
import { spawn } from "node:child_process";

// 关键: 清掉代理 env
const env = { ...process.env };
delete env.http_proxy;
delete env.https_proxy;
delete env.HTTP_PROXY;
delete env.HTTPS_PROXY;

spawn("pnpm", ["--filter", "@ocsv/frontend", "preview", "--port", "4173"], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
```

### 3. jsdom `<details>` 不自动 toggle

**背景**: jsdom 不模拟 `<details>` 元素的原生 `open` 切换 (这是已知 jsdom 限制,跟 Playwright 无关)。

**缓解**: 在 vitest 组件测试里手动 `details.open = true; dispatchEvent(new Event("toggle"))`,见 `UnknownBlockCard.test.tsx` 的 "大对象 → 折叠 details" case。

Playwright 跑真实 Chromium 没问题,不用这个 workaround。

### 4. Tauri IPC 在 e2e 不可用

**背景**: `vite preview` 跑的是纯静态 dist,没有 Tauri runtime。`invoke()` 调用全部失败,所有数据返回 `undefined`。

**解法** (二选一):

- **mock 掉** (推荐用于 smoke):在 setup 里 `vi.mock("@tauri-apps/api/core", ...)`
- **真测 Tauri 流程**:另起 tauri dev + WebDriver (见 [CROSS_PLATFORM_BUILD.md](CROSS_PLATFORM_BUILD.md) 的 "Tauri E2E" 章节,本文档不覆盖)

### 5. 慢的 e2e 别 commit

**症状**: 100+ 个 e2e case 跑 5 分钟,本地调试很痛苦。

**建议**:

- 本地用 `--ui` 模式调单个 case
- `test.only()` 临时只跑一个 (记得删掉再 commit)
- CI 才跑全量

---

## 🎯 路线图 (待补的 E2E)

| 模块       | 优先级 | 建议 case                                         |
| ---------- | ------ | ------------------------------------------------- |
| 路由跳转   | 高     | 会话列表 → 详情 → 返回列表,详情 → 轨迹页          |
| 快捷键     | 高     | `Cmd+K` 搜索 / `Cmd+F` 会话内 / `n` / `p` / `Esc` |
| 时间筛选   | 中     | preset 切换 / 自定义 datetime-local / URL 同步    |
| 主题切换   | 中     | dark / light / system 切换 + localStorage 持久化  |
| 时区设置   | 中     | 切换 IANA 名,刷新后保持                           |
| 大模型分析 | 低     | mock Anthropic 响应,验证 token 计数               |
| 导出       | 低     | Markdown / HTML 下载触发 + 文件内容               |
| 视觉回归   | 低     | 全页 screenshot 对比 baseline                     |

---

## 📚 参考

- [Playwright 官方文档](https://playwright.dev/docs/intro)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)
- [Tauri E2E Testing (WebDriver)](https://tauri.app/v1/guides/testing/) — 真 Tauri 流程
- [本文档配套:TROUBLESHOOTING.md](TROUBLESHOOTING.md)
