/**
 * v0.9.23 (M5): ChartsRegion 单元测试
 *
 * 覆盖:
 * - 0 chart → region 不渲染 (老 wire / openclaw / 0 chart session)
 * - 1 chart → 渲染 1 个 grid cell
 * - 6 chart → 渲染 6 个 grid cell,按 entry 顺序
 * - 非 meta block (kind !== "meta") → skip cell
 * - 6 chart kind 各自 dispatch 到对应 chart sub-component
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChartsRegion } from "./ChartsRegion";
import type { NormalizedMessageFE, TranscriptEntryOut } from "../../lib/api";

// @vitest-environment jsdom

function makeChartEntry(
  index: number,
  label: string,
  payload: Record<string, unknown> = {}
): TranscriptEntryOut {
  const block = { kind: "meta", label, payload };
  const normalized: NormalizedMessageFE = {
    id: `chart-${index}`,
    role: "meta",
    rawType: label,
    blocks: [block],
  };
  return {
    index,
    byteOffset: 0,
    raw: null,
    normalized,
  };
}

function makeMinimalPayload(label: string): Record<string, unknown> {
  // 6 chart sub-component 各自有最小可渲染 payload 契约:
  // - context.apply_compaction: summary
  // - llm.tools_snapshot: tools[]
  // - usage.chart: buckets[], total_tokens
  // - request.chart: buckets[], request_count
  // - todos.chart: buckets[], update_count
  // - ai-title.chart: buckets[], event_count
  switch (label) {
    case "context.apply_compaction":
      return { summary: "t", tokens_before: 1, tokens_after: 1 };
    case "llm.tools_snapshot":
      return { tools: ["read"] };
    case "usage.chart":
      return {
        buckets: [{ input_other: 1, output: 1, input_cache_read: 1 }],
        total_tokens: 3,
      };
    case "request.chart":
      return {
        buckets: [{ max_tokens_avg: 1, max_tokens_max: 1, max_tokens_min: 1 }],
        request_count: 1,
      };
    case "todos.chart":
      return {
        buckets: [{ done_count: 1, in_progress_count: 0, pending_count: 0 }],
        update_count: 1,
      };
    case "ai-title.chart":
      return {
        buckets: [{ event_count: 1, ai_count: 1, custom_count: 0 }],
        event_count: 1,
      };
    default:
      return {};
  }
}

const CHART_LABELS = [
  "context.apply_compaction",
  "llm.tools_snapshot",
  "usage.chart",
  "request.chart",
  "todos.chart",
  "ai-title.chart",
];

describe("ChartsRegion", () => {
  it("0 chart → 不渲染 region", () => {
    const { container } = render(<ChartsRegion charts={[]} />);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId("charts-region")).not.toBeInTheDocument();
  });

  it("1 chart → 渲染 1 个 grid cell", () => {
    const charts = [makeChartEntry(0, "usage.chart", makeMinimalPayload("usage.chart"))];
    render(<ChartsRegion charts={charts} />);
    expect(screen.getByTestId("charts-region")).toBeInTheDocument();
    expect(screen.getByTestId("charts-region-cell-0")).toBeInTheDocument();
  });

  it("6 chart → 渲染 6 个 grid cell,按 entry 顺序", () => {
    const charts = CHART_LABELS.map((label, i) =>
      makeChartEntry(i, label, makeMinimalPayload(label))
    );
    render(<ChartsRegion charts={charts} />);
    for (let i = 0; i < 6; i++) {
      expect(screen.getByTestId(`charts-region-cell-${i}`)).toBeInTheDocument();
    }
  });

  it("6 chart 各自 dispatch 到对应 chart sub-component", () => {
    const charts = CHART_LABELS.map((label, i) =>
      makeChartEntry(i, label, makeMinimalPayload(label))
    );
    render(<ChartsRegion charts={charts} />);
    // 6 chart 各自用独立 testid — 验证 dispatch 路由正确
    // compaction + tools-snapshot 走 .compaction-meta / .tools-snapshot-meta
    // CSS class(无独立 testid),用 chart 内容 feature 验证。
    expect(screen.getByTestId("compaction-summary")).toBeInTheDocument();
    expect(screen.getByTestId("tools-snapshot-list")).toBeInTheDocument();
    expect(screen.getByTestId("usage-chart-svg")).toBeInTheDocument();
    expect(screen.getByTestId("request-chart-svg")).toBeInTheDocument();
    expect(screen.getByTestId("todos-chart-svg")).toBeInTheDocument();
    expect(screen.getByTestId("ai-title-chart-svg")).toBeInTheDocument();
  });

  it("非 meta block (kind !== meta) → skip cell", () => {
    const good = makeChartEntry(0, "usage.chart", makeMinimalPayload("usage.chart"));
    // bad entry: kind="text", 无 label
    const bad: TranscriptEntryOut = {
      index: 1,
      byteOffset: 0,
      raw: null,
      normalized: {
        id: "bad",
        role: "meta",
        rawType: "x",
        blocks: [{ kind: "text", text: "x" }],
      },
    };
    render(<ChartsRegion charts={[good, bad]} />);
    // 只渲染 1 个 cell (good),bad 被 skip
    expect(screen.getByTestId("charts-region-cell-0")).toBeInTheDocument();
    expect(screen.queryByTestId("charts-region-cell-1")).not.toBeInTheDocument();
  });
});
