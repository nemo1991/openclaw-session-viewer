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

// ===== v0.7.0: content filter integration =====

import type { NormalizedBlockFE } from "../lib/api";

function makeBlockEntry(
  index: number,
  blocks: Array<{ kind: string; name?: string }>,
  role: string = "assistant"
): TranscriptEntryOut {
  return {
    index,
    byteOffset: index * 1000,
    raw: {},
    normalized: {
      id: `b-${index}`,
      role,
      rawType: role,
      timestamp: `2026-06-25T${String(10 + index).padStart(2, "0")}:00:00Z`,
      blocks: blocks as NormalizedBlockFE[],
    },
  };
}

describe("useTranscriptPipeline — content filter", () => {
  beforeEach(() => {
    cleanup();
    useTranscriptFilterStore.getState().clear();
    useTranscriptStore.getState().reset();
  });

  it("toggleTool:只有 Bash tool_use 的 entry 保留", () => {
    useTranscriptStore.setState({
      entries: [
        makeBlockEntry(0, [{ kind: "tool_use", name: "Bash" }]),
        makeBlockEntry(1, [{ kind: "tool_use", name: "Read" }]),
        makeBlockEntry(2, [{ kind: "text" }]),
      ],
    });
    useTranscriptFilterStore.getState().toggleTool("Bash");
    render(<Probe />);
    expect(screen.getByTestId("count-filtered")).toHaveTextContent("1");
  });

  it("setRole('user'):仅保留 user role 的 entry", () => {
    useTranscriptStore.setState({
      entries: [
        makeBlockEntry(0, [{ kind: "text" }], "user"),
        makeBlockEntry(1, [{ kind: "text" }], "assistant"),
        makeBlockEntry(2, [{ kind: "text" }], "user"),
      ],
    });
    useTranscriptFilterStore.getState().setRole("user");
    render(<Probe />);
    expect(screen.getByTestId("count-filtered")).toHaveTextContent("2");
  });

  it("toggleHas('thinking'):保留含 thinking block 的 entry", () => {
    useTranscriptStore.setState({
      entries: [
        makeBlockEntry(0, [{ kind: "thinking" }]),
        makeBlockEntry(1, [{ kind: "text" }]),
        makeBlockEntry(2, [{ kind: "thinking" }, { kind: "text" }]),
      ],
    });
    useTranscriptFilterStore.getState().toggleHas("thinking");
    render(<Probe />);
    expect(screen.getByTestId("count-filtered")).toHaveTextContent("2");
  });

  it("clear():content filter 全清,filteredEntries === entries 引用", () => {
    useTranscriptStore.setState({
      entries: [makeBlockEntry(0, [{ kind: "text" }]), makeBlockEntry(1, [{ kind: "text" }])],
    });
    const { toggleTool, toggleHas, clear } = useTranscriptFilterStore.getState();
    toggleTool("Bash");
    toggleHas("thinking");
    clear();
    render(<Probe />);
    expect(screen.getByTestId("count-filtered")).toHaveTextContent("2");
  });

  it("time + content 组合:time 在前 content 在后", () => {
    const entries = [
      // 0: 时间外 + Bash tool_use — time 过滤掉
      makeBlockEntry(0, [{ kind: "tool_use", name: "Bash" }]),
      // 1: 时间内 + Bash tool_use + thinking — 命中
      makeBlockEntry(1, [{ kind: "thinking" }, { kind: "tool_use", name: "Bash" }]),
      // 2: 时间内 + Read tool_use + thinking — tool 不匹配
      makeBlockEntry(2, [{ kind: "thinking" }, { kind: "tool_use", name: "Read" }]),
      // 3: 时间内 + Bash tool_use 但没 thinking — has 不匹配
      makeBlockEntry(3, [{ kind: "text" }, { kind: "tool_use", name: "Bash" }]),
    ];
    // 强制 entry 时间(override default ts)
    const e0 = entries[0]!;
    const e1 = entries[1]!;
    const e2 = entries[2]!;
    const e3 = entries[3]!;
    e0.normalized.timestamp = "2026-06-25T09:00:00Z"; // 1h 外(假设 now=14:00)
    e1.normalized.timestamp = "2026-06-25T13:30:00Z";
    e2.normalized.timestamp = "2026-06-25T13:40:00Z";
    e3.normalized.timestamp = "2026-06-25T13:50:00Z";
    useTranscriptStore.setState({ entries });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-25T14:00:00Z"));
    useTranscriptFilterStore.getState().setPreset("1h");
    useTranscriptFilterStore.getState().toggleTool("Bash");
    useTranscriptFilterStore.getState().toggleHas("thinking");
    render(<Probe />);
    // time: [1, 2, 3],content: tool=Bash → [1, 3],has=thinking → [1]
    expect(screen.getByTestId("count-filtered")).toHaveTextContent("1");
    vi.useRealTimers();
  });
});
