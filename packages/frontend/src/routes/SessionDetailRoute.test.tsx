// @vitest-environment jsdom
/**
 * SessionDetailRoute back-to-parent 回归测试 (v0.5.0)
 *
 * 覆盖:
 * - 子会话页 (location.state.subagentContext 有) → 渲染 "返回父会话" 按钮
 * - 点 back-to-parent → 调 useSessionsStore 找父 jsonlPath
 *   → navigate 到 /session/<parentId>?path=<parentJsonlPath> + state.session
 * - sessionsStore 为空时 back 按钮能触发 load 再 navigate
 *
 * 已知限制(与 docs/E2E_TESTING.md 一致):
 * - 测试环境无 Tauri runtime, mock 掉 @tauri-apps/api/core
 * - useLivePids 用 vi.mock stub
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

import SessionDetailRoute from "./SessionDetailRoute";
import { useSessionsStore } from "../state/sessionsStore";
import type { SessionMeta } from "@ocsv/shared";

// Tauri core mock — transcript 加载不实际发生,避免 IPC 错误
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../hooks/useLivePids", () => ({
  useLivePids: () => ({ livePids: [] }),
}));

// 直接 mock react-router-dom — 用 vi.hoisted 避免 hoist 时 mockNavigate 还未初始化
const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

const parentMeta: SessionMeta = {
  sessionId: "parent-session-id",
  projectKey: "test",
  workspaceGuess: "/test",
  source: "claude",
  jsonlPath: "/tmp/parent.jsonl",
  sizeBytes: 0,
  mtimeMs: 0,
  messageCount: 10,
  title: "Parent Session",
  primaryModel: "claude-opus-4",
  subagentDir: "/tmp/parent/subagents",
  subagentCount: 2,
  subagentIds: ["child-1", "child-2"],
};

const childMeta: SessionMeta = {
  sessionId: "child-1",
  projectKey: "test",
  workspaceGuess: "/test",
  source: "claude",
  jsonlPath: "/tmp/parent/subagents/agent-child-1.jsonl",
  sizeBytes: 0,
  mtimeMs: 0,
  messageCount: 5,
  title: "Child Subagent",
  primaryModel: "claude-opus-4",
  hasTrajectory: false,
};

function LocationCapture() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

function renderChildRoute(childMeta: SessionMeta) {
  return render(
    <MemoryRouter
      initialEntries={[
        {
          pathname: "/session/child-1",
          state: {
            session: childMeta,
            subagentContext: {
              parentSessionId: parentMeta.sessionId,
              agentId: "child-1",
              agentType: "Explore",
            },
          },
        },
      ]}
    >
      <Routes>
        <Route path="/session/:sessionId" element={<SessionDetailRoute />} />
        <Route path="/" element={<div>home</div>} />
      </Routes>
      <LocationCapture />
    </MemoryRouter>
  );
}

describe("SessionDetailRoute — back-to-parent (v0.5.0)", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    // 重置 sessions store 并预填父 session
    useSessionsStore.setState({ sessions: [parentMeta], loading: false, error: null });
  });

  it("子会话页:现有 'back-btn' 复用为 '返回父会话' (data-testid=back-to-parent)", async () => {
    renderChildRoute(childMeta);
    // v0.5.0:去掉了独立顶部 back-to-parent 条,改复用 header 的 .back-btn
    const backBtn = await screen.findByTestId("back-to-parent");
    expect(backBtn).toBeInTheDocument();
    expect(backBtn.classList.contains("back-btn")).toBe(true);
    expect(backBtn.textContent).toContain("返回父会话");
    // 按钮文字是 "parent-sessi…" (12 字符截断)
    expect(backBtn.textContent).toContain("parent-sessi");
  });

  it("点 back → 从 sessionsStore 找父 jsonlPath, navigate 走 ?path= 持久化", async () => {
    renderChildRoute(childMeta);
    const backBtn = await screen.findByTestId("back-to-parent");
    await userEvent.click(backBtn);

    // 关键断言:navigate 必须带父 jsonlPath
    // 之前的 bug 是 navigate("/session/<parentId>") 不带 state,父页 meta=undefined
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledTimes(1);
    });
    const [url, options] = mockNavigate.mock.calls[0]!;
    expect(url).toBe("/session/parent-session-id?path=%2Ftmp%2Fparent.jsonl");
    expect(options).toMatchObject({
      state: expect.objectContaining({
        session: expect.objectContaining({
          sessionId: "parent-session-id",
          jsonlPath: "/tmp/parent.jsonl",
        }),
      }),
    });
  });

  it("sessionsStore 为空时,back 触发 load 再 navigate", async () => {
    // 模拟 sessions 还没加载(用户直接深链到子会话)
    useSessionsStore.setState({ sessions: [], loading: false, error: null });
    const loadSpy = vi.spyOn(useSessionsStore.getState(), "load").mockResolvedValue();
    // load 后会更新 sessions,所以再 spy
    loadSpy.mockImplementation(async () => {
      useSessionsStore.setState({ sessions: [parentMeta] });
    });

    renderChildRoute(childMeta);
    const backBtn = await screen.findByTestId("back-to-parent");
    await userEvent.click(backBtn);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledTimes(1);
    });
    expect(loadSpy).toHaveBeenCalled();
    const [url] = mockNavigate.mock.calls[0]!;
    expect(url).toBe("/session/parent-session-id?path=%2Ftmp%2Fparent.jsonl");
  });

  it("父 session 不在 list 里(罕见) → navigate 走无 state 路径(至少 URL 合理)", async () => {
    useSessionsStore.setState({ sessions: [] });
    const loadSpy = vi.spyOn(useSessionsStore.getState(), "load").mockResolvedValue();
    loadSpy.mockImplementation(async () => {
      // 模拟 load 完还是没找到父(父被删)
      useSessionsStore.setState({ sessions: [] });
    });

    renderChildRoute(childMeta);
    const backBtn = await screen.findByTestId("back-to-parent");
    await userEvent.click(backBtn);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledTimes(1);
    });
    const [url, options] = mockNavigate.mock.calls[0]!;
    // fallback URL — 无 ?path= (因为没拿到 jsonlPath)
    expect(url).toBe("/session/parent-session-id");
    // options 可能 undefined
    expect(options).toBeUndefined();
  });

  it("非子会话:back 按钮 textContent 是 detail.back (回列表),data-testid=back-to-list", async () => {
    // 父会话(无 subagentContext) → 现有"返回"按钮照常回列表
    render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/session/parent-session-id",
            state: { session: parentMeta }, // 无 subagentContext
          },
        ]}
      >
        <Routes>
          <Route path="/session/:sessionId" element={<SessionDetailRoute />} />
        </Routes>
      </MemoryRouter>
    );
    const backBtn = await screen.findByTestId("back-to-list");
    expect(backBtn).toBeInTheDocument();
    expect(backBtn.classList.contains("back-btn")).toBe(true);
    // textContent 应只是 "返回"(不带 parent-sessi…)
    expect(backBtn.textContent).not.toContain("parent-sessi");
  });
});
