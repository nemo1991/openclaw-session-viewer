/**
 * TranscriptToolbar 组件可视化测试 — Filter + Sort 组合
 */

// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TranscriptToolbar } from "./TranscriptToolbar";

describe("TranscriptToolbar", () => {
  it("同时渲染 FilterPanel 和 SortPanel", () => {
    render(
      <TranscriptToolbar
        preset="all"
        tz="UTC"
        sortAsc={true}
        localInputToIso={() => undefined}
        isoToLocalInput={() => ""}
        onPresetChange={() => undefined}
        onApply={() => undefined}
        onClear={() => undefined}
        onSortChange={() => undefined}
      />
    );
    // FilterPanel
    expect(screen.getByTestId("filter-preset-24h")).toBeInTheDocument();
    // SortPanel
    expect(screen.getByTestId("sort-asc")).toBeInTheDocument();
    expect(screen.getByTestId("sort-desc")).toBeInTheDocument();
  });
});
