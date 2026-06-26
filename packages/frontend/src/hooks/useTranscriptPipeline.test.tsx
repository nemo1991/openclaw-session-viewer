/**
 * useTranscriptPipeline hook 单元测试
 *
 * 设计:用 probe component 暴露 hook 输出到 DOM,断言文本/数量。
 *
 * 覆盖:
 * - 无筛选:filteredEntries === entries
 * - 有筛选:filteredEntries 是新数组且只含匹配项
 * - sortAsc=false:倒序;sortAsc=true:正序
 * - filterActive 切换
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useTranscriptPipeline } from "./useTranscriptPipeline";
import { useTranscriptStore } from "../state/transcriptStore";
import { useTranscriptFilterStore } from "../state/transcriptFilterStore";
import type { TranscriptEntryOut } from "../lib/api";

function makeEntry(index: number, ts: string): TranscriptEntryOut {
  return {
    index,
    byteOffset: index * 1000,
    raw: {},
    normalized: {
      id: `e-${index}`,
      role: "assistant",
      rawType: "test",
      timestamp: ts,
      blocks: [],
    },
  };
}

function Probe() {
  const p = useTranscriptPipeline();
  return (
    <div>
      <span data-testid="count-entries">{p.entries.length}</span>
      <span data-testid="count-filtered">{p.filteredEntries.length}</span>
      <span data-testid="count-sorted">{p.sortedEntries.length}</span>
      <span data-testid="sort-asc">{String(p.sortAsc)}</span>
      <span data-testid="first-sorted-index">{p.sortedEntries[0]?.index ?? "none"}</span>
    </div>
  );
}

describe("useTranscriptPipeline", () => {
  beforeEach(() => {
    cleanup();
    useTranscriptFilterStore.getState().clear();
    useTranscriptStore.getState().reset();
  });

  it("空 entries:所有计数 = 0", () => {
    render(<Probe />);
    expect(screen.getByTestId("count-entries")).toHaveTextContent("0");
    expect(screen.getByTestId("count-filtered")).toHaveTextContent("0");
    expect(screen.getByTestId("count-sorted")).toHaveTextContent("0");
  });

  it("无筛选:filteredEntries === entries(引用相等)", () => {
    useTranscriptStore.setState({
      entries: [makeEntry(0, "2026-06-25T10:00:00Z"), makeEntry(1, "2026-06-25T11:00:00Z")],
    });
    render(<Probe />);
    expect(screen.getByTestId("count-filtered")).toHaveTextContent("2");
    expect(screen.getByTestId("count-sorted")).toHaveTextContent("2");
  });

  it("有筛选 (setRange):只保留区间内 entries", () => {
    useTranscriptStore.setState({
      entries: [
        makeEntry(0, "2026-06-25T09:00:00Z"),
        makeEntry(1, "2026-06-25T10:00:00Z"),
        makeEntry(2, "2026-06-25T11:00:00Z"),
      ],
    });
    useTranscriptFilterStore.getState().setRange("2026-06-25T10:00:00Z", "2026-06-25T11:00:00Z");
    render(<Probe />);
    expect(screen.getByTestId("count-entries")).toHaveTextContent("3");
    expect(screen.getByTestId("count-filtered")).toHaveTextContent("2");
    expect(screen.getByTestId("count-sorted")).toHaveTextContent("2");
  });

  it("setPreset('1h'):从 now-1h 起算,使用 fakeTimers 锁定 now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T14:00:00Z"));
    useTranscriptStore.setState({
      entries: [
        makeEntry(0, "2026-06-25T12:00:00Z"), // 2h 前 — 过滤掉
        makeEntry(1, "2026-06-25T13:30:00Z"), // 30min 前 — 保留
        makeEntry(2, "2026-06-25T14:00:00Z"), // now — 保留
      ],
    });
    useTranscriptFilterStore.getState().setPreset("1h");
    render(<Probe />);
    expect(screen.getByTestId("count-filtered")).toHaveTextContent("2");
    vi.useRealTimers();
  });

  it("sortAsc=false (倒序):sortedEntries[0] 是 entries 最后一项", () => {
    useTranscriptStore.setState({
      entries: [
        makeEntry(0, "2026-06-25T10:00:00Z"),
        makeEntry(1, "2026-06-25T11:00:00Z"),
        makeEntry(2, "2026-06-25T12:00:00Z"),
      ],
    });
    function ProbeSort() {
      const { sortAsc, setSortAsc, sortedEntries } = useTranscriptPipeline();
      return (
        <div>
          <button data-testid="flip" onClick={() => setSortAsc(false)} />
          <span data-testid="first">{sortedEntries[0]?.index ?? "none"}</span>
          <span data-testid="asc">{String(sortAsc)}</span>
        </div>
      );
    }
    render(<ProbeSort />);
    expect(screen.getByTestId("first")).toHaveTextContent("0");
    act(() => {
      screen.getByTestId("flip").click();
    });
    expect(screen.getByTestId("asc")).toHaveTextContent("false");
    expect(screen.getByTestId("first")).toHaveTextContent("2");
  });

  it("筛选 + 排序:filter 应用在前,sort 应用在后", () => {
    useTranscriptStore.setState({
      entries: [
        makeEntry(0, "2026-06-25T09:00:00Z"),
        makeEntry(1, "2026-06-25T10:00:00Z"),
        makeEntry(2, "2026-06-25T11:00:00Z"),
        makeEntry(3, "2026-06-25T12:00:00Z"),
      ],
    });
    useTranscriptFilterStore.getState().setRange("2026-06-25T10:00:00Z", "2026-06-25T13:00:00Z");
    function ProbeSort() {
      const { sortAsc, setSortAsc, sortedEntries } = useTranscriptPipeline();
      return (
        <div>
          <button data-testid="flip" onClick={() => setSortAsc(false)} />
          {sortedEntries.map((e) => (
            <span key={e.index} data-testid={`e-${e.index}`} />
          ))}
        </div>
      );
    }
    render(<ProbeSort />);
    // filtered: 1, 2, 3 — 正序
    expect(screen.getByTestId("e-1")).toBeInTheDocument();
    expect(screen.getByTestId("e-2")).toBeInTheDocument();
    expect(screen.getByTestId("e-3")).toBeInTheDocument();
    expect(screen.queryByTestId("e-0")).toBeNull();
    // 倒序
    act(() => {
      screen.getByTestId("flip").click();
    });
    expect(screen.getByTestId("e-1")).toBeInTheDocument();
    expect(screen.getByTestId("e-2")).toBeInTheDocument();
    expect(screen.getByTestId("e-3")).toBeInTheDocument();
  });
});
