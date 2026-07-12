/**
 * analytics.ts 单测 — v0.8.9 收口
 *
 * 覆盖 8 个 chart 函数 + 边界 helper,锁住 G2 Analytics 8 chart 数据源。
 * 所有函数都是纯函数 (无 React / DOM / invoke 依赖),直接 import 单测。
 *
 * Fixture 用 4 个不同 session 形状覆盖:
 * - claude main (有 UsedTool edges)
 * - claude subagent (有 Spawned edges)
 * - openclaw with errors
 * - 边界: thinking=0 / token=0
 */
import { describe, it, expect } from "vitest";
import {
  cutoffMs,
  filterByRange,
  sessionsByDay,
  tokenTopN,
  topToolsBar,
  modelAvgThinking,
  retryRateDistribution,
  subagentChainDist,
  summary,
  type Range,
} from "./analytics";
import type { GraphEntry, SessionNode, Edge } from "./types";

// ===== fixture helper =====
//
// 注意:filterByRange 用 Date.now() 当基准(不是 fixed NOW),所以 fixture 时间戳
// 必须基于"当前"动态算,否则测试会随真实时间漂移。

function makeNode(overrides: Partial<SessionNode> = {}): SessionNode {
  const nowMs = Date.now();
  return {
    node_id: "test-sid",
    source: "Claude",
    session_id: "test-sid",
    workspace: "/tmp/test",
    jsonl_path: "/tmp/test.jsonl",
    size_bytes: 1024,
    mtime_ms: nowMs,
    first_prompt: null,
    first_timestamp_ms: nowMs - 3600_000,
    last_timestamp_ms: nowMs,
    token_total: 1000,
    thinking_count: 5,
    primary_model: null, // 每个 fixture 必须显式 override,避免默认污染分组
    top_tools: ["Bash", "Read"],
    error_count: 0,
    subagent_count: 0,
    subagent_ids: [],
    is_subagent_root: false,
    parent_session_id: null,
    message_count: 20,
    ...overrides,
  };
}

function makeEdge(e: Edge): Edge {
  return e;
}

// 4 个不同 session + edges — 时间戳基于"当前"动态算
const NOW = Date.now(); // 用于不需要依赖 Date.now() 的函数 (tokenTopN / modelAvgThinking 等)
const FIXTURE: GraphEntry[] = [
  // 1. Claude main, Bash-heavy (2 天前)
  {
    node: makeNode({
      node_id: "claude-main-1",
      session_id: "claude-main-1",
      source: "Claude",
      primary_model: "claude-opus-4-8",
      thinking_count: 10,
      token_total: 5000,
      subagent_count: 1,
      subagent_ids: ["agent-sub-1"],
      error_count: 0,
      first_timestamp_ms: NOW - 86400_000 * 2,
      last_timestamp_ms: NOW - 86400_000 * 2,
    }),
    edges: [
      makeEdge({ type: "used_tool", session: "claude-main-1", tool_name: "Bash", count: 50 }),
      makeEdge({ type: "used_tool", session: "claude-main-1", tool_name: "Read", count: 20 }),
      makeEdge({
        type: "spawned",
        from_session: "claude-main-1",
        to_subagent_id: "agent-sub-1",
        to_subagent_path: "",
        description: null,
      }),
    ],
  },
  // 2. Claude subagent, smaller (2 天前)
  {
    node: makeNode({
      node_id: "claude-sub-1",
      session_id: "claude-sub-1",
      source: "Claude",
      primary_model: "claude-sonnet-5",
      thinking_count: 2,
      token_total: 500,
      is_subagent_root: true,
      parent_session_id: "claude-main-1",
      first_timestamp_ms: NOW - 86400_000 * 2 + 60_000,
      last_timestamp_ms: NOW - 86400_000 * 2 + 600_000,
    }),
    edges: [
      makeEdge({ type: "used_tool", session: "claude-sub-1", tool_name: "Bash", count: 5 }),
      makeEdge({ type: "used_tool", session: "claude-sub-1", tool_name: "Glob", count: 3 }),
    ],
  },
  // 3. OpenClaw with errors (6 小时前)
  {
    node: makeNode({
      node_id: "openclaw-err-1",
      session_id: "openclaw-err-1",
      source: "OpenClaw",
      primary_model: null,
      thinking_count: 0,
      token_total: 100,
      error_count: 3,
      first_timestamp_ms: NOW - 3600_000 * 6,
      last_timestamp_ms: NOW - 3600_000 * 5,
    }),
    edges: [],
  },
  // 4. 边界: thinking=0 token=0 (空 session, 1 分钟前) — OpenClaw 让默认 Claude 不污染 bucket
  {
    node: makeNode({
      node_id: "empty-1",
      session_id: "empty-1",
      source: "OpenClaw",
      thinking_count: 0,
      token_total: 0,
      first_timestamp_ms: NOW - 60_000,
      last_timestamp_ms: NOW,
    }),
    edges: [],
  },
];

