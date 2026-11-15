/**
 * v0.12 (A1/A2 + B1/C1/C2 + FR-F3/F4/C3) E2E
 *
 * 与其它 spec 不同:仓库 e2e/global-setup.ts 只起 vite preview,**不注入 Tauri IPC**,
 * 首页默认数据为空。这里用 page.addInitScript 注入 __TAURI_INTERNALS__.invoke,
 * 造出 4 个 source 的会话 + list_graph 折叠节点(其中 1 条命中 highErrors),
 * 才能真实验证「默认全部」「风险徽标」「卡片分层」。
 *
 * 注入是 per-page 的,不影响 smoke / health / kimi-source 等既有 spec 的空数据基线。
 */

import { test, expect, type Page } from "@playwright/test";

const NOW = Date.now();

interface Fixture {
  sessions: Record<string, unknown>[];
  graph: Record<string, unknown>[];
  settings: Record<string, unknown>;
}

function session(sid: string, source: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: sid,
    projectKey: `proj-${sid}`,
    workspaceGuess: `ws-${source}`,
    source,
    jsonlPath: `/tmp/${sid}.jsonl`,
    sizeBytes: 2048,
    mtimeMs: NOW,
    firstTimestamp: "2026-11-15T00:00:00Z",
    lastTimestamp: "2026-11-15T01:00:00Z",
    lastMessageAt: "2026-11-15T01:00:00Z",
    messageCount: 12,
    title: `会话 ${sid}`,
    firstPrompt: "首条提问",
    ...extra,
  };
}

function graphNode(index: number, sid: string, source: string, errorCount: number) {
  return {
    node: {
      node_id: `n-${index}`,
      source,
      session_id: sid,
      workspace: "ws",
      jsonl_path: `/tmp/${sid}.jsonl`,
      size_bytes: 1024,
      mtime_ms: NOW,
      first_prompt: "p",
      first_timestamp_ms: NOW - 3_600_000,
      last_timestamp_ms: NOW,
      token_total: 100,
      thinking_count: 0,
      primary_model: "model-placeholder",
      top_tools: [],
      error_count: errorCount,
      retry_count: 0,
      tool_call_count: 0,
      subagent_count: 0,
      subagent_ids: [],
      is_subagent_root: false,
      parent_session_id: null,
      message_count: 10,
    },
    edges: [],
  };
}

const FIXTURE: Fixture = {
  sessions: [
    session("s-claude", "claude", {
      // 9 个 stat-chip, 用于验证 C1 默认 ≤3 + 展开
      thinkingCount: 12,
      toolUseCount: 8,
      durationSeconds: 3600,
      errorCount: 25,
      repeatRunCount: 3,
      idleGapCount: 2,
      topTools: ["Read", "Bash", "Edit"],
    }),
    session("s-openclaw", "openclaw", { agentId: "main" }),
    session("s-kimi", "kimi", { agentId: "main" }),
    session("s-dsh", "dsh"),
  ],
  graph: [
    graphNode(0, "s-claude", "Claude", 25),
    graphNode(1, "s-openclaw", "OpenClaw", 0),
    graphNode(2, "s-kimi", "Kimi", 0),
    graphNode(3, "s-dsh", "DeepSeekHarness", 0),
  ],
  settings: {
    theme: "system",
    uiLanguage: "zh-CN",
    timezone: "auto",
    // 只开 highErrors, 排除 token 离群 / 模型漂移 / 子会话的干扰
    healthRules: {
      highErrorsEnabled: true,
      highErrorsThreshold: 20,
      tokenOutlierEnabled: false,
      tokenSigma: 3,
      subagentsEnabled: false,
      subagentsThreshold: 10,
      modelDriftEnabled: false,
      modelDriftMinModels: 2,
    },
  },
};

/** 注入本地 IPC mock —— 全部数据留在浏览器内存,零网络请求 */
async function seed(page: Page) {
  await page.addInitScript((fixture: Fixture) => {
    const emptyOverrides = {
      renames: {},
      hidden: {},
      pinned: {},
      archived: {},
      notes: {},
      tags: {},
      tagsAll: [],
      linksTo: {},
      linksFrom: {},
    };
    Object.assign(window, {
      // Tauri 2 @tauri-apps/api/event 在 unlisten 时读的是这个独立对象
      // (node_modules/@tauri-apps/api/event.js:43),缺失会在组件卸载时抛错。
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: () => {},
      },
      __TAURI_INTERNALS__: {
        transformCallback: () => 0,
        invoke: async (cmd: string) => {
          switch (cmd) {
            case "list_sessions":
            case "refresh_sessions":
              return fixture.sessions;
            case "get_settings":
              return fixture.settings;
            case "list_graph":
              return fixture.graph;
            case "list_overrides":
              return emptyOverrides;
            case "get_sync_status":
              return {
                lastRunAt: null,
                lastError: null,
                filesSeen: 0,
                filesSynced: 0,
                inProgress: false,
              };
            case "get_db_path":
              return "/tmp/observer.db";
            case "list_live_pids":
            case "list_tags":
            case "list_search_history":
              return [];
            default:
              return null;
          }
        },
      },
    });
  }, FIXTURE);
}

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

