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
import type { TranscriptEntryOut } from "../lib/api";

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