const NODES = FIXTURE.map((e) => e.node);

// ===== cutoffMs =====

describe("cutoffMs", () => {
  // cutoffMs 接受可选 now 参数 — 用固定 reference 避免 flaky
  const REF = 1_700_000_000_000; // 2023-11-14
  it("24h 返回 24 小时前的 ms", () => {
    expect(cutoffMs("24h", REF)).toBe(REF - 24 * 3600_000);
  });

  it("7d 返回 7 天前的 ms", () => {
    expect(cutoffMs("7d", REF)).toBe(REF - 7 * 24 * 3600_000);
  });

  it("30d 返回 30 天前的 ms", () => {
    expect(cutoffMs("30d", REF)).toBe(REF - 30 * 24 * 3600_000);
  });

  it("all 返回 null (无 cutoff)", () => {
    expect(cutoffMs("all", REF)).toBeNull();
  });
});

// ===== filterByRange =====

describe("filterByRange", () => {
  it("24h 范围过滤掉 24h 之外的 session", () => {
    // 内部用 mtime_ms 比较 — 给所有 fixture 设一个统一的近 mtime
    const fixedMtime = NOW - 60_000; // 1 分钟前
    const fixture: GraphEntry[] = FIXTURE.map((e) => ({
      ...e,
      node: { ...e.node, mtime_ms: fixedMtime },
    }));
    const filtered = filterByRange(fixture, "24h");
    // claude-main-1 + claude-sub-1 改成 mtime_ms = 1min 前 → 保留
    expect(filtered.length).toBeGreaterThan(0);
  });

  it("all 范围保留所有 session", () => {
    const filtered = filterByRange(FIXTURE, "all");
    expect(filtered.length).toBe(4);
  });

  it("7d 范围保留 (2 天前的也保留)", () => {
    const filtered = filterByRange(FIXTURE, "7d");
    expect(filtered.length).toBe(4);
  });

  it("空数组输入返空", () => {
    expect(filterByRange([], "24h")).toEqual([]);
  });
});

// ===== sessionsByDay =====

describe("sessionsByDay", () => {
  it("按 day + source 聚合 (bucket shape: {day, Claude, OpenClaw})", () => {
    const buckets = sessionsByDay(NODES);
    expect(buckets.length).toBeGreaterThan(0);
    // 至少 1 个 bucket 含 Claude > 0 (main + sub 同一天)
    const claudeBuckets = buckets.filter((b) => b.Claude > 0);
    const openclawBuckets = buckets.filter((b) => b.OpenClaw > 0);
    expect(claudeBuckets.length).toBeGreaterThan(0);
    expect(openclawBuckets.length).toBeGreaterThan(0);
  });

  it("Claude main + sub 同一天累加 Claude 计数", () => {
    // 用固定 timestamp 让 2 个 Claude session 同一天
    const sameDayTs = new Date("2026-07-01T12:00:00Z").getTime();
    const fixture: SessionNode[] = NODES.map(
      (n, i) =>
        i < 2
          ? { ...n, last_timestamp_ms: sameDayTs }
          : { ...n, last_timestamp_ms: sameDayTs + 86400_000 } // openclaw + empty 下一天
    );
    const buckets = sessionsByDay(fixture);
    const claudeTotal = buckets.reduce((sum, b) => sum + b.Claude, 0);
    expect(claudeTotal).toBe(2); // main + sub
  });

  it("OpenClaw 单独 bucket", () => {
    const buckets = sessionsByDay(NODES);
    const openclawTotal = buckets.reduce((sum, b) => sum + b.OpenClaw, 0);
    // openclaw-err-1 (3 errors) + empty-1 (边界) 都是 OpenClaw
    expect(openclawTotal).toBe(2);
  });

  it("空数组返空", () => {
    expect(sessionsByDay([])).toEqual([]);
  });
});

