import { describe, expect, it } from "vitest";
import { checkP95Budget, p95, PERF_P95_BUDGET_MS } from "./perf";

describe("A3 — 分析页 P95 采集口径 (nearest-rank)", () => {
  it("空样本 / 单样本", () => {
    expect(p95([])).toBeNull();
    expect(p95([42])).toBe(42);
  });

  it("20 个样本取第 19 个,与 Rust duration_p95 一致", () => {
    const samples = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    expect(p95(samples)).toBe(190);
  });

  it("忽略 NaN / 负数,不参与排序", () => {
    expect(p95([100, NaN, -5, 200])).toBe(200);
  });

  it("不修改入参数组", () => {
    const samples = [300, 100, 200];
    p95(samples);
    expect(samples).toEqual([300, 100, 200]);
  });
});

describe("A3 — <500ms 可选门槛断言", () => {
  it("默认预算是 500ms", () => {
    expect(PERF_P95_BUDGET_MS).toBe(500);
  });

  it("典型样本通过,报告样本数与 P95", () => {
    const v = checkP95Budget([120, 180, 210, 260, 310, 380, 155, 240, 290, 195]);
    expect(v.sampleCount).toBe(10);
    expect(v.p95Ms).toBe(380);
    expect(v.ok).toBe(true);
    expect(v.reason).toContain("估算预算");
  });

  it("注入验证:慢样本必须触发回归判定,而不是永远变绿", () => {
    const v = checkP95Budget(Array(20).fill(650));
    expect(v.p95Ms).toBe(650);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("性能回归");
  });

  it("无样本时跳过门槛(ok=true,不假失败)", () => {
    const v = checkP95Budget([]);
    expect(v.sampleCount).toBe(0);
    expect(v.p95Ms).toBeNull();
    expect(v.ok).toBe(true);
  });

  it("支持自定义预算", () => {
    expect(checkP95Budget([300], 250).ok).toBe(false);
    expect(checkP95Budget([300], 400).ok).toBe(true);
  });
});
