/**
 * TranscriptToolbar 组件可视化测试 — Filter + Sort 组合
 */

// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TranscriptToolbar } from "./TranscriptToolbar";

describe("TranscriptToolbar", () => {
  it("同时渲染 FilterPanel + SortPanel + ContentFilterPanel", () => {
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
        availableTools={["Bash", "Read", "Edit"]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        onToggleTool={() => undefined}
        onSetRole={() => undefined}
        onToggleHas={() => undefined}
        onClearContent={() => undefined}
      />
    );
    // FilterPanel
    expect(screen.getByTestId("filter-preset-24h")).toBeInTheDocument();
    // SortPanel
    expect(screen.getByTestId("sort-asc")).toBeInTheDocument();
    expect(screen.getByTestId("sort-desc")).toBeInTheDocument();
    // ContentFilterPanel
    expect(screen.getByTestId("content-filter-bar")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-tool-Bash")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-tool-Read")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-tool-Edit")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-role-all")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-role-user")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-role-assistant")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-has-thinking")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-has-tool_use")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-has-error")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-has-subagent")).toBeInTheDocument();
  });

  it("availableTools 为空时不渲染 tool 行,但 role + has 仍显示", () => {
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
        availableTools={[]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        onToggleTool={() => undefined}
        onSetRole={() => undefined}
        onToggleHas={() => undefined}
        onClearContent={() => undefined}
      />
    );
    expect(screen.queryByTestId("content-filter-tools")).toBeNull();
    expect(screen.getByTestId("content-filter-roles")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-hases")).toBeInTheDocument();
  });
});
