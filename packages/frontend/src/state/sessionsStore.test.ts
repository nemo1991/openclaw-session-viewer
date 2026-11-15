/**
 * sessionsStore.test.ts — v0.8.13 item F
 *
 * sessionsStore 是主页和详情 reload 的核心数据源。v0.8.13 之前 0 测试,filter
 * 组合回归只能靠 route/component 间接测试发现。source 默认值 / 组合过滤很容易
 * 静默漏会话,补 unit test 锁住契约。
 *
 * Mock 模式: vi.mock 替换 apiListSessions / apiRefreshSessions,控 invoke 调用
 * 计数 + 验证 setFilter / filteredSessions / availableAgentIds 行为。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock 必须在 import store 之前
const mockApiListSessions = vi.fn();
const mockApiRefreshSessions = vi.fn();

vi.mock("../lib/api", () => ({
  apiListSessions: () => mockApiListSessions(),
  apiRefreshSessions: () => mockApiRefreshSessions(),
  extractErrorMessage: (e: unknown) => {
    if (typeof e === "string") return e;
    if (e && typeof e === "object" && "message" in e)
      return String((e as { message: unknown }).message);
    return String(e);
  },
}));

import { useSessionsStore, DEFAULT_SESSIONS_FILTER } from "./sessionsStore";
import type { SessionMeta } from "@ocsv/shared";

// ===== fixture =====

function makeSession(
  overrides: Partial<SessionMeta> & {
    sessionId: string;
    source: "claude" | "openclaw" | "kimi" | "dsh";
  }
): SessionMeta {
  const base: SessionMeta = {
    sessionId: overrides.sessionId,
    projectKey: overrides.projectKey ?? "proj-a",
    workspaceGuess: overrides.workspaceGuess ?? null,
    source: overrides.source,
    jsonlPath: `/tmp/${overrides.sessionId}.jsonl`,
    sizeBytes: 1000,
    mtimeMs: Date.now(),
    firstTimestamp: "2026-08-01T10:00:00Z",
    lastTimestamp: "2026-08-01T11:00:00Z",
    messageCount: 10,
    title: `title ${overrides.sessionId}`,
    livePid: overrides.livePid,
    subagentDir: overrides.subagentDir,
    agentId: overrides.agentId,
    agentLabel: overrides.agentLabel,
    agentTarget: overrides.agentTarget,
    firstPrompt: overrides.firstPrompt ?? `first prompt ${overrides.sessionId}`,
    lastMessageAt: "2026-08-01T11:00:00Z",
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  // Reset store + mock calls。v0.12 (B1): 直接消费 store 的真实默认定义,
  // 让「默认 source」这条契约由实现驱动,而不是在测试里再写一份。
  useSessionsStore.setState({
    sessions: [],
    loading: false,
    error: null,
    filter: { ...DEFAULT_SESSIONS_FILTER },
  });
  mockApiListSessions.mockReset();
  mockApiRefreshSessions.mockReset();
});

// ===== load / refresh 状态机 =====

describe("sessionsStore.load", () => {
  it("load 调 apiListSessions 填充 sessions", async () => {
    const fixture: SessionMeta[] = [makeSession({ sessionId: "s1", source: "openclaw" })];
    mockApiListSessions.mockResolvedValueOnce(fixture);

    await useSessionsStore.getState().load();

    expect(mockApiListSessions).toHaveBeenCalledTimes(1);
    expect(useSessionsStore.getState().sessions).toEqual(fixture);
    expect(useSessionsStore.getState().loading).toBe(false);
    expect(useSessionsStore.getState().error).toBeNull();
  });

  it("load 失败设置 error,不清空 sessions (保留上次的)", async () => {
    useSessionsStore.setState({
      sessions: [makeSession({ sessionId: "prev", source: "openclaw" })],
    });
    mockApiListSessions.mockRejectedValueOnce(new Error("network down"));

    await useSessionsStore.getState().load();

    expect(useSessionsStore.getState().error).toBe("network down");
    expect(useSessionsStore.getState().loading).toBe(false);
    expect(useSessionsStore.getState().sessions).toHaveLength(1);
    expect(useSessionsStore.getState().sessions[0]?.sessionId).toBe("prev");
  });

  it("load 期间 loading 为 true", async () => {
    let resolveFn!: (v: SessionMeta[]) => void;
    mockApiListSessions.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      })
    );

    const p = useSessionsStore.getState().load();
    expect(useSessionsStore.getState().loading).toBe(true);
    resolveFn([]);
    await p;
    expect(useSessionsStore.getState().loading).toBe(false);
  });
});

describe("sessionsStore.refresh", () => {
  it("refresh 调 apiRefreshSessions 替换 sessions", async () => {
    mockApiRefreshSessions.mockResolvedValueOnce([
      makeSession({ sessionId: "new", source: "openclaw" }),
    ]);

    await useSessionsStore.getState().refresh();

    expect(mockApiRefreshSessions).toHaveBeenCalledTimes(1);
    expect(useSessionsStore.getState().sessions).toHaveLength(1);
    expect(useSessionsStore.getState().sessions[0]?.sessionId).toBe("new");
  });

  it("refresh 失败保留旧 sessions (跟 load 行为不同 — refresh 是后台更新)", async () => {
    useSessionsStore.setState({
      sessions: [makeSession({ sessionId: "keep", source: "openclaw" })],
    });
    mockApiRefreshSessions.mockRejectedValueOnce(new Error("refresh fail"));

    await useSessionsStore.getState().refresh();

    expect(useSessionsStore.getState().error).toBe("refresh fail");
    expect(useSessionsStore.getState().sessions).toHaveLength(1);
    expect(useSessionsStore.getState().sessions[0]?.sessionId).toBe("keep");
  });
});

// ===== filter 组合 =====

describe("sessionsStore.filteredSessions", () => {
  const now = Date.now();
  const recent = now - 60 * 60 * 1000; // 1h ago
  const old = now - 10 * 24 * 60 * 60 * 1000; // 10d ago

  const claudeA = makeSession({
    sessionId: "claude-a",
    source: "claude",
    livePid: 1234,
    subagentDir: "/tmp/sub",
    mtimeMs: recent,
    title: "alpha claude",
  });
  const claudeB = makeSession({
    sessionId: "claude-b",
    source: "claude",
    mtimeMs: old,
    title: "beta claude",
  });
  const openclawMain = makeSession({
    sessionId: "oc-main",
    source: "openclaw",
    agentId: "main",
    title: "main session",
  });
  const openclawWork = makeSession({
    sessionId: "oc-work",
    source: "openclaw",
    agentId: "work",
    title: "work session",
  });

  beforeEach(() => {
    useSessionsStore.setState({ sessions: [claudeA, claudeB, openclawMain, openclawWork] });
    useSessionsStore.getState().setFilter({ source: "claude" }); // 先重置 source 让后续过滤组合更清晰
  });

  it("默认 source='claude' 过滤掉 openclaw", () => {
    const filtered = useSessionsStore.getState().filteredSessions();
    expect(filtered).toHaveLength(2);
    expect(filtered.every((s) => s.source === "claude")).toBe(true);
  });

  it("switch source='openclaw' 后只显示 openclaw", () => {
    useSessionsStore.getState().setFilter({ source: "openclaw" });
    const filtered = useSessionsStore.getState().filteredSessions();
    expect(filtered).toHaveLength(2);
    expect(filtered.every((s) => s.source === "openclaw")).toBe(true);
  });

  it("liveOnly 过滤: 只留有 livePid 的", () => {
    useSessionsStore.getState().setFilter({ liveOnly: true });
    const filtered = useSessionsStore.getState().filteredSessions();
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.sessionId).toBe("claude-a");
  });

  it("hasSubagents 过滤: 只留有 subagentDir 的", () => {
    useSessionsStore.getState().setFilter({ hasSubagents: true });
    const filtered = useSessionsStore.getState().filteredSessions();
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.sessionId).toBe("claude-a");
  });

  it("last7Days 过滤: mtimeMs < 7d cutoff 被剔", () => {
    useSessionsStore.getState().setFilter({ last7Days: true });
    const filtered = useSessionsStore.getState().filteredSessions();
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.sessionId).toBe("claude-a"); // recent 留下
  });

  it("query 文本搜索 title + sessionId", () => {
    useSessionsStore.getState().setFilter({ query: "beta" });
    const filtered = useSessionsStore.getState().filteredSessions();
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.sessionId).toBe("claude-b");
  });

  it("query 不区分大小写,匹配 title 子串", () => {
    useSessionsStore.getState().setFilter({ query: "ALPHA" });
    const filtered = useSessionsStore.getState().filteredSessions();
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.sessionId).toBe("claude-a");
  });

  it("agentId 过滤只对 openclaw 生效", () => {
    // 当前 source=claude,agentId 过滤不生效(Claude 没有 agentId)
    useSessionsStore.getState().setFilter({ agentId: "main" });
    let filtered = useSessionsStore.getState().filteredSessions();
    expect(filtered).toHaveLength(2); // 2 个 claude 都留下

    // 切到 openclaw, agentId=main 只留 main
    useSessionsStore.getState().setFilter({ source: "openclaw" });
    filtered = useSessionsStore.getState().filteredSessions();
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.sessionId).toBe("oc-main");
  });

  it("组合过滤: source + liveOnly + query", () => {
    // source=claude + liveOnly + query="alpha" → 只有 claude-a
    useSessionsStore.getState().setFilter({ liveOnly: true, query: "alpha" });
    const filtered = useSessionsStore.getState().filteredSessions();
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.sessionId).toBe("claude-a");
  });
});

// ===== availableAgentIds 去重排序 =====

describe("sessionsStore.availableAgentIds", () => {
  it("返回 openclaw sessions 的去重排序 agentId 列表", () => {
    // v0.12: 默认 source 已是 "all",agent 组只在显式切到 openclaw 时出现
    useSessionsStore.getState().setFilter({ source: "openclaw" });
    useSessionsStore.setState({
      sessions: [
        makeSession({ sessionId: "a", source: "openclaw", agentId: "work" }),
        makeSession({ sessionId: "b", source: "openclaw", agentId: "main" }),
        makeSession({ sessionId: "c", source: "openclaw", agentId: "work" }), // dup
        makeSession({ sessionId: "d", source: "openclaw", agentId: "extra" }),
        makeSession({ sessionId: "e", source: "claude" }), // Claude 无 agentId
        makeSession({ sessionId: "f", source: "openclaw" }), // 无 agentId
      ],
    });

    const ids = useSessionsStore.getState().availableAgentIds();
    expect(ids).toEqual(["extra", "main", "work"]);
  });

  it("无 openclaw sessions 时返回空数组", () => {
    useSessionsStore.setState({
      sessions: [makeSession({ sessionId: "a", source: "claude" })],
    });
    expect(useSessionsStore.getState().availableAgentIds()).toEqual([]);
  });
});

// ===== setFilter partial merge =====

describe("sessionsStore.setFilter", () => {
  it("setFilter partial: 只覆盖指定字段,其他保留", () => {
    const initial = useSessionsStore.getState().filter;
    expect(initial.source).toBe("all");
    expect(initial.query).toBe("");

    useSessionsStore.getState().setFilter({ query: "search" });

    const after = useSessionsStore.getState().filter;
    expect(after.query).toBe("search");
    expect(after.source).toBe("all");
    expect(after.liveOnly).toBe(false);
  });
});

// ===== v0.9.0: Kimi Code 第三种 source =====

describe("sessionsStore.v0.9.0 Kimi", () => {
  it("默认 filter.source 为 'all' (v0.12 FR-F1 — 开箱四源同屏)", () => {
    // beforeEach 已从 DEFAULT_SESSIONS_FILTER 重置,这里锁住新默认契约
    expect(useSessionsStore.getState().filter.source).toBe("all");
  });

  it("setFilter source='kimi' 后只显示 kimi sessions,隐藏 claude/openclaw", () => {
    useSessionsStore.setState({
      sessions: [
        makeSession({ sessionId: "k1", source: "kimi", agentId: "main" }),
        makeSession({ sessionId: "k2", source: "kimi", agentId: "main" }),
        makeSession({ sessionId: "c1", source: "claude" }),
        makeSession({ sessionId: "o1", source: "openclaw", agentId: "main" }),
      ],
    });

    useSessionsStore.getState().setFilter({ source: "kimi" });
    const filtered = useSessionsStore.getState().filteredSessions();
    expect(filtered).toHaveLength(2);
    expect(filtered.every((s) => s.source === "kimi")).toBe(true);
    expect(filtered.map((s) => s.sessionId).sort()).toEqual(["k1", "k2"]);
  });

  it("availableAgentIds for source='kimi' 返回 ['main'] (kimi 每 session 1:1 main agent)", () => {
    useSessionsStore.setState({
      sessions: [
        makeSession({ sessionId: "k1", source: "kimi", agentId: "main" }),
        makeSession({ sessionId: "k2", source: "kimi", agentId: "main" }),
        makeSession({ sessionId: "c1", source: "claude" }),
        makeSession({ sessionId: "o1", source: "openclaw", agentId: "work" }),
      ],
    });

    useSessionsStore.getState().setFilter({ source: "kimi" });
    const ids = useSessionsStore.getState().availableAgentIds();
    expect(ids).toEqual(["main"]);
  });

  it("hasSubagents on kimi source 隐藏 main-only sessions (subagentDir 缺失)", () => {
    useSessionsStore.setState({
      sessions: [
        // kimi session 无子代理目录 (main-only)
        makeSession({
          sessionId: "k-main-only",
          source: "kimi",
          agentId: "main",
          subagentDir: undefined,
        }),
        // kimi session 有 agent-* 子目录
        makeSession({
          sessionId: "k-with-subs",
          source: "kimi",
          agentId: "main",
          subagentDir: "/home/.kimi-code/sessions/wd_x/session_y/agents",
        }),
      ],
    });

    useSessionsStore.getState().setFilter({ source: "kimi", hasSubagents: true });
    const filtered = useSessionsStore.getState().filteredSessions();
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.sessionId).toBe("k-with-subs");
  });
});

// ===== v0.12 (B1 / FR-F1, FR-F3): 全部 source + 重置筛选 =====

describe("sessionsStore.v0.12 全部 source 与 resetFilter", () => {
  const FOUR = [
    makeSession({ sessionId: "c1", source: "claude" }),
    makeSession({ sessionId: "o1", source: "openclaw", agentId: "main" }),
    makeSession({ sessionId: "k1", source: "kimi", agentId: "main" }),
    makeSession({ sessionId: "d1", source: "dsh" }),
  ];

  it("FR-F1: 默认 source='all' 时四种 source 同屏,无遗漏", () => {
    useSessionsStore.setState({ sessions: FOUR });
    const filtered = useSessionsStore.getState().filteredSessions();
    expect(filtered.map((s) => s.sessionId).sort()).toEqual(["c1", "d1", "k1", "o1"]);
    expect(new Set(filtered.map((s) => s.source)).size).toBe(4);
  });

  it("FR-F1: 'all' 只是跳过 source 过滤,query / liveOnly 等仍生效", () => {
    useSessionsStore.setState({
      sessions: [
        ...FOUR,
        makeSession({ sessionId: "c2", source: "claude", title: "needle", livePid: 42 }),
      ],
    });
    useSessionsStore.getState().setFilter({ query: "needle" });
    expect(
      useSessionsStore
        .getState()
        .filteredSessions()
        .map((s) => s.sessionId)
    ).toEqual(["c2"]);
  });

  it("FR-F1: 单 source 切换后再切回 'all' 恢复四源", () => {
    useSessionsStore.setState({ sessions: FOUR });
    useSessionsStore.getState().setFilter({ source: "claude" });
    expect(useSessionsStore.getState().filteredSessions()).toHaveLength(1);
    useSessionsStore.getState().setFilter({ source: "all" });
    expect(useSessionsStore.getState().filteredSessions()).toHaveLength(4);
  });

  it("FR-F3: resetFilter 把 filter 全部字段一步归位(且产生新对象)", () => {
    const before = useSessionsStore.getState().filter;
    useSessionsStore.getState().setFilter({
      source: "dsh",
      query: "abc",
      liveOnly: true,
      hasSubagents: true,
      last7Days: true,
      agentId: "work",
    });
    useSessionsStore.getState().resetFilter();
    const after = useSessionsStore.getState().filter;
    expect(after).toEqual(DEFAULT_SESSIONS_FILTER);
    expect(after.source).toBe("all");
    expect(after.query).toBe("");
    expect(after.liveOnly).toBe(false);
    expect(after.hasSubagents).toBe(false);
    expect(after.last7Days).toBe(false);
    expect(after.agentId).toBeUndefined();
    // 必须是新对象,否则 zustand 订阅者不会收到更新
    expect(after).not.toBe(before);
  });

  it("FR-F2: 'all' 下 availableAgentIds 为空(低频 agent 组隐藏),切 openclaw 后恢复", () => {
    useSessionsStore.setState({
      sessions: [
        makeSession({ sessionId: "o1", source: "openclaw", agentId: "main" }),
        makeSession({ sessionId: "o2", source: "openclaw", agentId: "work" }),
      ],
    });
    expect(useSessionsStore.getState().availableAgentIds()).toEqual([]);
    useSessionsStore.getState().setFilter({ source: "openclaw" });
    expect(useSessionsStore.getState().availableAgentIds()).toEqual(["main", "work"]);
  });
});
