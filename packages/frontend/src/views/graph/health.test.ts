/**
 * v0.11 (B1): 会话体检规则引擎单测
 *
 * 验收对应 ROADMAP 6 / B1 / B2 与第九章「上线后验证清单」:
 * - 体检标记在 4 种 source 上均可触发且标签可解释
 * - 空数据不报错
 * - 关闭某规则 / 改阈值后不再标记,且重算生效 (B3)
 * - 与 Analytics 共用折叠后的 nodes,口径一致
 */

import { describe, expect, it } from "vitest";
import type { GraphEntry } from "./types";
import { foldGraphEntries } from "./analytics";
import type { GraphNode } from "./analytics";
import {
  DEFAULT_HEALTH_RULES,
  evaluateHealth,
  normalizeHealthRules,
  type HealthRuleId,
} from "./health";

const NOW = Date.now();

/** 时间戳基于当前时间动态生成,避免测试随时间漂移(同 analytics.test.ts) */
function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    node_id: "n-default",
    source: "Claude",
    session_id: "s-default",
    workspace: "proj-placeholder",
    jsonl_path: "/tmp/placeholder.jsonl",
    size_bytes: 1000,
    mtime_ms: NOW,
    first_prompt: "placeholder prompt",
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

const FOUR_SOURCES: GraphNode["source"][] = ["Claude", "OpenClaw", "Kimi", "DeepSeekHarness"];

function flagRules(result: ReturnType<typeof evaluateHealth>, sid: string): HealthRuleId[] {
  const row = result.flagged.find((f) => f.node.session_id === sid);
  return row ? row.flags.map((f) => f.rule) : [];
}

describe("evaluateHealth — 空数据与边界", () => {
  it("空数组返回全零报告,不抛错、不产生 NaN", () => {
    const r = evaluateHealth([]);
    expect(r.totalSessions).toBe(0);
    expect(r.flaggedCount).toBe(0);
    expect(r.cleanCount).toBe(0);
    expect(r.flagged).toEqual([]);
    expect(r.byRule).toHaveLength(4);
    expect(r.byRule.every((b) => b.count === 0)).toBe(true);
    expect(r.bySource).toHaveLength(4);
    expect(r.bySource.every((b) => b.total === 0 && b.flagged === 0)).toBe(true);
    expect(r.tokenCutoff).toBeNull();
    expect(r.tokenMean).toBe(0);
  });

  it("单样本 / 全部 token 相同(σ=0)时不判定离群,避免全量误报", () => {
    const single = evaluateHealth([makeNode({ token_total: 999 })]);
    expect(single.tokenCutoff).toBeNull();
    expect(single.flaggedCount).toBe(0);

    const same = evaluateHealth(
      FOUR_SOURCES.map((source, i) =>
        makeNode({ source, session_id: `same-${i}`, node_id: `same-${i}`, token_total: 500 })
      )
    );
    expect(same.tokenStdDev).toBe(0);
    expect(same.tokenCutoff).toBeNull();
    expect(same.flaggedCount).toBe(0);
  });

  it("脏数据(NaN token / 非法 error_count)不抛错、不产生 NaN 标签", () => {
    const r = evaluateHealth([
      makeNode({ session_id: "dirty", token_total: Number.NaN, error_count: Number.NaN }),
      makeNode({ session_id: "clean", token_total: 100, error_count: 0 }),
    ]);
    expect(r.totalSessions).toBe(2);
    expect(r.flaggedCount).toBe(0);
    expect(r.flagged.every((f) => f.flags.every((x) => Number.isFinite(x.actual)))).toBe(true);
  });
});

