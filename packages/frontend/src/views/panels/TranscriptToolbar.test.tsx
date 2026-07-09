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
        availableTools={[
          ["Bash", 286],
          ["Read", 50],
          ["Edit", 10],
        ]}
        selectedTools={[]}
        role={undefined}
        has={[]}
        availableModels={["claude-opus-4-7", "claude-sonnet-4-5"]}
        selectedModels={[]}
        sidechainMode="all"
        onToggleTool={() => undefined}
        onSetRole={() => undefined}
        onToggleHas={() => undefined}
        onToggleModel={() => undefined}
        onSetSidechainMode={() => undefined}
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
    expect(screen.getByTestId("filter-role-all")).toBeInTheDocument();
    expect(screen.getByTestId("filter-role-user")).toBeInTheDocument();
    expect(screen.getByTestId("filter-role-assistant")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-has-thinking")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-has-tool_use")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-has-error")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-has-subagent")).toBeInTheDocument();
    // v0.7.0 model chips
    expect(screen.getByTestId("content-filter-model-claude-opus-4-7")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-model-claude-sonnet-4-5")).toBeInTheDocument();
    // v0.7.0 sidechain 3 选项
    expect(screen.getByTestId("filter-sidechain-all")).toBeInTheDocument();
    expect(screen.getByTestId("filter-sidechain-main")).toBeInTheDocument();
    expect(screen.getByTestId("filter-sidechain-sidechain")).toBeInTheDocument();
  });

  it("availableTools 为空时不渲染 tool 行,但 role + has + models + sidechain 仍显示", () => {
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
        availableModels={["claude-opus-4-7"]}
        selectedModels={[]}
        sidechainMode="all"
        onToggleTool={() => undefined}
        onSetRole={() => undefined}
        onToggleHas={() => undefined}
        onToggleModel={() => undefined}
        onSetSidechainMode={() => undefined}
        onClearContent={() => undefined}
      />
    );
    expect(screen.queryByTestId("content-filter-tools")).toBeNull();
    expect(screen.getByTestId("content-filter-roles")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-hases")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-models")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter-sidechains")).toBeInTheDocument();
  });
});
