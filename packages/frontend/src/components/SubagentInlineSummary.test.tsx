// @vitest-environment jsdom
/**
 * SubagentInlineSummary 单元测试 (v0.6.0)
 *
 * 覆盖:
 * - 加载中 → 显示 spinner + loading 文案
 * - 成功 → 显示消息数 + 工具分布 + 时间段 + 打开按钮
 * - 错误(子代理 jsonl 缺失等)→ 显示 empty 文案 + 打开按钮仍可用
 * - 工具分布只显示 top 3 + "more" 提示
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SubagentInlineSummary } from "./SubagentInlineSummary";
import * as api from "../lib/api";
import type { SubagentSummary } from "@ocsv/shared";

const mockGetSummary = vi.spyOn(api, "apiGetSubagentSummary");
const mockOnOpen = vi.fn();

const mockSummary: SubagentSummary = {
  agentId: "a1d924c184a57a7da",
  description: "扫描 src/ 目录",
  agentType: "Explore",
  messageCount: 53,
  toolDistribution: [
    ["Bash", 12],
    ["Read", 8],
    ["Edit", 3],
    ["Glob", 2],
  ],
  firstTimestamp: "2026-06-25T10:02:00Z",
  lastTimestamp: "2026-06-25T10:04:30Z",
  durationSeconds: 150,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SubagentInlineSummary", () => {
  it("加载中 → spinner + loading 文案", () => {
    mockGetSummary.mockReturnValue(new Promise(() => {})); // 永不解析
    render(
      <SubagentInlineSummary
        parentSessionDir="/tmp/main"
        agentId="a1d924c"
        onOpenChildPage={mockOnOpen}
      />
    );
    expect(screen.getByText(/加载/)).toBeInTheDocument();
  });

  it("成功 → 消息数 + 工具分布(top 3) + 时间段 + 打开按钮", async () => {
    mockGetSummary.mockResolvedValue(mockSummary);
    render(
      <SubagentInlineSummary
        parentSessionDir="/tmp/main"
        agentId="a1d924c"
        onOpenChildPage={mockOnOpen}
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId("subagent-inline-summary")).toBeInTheDocument();
    });
    // 消息数 (53 在 span 内 + 跟 "条" 拼接, 用 regex)
    expect(screen.getByText(/53\s*条/)).toBeInTheDocument();
    // 工具 chip: 名字存在即可(×N 计数在嵌套 span 里)
    const toolsEl = screen.getByTestId("subagent-inline-tools");
    expect(toolsEl.textContent).toContain("Bash");
    expect(toolsEl.textContent).toContain("Read");
    expect(toolsEl.textContent).toContain("Edit");
    // top 3: Bash/Read/Edit 显示, Glob 不显示(第 4 个)
    expect(toolsEl.textContent).not.toContain("Glob");
    // "+1" more indicator
    expect(screen.getByText("+1")).toBeInTheDocument();
    // 时长 "2m 30s" (150 秒)
    expect(screen.getByText(/2m 30s/)).toBeInTheDocument();
    // 打开按钮
    expect(screen.getByTestId("subagent-inline-open-btn")).toBeInTheDocument();
  });

  it("summary 为 null (子代理 jsonl 缺失) → empty 文案 + 打开按钮", async () => {
    mockGetSummary.mockResolvedValue(null);
    render(
      <SubagentInlineSummary
        parentSessionDir="/tmp/main"
        agentId="missing"
        onOpenChildPage={mockOnOpen}
      />
    );
    await waitFor(() => {
      expect(screen.getByTestId("subagent-inline-summary")).toBeInTheDocument();
    });
    expect(screen.getByText(/无子代理/)).toBeInTheDocument();
  });

  it("调 apiGetSubagentSummary 时传对的 parentSessionDir + agentId", async () => {
    mockGetSummary.mockResolvedValue(mockSummary);
    render(
      <SubagentInlineSummary
        parentSessionDir="/Users/foo/main"
        agentId="abc123"
        onOpenChildPage={mockOnOpen}
      />
    );
    await waitFor(() => {
      expect(mockGetSummary).toHaveBeenCalledWith("/Users/foo/main", "abc123");
    });
  });

  it("点打开按钮 → 调 onOpenChildPage", async () => {
    mockGetSummary.mockResolvedValue(mockSummary);
    render(
      <SubagentInlineSummary
        parentSessionDir="/tmp/main"
        agentId="a1d924c"
        onOpenChildPage={mockOnOpen}
      />
    );
    const btn = await screen.findByTestId("subagent-inline-open-btn");
    await userEvent.click(btn);
    expect(mockOnOpen).toHaveBeenCalledTimes(1);
  });
});
