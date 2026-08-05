// @vitest-environment jsdom
/**
 * v0.8.14 item E: SearchPalette 历史记录 spam 修复
 *
 * 老实现: deps [debouncedQuery, hits.length, searching] 的 useEffect 每次
 * search 完成都重置 500ms timer。typing "claude code" (8 chars) → 8 次
 * search 完成 → 8 次 setTimeout(虽然 cleanup 会 cancel 旧 timer,但 race 边界
 * 仍可能 fire 多次)。每条 query 都会被记录一次,history 被噪音灌满。
 *
 * 新实现: 移除自动 record effect,只在 Enter 提交时记录一次 (useKey handler 内)。
 *
 * 测试锁住:
 * - typing 期间不调 apiRecordSearch
 * - Enter (hits > 0) 调一次 apiRecordSearch + reload history
 * - Enter 但 hits = 0 不调 apiRecordSearch
 * - Enter 空 query 不调 apiRecordSearch
 * - history 在 mount 时拉一次 (apiListSearchHistory)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

import { SearchPalette } from "./SearchPalette";
import { useSearchStore } from "../state/searchStore";
import type { GlobalSearchHitOut } from "../lib/api";

// ===== Mock overridesApi =====
const mockRecordSearch = vi.fn();
const mockListSearchHistory = vi.fn();
vi.mock("../lib/overridesApi", () => ({
  apiRecordSearch: (query: string, hitCount: number) => mockRecordSearch(query, hitCount),
  apiListSearchHistory: (limit: number) => mockListSearchHistory(limit),
}));

// ===== Mock i18n =====
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { language: "en" },
  }),
}));

// 拦截真 useSearchStore.search → no-op,避免 search effect 调 search() 时
// 清掉我们手动 setState 的 hits。真 store 其他部分(open/query/hits) 保留。
// 实现:把 search 替换成 vi.fn 即可(setState 直接覆盖)。
// zustand store 的方法可以单独 set:
const mockSearch = vi.fn(async (_q: string) => {
  /* noop:测试不走真搜索路径,hits 直接 setState */
});
const mockHide = vi.fn();

function setup() {
  // Reset search action override before each test
  useSearchStore.setState({ search: mockSearch as never, hide: mockHide as never });
  return render(
    <MemoryRouter
      initialEntries={["/"]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <Routes>
        <Route path="/" element={<SearchPalette />} />
        <Route path="/session/:sessionId" element={<div data-testid="session-detail" />} />
      </Routes>
    </MemoryRouter>
  );
}

function resetStore() {
  mockRecordSearch.mockReset();
  mockRecordSearch.mockResolvedValue(undefined);
  mockListSearchHistory.mockReset();
  mockListSearchHistory.mockResolvedValue([]);
  mockSearch.mockClear();
  mockHide.mockClear();
  useSearchStore.setState({
    open: true,
    query: "",
    hits: [] as GlobalSearchHitOut[],
    searching: false,
  });
}

describe("SearchPalette v0.8.14 item E: history spam 修复", () => {
  beforeEach(() => {
    resetStore();
  });

  it("typing 不触发 apiRecordSearch(老 bug 锁住)", async () => {
    setup();

    // 等 mount effect 跑完 (history load)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockRecordSearch).not.toHaveBeenCalled();

    // 模拟 typing 8 chars 通过 store 的 setQuery。
    // 老 bug 会在每次 [debouncedQuery, hits.length, searching] 变化时启 500ms timer
    // 新实现应该一次都不调 record
    act(() => {
      useSearchStore.setState({
        query: "c",
      });
    });
    act(() => {
      useSearchStore.setState({ query: "cl" });
    });
    act(() => {
      useSearchStore.setState({ query: "cla" });
    });
    act(() => {
      useSearchStore.setState({ query: "clau" });
    });
    act(() => {
      useSearchStore.setState({ query: "claud" });
    });
    act(() => {
      useSearchStore.setState({ query: "claude" });
    });
    act(() => {
      useSearchStore.setState({ query: "claude " });
    });
    act(() => {
      useSearchStore.setState({ query: "claude c" });
    });

    // 等 debounce (300ms) + 老 timer (500ms) — 1s 足够覆盖所有 race window
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1100));
    });

    expect(mockRecordSearch).not.toHaveBeenCalled();
  });

  it("Enter (hits > 0) 调一次 apiRecordSearch + navigate + hide", async () => {
    setup();

    // 等 mount effect
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // 设置 store 状态:有 hits + query (模拟 search 完成后)
    await act(async () => {
      useSearchStore.setState({
        query: "claude",
        hits: [
          {
            sessionId: "sess-1",
            sessionPath: "/tmp/s1.jsonl",
            title: "Claude test",
            projectKey: "/tmp",
            workspaceGuess: null,
            source: "claude",
            hit: {
              sessionPath: "/tmp/s1.jsonl",
              sessionId: "sess-1",
              index: 0,
              snippet: "claude is great",
              byteOffset: 0,
              charOffset: 0,
            },
          },
        ],
        searching: false,
      });
    });

    // 等 300ms debounce 把 component-local debouncedQuery 同步成 "claude"
    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    // 直接 fire Enter — useKey("enter", handler) 内部 addEventListener("keydown")
    // 监听 window,所以 fireEvent.keyDown(window, { key: "Enter" }) 能触发
    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter" });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockRecordSearch).toHaveBeenCalledTimes(1);
    expect(mockRecordSearch).toHaveBeenCalledWith("claude", 1);

    // record 完会 reload history
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mockListSearchHistory).toHaveBeenCalled();

    // 也应该 hide (navigate 由 MemoryRouter 真实处理)
    expect(mockHide).toHaveBeenCalled();
  });

  it("Enter 但 hits = 0 不调 apiRecordSearch", async () => {
    setup();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      useSearchStore.setState({
        query: "no match",
        hits: [],
        searching: false,
      });
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter" });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockRecordSearch).not.toHaveBeenCalled();
    expect(mockHide).not.toHaveBeenCalled();
  });

  it("Enter 空 query 不调 apiRecordSearch", async () => {
    setup();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    await act(async () => {
      useSearchStore.setState({
        query: "",
        hits: [
          {
            sessionId: "sess-1",
            sessionPath: "/tmp/s1.jsonl",
            title: "anything",
            projectKey: "/tmp",
            workspaceGuess: null,
            source: "claude",
            hit: {
              sessionPath: "/tmp/s1.jsonl",
              sessionId: "sess-1",
              index: 0,
              snippet: "x",
              byteOffset: 0,
              charOffset: 0,
            },
          },
        ],
        searching: false,
      });
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 350));
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: "Enter" });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockRecordSearch).not.toHaveBeenCalled();
  });

  it("mount 时拉一次 history (apiListSearchHistory)", async () => {
    mockListSearchHistory.mockResolvedValueOnce([{ id: 1, query: "prev", hitCount: 3, ts: 1000 }]);

    setup();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockListSearchHistory).toHaveBeenCalledTimes(1);
    expect(mockListSearchHistory).toHaveBeenCalledWith(10);
  });

  it("Escape 调 hide()(回归覆盖,不是 Item E 直接修复)", async () => {
    setup();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(useSearchStore.getState().open).toBe(true);

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mockHide).toHaveBeenCalled();
    expect(mockRecordSearch).not.toHaveBeenCalled();
  });
});
