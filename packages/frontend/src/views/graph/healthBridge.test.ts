/**
 * v0.12 (C2 / FR-C2): 首页风险徽标数据桥单测
 *
 * 验收对应 PRD §5.2 / §12 / §13.3:
 * - 复用 v0.11 foldGraphEntries + evaluateHealth,不产生第二套口径
 * - 命中规则的 parent 会话按 session_id 精确可查;子会话折叠进 parent 不重复标
 * - 4 source 均可识别;改阈值后重算生效;规则全关无徽标
 * - entries 为空 / 加载中 / 脏数据时返回空 Map,不抛错
 */
import { describe, expect, it } from "vitest";
import type { GraphEntry } from "./types";
import type { GraphNode } from "./analytics";
import { DEFAULT_HEALTH_RULES } from "./health";
import { buildRiskIndex } from "./healthBridge";

const NOW = Date.now();

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    node_id: "n-default",
    source: "Claude",
    session_id: "s-default",
    workspace: "proj",
    jsonl_path: "/tmp/placeholder.jsonl",
    size_bytes: 1000,
    mtime_ms: NOW,
    first_prompt: "placeholder",
    first_timestamp_ms: NOW - 3600_000,
    last_timestamp_ms: NOW,
    token_total: 100,
    thinking_count: 0,
    primary_model: "model-placeholder",
    top_tools: [],
    error_count: 0,
    retry_count: 0,
    tool_call_count: 0,
    subagent_count: 0,
    subagent_ids: [],
    is_subagent_root: false,
    parent_session_id: null,
    message_count: 1,
    ...overrides,
  };
}

function entry(node: GraphNode): GraphEntry {
  return { node, edges: [] };
}

/** 只开 highErrors,隔绝 token 离群 / 模型漂移等干扰 */
const RULES = {
  ...DEFAULT_HEALTH_RULES,
  highErrorsThreshold: 20,
  tokenOutlierEnabled: false,
  subagentsEnabled: false,
  modelDriftEnabled: false,
};

describe("buildRiskIndex — 空数据与容错", () => {
  it("entries 为 null / undefined / [] 时返回空 Map(加载中不报错)", () => {
    expect(buildRiskIndex(null).size).toBe(0);
    expect(buildRiskIndex(undefined).size).toBe(0);
    expect(buildRiskIndex([]).size).toBe(0);
  });

  it("脏 wire 缺 node 时不抛错,徽标暂缺", () => {
    expect(() => buildRiskIndex([{} as GraphEntry], RULES)).not.toThrow();
    expect(buildRiskIndex([{} as GraphEntry], RULES).size).toBe(0);
  });

  it("全库无命中时返回空 Map", () => {
    const entries = [entry(makeNode({ session_id: "clean", error_count: 1 }))];
    expect(buildRiskIndex(entries, RULES).size).toBe(0);
  });
});

describe("buildRiskIndex — 映射与口径", () => {
  it("命中 highErrors 的 parent 按 session_id 精确可查,标签含实际值与阈值", () => {
    const entries = [
      entry(makeNode({ node_id: "n-p", session_id: "sess-parent", error_count: 25 })),
    ];
    const index = buildRiskIndex(entries, RULES);
    expect(index.size).toBe(1);
    const hit = index.get("sess-parent");
    expect(hit).toBeDefined();
    expect(hit?.score).toBe(1);
    expect(hit?.flags[0]?.rule).toBe("highErrors");
    expect(hit?.flags[0]?.actual).toBe(25);
    expect(hit?.flags[0]?.threshold).toBe(20);
    expect(hit?.flags[0]?.label).toContain("25");
  });

  it("子会话被 foldGraphEntries 折叠进 parent,不单独出现在索引(避免重复计数)", () => {
    const parent = makeNode({
      node_id: "n-parent",
      session_id: "sess-parent",
      error_count: 25,
      is_subagent_root: false,
    });
    const child = makeNode({
      node_id: "n-child",
      session_id: "sess-child",
      error_count: 30,
      is_subagent_root: true,
      parent_session_id: "sess-parent",
    });
    const index = buildRiskIndex([entry(parent), entry(child)], RULES);
    expect(index.has("sess-parent")).toBe(true);
    expect(index.has("sess-child")).toBe(false);
    // parent 聚合了子会话的 error_count,口径与 HealthView 完全一致
    expect(index.get("sess-parent")?.node.error_count).toBe(55);
  });

  it("四种 source 的命中会话均可识别(同源数据 100%)", () => {
    const sources: GraphNode["source"][] = ["Claude", "OpenClaw", "Kimi", "DeepSeekHarness"];
    const entries = sources.map((source, i) =>
      entry(
        makeNode({
          node_id: `n-${i}`,
          session_id: `sess-${i}`,
          source,
          error_count: 25,
        })
      )
    );
    const index = buildRiskIndex(entries, RULES);
    expect(index.size).toBe(4);
    for (let i = 0; i < 4; i++) expect(index.has(`sess-${i}`)).toBe(true);
  });

  it("改阈值后重算生效(设置页 healthRules 变化 → 首页徽标随之变化)", () => {
    const entries = [entry(makeNode({ session_id: "s1", error_count: 25 }))];
    expect(buildRiskIndex(entries, { ...RULES, highErrorsThreshold: 20 }).has("s1")).toBe(true);
    expect(buildRiskIndex(entries, { ...RULES, highErrorsThreshold: 30 }).has("s1")).toBe(false);
  });

  it("规则全关时首页无徽标(与 v0.11 行为一致)", () => {
    const entries = [entry(makeNode({ session_id: "s1", error_count: 999 }))];
    const allOff = {
      ...RULES,
      highErrorsEnabled: false,
      tokenOutlierEnabled: false,
      subagentsEnabled: false,
      modelDriftEnabled: false,
    };
    expect(buildRiskIndex(entries, allOff).size).toBe(0);
  });

  it("healthRules 缺失时回退到 v0.11 默认阈值,不抛错", () => {
    const entries = [entry(makeNode({ session_id: "s1", error_count: 999 }))];
    expect(buildRiskIndex(entries, null).has("s1")).toBe(true);
  });
});
