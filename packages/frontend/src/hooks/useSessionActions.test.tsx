/**
 * v0.9.24 (M7-A): useSessionActions 单元测试
 *
 * 覆盖:
 * - handleReload 触发 sessions store refresh + transcript reset + start
 * - handleReload metad 不存在 → 早 return
 * - handleReload 已经在 reload → 早 return
 * - handleExport → save dialog + apiExport + reveal
 * - handleExport save 取消 → 早 return
 * - reloadModifier 来自 useModifierLabel
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSessionActions } from "./useSessionActions";
import { useSessionsStore } from "../state/sessionsStore";
import { useTranscriptStore } from "../state/transcriptStore";
import type { SessionMeta } from "@ocsv/shared";

// Mock apiExportMarkdown / apiExportHtml / apiRevealInFinder
vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    apiExportMarkdown: vi.fn(),
    apiExportHtml: vi.fn(),
    apiRevealInFinder: vi.fn(),
  };
});

// Mock @tauri-apps/plugin-dialog
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

// Mock useModifierLabel
vi.mock("./useIsMac", () => ({
  useModifierLabel: () => "Cmd" as const,
}));

// @vitest-environment jsdom

const fakeMeta: SessionMeta = {
  sessionId: "s1",
  projectKey: "p1",
  workspaceGuess: "/tmp",
  source: "claude",
  jsonlPath: "/tmp/s1.jsonl",
  sizeBytes: 1024,
  mtimeMs: 0,
  messageCount: 5,
  title: "Test Session",
  hasTrajectory: false,
};

const defaultCtx = {
  meta: fakeMeta,
  targetPath: "/tmp/s1.jsonl",
  sessionId: "s1",
  navigate: vi.fn(),
  pathnameSearch: "/session/s1",
};

describe("useSessionActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionsStore.setState({ sessions: [], refresh: vi.fn(async () => {}) });
    useTranscriptStore.setState({ path: null, entries: [], loading: false });
  });

  it("handleReload 触发 sessions.refresh + transcript reset + start", async () => {
    const refresh = vi.fn(async () => {});
    useSessionsStore.setState({
      sessions: [{ ...fakeMeta } as SessionMeta],
      refresh,
    });
    useTranscriptStore.setState({
      path: "/tmp/s1.jsonl",
      entries: [],
      loading: false,
    });

    const resetSpy = vi.spyOn(useTranscriptStore.getState(), "reset");
    const startSpy = vi.fn(async () => {});
    // Override start
    useTranscriptStore.setState({ start: startSpy as never });

    const { result } = renderHook(() => useSessionActions(defaultCtx));

    await act(async () => {
      await result.current.handleReload();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(resetSpy).toHaveBeenCalled();
    expect(startSpy).toHaveBeenCalledWith("/tmp/s1.jsonl");
    expect(defaultCtx.navigate).toHaveBeenCalledWith("/session/s1", {
      state: { session: fakeMeta },
      replace: true,
    });
  });

  it("handleReload 没 meta → 早 return", async () => {
    const refresh = vi.fn(async () => {});
    useSessionsStore.setState({ refresh });

    const { result } = renderHook(() => useSessionActions({ ...defaultCtx, meta: undefined }));

    await act(async () => {
      await result.current.handleReload();
    });

    expect(refresh).not.toHaveBeenCalled();
  });

  it("handleReload reloading 状态 → 早 return", async () => {
    // 故意让 refresh 永远 pending, 模拟 reloading 状态持续
    const refresh = vi.fn(() => new Promise<void>(() => {}));
    useSessionsStore.setState({ refresh });
    useSessionsStore.setState({
      sessions: [{ ...fakeMeta } as SessionMeta],
    });

    const { result } = renderHook(() => useSessionActions(defaultCtx));

    // 触发第一次 reload (进入 reloading=true 但永不 resolve)
    act(() => {
      void result.current.handleReload();
    });

    // 等待 React 调度 re-render (setReloading(true) 之后)
    // 等 microtask flush
    await act(async () => {
      await Promise.resolve();
    });

    // 第二次 reload 应该 no-op (reloading=true)
    await act(async () => {
      await result.current.handleReload();
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("handleExport 触发 save dialog + apiExport + reveal", async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { apiExportMarkdown, apiRevealInFinder } = await import("../lib/api");
    (save as ReturnType<typeof vi.fn>).mockResolvedValue("/tmp/out.md");
    (apiExportMarkdown as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (apiRevealInFinder as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const { result } = renderHook(() => useSessionActions(defaultCtx));

    await act(async () => {
      await result.current.handleExport("md");
    });

    expect(save).toHaveBeenCalledWith({
      defaultPath: "Test Session.md",
      filters: [{ name: "MD", extensions: ["md"] }],
    });
    expect(apiExportMarkdown).toHaveBeenCalledWith("/tmp/s1.jsonl", "/tmp/out.md");
    expect(apiRevealInFinder).toHaveBeenCalledWith("/tmp/out.md", null, true);
  });

  it("handleExport save dialog 取消 → 早 return", async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { apiExportMarkdown } = await import("../lib/api");
    (save as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const { result } = renderHook(() => useSessionActions(defaultCtx));

    await act(async () => {
      await result.current.handleExport("md");
    });

    expect(apiExportMarkdown).not.toHaveBeenCalled();
  });

  it("handleExport 没 targetPath → 早 return", async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { result } = renderHook(() =>
      useSessionActions({ ...defaultCtx, targetPath: undefined })
    );

    await act(async () => {
      await result.current.handleExport("md");
    });

    expect(save).not.toHaveBeenCalled();
  });

  it("reloadModifier 默认 mock 为 Cmd", () => {
    const { result } = renderHook(() => useSessionActions(defaultCtx));
    expect(result.current.reloadModifier).toBe("Cmd");
  });
});
