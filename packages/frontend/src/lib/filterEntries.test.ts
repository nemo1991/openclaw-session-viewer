/**
 * applyTimeFilter 单元测试
 *
 * 覆盖:
 * - 无 range → 直通(返回原数组引用)
 * - 只 from / 只 to / 完整区间 / 区间无匹配
 * - 缺 timestamp 的 entry 保留
 * - timestamp 解析失败的 entry 保留
 * - 区间边界包含(>=, <=)
 * - 多次调用稳定(纯函数)
 */

import { describe, it, expect } from "vitest";
import { applyTimeFilter } from "./filterEntries";
import type { TranscriptEntryOut } from "./api";

function makeEntry(index: number, ts?: string): TranscriptEntryOut {
  return {
    index,
    byteOffset: index * 1000,
    raw: {},
    normalized: {
      id: `e-${index}`,
      role: "assistant",
      rawType: "test",
      timestamp: ts,
      blocks: [],
    },
  };
}

describe("applyTimeFilter", () => {
  it("无 range → 直通(元素全部保留)", () => {
    const entries = [makeEntry(0, "2026-06-25T10:00:00Z"), makeEntry(1)];
    const out = applyTimeFilter(entries, {});
    // .filter 始终返回新数组 — 断言内容而不是引用
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(entries[0]); // 元素引用复用
    expect(out[1]).toBe(entries[1]);
  });

  it("只 from:保留 >= from 的 entry", () => {
    const entries = [
      makeEntry(0, "2026-06-25T09:00:00Z"),
      makeEntry(1, "2026-06-25T10:00:00Z"),
      makeEntry(2, "2026-06-25T11:00:00Z"),
    ];
    const out = applyTimeFilter(entries, { from: "2026-06-25T10:00:00Z" });
    expect(out.map((e) => e.index)).toEqual([1, 2]);
  });

  it("只 to:保留 <= to 的 entry", () => {
    const entries = [
      makeEntry(0, "2026-06-25T09:00:00Z"),
      makeEntry(1, "2026-06-25T10:00:00Z"),
      makeEntry(2, "2026-06-25T11:00:00Z"),
    ];
    const out = applyTimeFilter(entries, { to: "2026-06-25T10:00:00Z" });
    expect(out.map((e) => e.index)).toEqual([0, 1]);
  });

  it("完整 from+to:闭区间 [from, to]", () => {
    const entries = [
      makeEntry(0, "2026-06-25T09:00:00Z"),
      makeEntry(1, "2026-06-25T10:00:00Z"),
      makeEntry(2, "2026-06-25T10:30:00Z"),
      makeEntry(3, "2026-06-25T11:00:00Z"),
    ];
    const out = applyTimeFilter(entries, {
      from: "2026-06-25T10:00:00Z",
      to: "2026-06-25T11:00:00Z",
    });
    expect(out.map((e) => e.index)).toEqual([1, 2, 3]);
  });

  it("区间内无匹配 → []", () => {
    const entries = [makeEntry(0, "2026-06-25T09:00:00Z"), makeEntry(1, "2026-06-25T11:00:00Z")];
    const out = applyTimeFilter(entries, {
      from: "2026-06-25T10:00:00Z",
      to: "2026-06-25T10:30:00Z",
    });
    expect(out).toEqual([]);
  });

  it("缺 timestamp 的 entry 保留", () => {
    const entries = [makeEntry(0), makeEntry(1, "2026-06-25T10:00:00Z")];
    const out = applyTimeFilter(entries, {
      from: "2026-06-25T09:00:00Z",
      to: "2026-06-25T11:00:00Z",
    });
    // e-0 没 timestamp → 保留;e-1 在区间 → 保留
    expect(out.map((e) => e.index)).toEqual([0, 1]);
  });

  it("timestamp 解析失败的 entry 保留", () => {
    const entries = [makeEntry(0, "not-a-date"), makeEntry(1, "2026-06-25T10:00:00Z")];
    const out = applyTimeFilter(entries, {
      from: "2026-06-25T09:00:00Z",
      to: "2026-06-25T11:00:00Z",
    });
    expect(out.map((e) => e.index)).toEqual([0, 1]);
  });

  it("边界包含(>=, <=):from/to 完全相等时该 entry 保留", () => {
    const entries = [makeEntry(0, "2026-06-25T10:00:00Z")];
    const out = applyTimeFilter(entries, {
      from: "2026-06-25T10:00:00Z",
      to: "2026-06-25T10:00:00Z",
    });
    expect(out).toHaveLength(1);
  });

  it("纯函数:相同输入多次调用结果引用稳定", () => {
    const entries = [makeEntry(0, "2026-06-25T10:00:00Z")];
    const out1 = applyTimeFilter(entries, { from: "2026-06-25T09:00:00Z" });
    const out2 = applyTimeFilter(entries, { from: "2026-06-25T09:00:00Z" });
    // 输入相同 → 不同数组但元素引用一致
    expect(out1).not.toBe(out2);
    expect(out1[0]).toBe(out2[0]);
  });
});
