# E2E 测试 (Playwright)

本文档说明 OpenClaw Session Viewer 的端到端 (E2E) 测试方案 —— Playwright 配置、用法、如何写新 case、已知坑。

> **最后更新**:2026-06-27(v0.4.5 重构后踩坑总结,把"代理问题"的真因全部查清)

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

| 文件                      | 作用                                                                |
| ------------------------- | ------------------------------------------------------------------- |
| `playwright.config.ts`    | 顶层配置:chromium / port 4173 / **不加 proxy bypass** / globalSetup |
| `e2e/global-setup.ts`     | 启动 `vite preview` server,用 `env -u` 清掉坏的代理 env             |
| `e2e/smoke.spec.ts`       | 2 个 smoke case:首屏挂载 + 无 JS 错误                               |
| `e2e/detail-page.spec.ts` | 6 个 detail page case(部分在 vite preview 下受 Tauri IPC 缺失限制)  |

### 关键配置点(2026-06-27 修订)

```ts
// playwright.config.ts
{
  testDir: "./e2e",
  use: {
    baseURL: "http://localhost:4173",  // localhost(macOS 解析到 ::1),不要 127.0.0.1
    trace: "on-first-retry",           // 失败时录 trace
    screenshot: "only-on-failure",     // 失败时截图
    // 不加 proxy bypass — 反而破坏 IPv4/IPv6 路径
  },
  projects: [{
    name: "chromium",
    use: {
      ...devices["Desktop Chrome"],
      // 不传 launchOptions.proxy,默认行为 OK
    },
  }],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-setup.ts",
}
```

---

## 🚀 怎么用

### 命令

```bash
# 跑全部 e2e(顶层,带全局 setup + teardown)
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

### 跑之前(关键 — dev env 必做)

```bash
# 1. 先 build(preview 跑的是 dist)
pnpm --filter @ocsv/frontend build

# 2. 装浏览器(首次需要)
pnpm exec playwright install chromium

# 3. ⚠️ 如果 dev env 设了 http_proxy=127.0.0.1:8001 (xray 之类),
#    Chromium 会读 env 走代理 → ERR_PROXY_CONNECTION_FAILED
#    shell 层清掉:
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
  pnpm exec playwright test