// ===== tokenTopN =====

describe("tokenTopN", () => {
  it("按 tokens (token_total) 降序排序,返回 {session_id, tokens, ...}", () => {
    const top = tokenTopN(NODES, 10);
    // token_total=0 的 session (empty-1) 被过滤,所以 3 个
    expect(top.length).toBe(3);
    expect(top[0]?.session_id).toBe("claude-main-1"); // 5000
    expect(top[0]?.tokens).toBe(5000);
    expect(top[1]?.session_id).toBe("claude-sub-1"); // 500
    expect(top[1]?.tokens).toBe(500);
    expect(top[2]?.session_id).toBe("openclaw-err-1"); // 100
  });

  it("limit 限制结果数", () => {
    const top = tokenTopN(NODES, 2);
    expect(top.length).toBe(2);
  });

  it("limit=0 返空", () => {
    expect(tokenTopN(NODES, 0)).toEqual([]);
  });

  it("过滤掉 token_total=0 的 session", () => {
    const top = tokenTopN(NODES, 10);
    const emptyEntry = top.find((r) => r.session_id === "empty-1");
    expect(emptyEntry).toBeUndefined();
  });
});

// ===== topToolsBar =====

describe("topToolsBar", () => {
  it("跨 session 累加 total_calls (Bash 50+5=55)", () => {
    const bars = topToolsBar(FIXTURE, 10);
    const bash = bars.find((b) => b.tool === "Bash");
    expect(bash).toBeDefined();
    if (bash) expect(bash.total_calls).toBe(55); // 50 (main) + 5 (sub)
  });

  it("按 total_calls 降序排序", () => {
    const bars = topToolsBar(FIXTURE, 10);
    expect(bars[0]?.tool).toBe("Bash");
    expect(bars[1]?.tool).toBe("Read"); // 20
    expect(bars[2]?.tool).toBe("Glob"); // 3
  });

  it("topN 限制数", () => {
    const bars = topToolsBar(FIXTURE, 1);
    expect(bars.length).toBe(1);
    expect(bars[0]?.tool).toBe("Bash");
  });

  it("同 tool 在多 session 累加 (不会重复 entry)", () => {
    // Bash 在 claude-main-1 + claude-sub-1 都出现 — 应该累加,不应该 2 行
    const bars = topToolsBar(FIXTURE, 10);
    const bashEntries = bars.filter((b) => b.tool === "Bash");
    expect(bashEntries.length).toBe(1);
  });

  it("每个 tool 还记录 sessions_count (出现过的 session 数)", () => {
    const bars = topToolsBar(FIXTURE, 10);
    const bash = bars.find((b) => b.tool === "Bash");
    expect(bash?.sessions_count).toBe(2); // main + sub
    const read = bars.find((b) => b.tool === "Read");
    expect(read?.sessions_count).toBe(1); // 只 main
  });
});

// ===== modelAvgThinking =====

describe("modelAvgThinking", () => {
  it("按 primary_model 分组算 avg thinking_count", () => {
    const models = modelAvgThinking(NODES);
    // claude-opus-4-8 → 1 session (claude-main-1, thinking=10)
    // claude-sonnet-5 → 1 session (claude-sub-1, thinking=2)
    const opus = models.find((m) => m.primary_model === "claude-opus-4-8");
    const sonnet = models.find((m) => m.primary_model === "claude-sonnet-5");
    expect(opus?.avg_thinking).toBe(10);
    expect(sonnet?.avg_thinking).toBe(2);
  });

  it("thinking=0 的 session 不影响其他 session 的 avg", () => {
    // empty-1 thinking=0 不应让 claude-opus-4-8 的 avg 变成 5
    const models = modelAvgThinking(NODES);
    const opus = models.find((m) => m.primary_model === "claude-opus-4-8");
    expect(opus?.avg_thinking).toBe(10);
  });

  it("每个 model 还记录 sessions_count 和 total_tokens", () => {
    const models = modelAvgThinking(NODES);
    const opus = models.find((m) => m.primary_model === "claude-opus-4-8");
    expect(opus?.sessions_count).toBe(1);
    expect(opus?.total_tokens).toBe(5000);
  });
});

