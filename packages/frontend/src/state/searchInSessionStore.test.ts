/**
 * searchInSessionStore 单元测试
 *
 * 覆盖:
 * - 空 query → hits 清空, currentHitIndex = -1
 * - 大小写不敏感
 * - 多 entry 多 hit, 同 entry 多 hit
 * - snippet padding + 空白压缩 + 边界省略号
 * - next/prev 循环 (到末尾回 0)
 * - setCurrentHitIndex clamping (负数 → 0, 越界 → hits.length-1)
 * - hide() 重置全部
 */

import { describe, it, expect, beforeEach } from "vitest";
import { useSearchInSessionStore } from "./searchInSessionStore";
import type { TranscriptEntryOut } from "../lib/api";

function makeEntry(index: number, blocks: unknown[]): TranscriptEntryOut {
  return {
    index,
    byteOffset: index * 1000,
    raw: {},
    normalized: {
      id: `entry-${index}`,
      role: "assistant",
      rawType: "test",
      timestamp: "2026-06-25T14:00:00Z",
      blocks: blocks as TranscriptEntryOut["normalized"]["blocks"],
    },
  };
}

describe("searchInSessionStore", () => {
  beforeEach(() => {
    // 每个 case 之前重置
    useSearchInSessionStore.getState().hide();
  });

  it("初始状态:open=false, query='', hits=[], currentHitIndex=-1", () => {
    const s = useSearchInSessionStore.getState();
    expect(s.open).toBe(false);
    expect(s.query).toBe("");
    expect(s.hits).toEqual([]);
    expect(s.currentHitIndex).toBe(-1);
  });

  it("show() / hide() 切换 open", () => {
    useSearchInSessionStore.getState().show();
    expect(useSearchInSessionStore.getState().open).toBe(true);
    useSearchInSessionStore.getState().hide();
    expect(useSearchInSessionStore.getState().open).toBe(false);
  });

  it("hide() 同时清空 query/hits/currentHitIndex", () => {
    const { setQuery, search, hide } = useSearchInSessionStore.getState();
    setQuery("foo");
    search([makeEntry(0, [{ kind: "text", text: "foo bar" }])]);
    expect(useSearchInSessionStore.getState().hits.length).toBeGreaterThan(0);
    hide();
    const s = useSearchInSessionStore.getState();
    expect(s.query).toBe("");
    expect(s.hits).toEqual([]);
    expect(s.currentHitIndex).toBe(-1);
  });

  it("setQuery 仅更新 query 字段", () => {
    useSearchInSessionStore.getState().setQuery("hello");
    expect(useSearchInSessionStore.getState().query).toBe("hello");
  });

  it("search:空 query → 清空 hits, currentHitIndex = -1", () => {
    const { search, setQuery } = useSearchInSessionStore.getState();
    setQuery("foo");
    search([makeEntry(0, [{ kind: "text", text: "foo" }])]);
    expect(useSearchInSessionStore.getState().hits.length).toBe(1);
    setQuery("");
    search([makeEntry(0, [{ kind: "text", text: "foo" }])]);
    const s = useSearchInSessionStore.getState();
    expect(s.hits).toEqual([]);
    expect(s.currentHitIndex).toBe(-1);
  });

  it("search:大小写不敏感", () => {
    const { setQuery, search } = useSearchInSessionStore.getState();
    setQuery("HELLO");
    search([makeEntry(0, [{ kind: "text", text: "hello world" }])]);
    expect(useSearchInSessionStore.getState().hits.length).toBe(1);
  });

  it("search:无匹配 → hits=[], currentHitIndex=-1", () => {
    const { setQuery, search } = useSearchInSessionStore.getState();
    setQuery("xyz");
    search([makeEntry(0, [{ kind: "text", text: "hello world" }])]);
    const s = useSearchInSessionStore.getState();
    expect(s.hits).toEqual([]);
    expect(s.currentHitIndex).toBe(-1);
  });

  it("search:有匹配 → currentHitIndex 自动到 0", () => {
    const { setQuery, search } = useSearchInSessionStore.getState();
    setQuery("hello");
    search([makeEntry(0, [{ kind: "text", text: "hello world" }])]);
    expect(useSearchInSessionStore.getState().currentHitIndex).toBe(0);
  });

  it("search:同一 entry 多个匹配位置 → 多个 hit", () => {
    const { setQuery, search } = useSearchInSessionStore.getState();
    setQuery("foo");
    search([makeEntry(0, [{ kind: "text", text: "foo bar foo baz foo" }])]);
    expect(useSearchInSessionStore.getState().hits.length).toBe(3);
  });

  it("search:多 entry 各有匹配 → 多个 hit", () => {
    const { setQuery, search } = useSearchInSessionStore.getState();
    setQuery("needle");
    search([
      makeEntry(0, [{ kind: "text", text: "needle in 0" }]),
      makeEntry(1, [{ kind: "text", text: "needle in 1" }]),
      makeEntry(2, [{ kind: "text", text: "no match" }]),
    ]);
    const hits = useSearchInSessionStore.getState().hits;
    expect(hits.length).toBe(2);
    expect(hits[0]!.entryIndex).toBe(0);
    expect(hits[1]!.entryIndex).toBe(1);
  });

  it("snippet:命中位置在中间时,前后有 …省略号", () => {
    const { setQuery, search } = useSearchInSessionStore.getState();
    const longText = "a".repeat(200) + "TARGET" + "b".repeat(200);
    setQuery("TARGET");
    search([makeEntry(0, [{ kind: "text", text: longText }])]);
    const hit = useSearchInSessionStore.getState().hits[0]!;
    expect(hit.snippet).toMatch(/^…/);
    expect(hit.snippet).toMatch(/…$/);
    expect(hit.snippet).toContain("target"); // 大小写不敏感后
  });

  it("snippet:命中位置在文本开头时,末尾有省略号但开头没有", () => {
    // 搜索跑在 JSON.stringify(normalized) 上,所以 "TARGET" 前面总有 JSON 包装
    // 没法构造"snippet 真正在开头"的测试。改测:长文本命中时,末尾一定有省略号
    // (因为 slice 截到 end = pos + qLen + 60,后面有 200 个 b)
    const { setQuery, search } = useSearchInSessionStore.getState();
    const longText = "TARGET" + "b".repeat(200);
    setQuery("TARGET");
    search([makeEntry(0, [{ kind: "text", text: longText }])]);
    const hit = useSearchInSessionStore.getState().hits[0]!;
    expect(hit.snippet.endsWith("…")).toBe(true);
  });

  it("next:循环 (0 → 1 → 2 → 0)", () => {
    const { setQuery, search, next } = useSearchInSessionStore.getState();
    setQuery("foo");
    search([
      makeEntry(0, [{ kind: "text", text: "foo" }]),
      makeEntry(1, [{ kind: "text", text: "foo" }]),
      makeEntry(2, [{ kind: "text", text: "foo" }]),
    ]);
    expect(useSearchInSessionStore.getState().currentHitIndex).toBe(0);
    next();
    expect(useSearchInSessionStore.getState().currentHitIndex).toBe(1);
    next();
    expect(useSearchInSessionStore.getState().currentHitIndex).toBe(2);
    next(); // wrap
    expect(useSearchInSessionStore.getState().currentHitIndex).toBe(0);
  });

  it("prev:循环 (0 → 末尾 → 0)", () => {
    const { setQuery, search, prev } = useSearchInSessionStore.getState();
    setQuery("foo");
    search([
      makeEntry(0, [{ kind: "text", text: "foo" }]),
      makeEntry(1, [{ kind: "text", text: "foo" }]),
      makeEntry(2, [{ kind: "text", text: "foo" }]),
    ]);
    expect(useSearchInSessionStore.getState().currentHitIndex).toBe(0);
    prev(); // wrap to last
    expect(useSearchInSessionStore.getState().currentHitIndex).toBe(2);
    prev();
    expect(useSearchInSessionStore.getState().currentHitIndex).toBe(1);
  });

  it("next/prev:hits 为空时是 no-op", () => {
    const { next, prev } = useSearchInSessionStore.getState();
    next();
    prev();
    expect(useSearchInSessionStore.getState().currentHitIndex).toBe(-1);
  });

  it("setCurrentHitIndex:负数 → 0", () => {
    const { setQuery, search, setCurrentHitIndex } = useSearchInSessionStore.getState();
    setQuery("foo");
    search([
      makeEntry(0, [{ kind: "text", text: "foo" }]),
      makeEntry(1, [{ kind: "text", text: "foo" }]),
    ]);
    setCurrentHitIndex(-5);
    expect(useSearchInSessionStore.getState().currentHitIndex).toBe(0);
  });

  it("setCurrentHitIndex:越界 → hits.length - 1", () => {
    const { setQuery, search, setCurrentHitIndex } = useSearchInSessionStore.getState();
    setQuery("foo");
    search([
      makeEntry(0, [{ kind: "text", text: "foo" }]),
      makeEntry(1, [{ kind: "text", text: "foo" }]),
    ]);
    setCurrentHitIndex(999);
    expect(useSearchInSessionStore.getState().currentHitIndex).toBe(1);
  });

  it("setCurrentHitIndex:正常范围 → 设定值", () => {
    const { setQuery, search, setCurrentHitIndex } = useSearchInSessionStore.getState();
    setQuery("foo");
    search([
      makeEntry(0, [{ kind: "text", text: "foo" }]),
      makeEntry(1, [{ kind: "text", text: "foo" }]),
      makeEntry(2, [{ kind: "text", text: "foo" }]),
    ]);
    setCurrentHitIndex(1);
    expect(useSearchInSessionStore.getState().currentHitIndex).toBe(1);
  });

  it("setCurrentHitIndex:hits 为空 → -1", () => {
    const { setCurrentHitIndex } = useSearchInSessionStore.getState();
    setCurrentHitIndex(5);
    expect(useSearchInSessionStore.getState().currentHitIndex).toBe(-1);
  });
});
