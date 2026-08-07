// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useIsMac, useModifierSymbol, useModifierLabel } from "./useIsMac";

describe("useIsMac", () => {
  const originalPlatform = navigator.platform;
  const originalUA = navigator.userAgent;

  function setPlatform(platform: string, ua: string) {
    Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
    Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
  }

  afterEach(() => {
    setPlatform(originalPlatform, originalUA);
  });

  it("returns true on Mac platform", () => {
    setPlatform("MacIntel", "Mozilla/5.0 (Macintosh)");
    const { result } = renderHook(() => useIsMac());
    expect(result.current).toBe(true);
  });

  it("returns true on iPhone UA", () => {
    setPlatform("", "Mozilla/5.0 (iPhone)");
    const { result } = renderHook(() => useIsMac());
    expect(result.current).toBe(true);
  });

  it("returns false on Windows", () => {
    setPlatform("Win32", "Mozilla/5.0 (Windows)");
    const { result } = renderHook(() => useIsMac());
    expect(result.current).toBe(false);
  });

  it("returns false on Linux", () => {
    setPlatform("Linux x86_64", "Mozilla/5.0 (X11; Linux)");
    const { result } = renderHook(() => useIsMac());
    expect(result.current).toBe(false);
  });

  it("useModifierSymbol returns ⌘ on Mac", () => {
    setPlatform("MacIntel", "Mozilla/5.0 (Macintosh)");
    const { result } = renderHook(() => useModifierSymbol());
    expect(result.current).toBe("⌘");
  });

  it("useModifierSymbol returns Ctrl on Windows", () => {
    setPlatform("Win32", "Mozilla/5.0 (Windows)");
    const { result } = renderHook(() => useModifierSymbol());
    expect(result.current).toBe("Ctrl");
  });

  it("useModifierLabel returns Cmd on Mac", () => {
    setPlatform("MacIntel", "Mozilla/5.0 (Macintosh)");
    const { result } = renderHook(() => useModifierLabel());
    expect(result.current).toBe("Cmd");
  });

  it("useModifierLabel returns Ctrl on Windows", () => {
    setPlatform("Win32", "Mozilla/5.0 (Windows)");
    const { result } = renderHook(() => useModifierLabel());
    expect(result.current).toBe("Ctrl");
  });
});
