/**
 * v0.8.4 item 1: HomeStatusBar pill + expand panel
 * v0.8.5: SyncBanner 合入 pill — 测 sync-progress 事件驱动 pill
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as overridesApi from "../lib/overridesApi";

// 捕获 listen() 回调, 测试中直接 emit sync-progress 模拟后端事件
let progressListener: ((e: { payload: unknown }) => void) | null = null;
let updatedListener: ((e: { payload: unknown }) => void) | null = null;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, cb: (e: { payload: unknown }) => void) => {
    if (event === "sync-progress") progressListener = cb;
    else if (event === "sessions-updated") updatedListener = cb;
    return Promise.resolve(() => {
      if (event === "sync-progress") progressListener = null;
      else if (event === "sessions-updated") updatedListener = null;
    });
  }),
}));

import { HomeStatusBar } from "./HomeStatusBar";

const mockApiGetSyncStatus = vi.spyOn(overridesApi, "apiGetSyncStatus");
const mockApiGetDbPath = vi.spyOn(overridesApi, "apiGetDbPath");
const mockApiRebuildDb = vi.spyOn(overridesApi, "apiRebuildDb");

function emitProgress(payload: Record<string, unknown>) {
  act(() => {
    progressListener?.({ payload });
  });
}

beforeEach(() => {
  cleanup();
  progressListener = null;
  updatedListener = null;
  mockApiGetSyncStatus.mockReset();
  mockApiGetDbPath.mockReset();
  mockApiRebuildDb.mockReset();
  // 默认: 30s 前 sync 成功, 无错
  mockApiGetSyncStatus.mockResolvedValue({
    lastRunAt: Date.now() - 30_000,
    lastError: null,
    filesSeen: 50,
    filesSynced: 50,
    inProgress: false,
  });
  mockApiGetDbPath.mockResolvedValue("/Users/test/observer.db");
  mockApiRebuildDb.mockResolvedValue(undefined);
});

describe("v0.8.4 HomeStatusBar", () => {
  it("默认 pill 可见, 显示 age + synced/seen 计数", async () => {
    render(<HomeStatusBar />);
    const pill = await screen.findByTestId("home-status-pill");
    expect(pill).toBeInTheDocument();
    expect(pill.textContent).toMatch(/30s ago/);
    expect(pill.textContent).toMatch(/50\/50 synced/);
    expect(screen.queryByTestId("home-status-panel")).toBeNull();
  });

  it("green freshness: 最近 sync (<60s)", async () => {
    mockApiGetSyncStatus.mockResolvedValue({
      lastRunAt: Date.now() - 10_000,
      lastError: null,
      filesSeen: 5,
      filesSynced: 5,
      inProgress: false,
    });
    const { container } = render(<HomeStatusBar />);
    await screen.findByTestId("home-status-pill");
    expect(container.querySelector(".home-status-bar")!.getAttribute("data-freshness")).toBe("ok");
  });

  it("yellow freshness: 1-10 min stale", async () => {
    mockApiGetSyncStatus.mockResolvedValue({
      lastRunAt: Date.now() - 5 * 60_000,
      lastError: null,
      filesSeen: 5,
      filesSynced: 5,
      inProgress: false,
    });
    const { container } = render(<HomeStatusBar />);
    await screen.findByTestId("home-status-pill");
    expect(container.querySelector(".home-status-bar")!.getAttribute("data-freshness")).toBe(
      "stale"
    );
  });

  it("red freshness: lastError 非空", async () => {
    mockApiGetSyncStatus.mockResolvedValue({
      lastRunAt: Date.now() - 30_000,
      lastError: "sync failed: IO error",
      filesSeen: 5,
      filesSynced: 3,
      inProgress: false,
    });
    const { container } = render(<HomeStatusBar />);
    await screen.findByTestId("home-status-pill");
    expect(container.querySelector(".home-status-bar")!.getAttribute("data-freshness")).toBe(
      "error"
    );
  });

  it("blue freshness: status inProgress === true", async () => {
    mockApiGetSyncStatus.mockResolvedValue({
      lastRunAt: Date.now() - 1000,
      lastError: null,
      filesSeen: 100,
      filesSynced: 20,
      inProgress: true,
    });
    const { container } = render(<HomeStatusBar />);
    await screen.findByTestId("home-status-pill");
    expect(container.querySelector(".home-status-bar")!.getAttribute("data-freshness")).toBe(
      "syncing"
    );
  });

  it("点 pill 展开 → 显示 last sync / files / DB path / 重建按钮", async () => {
    render(<HomeStatusBar />);
    const pill = await screen.findByTestId("home-status-pill");
    await userEvent.click(pill);
    const panel = screen.getByTestId("home-status-panel");
    expect(panel).toBeInTheDocument();
    expect(panel.textContent).toMatch(/Last sync/);
    expect(panel.textContent).toMatch(/Files/);
    expect(panel.textContent).toMatch(/DB path/);
    expect(panel.textContent).toMatch(/\/Users\/test\/observer\.db/);
    expect(screen.getByTestId("home-status-rebuild")).toBeInTheDocument();
  });

  it("点 pill 再点 → 收起", async () => {
    render(<HomeStatusBar />);
    const pill = await screen.findByTestId("home-status-pill");
    await userEvent.click(pill);
    expect(screen.queryByTestId("home-status-panel")).toBeInTheDocument();
    await userEvent.click(pill);
    expect(screen.queryByTestId("home-status-panel")).toBeNull();
  });
});

describe("v0.8.5 sync-progress → pill live state", () => {
  it("scan 阶段: pill 显示'扫描中' + scanning freshness", async () => {
    render(<HomeStatusBar />);
    await screen.findByTestId("home-status-pill");
    emitProgress({ phase: "scanning" });
    expect(screen.getByTestId("home-status-pill-text").textContent).toMatch(/扫描中/);
    const bar = document.querySelector(".home-status-bar")!;
    expect(bar.getAttribute("data-freshness")).toBe("scanning");
    expect(bar.getAttribute("data-live")).toBe("scanning");
  });

  it("sync 阶段: pill 显示'同步 N/M' + 当前文件名尾部", async () => {
    render(<HomeStatusBar />);
    await screen.findByTestId("home-status-pill");
    emitProgress({
      phase: "syncing",
      total: 50,
      done: 12,
      failed: 0,
      current_file: "/Users/test/sessions/abc.jsonl",
    });
    const text = screen.getByTestId("home-status-pill-text").textContent!;
    expect(text).toMatch(/同步 12\/50/);
    expect(text).toMatch(/sessions\/abc\.jsonl/); // 后两段
  });

  it("done 阶段: pill 显示'✓ 同步完成 N/M', 2s 后回落", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<HomeStatusBar />);
      await screen.findByTestId("home-status-pill");
      emitProgress({ phase: "syncing", total: 50, done: 30, failed: 0 });
      emitProgress({ phase: "done", total: 50, done: 50, failed: 2 });
      // done 短暂绿
      const bar = document.querySelector(".home-status-bar")!;
      expect(bar.getAttribute("data-live")).toBe("done");
      expect(screen.getByTestId("home-status-pill-text").textContent).toMatch(/同步完成 50\/50/);
      expect(screen.getByTestId("home-status-pill-text").textContent).toMatch(/2 failed/);
      // 等 done 回落 (2s + 一帧微任务)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
        // 让 setTimeout 回调里 promise (apiGetSyncStatus) 的 microtask flush
        await Promise.resolve();
      });
      expect(bar.getAttribute("data-live")).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("error 阶段: pill 持续显示红色失败信息", async () => {
    render(<HomeStatusBar />);
    await screen.findByTestId("home-status-pill");
    emitProgress({ phase: "error", message: "disk full" });
    const bar = document.querySelector(".home-status-bar")!;
    expect(bar.getAttribute("data-live")).toBe("error");
    expect(bar.getAttribute("data-freshness")).toBe("live-error");
    expect(screen.getByTestId("home-status-pill-text").textContent).toMatch(/同步失败/);
    expect(screen.getByTestId("home-status-pill-text").textContent).toMatch(/disk full/);
  });
});