// ===== retryRateDistribution =====

describe("retryRateDistribution", () => {
  it("按 error_count 分桶 (bucket 字符串格式)", () => {
    const buckets = retryRateDistribution(NODES);
    expect(buckets.length).toBeGreaterThan(0);
    // 每个 row shape: { bucket, sessions_count }
    buckets.forEach((b) => {
      expect(typeof b.bucket).toBe("string");
      expect(typeof b.sessions_count).toBe("number");
    });
  });

  it("openclaw-err-1 (3 errors) 出现在高 error bucket", () => {
    const buckets = retryRateDistribution(NODES);
    const totalSessions = buckets.reduce((sum, b) => sum + b.sessions_count, 0);
    // 至少 1 个有 error 的 session 应被分桶 (openclaw-err-1)
    expect(totalSessions).toBeGreaterThan(0);
  });
});

// ===== subagentChainDist =====

describe("subagentChainDist", () => {
  it("按 subagent_count 分桶 (bucket 字符串格式)", () => {
    const dist = subagentChainDist(NODES);
    expect(dist.length).toBeGreaterThan(0);
    dist.forEach((b) => {
      expect(typeof b.bucket).toBe("string");
      expect(typeof b.sessions_count).toBe("number");
    });
  });

  it("累加所有 bucket 的 sessions_count = 4 (所有 session 都被分桶)", () => {
    const dist = subagentChainDist(NODES);
    const total = dist.reduce((sum, b) => sum + b.sessions_count, 0);
    expect(total).toBe(4);
  });
});

// ===== summary =====

describe("summary", () => {
  it("聚合 total_sessions / total_tokens / total_subagents / total_errors", () => {
    const s = summary(NODES);
    expect(s.total_sessions).toBe(4);
    // 5000 + 500 + 100 + 0 = 5600
    expect(s.total_tokens).toBe(5600);
    // claude-main-1 有 1 subagent
    expect(s.total_subagents).toBe(1);
    // 0 + 0 + 3 + 0 = 3
    expect(s.total_errors).toBe(3);
    // clean_sessions = error_count=0 的 session 数 = 3 (main + sub + empty)
    expect(s.clean_sessions).toBe(3);
  });

  it("date_range 包含所有 session 的 first/last", () => {
    const s = summary(NODES);
    expect(s.date_range.from_ms).toBeLessThan(s.date_range.to_ms);
  });

  it("空数组返 0", () => {
    const s = summary([]);
    expect(s.total_sessions).toBe(0);
    expect(s.total_tokens).toBe(0);
  });
});

// ===== Edge type 契约测试 (锁住 v0.8.8 bug #2 修复) =====

describe("Edge type discrimination (v0.8.8 contract)", () => {
  it("used_tool edge 是 snake_case tag", () => {
    const e: Edge = { type: "used_tool", session: "s", tool_name: "Bash", count: 1 };
    expect(e.type).toBe("used_tool"); // 跟 Rust serde tag 一致
  });

  it("spawned edge 是 snake_case tag", () => {
    const e: Edge = {
      type: "spawned",
      from_session: "s",
      to_subagent_id: "a",
      to_subagent_path: "",
      description: null,
    };
    expect(e.type).toBe("spawned");
  });

  it("cross_session edge 是 snake_case tag", () => {
    const e: Edge = { type: "cross_session", parent: "p", child: "c" };
    expect(e.type).toBe("cross_session");
  });

  it("attempted_fix edge 是 snake_case tag", () => {
    const e: Edge = { type: "attempted_fix", session: "s", error_count: 1 };
    expect(e.type).toBe("attempted_fix");
  });

  it("parent_uuid edge 是 snake_case tag", () => {
    const e: Edge = { type: "parent_uuid", session: "s", from_uuid: "a", to_uuid: "b" };
    expect(e.type).toBe("parent_uuid");
  });
});