# 4. 跑
pnpm test:e2e
```

### npm scripts (顶层)

```json
{
  "test": "pnpm -r test", // 仅 vitest (单元 + 组件,3s)
  "test:e2e": "playwright test", // 仅 Playwright (~8s)
  "test:all": "pnpm test && pnpm test:e2e" // 全跑
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

## ⚠️ 已知坑 & 解决 (2026-06-27 全部踩过一遍)

### 1. dev 环境的 `http_proxy` 不可用 — **真因是 xray 代理**

**症状**:

- `curl http://localhost:4173/` (带默认 env) 返回 `503`
- Playwright `chromium.launch()` 报 `net::ERR_PROXY_CONNECTION_FAILED`
- `chrome-headless-shell --proxy-server=direct:// ...` 直接命令行调却能拿到 HTML
- **Chrome.app 日常使用 localhost 完全正常**

**根因(经实测验证)**:

- 本机 dev env 配了 `http_proxy=http://127.0.0.1:8001` (指向一个 xray 进程)
- xray 监听 8001,只代理 V2Ray 白名单域名,localhost 收到直接返回 503
- **Chrome.app 不读 `http_proxy` env**(macOS 上读 `scutil --proxy` 的 PAC),所以日常能通
- **Playwright 启的 Chromium 进程读 `http_proxy` env** → 走 xray → 503
- 加 `--proxy-server=direct://` 等 Chromium flag **没用**,Chromium 启起来后 env 优先级仍高于 CLI flag

**缓解**(按推荐度):

1. **shell 层清 env(唯一可靠方案)**:
   ```bash
   env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
     pnpm exec playwright test
   ```
   Playwright 进程从一开始就无这些 env,Chromium 子进程也读不到
2. CI 环境通常是干净的,直接跑就行

### 2. ❌ 不要给 chromium 加 `--proxy-server=direct://`

**症状**: 加了之后 chromium 报 `ERR_CONNECTION_REFUSED`,localhost 完全连不上。

**真因(踩坑实测)**:

- vite preview 在 macOS 默认 **只 listen IPv6 `::1`**,**不 listen IPv4 `127.0.0.1`**
  ```bash
  $ lsof -nP -iTCP:4173 -sTCP:LISTEN
  COMMAND  PID  USER  FD  TYPE  DEVICE  NODE NAME
  node     XX  user  18u IPv6  ...      TCP [::1]:4173 (LISTEN)  ← 只有 IPv6
  ```
- 加 `--proxy-server=direct://` 让 Chromium 强制 IPv4 解析路径 → 连不上
- 解决:**不加任何 proxy flag**,Chromium 默认行为 OK
- URL 用 `localhost`(macOS 解析到 `::1`),**不要用 127.0.0.1**

**参考踩坑命令**:

```bash
# ✅ 通
NO_PROXY='*' curl http://localhost:4173/  # → 200
$CHROME --headless --dump-dom http://localhost:4173/  # → HTML
chromium.launchPersistentContext('', { headless: true }) + localhost  # → 通

# ❌ 不通
$CHROME --proxy-server=direct:// --dump-dom http://127.0.0.1:4173/  # → 空 HTML (server 不在 IPv4)
curl http://127.0.0.1:4173/  # → connection refused (server 只 listen ::1)
```

### 3. `webServer` 不灵,用 `globalSetup` 替代

**原因**: Playwright 的 `webServer.url` 检查走系统代理,在 dev 环境会失败。

**解法** (`e2e/global-setup.ts`):

```ts
import { spawn } from "node:child_process";

// 关键: 清掉代理 env,让 vite preview 子进程也不读这些
const env = { ...process.env };
delete env.http_proxy;
delete env.https_proxy;
delete env.HTTP_PROXY;
delete env.HTTPS_PROXY;

server = spawn("pnpm", ["--filter", "@ocsv/frontend", "preview", "--port", String(PORT)], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
```

### 4. jsdom `<details>` 不自动 toggle

**背景**: jsdom 不模拟 `<details>` 元素的原生 `open` 切换 (这是已知 jsdom 限制,跟 Playwright 无关)。

**缓解**: 在 vitest 组件测试里手动 `details.open = true; dispatchEvent(new Event("toggle"))`,见 `UnknownBlockCard.test.tsx` 的 "大对象 → 折叠 details" case。

Playwright 跑真实 Chromium 没问题,不用这个 workaround。

### 5. Tauri IPC 在 e2e 不可用 — 错误消息本身没 "tauri" 字样

**背景**: `vite preview` 跑的是纯静态 dist,没有 Tauri runtime。`@tauri-apps/api/event` 的 `listen()` 调用 `window.__TAURI_INTERNALS__.transformCallback`,但 `__TAURI_INTERNALS__` 是 undefined。

**典型 pageerror**:

```
Cannot read properties of undefined (reading 'transformCallback')
```

**关键**:错误消息本身**不含 "tauri" 字样**,原来的 e2e 错误过滤只过滤 `"tauri"` / `"__TAURI__"` 字符串,**漏掉了这个最常见的 Tauri 缺失错误**。

**修复**(`e2e/smoke.spec.ts` + `e2e/detail-page.spec.ts`):

```ts
const realErrors = errors.filter(
  (e) =>
    !e.includes("__TAURI__") &&
    !e.includes("tauri") &&
    !e.includes("window.__TAURI_INTERNALS__") &&
    !e.includes("transformCallback") // ← 必须加
);
```

**完整 mock IPC**(更彻底的方案,适合 detail-page 完整测试):

```ts
await page.addInitScript((session) => {
  (window as any).__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: async (cmd: string) => {
      if (cmd === "list_sessions") return [session];
      if (cmd === "get_session_meta") return session;
      if (cmd === "list_live_pids") return [];
      if (cmd === "get_settings") return { theme: "system", timezone: "UTC", ... };
      return null;
    },
  };
});
```

### 6. SessionDetailRoute 没 location.state → 走 fallback 分支

**背景**: `SessionDetailRoute` 读 `useLocation().state.session`,没值就走 `if (!meta) return <NotFound/>` 早返回,**不挂** `<SearchInSessionBar />` / `<FilterPanel />` / `<TranscriptView />`。

**症状**: `e2e/detail-page.spec.ts` 直接 `page.goto("/session/abc123")` 后,测试断言 `[data-testid="filter-preset-all"]` 存在但 count=0 — 因为 FilterPanel 没 mount。

**已知妥协**:

- 当前 `detail-page.spec.ts` 的 4 个 case 在 vite preview 下是 "不真挂载",**功能是 smoke**(确认页面不崩)
- 要完整 verify detail page 行为,需要 mock Tauri invoke + 点击 session 卡片 navigate(state:{session})

### 7. 慢的 e2e 别 commit

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