test.describe("v0.12 首页减负与操作简化", () => {
  test("B1: 默认「全部」四源同屏,常驻筛选控件 ≤6,高级筛选默认折叠", async ({ page }) => {
    await seed(page);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator('[data-testid="source-all"]')).toBeChecked();
    // 5 个 source radio + 1 个搜索框 = 6 个常驻控件
    await expect(
      page.locator('[data-testid="source-filter-group"] input[type="radio"]')
    ).toHaveCount(5);
    await expect(page.locator('[data-testid="session-search"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="advanced-filters"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="session-card"]')).toHaveCount(4);
  });

  test("FR-F4: 高级筛选展开态本地持久化(reload 后仍展开)", async ({ page }) => {
    await seed(page);
    await page.goto("/");
    await expect(page.locator('[data-testid="advanced-filters"]')).toHaveCount(0);

    await page.locator('[data-testid="advanced-filter-toggle"]').click();
    await expect(page.locator('[data-testid="advanced-filters"]')).toBeVisible();
    await expect(page.locator('[data-testid="filter-liveOnly"]')).toBeVisible();

    await page.reload();
    await expect(page.locator('[data-testid="advanced-filters"]')).toBeVisible();
    await expect(page.locator('[data-testid="advanced-filter-toggle"]')).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  test("FR-F3: 重置筛选一步回默认(source/query/高级项/列表全归位)", async ({ page }) => {
    await seed(page);
    await page.goto("/");
    await page.locator('[data-testid="advanced-filter-toggle"]').click();
    await page.locator('[data-testid="filter-last7Days"]').check();
    await page.locator('[data-testid="session-search"]').fill("s-claude");
    await page.locator('[data-testid="source-claude"]').check();
    await expect(page.locator('[data-testid="session-card"]')).toHaveCount(1);

    await page.locator('[data-testid="filter-reset"]').click();

    await expect(page.locator('[data-testid="source-all"]')).toBeChecked();
    await expect(page.locator('[data-testid="session-search"]')).toHaveValue("");
    await expect(page.locator('[data-testid="filter-last7Days"]')).not.toBeChecked();
    await expect(page.locator('[data-testid="session-card"]')).toHaveCount(4);
  });

  test("C1: 卡片默认 chip ≤3,展开后显示全部", async ({ page }) => {
    await seed(page);
    await page.goto("/");
    const card = page
      .locator('[data-testid="session-card"]')
      .filter({ hasText: "会话 s-claude" })
      .first();
    await expect(card.locator('[data-testid="stats-chip"]')).toHaveCount(3);
    await expect(card.locator('[data-testid="stats-toggle"]')).toHaveCount(1);

    await card.locator('[data-testid="stats-toggle"]').click();
    expect(await card.locator('[data-testid="stats-chip"]').count()).toBe(9);
    await expect(card.locator('[data-testid="stats-toggle"]')).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  test("C2: 命中体检规则的会话显示风险徽标,点击直达 /graph?view=health", async ({ page }) => {
    await seed(page);
    await page.goto("/");
    const badges = page.locator('[data-testid="risk-badge"]');
    await expect(badges).toHaveCount(1);
    await expect(badges.first()).toHaveAttribute("aria-label", /1/);

    await badges.first().click();
    await expect(page).toHaveURL(/view=health/);
    await expect(page.locator('[data-testid="health-tab"]')).toHaveClass(/active/);
  });

  test("FR-C3: 显式重命名按钮可见且可进入编辑态", async ({ page }) => {
    await seed(page);
    await page.goto("/");
    const rename = page.locator('[data-testid="card-rename"]').first();
    await expect(rename).toBeVisible();
    await rename.click();
    await expect(page.locator(".title-rename-input")).toHaveCount(1);
  });

  test("A1/A2: 侧边栏 7 项常驻、高亮联动、Logo 回首页、深链不破", async ({ page }) => {
    await seed(page);
    await page.goto("/");
    await expect(page.locator(".side-nav-item")).toHaveCount(7);
    await expect(page.locator('[data-testid="nav-sessions"]')).toHaveAttribute(
      "aria-current",
      "page"
    );

    await page.locator('[data-testid="nav-health"]').click();
    await expect(page).toHaveURL(/view=health/);
    await expect(page.locator('[data-testid="nav-health"]')).toHaveAttribute(
      "aria-current",
      "page"
    );
    // 侧边栏与 explorer-tabs 以 URL 为单一真相源,双向同步
    await expect(page.locator('[data-testid="health-tab"]')).toHaveClass(/active/);

    await page.locator('[data-testid="side-nav-logo"]').click();
    await expect(page.locator('[data-testid="session-card"]')).toHaveCount(4);

    // ?view= 深链直访仍可达
    await page.goto("/#/graph?view=health");
    await expect(page.locator('[data-testid="health-tab"]')).toHaveClass(/active/);
    await expect(page.locator('[data-testid="nav-health"]')).toHaveAttribute(
      "aria-current",
      "page"
    );
  });

  test("全链路无新增 JS 错误", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await seed(page);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator('[data-testid="session-card"]')).toHaveCount(4);
    await page.locator('[data-testid="nav-health"]').click();
    await expect(page.locator('[data-testid="health-tab"]')).toHaveClass(/active/);
    expect(realErrors(errors)).toEqual([]);
  });
});
