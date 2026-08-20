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
  // v0.9.28 (M11.2): mount 默认乐观显示 "扫描中…" (避免 250ms race 期间 pill 停留在 idle),
  // 真实 sync-progress 事件到达后覆盖。下面 5 个测试都断言初始 freshness=scanning,
  // freshness 反映 status 的 case 由 "v0.8.5 sync-progress → pill live state" describe 块覆盖
  // (它们显式 emit 事件把 live 从 scanning 切到目标态)。

  it("默认 pill 可见, 乐观显示 '扫描中…'", async () => {
    render(<HomeStatusBar />);
    const pill = await screen.findByTestId("home-status-pill");
    expect(pill).toBeInTheDocument();
    expect(pill.textContent).toMatch(/扫描中/);
    const bar = document.querySelector(".home-status-bar")!;
    expect(bar.getAttribute("data-freshness")).toBe("scanning");
    expect(bar.getAttribute("data-live")).toBe("scanning");
    expect(screen.queryByTestId("home-status-panel")).toBeNull();
  });

  it("v0.9.28 (M11.2): 乐观 scanning 默认被 sync-progress 事件覆盖 → 回落 idle", async () => {
    // 完整生命周期: mount → optimistic scanning → done event → 2s 后回落 idle
    // 这是用户首次开 app 看到的视觉路径,验证 optimistic 状态能被真实事件正确覆盖。
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<HomeStatusBar />);
      const pill = await screen.findByTestId("home-status-pill");
      const bar = document.querySelector(".home-status-bar")!;
      // mount: 乐观 scanning
      expect(bar.getAttribute("data-live")).toBe("scanning");
      expect(screen.getByTestId("home-status-pill-text").textContent).toMatch(/扫描中/);
      // done 事件覆盖 → 显示 "同步完成"
      emitProgress({ phase: "done", total: 50, done: 50, failed: 0 });
      expect(bar.getAttribute("data-live")).toBe("done");
      expect(screen.getByTestId("home-status-pill-text").textContent).toMatch(/同步完成 50\/50/);
      // 2s 后回落 idle
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
        await Promise.resolve();
      });
      expect(bar.getAttribute("data-live")).toBe("idle");
      // 回落 idle 后 buildPillText 退回 status 分支,显示 "30s ago · 50/50 synced" (允许 ±2s 误差)
      expect(screen.getByTestId("home-status-pill-text").textContent).toMatch(/\d+s ago/);
      expect(screen.getByTestId("home-status-pill-text").textContent).toMatch(/50\/50 synced/);
      // 不应误触发 panel 展开
      expect(screen.queryByTestId("home-status-panel")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("green freshness: 最近 sync (<60s) → optimistic scanning 期间覆盖 status 新鲜度", async () => {
    // v0.9.28 (M11.2): mount 默认 live=scanning 优先于 status 新鲜度。
    // 这个测试只断言 optimistic 状态生效;真实 status 新鲜度在 done 回落 idle 后
    // 由 "v0.8.5 sync-progress → pill live state" describe 块里 done → idle 路径验证。
    mockApiGetSyncStatus.mockResolvedValue({
      lastRunAt: Date.now() - 10_000,
      lastError: null,
      filesSeen: 5,
      filesSynced: 5,
      inProgress: false,
    });
    const { container } = render(<HomeStatusBar />);
    await screen.findByTestId("home-status-pill");
    expect(container.querySelector(".home-status-bar")!.getAttribute("data-freshness")).toBe(
      "scanning"
    );
  });

  it("yellow freshness: 1-10 min stale → optimistic scanning 覆盖 status", async () => {
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
      "scanning"
    );
  });

  it("red freshness: lastError 非空 → optimistic scanning 覆盖 status", async () => {
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
      "scanning"
    );
  });

  it("blue freshness: status inProgress === true → optimistic scanning 覆盖 status", async () => {
    mockApiGetSyncStatus.mockResolvedValue({
      lastRunAt: Date.now() - 1000,
      lastError: null,
      filesSeen: 100,
      filesSynced: 20,
      inProgress: true,
    });
    const { container } = render(<HomeStatusBar />);
    await screen.findByTestId("home-status-pill");
    // mount 后 live=scanning 优先;emit syncing 切到 syncing 后才能反映 status.inProgress
    expect(container.querySelector(".home-status-bar")!.getAttribute("data-freshness")).toBe(
      "scanning"
    );
    emitProgress({ phase: "syncing", total: 100, done: 20, failed: 0 });
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

  it("v0.8.13 partial_error 阶段: pill 显示 ⚠ + '完成 X/Y · N 失败' (不是绿色 ✓)", async () => {
    // v0.8.13 item E: 后端 failed > 0 时发 phase:"partial_error",前端必须渲染 ⚠
    // 而不是绿色 ✓,避免把部分失败误判为同步成功。
    render(<HomeStatusBar />);
    await screen.findByTestId("home-status-pill");
    emitProgress({ phase: "syncing", total: 50, done: 30, failed: 0 });
    emitProgress({ phase: "partial_error", total: 50, done: 48, failed: 2 });
    const bar = document.querySelector(".home-status-bar")!;
    expect(bar.getAttribute("data-live")).toBe("partial_error");
    expect(bar.getAttribute("data-freshness")).toBe("partial_error");
    // icon ⚠ 在 .home-status-pill-icon span 里(text span 不含 icon)
    const iconEl = document.querySelector(".home-status-pill-icon");
    expect(iconEl?.textContent).toMatch(/⚠/);
    const text = screen.getByTestId("home-status-pill-text").textContent!;
    expect(text).toMatch(/同步完成 48\/50/);
    expect(text).toMatch(/2 失败/);
    await userEvent.click(screen.getByTestId("home-status-pill"));
    expect(screen.getByTestId("home-status-panel").textContent).toMatch(/Partial error/);
  });
});
