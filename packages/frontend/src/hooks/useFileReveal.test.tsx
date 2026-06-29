// @vitest-environment jsdom
/**
 * useFileReveal hook 单元测试 (v0.6.0)
 *
 * 覆盖:
 * - 成功 reveal → 调 apiRevealInFinder(path, workspaceRoot, allowRelaxed)
 * - 失败 → revealAndNotify 返回 { ok: false, error }
 * - settings.pathSecurity.allowRelaxed=true → 传 true 给后端
 * - settings.pathSecurity.allowRelaxed=false (默认) → 传 false
 * - settings 缺失 pathSecurity → fallback false (lock-down)
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useFileReveal } from "./useFileReveal";
import * as api from "../lib/api";
import { useSettingsStore } from "../state/settingsStore";
import { DEFAULT_SETTINGS } from "@ocsv/shared";

const mockInvoke = vi.spyOn(api, "apiRevealInFinder");
const mockExtractError = api.extractErrorMessage;

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      pathSecurity: { allowRelaxed: false },
      defaultExportDir: "/Users/test/workspace",
    },
  });
});

describe("useFileReveal", () => {
  it("默认 lock-down 模式: 传 allowRelaxed=false", async () => {
    mockInvoke.mockResolvedValue(undefined);
    const { result } = renderHook(() => useFileReveal());
    await act(async () => {
      await result.current.revealAndNotify("/Users/test/workspace/src/foo.ts");
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "/Users/test/workspace/src/foo.ts",
      "/Users/test/workspace",
      false
    );
  });

  it("allowRelaxed=true: 传 true 给后端", async () => {
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        pathSecurity: { allowRelaxed: true },
        defaultExportDir: "/Users/test/workspace",
      },
    });
    mockInvoke.mockResolvedValue(undefined);
    const { result } = renderHook(() => useFileReveal());
    await act(async () => {
      await result.current.revealAndNotify("/Users/foo/other.jsonl");
    });
    expect(mockInvoke).toHaveBeenCalledWith(
      "/Users/foo/other.jsonl",
      "/Users/test/workspace",
      true
    );
  });

  it("成功 → revealAndNotify 返回 { ok: true }", async () => {
    mockInvoke.mockResolvedValue(undefined);
    const { result } = renderHook(() => useFileReveal());
    let res: { ok: boolean; error?: string } | undefined;
    await act(async () => {
      res = await result.current.revealAndNotify("/tmp/foo.txt");
    });
    expect(res).toEqual({ ok: true });
  });

  it("后端返回 PathSecurity 错误 → revealAndNotify 返回 { ok: false, error }", async () => {
    mockInvoke.mockRejectedValue(new Error("PathSecurity: 路径不在 workspace 内"));
    const { result } = renderHook(() => useFileReveal());
    let res: { ok: boolean; error?: string } | undefined;
    await act(async () => {
      res = await result.current.revealAndNotify("/etc/passwd");
    });
    expect(res?.ok).toBe(false);
    expect(res?.error).toContain("PathSecurity");
    expect(res?.error).toContain("workspace");
  });

  it("settings 缺失 pathSecurity → fallback 到 lock-down", async () => {
    useSettingsStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        pathSecurity: undefined,
        defaultExportDir: "/Users/test/workspace",
      },
    });
    mockInvoke.mockResolvedValue(undefined);
    const { result } = renderHook(() => useFileReveal());
    await act(async () => {
      await result.current.revealAndNotify("/Users/test/workspace/file.txt");
    });
    expect(mockInvoke).toHaveBeenCalledWith(expect.any(String), "/Users/test/workspace", false);
  });

  it("reveal() 静默吞错误(不抛 Promise rejection)", async () => {
    mockInvoke.mockRejectedValue(new Error("PathSecurity: nope"));
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useFileReveal());
    await act(async () => {
      await result.current.reveal("/etc/passwd");
    });
    // console.warn 由调用方负责(reveal 内部不输出, 留给 UI)
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});

void mockExtractError; // 保留 import 引用
