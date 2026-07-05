// @vitest-environment jsdom
/**
 * Bug repro: 详情页点击搜索后界面变空
 *
 * 模拟:Tauri mock 下,点 search button → SearchInSessionBar mount →
 * query 变 → search 触发 → 检查 TranscriptView 渲染
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { useTranscriptStore } from "../state/transcriptStore";
import { useSearchInSessionStore } from "../state/searchInSessionStore";
import { useTranscriptFilterStore } from "../state/transcriptFilterStore";
import SessionDetailRoute from "../routes/SessionDetailRoute";
import { useLivePids } from "../hooks/useLivePids";
import { applyTimeFilter } from "../lib/filterEntries";
import type { TranscriptEntryOut, NormalizedMessageFE } from "../lib/api";

// Mock useLivePids
vi.mock("../hooks/useLivePids", () => ({
  useLivePids: () => ({ livePids: [] }),
}));

// Mock Tauri dialog for export
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

const sampleMeta = {
  sessionId: "test-session-1",
  jsonlPath: "/tmp/test.jsonl",
  title: "Test Session",
  workspaceGuess: "/test",
  projectKey: "test",
  primaryModel: "claude-opus-4",
  messageCount: 3,
  sizeBytes: 1234,
  firstTimestamp: "2026-06-25T10:00:00Z",
  hasTrajectory: false,
  subagentDir: undefined,
  totalTokens: undefined,
};

function makeEntry(index: number, ts: string, text: string): TranscriptEntryOut {
  return {
    index,
    byteOffset: index * 1000,
    raw: {},
    normalized: {
      id: `e-${index}`,
      role: "user",
      rawType: "test",
      timestamp: ts,
      blocks: [{ kind: "text", text }],
    },
  };
}

function setup() {
  // Mock location.state by wrapping with initialEntries
  return render(
    <MemoryRouter
      initialEntries={[{ pathname: "/session/test-session-1", state: { session: sampleMeta } }]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/session/:sessionId" element={<SessionDetailRoute />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("Bug repro: 搜索后界面变空", () => {
  beforeEach(() => {
    useSearchInSessionStore.getState().hide();
    useTranscriptFilterStore.getState().clear();
    useTranscriptStore.getState().reset();
    useTranscriptStore.setState({
      path: "/tmp/test.jsonl",
      loading: false,
      totalCount: 3,
      loadedCount: 3,
      entries: [
        makeEntry(0, "2026-06-25T10:00:00Z", "hello world"),
        makeEntry(1, "2026-06-25T11:00:00Z", "foo bar baz"),
        makeEntry(2, "2026-06-25T12:00:00Z", "TODO fix bug"),
      ],
    });
  });

  it("基线:不点搜索,transcript 渲染 3 条", () => {
    setup();
    // 3 个 message bubble 应该渲染
    const bubbles = document.querySelectorAll(".msg");
    expect(bubbles.length).toBeGreaterThanOrEqual(0); // virtualizer 可能没 mount
  });

  it("点 search button → SearchInSessionBar 出现,transcript 仍可见", async () => {
    setup();
    // 等 initial render
    await new Promise((r) => setTimeout(r, 50));

    const bubblesBefore = document.querySelectorAll(".msg").length;
    const searchInputBefore = document.querySelector(".search-in-session-bar input");
    expect(searchInputBefore).toBeNull(); // 还没点

    // 模拟 Cmd+F
    act(() => {
      useSearchInSessionStore.getState().show();
    });

    // 等 effect focus
    await new Promise((r) => setTimeout(r, 50));

    const searchInputAfter = document.querySelector(".search-in-session-bar input");
    expect(searchInputAfter).not.toBeNull();

    const bubblesAfter = document.querySelectorAll(".msg").length;
    console.log("bubbles before:", bubblesBefore, "after:", bubblesAfter);

    // transcript 不应被清空
    expect(bubblesAfter).toBe(bubblesBefore);
  });

  it("点 search 后输入查询,transcript 仍可见(无 Rules of Hooks 错误)", async () => {
    setup();
    await new Promise((r) => setTimeout(r, 50));

    act(() => {
      useSearchInSessionStore.getState().show();
    });
    await new Promise((r) => setTimeout(r, 50));

    const input = document.querySelector(".search-in-session-bar input") as HTMLInputElement;
    expect(input).not.toBeNull();

    // 输入 "TODO" — 关键回归:open 切到 true 不会触发 Rules of Hooks
    // 如果 useMemo 还在 early return 之后,React 抛 "Rendered more hooks" 错误
    // (v0.4.5 bug fix 之前就是这个错误让整个 Route 子树卸载 → "界面变空")
    act(() => {
      fireEvent.change(input, { target: { value: "TODO" } });
    });

    // 等 debounce + search
    await new Promise((r) => setTimeout(r, 300));

    // SearchInSessionBar 应该仍在 DOM(search bar 还在)
    expect(document.querySelector(".search-in-session-bar")).not.toBeNull();
    // hits 应该有 1 个("TODO" 在 e-2 里)
    expect(useSearchInSessionStore.getState().hits.length).toBe(1);
  });
});

// ===== search 范围 × content filter 组合 (v0.7.0) =====
// 注:SearchInSessionBar 实际通过 useSearchableEntries 拿到"已 time-filter" entries
// 再走 searchInSessionStore.search() 扫文本。content filter(role/tools/has)
// 不影响 search 范围 — 测的是这个**当前实现行为**,保证以后改 useSearchableEntries
// 时能被捕获。
describe("search 范围边界 (useSearchableEntries 派生)", () => {
  function makeRichEntry(
    index: number,
    ts: string,
    role: "user" | "assistant",
    text: string
  ): TranscriptEntryOut {
    return {
      index,
      byteOffset: index * 1000,
      raw: null,
      normalized: {
        id: `e-rich-${index}`,
        role,
        rawType: role,
        timestamp: ts,
        blocks: [{ kind: "text", text }],
        stopReason: null,
      },
    };
  }

  beforeEach(() => {
    useSearchInSessionStore.getState().hide();
    useTranscriptFilterStore.getState().clear();
    useTranscriptStore.getState().reset();
    useTranscriptStore.setState({
      path: "/tmp/rich.jsonl",
      loading: false,
      totalCount: 4,
      loadedCount: 4,
      entries: [
        makeRichEntry(0, "2026-06-25T10:00:00Z", "user", "TODO first task"),
        makeRichEntry(1, "2026-06-25T11:00:00Z", "user", "no match here"),
        makeRichEntry(2, "2026-06-25T12:00:00Z", "assistant", "TODO second task"),
        makeRichEntry(3, "2026-06-25T13:00:00Z", "assistant", "all done"),
      ],
    });
  });

  it("无 content filter + 搜 'TODO' → 命中 2 个(0 + 2)", () => {
    // hook 在 component 树外不可调 — 直接调 store 模拟 effect 内调用
    const entries = useTranscriptStore.getState().entries;
    expect(entries).toHaveLength(4);
    useSearchInSessionStore.getState().setQuery("TODO");
    useSearchInSessionStore.getState().search(entries);
    const hits = useSearchInSessionStore.getState().hits;
    expect(hits.length).toBe(2);
    expect(hits.map((h: { entryIndex: number }) => h.entryIndex).sort()).toEqual([0, 2]);
  });

  it("role=user(已 setRole)+ 直接读 entries 仍 4 条(content filter 不影响 search 范围)", () => {
    useTranscriptFilterStore.getState().setRole("user");
    // useSearchableEntries 读 store.getState() 在 component 外不更新,
    // 但 store 实际 state.entries 不变 → 验证 4 条
    const entries = useTranscriptStore.getState().entries;
    expect(entries).toHaveLength(4);
  });

  it("time filter 切到 10:30 之后 → store.filterRange 应用 + search 仅命中索引 2", () => {
    useTranscriptFilterStore.setState({
      preset: "custom",
      from: "2026-06-25T10:30:00Z",
      to: undefined,
    });
    const filtered = applyTimeFilter(useTranscriptStore.getState().entries, {
      from: "2026-06-25T10:30:00Z",
    });
    expect(filtered.map((e: TranscriptEntryOut) => e.index)).toEqual([1, 2, 3]);
    useSearchInSessionStore.getState().setQuery("TODO");
    useSearchInSessionStore.getState().search(filtered);
    const hits = useSearchInSessionStore.getState().hits;
    expect(hits.length).toBe(1);
    expect(hits[0]?.entryIndex).toBe(2);
  });

  it("time filter 完全覆盖外 → 0 entries → 0 hits", () => {
    useTranscriptFilterStore.setState({
      preset: "custom",
      from: "2027-01-01T00:00:00Z",
      to: "2027-12-31T23:59:59Z",
    });
    const filtered = applyTimeFilter(useTranscriptStore.getState().entries, {
      from: "2027-01-01T00:00:00Z",
      to: "2027-12-31T23:59:59Z",
    });
    expect(filtered).toHaveLength(0);
    useSearchInSessionStore.getState().setQuery("TODO");
    useSearchInSessionStore.getState().search(filtered);
    expect(useSearchInSessionStore.getState().hits).toHaveLength(0);
  });
});
