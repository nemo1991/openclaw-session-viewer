/**
 * v0.12 (C1 / FR-C1): 卡片 stat-chip 分层选择单测
 *
 * 覆盖验收指标「未展开卡片常驻 chip ≤3」「错误/重复/时长优先」「展开显示全部」。
 */
import { describe, expect, it } from "vitest";
import { selectStatChips, type RankedChip } from "./sessionCardChips";

function chip(key: string, priority: number): RankedChip<string> {
  return { key, priority, node: key };
}

/** 模拟首页 SessionCard 的全部 10+ 类 chip(含 2 个 topTools) */
function allChips(): RankedChip<string>[] {
  return [
    chip("thinking", 3),
    chip("tools", 4),
    chip("duration", 2),
    chip("error", 0),
    chip("repeat", 1),
    chip("idle", 5),
    chip("todo", 6),
    chip("tokens", 7),
    chip("compaction", 8),
    chip("toptool-0", 9),
    chip("toptool-1", 10),
  ];
}

describe("selectStatChips — 默认分层", () => {
  it("默认最多露 3 个,且按 error > repeat > duration 高信号优先", () => {
    const r = selectStatChips(allChips(), false);
    expect(r.shown).toHaveLength(3);
    expect(r.shown.map((c) => c.key)).toEqual(["error", "repeat", "duration"]);
  });

  it("折叠态正确给出 hasMore / hiddenCount 供展开按钮文案使用", () => {
    const r = selectStatChips(allChips(), false);
    expect(r.hasMore).toBe(true);
    expect(r.hiddenCount).toBe(8);
    expect(r.ordered).toHaveLength(11);
  });

  it("展开后显示全部 chip,hiddenCount 归零,但 hasMore 仍为 true(按钮保留)", () => {
    const r = selectStatChips(allChips(), true);
    expect(r.shown).toHaveLength(11);
    expect(r.hiddenCount).toBe(0);
    expect(r.hasMore).toBe(true);
    expect(r.shown.map((c) => c.key)).toEqual(r.ordered.map((c) => c.key));
  });

  it("chip 数 ≤3 时全部露出且无展开按钮", () => {
    const few = [chip("thinking", 3), chip("error", 0)];
    const r = selectStatChips(few, false);
    expect(r.hasMore).toBe(false);
    expect(r.hiddenCount).toBe(0);
    expect(r.shown.map((c) => c.key)).toEqual(["error", "thinking"]);
  });

  it("空数组不抛错,返回全零选择", () => {
    const r = selectStatChips([], false);
    expect(r.ordered).toEqual([]);
    expect(r.shown).toEqual([]);
    expect(r.hasMore).toBe(false);
    expect(r.hiddenCount).toBe(0);
  });

  it("不修改入参数组顺序(纯函数)", () => {
    const input = allChips();
    const before = input.map((c) => c.key);
    selectStatChips(input, false);
    expect(input.map((c) => c.key)).toEqual(before);
  });

  it("maxVisible 非法值 / 0 有安全兜底", () => {
    expect(selectStatChips(allChips(), false, 0).shown).toHaveLength(0);
    expect(selectStatChips(allChips(), false, Number.NaN).shown).toHaveLength(3);
    expect(selectStatChips(allChips(), false, -5).shown).toHaveLength(0);
  });
});