describe("evaluateHealth — 四条规则与可解释标签", () => {
  it("4 种 source 均由「高错误数」触发,标签含实际值与阈值", () => {
    const nodes = FOUR_SOURCES.map((source, i) =>
      makeNode({
        source,
        session_id: `err-${i}`,
        node_id: `err-${i}`,
        error_count: 25,
      })
    );
    const r = evaluateHealth(nodes);
    expect(r.flaggedCount).toBe(4);
    expect(r.cleanCount).toBe(0);
    expect(r.bySource.map((b) => b.flagged)).toEqual([1, 1, 1, 1]);
    expect(r.bySource.map((b) => b.total)).toEqual([1, 1, 1, 1]);
    expect(r.byRule.find((b) => b.rule === "highErrors")?.count).toBe(4);

    for (const row of r.flagged) {
      const flag = row.flags.find((f) => f.rule === "highErrors");
      expect(flag).toBeDefined();
      expect(flag?.label).toContain("高错误数");
      expect(flag?.label).toContain("25");
      expect(flag?.label).toContain("20");
      expect(flag?.detail).toContain("error_count = 25");
      expect(flag?.actual).toBe(25);
      expect(flag?.threshold).toBe(20);
    }
  });

  it("未命中任何规则的会话不带标签", () => {
    const r = evaluateHealth([
      makeNode({ session_id: "clean-1", error_count: 1, token_total: 100 }),
      makeNode({ session_id: "clean-2", error_count: 2, token_total: 120 }),
    ]);
    expect(r.flaggedCount).toBe(0);
    expect(r.cleanCount).toBe(2);
  });

  it("token 离群:μ + 3σ 判定线,detail 写出 μ / σ / cutoff", () => {
    const nodes = Array.from({ length: 10 }, (_, i) =>
      makeNode({ session_id: `base-${i}`, node_id: `base-${i}`, token_total: 100 })
    ).concat(makeNode({ session_id: "outlier", node_id: "outlier", token_total: 100000 }));
    const r = evaluateHealth(nodes);
    expect(flagRules(r, "outlier")).toContain("tokenOutlier");
    expect(flagRules(r, "base-0")).toEqual([]);
    const f = r.flagged.flatMap((x) => x.flags).find((x) => x.rule === "tokenOutlier");
    expect(f?.detail).toContain("均值 μ");
    expect(f?.detail).toContain("总体标准差 σ");
    expect(f?.actual).toBe(100000);
    expect(f?.threshold).toBeCloseTo(r.tokenCutoff ?? 0, 5);
    expect(r.byRule.find((b) => b.rule === "tokenOutlier")?.count).toBe(1);
  });

  it("子会话过多:subagent_count ≥ 10", () => {
    const nodes = [
      ...Array.from({ length: 4 }, (_, i) =>
        makeNode({ session_id: `base-${i}`, node_id: `base-${i}`, subagent_count: 0 })
      ),
      makeNode({ session_id: "many", node_id: "many", subagent_count: 12 }),
    ];
    const r = evaluateHealth(nodes);
    expect(flagRules(r, "many")).toContain("manySubagents");
    expect(
      r.flagged.flatMap((x) => x.flags).find((x) => x.rule === "manySubagents")?.label
    ).toContain("12");
  });

  it("同会话模型漂移:available_models ≥ 2 命中,缺字段不臆造", () => {
    const nodes = [
      makeNode({ session_id: "drift", node_id: "drift", available_models: ["m1", "m2", "m3"] }),
      makeNode({ session_id: "one-model", node_id: "one-model", available_models: ["m1"] }),
      makeNode({ session_id: "no-field", node_id: "no-field" }),
    ];
    const r = evaluateHealth(nodes);
    expect(flagRules(r, "drift")).toContain("modelDrift");
    expect(flagRules(r, "one-model")).toEqual([]);
    expect(flagRules(r, "no-field")).toEqual([]);
    expect(
      r.flagged.flatMap((x) => x.flags).find((x) => x.rule === "modelDrift")?.detail
    ).toContain("3 个模型");
  });

  it("Top 风险排序:命中规则数优先,其次 error_count / token_total,结果稳定", () => {
    const nodes = [
      makeNode({ session_id: "one", node_id: "one", error_count: 25 }),
      makeNode({
        session_id: "three",
        node_id: "three",
        error_count: 25,
        subagent_count: 12,
        available_models: ["m1", "m2"],
      }),
      makeNode({ session_id: "clean", node_id: "clean" }),
    ];
    const r = evaluateHealth(nodes);
    expect(r.flagged.map((f) => f.node.session_id)).toEqual(["three", "one"]);
    expect(r.flagged[0]?.score).toBe(3);
    expect(r.flagged[1]?.score).toBe(1);
  });
});

