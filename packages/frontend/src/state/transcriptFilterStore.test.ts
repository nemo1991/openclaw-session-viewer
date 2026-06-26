/**
 * transcriptFilterStore 单元测试
 *
 * 覆盖:
 * - 初始状态:preset="all", from/to=undefined
 * - setPreset:all → 清空, 1h/24h/7d → 计算 from (to=undefined), custom → 保留 from/to
 * - setRange:有 range → custom, 无 range → all
 * - clear:重置全部
 * - isFilterActive helper
 *
 * 用 vi.useFakeTimers() 锁住 Date.now() 让 preset 数学可预测
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useTranscriptFilterStore, isFilterActive } from "./transcriptFilterStore";

describe("transcriptFilterStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T14:00:00Z"));
    useTranscriptFilterStore.getState().clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("初始状态:preset='all', from/to=undefined", () => {
    const s = useTranscriptFilterStore.getState();
    expect(s.preset).toBe("all");
    expect(s.from).toBeUndefined();
    expect(s.to).toBeUndefined();
  });

  it("setPreset('all'):清空 from/to, preset 变 'all'", () => {
    const { setPreset, setRange } = useTranscriptFilterStore.getState();
    setRange("2026-06-25T00:00:00Z", "2026-06-25T23:59:59Z");
    setPreset("all");
    const s = useTranscriptFilterStore.getState();
    expect(s.preset).toBe("all");
    expect(s.from).toBeUndefined();
    expect(s.to).toBeUndefined();
  });

  it("setPreset('1h'):from = now - 1h, to = undefined", () => {
    const { setPreset } = useTranscriptFilterStore.getState();
    setPreset("1h");
    const s = useTranscriptFilterStore.getState();
    expect(s.preset).toBe("1h");
    expect(s.from).toBe("2026-06-25T13:00:00.000Z");
    expect(s.to).toBeUndefined();
  });

  it("setPreset('24h'):from = now - 24h", () => {
    const { setPreset } = useTranscriptFilterStore.getState();
    setPreset("24h");
    const s = useTranscriptFilterStore.getState();
    expect(s.preset).toBe("24h");
    expect(s.from).toBe("2026-06-24T14:00:00.000Z");
  });

  it("setPreset('7d'):from = now - 7d", () => {
    const { setPreset } = useTranscriptFilterStore.getState();
    setPreset("7d");
    const s = useTranscriptFilterStore.getState();
    expect(s.preset).toBe("7d");
    expect(s.from).toBe("2026-06-18T14:00:00.000Z");
  });

  it("setPreset('custom'):保留现有 from/to,只切 preset", () => {
    const { setRange, setPreset } = useTranscriptFilterStore.getState();
    setRange("2026-06-20T00:00:00Z", "2026-06-25T00:00:00Z");
    setPreset("custom");
    const s = useTranscriptFilterStore.getState();
    expect(s.preset).toBe("custom");
    expect(s.from).toBe("2026-06-20T00:00:00Z");
    expect(s.to).toBe("2026-06-25T00:00:00Z");
  });

  it("setRange(from, to):两个都给 → preset 变 custom", () => {
    const { setRange } = useTranscriptFilterStore.getState();
    setRange("2026-06-20T00:00:00Z", "2026-06-25T00:00:00Z");
    const s = useTranscriptFilterStore.getState();
    expect(s.preset).toBe("custom");
    expect(s.from).toBe("2026-06-20T00:00:00Z");
    expect(s.to).toBe("2026-06-25T00:00:00Z");
  });

  it("setRange(undefined, undefined):preset 变回 all", () => {
    const { setRange } = useTranscriptFilterStore.getState();
    setRange("2026-06-20T00:00:00Z", "2026-06-25T00:00:00Z");
    setRange(undefined, undefined);
    const s = useTranscriptFilterStore.getState();
    expect(s.preset).toBe("all");
    expect(s.from).toBeUndefined();
    expect(s.to).toBeUndefined();
  });

  it("setRange(只 from):hasRange = true → preset custom", () => {
    const { setRange } = useTranscriptFilterStore.getState();
    setRange("2026-06-20T00:00:00Z", undefined);
    const s = useTranscriptFilterStore.getState();
    expect(s.preset).toBe("custom");
    expect(s.from).toBe("2026-06-20T00:00:00Z");
    expect(s.to).toBeUndefined();
  });

  it("clear():重置全部", () => {
    const { setRange, clear } = useTranscriptFilterStore.getState();
    setRange("2026-06-20T00:00:00Z", "2026-06-25T00:00:00Z");
    clear();
    const s = useTranscriptFilterStore.getState();
    expect(s.preset).toBe("all");
    expect(s.from).toBeUndefined();
    expect(s.to).toBeUndefined();
  });
});

describe("isFilterActive helper", () => {
  beforeEach(() => {
    useTranscriptFilterStore.getState().clear();
  });

  it("preset='all' + 无 from/to → false", () => {
    expect(isFilterActive(useTranscriptFilterStore.getState())).toBe(false);
  });

  it("preset='1h' → true", () => {
    useTranscriptFilterStore.getState().setPreset("1h");
    expect(isFilterActive(useTranscriptFilterStore.getState())).toBe(true);
  });

  it("preset='all' 但设了 from → true (边界:用户手动设了范围)", () => {
    useTranscriptFilterStore.getState().setRange("2026-06-20T00:00:00Z", undefined);
    expect(isFilterActive(useTranscriptFilterStore.getState())).toBe(true);
  });
});
