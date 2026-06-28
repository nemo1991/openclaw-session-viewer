/**
 * SubagentPanel 组件可视化测试(v0.5.0)
 *
 * 覆盖:
 * - count = 0 → 不渲染 trigger
 * - count > 0 → 渲染 trigger,文字 "子代理 (N)"
 * - 点击 trigger → 展开面板 → apiListSubagentsByMeta 被调
 * - mock 返回 2 个 fixture → 渲染 2 行,含 agentType badge + description + 时间
 * - mock 返回 [] → 显示 empty 文案
 * - 点击 "打开" 按钮 → useNavigate 调 /session/<agentId>
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { SubagentPanel } from "./SubagentPanel";
import * as api from "../lib/api";
import type { SessionMeta, SubagentMeta } from "@ocsv/shared";

const mockedList = vi.spyOn(api, "apiListSubagentsByMeta");

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const mockMeta: SessionMeta = {
  sessionId: "main-session-123",
  projectKey: "test",
  workspaceGuess: "/test",
  source: "claude",
  jsonlPath: "/tmp/main.jsonl",
  sizeBytes: 0,
  mtimeMs: 0,
  messageCount: 10,
  title: "Test Main",
  primaryModel: "claude-opus-4",
  subagentDir: "/tmp/main/subagents",
  subagentCount: 2,
  subagentIds: ["a1d92", "b2867"],
};

const mockSubs: SubagentMeta[] = [
  {
    agentId: "a1d92",
    jsonlPath: "/tmp/main/subagents/agent-a1d92.jsonl",
    metaPath: "/tmp/main/subagents/agent-a1d92.meta.json",
    agentType: "Explore",
    description: "Explore release workflow setup",
    messageCount: 53,
    firstTimestamp: "2026-06-25T10:02:00Z",
    lastTimestamp: "2026-06-25T10:04:00Z",
  },
  {
    agentId: "b2867",
    jsonlPath: "/tmp/main/subagents/agent-b2867.jsonl",
    metaPath: "/tmp/main/subagents/agent-b2867.meta.json",
    agentType: "Plan",
    description: "Design implementation plan",
    messageCount: 12,
    firstTimestamp: "2026-06-25T11:00:00Z",
    lastTimestamp: "2026-06-25T11:05:00Z",
  },
];

describe("SubagentPanel", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("subagentCount = 0 → 不渲染 trigger", () => {
    const metaNoSubs: SessionMeta = { ...mockMeta, subagentCount: 0, subagentIds: undefined };
    render(
      <MemoryRouter>
        <SubagentPanel parentSession={metaNoSubs} />
      </MemoryRouter>
    );
    expect(screen.queryByTestId("subagent-trigger")).toBeNull();
  });

  it("subagentCount = 3 → 渲染 trigger,文字含 (3)", () => {
    const meta3: SessionMeta = { ...mockMeta, subagentCount: 3 };
    render(
      <MemoryRouter>
        <SubagentPanel parentSession={meta3} />
      </MemoryRouter>
    );
    const trigger = screen.getByTestId("subagent-trigger");
    expect(trigger).toBeInTheDocument();
    expect(trigger.textContent).toContain("(3)");
    expect(trigger.getAttribute("data-count")).toBe("3");
  });

  it("点 trigger 展开 → 调 apiListSubagentsByMeta", async () => {
    mockedList.mockResolvedValue(mockSubs);
    render(
      <MemoryRouter>
        <SubagentPanel parentSession={mockMeta} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByTestId("subagent-trigger"));
    // 等 useEffect 跑完
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(mockedList).toHaveBeenCalledWith(mockMeta);
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it("展开后渲染 mock 返回的 2 行(按 firstTimestamp 升序)", async () => {
    mockedList.mockResolvedValue(mockSubs);
    render(
      <MemoryRouter>
        <SubagentPanel parentSession={mockMeta} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByTestId("subagent-trigger"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const rows = screen.getAllByTestId("subagent-row");
    expect(rows).toHaveLength(2);
    // 顺序按 firstTimestamp: a1d92 (10:02) → b2867 (11:00)
    expect(rows[0].getAttribute("data-agent-id")).toBe("a1d92");
    expect(rows[1].getAttribute("data-agent-id")).toBe("b2867");
    // 类型 badge
    expect(within(rows[0]).getByText("Explore")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Plan")).toBeInTheDocument();
    // 描述
    expect(within(rows[0]).getByText("Explore release workflow setup")).toBeInTheDocument();
  });

  it("mock 返回 [] → 显示 empty 文案", async () => {
    mockedList.mockResolvedValue([]);
    render(
      <MemoryRouter>
        <SubagentPanel parentSession={mockMeta} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByTestId("subagent-trigger"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(screen.getByText(/该会话无子代理|无子代理/)).toBeInTheDocument();
  });

  it("点 '打开' 按钮 → useNavigate 到 /session/<agentId> + state.subagentContext", async () => {
    mockedList.mockResolvedValue(mockSubs);
    render(
      <MemoryRouter>
        <SubagentPanel parentSession={mockMeta} />
      </MemoryRouter>
    );
    await userEvent.click(screen.getByTestId("subagent-trigger"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // 点第一个 subagent 的打开按钮
    const openBtns = screen.getAllByTestId("subagent-open-btn");
    await userEvent.click(openBtns[0]);
    expect(mockNavigate).toHaveBeenCalledWith(
      "/session/a1d92",
      expect.objectContaining({
        state: expect.objectContaining({
          session: expect.objectContaining({ sessionId: "a1d92" }),
          subagentContext: expect.objectContaining({
            parentSessionId: "main-session-123",
            agentId: "a1d92",
            agentType: "Explore",
          }),
        }),
      })
    );
  });
});