describe("evaluateHealth — B3 规则可配置与重算", () => {
  it("关闭 highErrors 后 error_count=25 不再标记", () => {
    const r = evaluateHealth([makeNode({ error_count: 25 })], {
      ...DEFAULT_HEALTH_RULES,
      highErrorsEnabled: false,
    });
    expect(r.flaggedCount).toBe(0);
  });

  it("阈值改为 30 后 error_count=25 不再标记(重算生效)", () => {
    const r = evaluateHealth([makeNode({ error_count: 25 })], {
      ...DEFAULT_HEALTH_RULES,
      highErrorsThreshold: 30,
    });
    expect(r.flaggedCount).toBe(0);
    expect(r.byRule.find((b) => b.rule === "highErrors")?.count).toBe(0);
  });

  it("全部规则关闭时报告仍完整,只是无标记", () => {
    const r = evaluateHealth([makeNode({ error_count: 99, subagent_count: 99 })], {
      highErrorsEnabled: false,
      tokenOutlierEnabled: false,
      subagentsEnabled: false,
      modelDriftEnabled: false,
    });
    expect(r.totalSessions).toBe(1);
    expect(r.flaggedCount).toBe(0);
    expect(r.cleanCount).toBe(1);
    expect(r.tokenCutoff).toBeNull();
  });

  it("部分配置(老 settings.json 只存了一个字段)用默认值补齐", () => {
    const r = evaluateHealth([makeNode({ error_count: 25 })], { highErrorsThreshold: 30 });
    expect(r.flaggedCount).toBe(0);
  });
});

describe("normalizeHealthRules — 阈值防御", () => {
  it("undefined / null 返回默认配置", () => {
    expect(normalizeHealthRules()).toEqual(DEFAULT_HEALTH_RULES);
    expect(normalizeHealthRules(null)).toEqual(DEFAULT_HEALTH_RULES);
  });

  it("NaN / Infinity / 负数 / 越界值被 clamp,不产生 NaN 判定", () => {
    const r = normalizeHealthRules({
      highErrorsThreshold: Number.NaN,
      tokenSigma: -5,
      subagentsThreshold: Number.POSITIVE_INFINITY,
      modelDriftMinModels: 1,
    });
    expect(r.highErrorsThreshold).toBe(DEFAULT_HEALTH_RULES.highErrorsThreshold);
    expect(r.tokenSigma).toBe(0.01);
    expect(Number.isFinite(r.subagentsThreshold)).toBe(true);
    expect(r.modelDriftMinModels).toBe(2);
  });
});

describe("evaluateHealth — 与 Analytics 共用折叠口径", () => {
  it("subagent 归并到 parent 后,体检吃折叠后的 error_count,不重复计子会话", () => {
    const parent = makeNode({
      session_id: "parent",
      node_id: "parent",
      error_count: 15,
      subagent_ids: ["child-session"],
    });
    const child = makeNode({
      session_id: "child-session",
      node_id: "child-session",
      error_count: 6,
      parent_session_id: "parent",
      is_subagent_root: true,
    });
    const entries: GraphEntry[] = [
      { node: parent, edges: [] },
      { node: child, edges: [] },
    ];
    const folded = foldGraphEntries(entries);

    // 折叠后只剩 parent,error_count = 15 + 6 = 21 → 命中 ≥20
    expect(folded.nodes).toHaveLength(1);
    const r = evaluateHealth(folded.nodes);
    expect(r.totalSessions).toBe(1);
    expect(r.flaggedCount).toBe(1);
    expect(r.flagged[0]?.node.session_id).toBe("parent");
    expect(r.flagged[0]?.flags.find((f) => f.rule === "highErrors")?.actual).toBe(21);

    // 未折叠会同时看到 parent 与 child(口径不一致的反例)
    const raw = evaluateHealth([parent, child]);
    expect(raw.totalSessions).toBe(2);
  });
});
