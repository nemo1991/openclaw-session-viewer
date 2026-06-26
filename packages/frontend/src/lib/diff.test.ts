import { describe, it, expect } from "vitest";
import { computeLineDiff, diffStats, DiffTooLargeError } from "./diff";

describe("computeLineDiff", () => {
  it("纯新增:空 old + 单行 new", () => {
    const result = computeLineDiff("", "hello\n");
    expect(result).toEqual([{ kind: "add", text: "hello" }]);
  });

  it("纯删除:单行 old + 空 new", () => {
    const result = computeLineDiff("hello\n", "");
    expect(result).toEqual([{ kind: "del", text: "hello" }]);
  });

  it("纯替换:无公共行", () => {
    const result = computeLineDiff("foo\n", "bar\n");
    // jsdiff 行为:del foo + add bar
    expect(result).toContainEqual({ kind: "del", text: "foo" });
    expect(result).toContainEqual({ kind: "add", text: "bar" });
  });

  it("完全相同", () => {
    const result = computeLineDiff("a\nb\nc\n", "a\nb\nc\n");
    expect(result).toEqual([
      { kind: "eq", text: "a" },
      { kind: "eq", text: "b" },
      { kind: "eq", text: "c" },
    ]);
  });

  it("中间修改:首行保留,后续变更", () => {
    const result = computeLineDiff("a\nb\nc\n", "a\nB\nC\nc\n");
    // 首行肯定保留
    expect(result[0]).toEqual({ kind: "eq", text: "a" });
    // 中间有 del 和 add
    const dels = result.filter((l) => l.kind === "del").map((l) => l.text);
    const adds = result.filter((l) => l.kind === "add").map((l) => l.text);
    expect(dels.length).toBeGreaterThan(0);
    expect(adds.length).toBeGreaterThan(0);
    // 新增行至少包含 B 和 C
    expect(adds).toContain("B");
    expect(adds).toContain("C");
  });

  it("空 old + 空 new", () => {
    expect(computeLineDiff("", "")).toEqual([]);
  });

  it("超 5000 行抛 DiffTooLargeError", () => {
    const big = Array.from({ length: 5001 }, () => "x").join("\n");
    expect(() => computeLineDiff(big, "y")).toThrow(DiffTooLargeError);
  });
});

describe("diffStats", () => {
  it("统计正确", () => {
    const lines = [
      { kind: "eq" as const, text: "a" },
      { kind: "del" as const, text: "b" },
      { kind: "add" as const, text: "B" },
      { kind: "eq" as const, text: "c" },
    ];
    expect(diffStats(lines)).toEqual({ added: 1, removed: 1, unchanged: 2 });
  });

  it("空数组", () => {
    expect(diffStats([])).toEqual({ added: 0, removed: 0, unchanged: 0 });
  });
});
