/**
 * v0.9.22 (M4): SessionOverview — L1 layer 单元测试
 *
 * 覆盖 SessionSummaryStrip 9 个 DB-derived 字段 + MetaBannerFold 条件渲染:
 * - phaseHint / phaseDetail / repeatRun / idleGap / subagent / thinking / error
 * - topTools + "其他" 折叠
 * - metaBanner 渲染 (claude / openclaw 无 → 不渲染)
 * - empty data fallback (textMsg === 0 → 不渲染)
 * - 没 phaseHint → 不渲染 (enrich 还没跑完)
 */

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SessionOverview } from "./SessionOverview";
import type { SessionMeta } from "@ocsv/shared";

// @vitest-environment jsdom

const baseMeta: SessionMeta = {
  sessionId: "s1",
  projectKey: "p1",
  workspaceGuess: "/tmp",
  source: "kimi",
  jsonlPath: "/tmp/s1.jsonl",
  sizeBytes: 1024,
  mtimeMs: 0,
  messageCount: 10,
  textMessageCount: 10,
  toolUsage: [
    ["read", 5],
    ["write", 3],
  ],
  phaseHint: "explore",
  phaseDetail: "test phase",
  subagentCount: 0,
  thinkingCount: 0,
  errorCount: 0,
  repeatRunCount: 0,
  idleGapCount: 0,
};

describe("SessionOverview", () => {
  it("渲染 SessionSummaryStrip (phaseHint + topTools)", () => {
    render(<SessionOverview meta={baseMeta} />);
    expect(screen.getByTestId("session-summary-strip")).toBeInTheDocument();
    expect(screen.getByText("探索")).toBeInTheDocument();
    expect(screen.getByTestId("ss-tool-read")).toBeInTheDocument();
    expect(screen.getByTestId("ss-tool-write")).toBeInTheDocument();
  });

  it("textMessageCount === 0 → 不渲染 SessionSummaryStrip", () => {
    render(<SessionOverview meta={{ ...baseMeta, textMessageCount: 0 }} />);
    expect(screen.queryByTestId("session-summary-strip")).not.toBeInTheDocument();
  });

  it("没 phaseHint → 不渲染 SessionSummaryStrip (enrich 还没跑完)", () => {
    render(<SessionOverview meta={{ ...baseMeta, phaseHint: undefined }} />);
    expect(screen.queryByTestId("session-summary-strip")).not.toBeInTheDocument();
  });

  it("toolUsage 空 + textMsg < 3 → 不渲染", () => {
    render(<SessionOverview meta={{ ...baseMeta, toolUsage: [], textMessageCount: 2 }} />);
    expect(screen.queryByTestId("session-summary-strip")).not.toBeInTheDocument();
  });

  it("subagentCount > 0 → 显示 subagent chip", () => {
    render(<SessionOverview meta={{ ...baseMeta, subagentCount: 3 }} />);
    expect(screen.getByText(/subagent × 3/)).toBeInTheDocument();
  });

  it("thinkingCount > 0 → 显示 thinking chip", () => {
    render(<SessionOverview meta={{ ...baseMeta, thinkingCount: 7 }} />);
    expect(screen.getByText(/thinking × 7/)).toBeInTheDocument();
  });

  it("errorCount > 0 → 显示 error chip", () => {
    render(<SessionOverview meta={{ ...baseMeta, errorCount: 2 }} />);
    expect(screen.getByText(/错误 × 2/)).toBeInTheDocument();
  });

  it("repeatRunCount > 0 → 显示 repeat chip", () => {
    render(
      <SessionOverview
        meta={{ ...baseMeta, repeatRunCount: 4, repeatRunMaxTool: "read", repeatRunMaxCount: 3 }}
      />
    );
    expect(screen.getByText(/连续重复 4 段/)).toBeInTheDocument();
    expect(screen.getByText(/read × 3/)).toBeInTheDocument();
  });

  it("idleGapCount > 0 + idleGapMaxMs → 显示最长时间间隔", () => {
    render(<SessionOverview meta={{ ...baseMeta, idleGapCount: 5, idleGapMaxMs: 125000 }} />);
    // 125000 ms = 125 sec = 2 分钟
    expect(screen.getByText(/5 长间隔/)).toBeInTheDocument();
    expect(screen.getByText(/2 分钟/)).toBeInTheDocument();
  });

  it("top 5 + 其他 折叠:toolUsage > 5 项 → 渲染 +N 其他", () => {
    render(
      <SessionOverview
        meta={{
          ...baseMeta,
          toolUsage: [
            ["read", 10],
            ["write", 5],
            ["bash", 3],
            ["grep", 2],
            ["glob", 1],
            ["todo", 1],
            ["other", 1],
          ],
        }}
      />
    );
    expect(screen.getByTestId("ss-tool-read")).toBeInTheDocument();
    expect(screen.getByText(/其他/)).toBeInTheDocument();
  });

  it("metaBanner 渲染 (kimi session)", () => {
    render(
      <SessionOverview
        meta={{
          ...baseMeta,
          metaBanner: {
            protocolVersion: "1",
            profileName: "default",
            modelAlias: "kimi-k2",
            thinkingEffort: "high",
            permissionMode: "default",
            activeToolCount: 5,
            configChangeCount: 1,
            approvalCount: 2,
            compactionCount: 0,
            lastCompactionDurationMs: undefined,
          },
        }}
      />
    );
    expect(screen.getByTestId("meta-banner-fold")).toBeInTheDocument();
  });

  it("metaBanner 不渲染 (claude / openclaw)", () => {
    render(<SessionOverview meta={{ ...baseMeta, source: "claude" }} />);
    expect(screen.queryByTestId("meta-banner-fold")).not.toBeInTheDocument();
  });

  it("metaBanner 点击 toggle 展开 detail", () => {
    render(
      <SessionOverview
        meta={{
          ...baseMeta,
          metaBanner: {
            protocolVersion: "1",
            modelAlias: "kimi-k2",
            configChangeCount: 1,
            approvalCount: 2,
            compactionCount: 0,
            lastCompactionDurationMs: undefined,
          },
        }}
      />
    );
    expect(screen.queryByTestId("meta-banner-detail")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("meta-banner-toggle"));
    expect(screen.getByTestId("meta-banner-detail")).toBeInTheDocument();
  });
});
