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

describe("SessionSummaryStrip — v0.8.4 item 2' 全读 DB", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    useSessionsStore.setState({ sessions: [], loading: false, error: null });
  });

  function renderWithMeta(meta: SessionMeta) {
    return render(
      <MemoryRouter initialEntries={[{ pathname: "/session/x", state: { session: meta } }]}>
        <Routes>
          <Route path="/session/:sessionId" element={<SessionDetailRoute />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it("从 meta.toolUsage 读 tool chip (不再调 summarizeSession)", async () => {
    renderWithMeta({
      ...parentMeta,
      textMessageCount: 50,
      toolUsage: [
        ["Bash", 286],
        ["Read", 50],
        ["Edit", 12],
      ],
      phaseHint: "implement",
      phaseDetail: "75% 写操作",
      repeatRunCount: 1,
      repeatRunMaxTool: "Bash",
      repeatRunMaxCount: 286,
      idleGapCount: 2,
      idleGapMaxMs: 7 * 60 * 1000,
      thinkingCount: 5,
      errorCount: 1,
    });
    const strip = await screen.findByTestId("session-summary-strip");
    expect(strip.textContent).toMatch(/实施/);
    expect(strip.textContent).toMatch(/75%/);
    expect(strip.textContent).toMatch(/Bash/);
    expect(strip.textContent).toMatch(/286/);
    expect(strip.textContent).toMatch(/Read/);
    expect(strip.textContent).toMatch(/50/);
    expect(strip.textContent).toMatch(/thinking/);
    expect(strip.textContent).toMatch(/错误/);
    expect(strip.textContent).toMatch(/连续重复/);
    expect(strip.textContent).toMatch(/长间隔/);
  });

  it("phaseHint 不存在 (enrich 还没跑) → strip 不渲染", async () => {
    const { container } = renderWithMeta({
      ...parentMeta,
      textMessageCount: 50,
      toolUsage: [["Bash", 5]],
      // phaseHint 缺失
    });
    // 等下 React 渲染完
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector('[data-testid="session-summary-strip"]')).toBeNull();
  });

  it("textMessageCount=0 → strip 不渲染 (避免加载中闪烁)", async () => {
    const { container } = renderWithMeta({
      ...parentMeta,
      textMessageCount: 0,
      toolUsage: [],
      phaseHint: "short",
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector('[data-testid="session-summary-strip"]')).toBeNull();
  });

  it("toolUsage > 5 → 显示 '+N 其他' chip (top 5 + 其他)", async () => {
    renderWithMeta({
      ...parentMeta,
      textMessageCount: 100,
      toolUsage: [
        ["A", 100],
        ["B", 80],
        ["C", 60],
        ["D", 40],
        ["E", 20],
        ["F", 10],
        ["G", 5],
      ],
      phaseHint: "mixed",
    });
    const strip = await screen.findByTestId("session-summary-strip");
    expect(strip.textContent).toMatch(/\+2 其他/); // F + G
  });

  it("idleGapMaxMs 缺失 → 长间隔 chip 不显示", async () => {
    renderWithMeta({
      ...parentMeta,
      textMessageCount: 50,
      toolUsage: [["Bash", 10]],
      phaseHint: "mixed",
      idleGapCount: 2,
      // idleGapMaxMs 缺失
    });
    const strip = await screen.findByTestId("session-summary-strip");
    expect(strip.textContent).not.toMatch(/长间隔/);
  });

  it("max tool chip: repeatRunMaxTool / repeatRunMaxCount 显示在 chip 里", async () => {
    renderWithMeta({
      ...parentMeta,
      textMessageCount: 50,
      toolUsage: [["Bash", 100]],
      phaseHint: "mixed",
      repeatRunCount: 3,
      repeatRunMaxTool: "Bash",
      repeatRunMaxCount: 100,
    });
    const strip = await screen.findByTestId("session-summary-strip");
    expect(strip.textContent).toMatch(/连续重复 3 段/);
    expect(strip.textContent).toMatch(/Bash × 100/);
  });
});

describe("SessionDetailRoute — reload 按钮 (v0.8.11)", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    useSessionsStore.setState({ sessions: [parentMeta], loading: false, error: null });
  });

  function renderParentRoute() {
    return render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/session/parent-session-id",
            state: { session: parentMeta },
          },
        ]}
      >
        <Routes>
          <Route path="/session/:sessionId" element={<SessionDetailRoute />} />
        </Routes>
      </MemoryRouter>
    );
  }

  it("render reload 按钮 (data-testid=reload-btn) + 在 header actions 区域", async () => {
    renderParentRoute();
    const btn = await screen.findByTestId("reload-btn");
    expect(btn).toBeInTheDocument();
    expect(btn.classList.contains("reloading")).toBe(false);
  });

  it("reload 按钮存在 → 一定在 Search 按钮之前 (DOM order)", async () => {
    renderParentRoute();
    const reloadBtn = await screen.findByTestId("reload-btn");
    const searchBtn = screen.getByTitle(/会话内搜索|搜索/);
    // reloadBtn DOM 位置应在 searchBtn 之前(因为 reload 在 code 里写在 Search 前)
    expect(
      reloadBtn.compareDocumentPosition(searchBtn) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("点 reload 按钮 → 触发 sessionsStore.refresh (走 refresh_sessions IPC)", async () => {
    const refreshSpy = vi.spyOn(useSessionsStore.getState(), "refresh").mockResolvedValue();
    renderParentRoute();
    const btn = await screen.findByTestId("reload-btn");
    await userEvent.click(btn);
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("refresh 后在 sessions 找当前 sid → navigate 用新 meta 触发 useMemo 重派生", async () => {
    const refreshedMeta: SessionMeta = {
      ...parentMeta,
      messageCount: 99, // 模拟后端 sync 后 messageCount 变了
    };
    const refreshSpy = vi
      .spyOn(useSessionsStore.getState(), "refresh")
      .mockImplementation(async () => {
        // 模拟 refresh 完后 sessions store 已被更新
        useSessionsStore.setState({ sessions: [refreshedMeta] });
      });

    renderParentRoute();
    const btn = await screen.findByTestId("reload-btn");
    await userEvent.click(btn);

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalled();
    });
    // navigate 用 replace=true 触发 useMemo 重新派生 (location.state.session 更新)
    const [url, options] = mockNavigate.mock.calls[0]!;
    expect(url).toBe("/session/parent-session-id");
    expect(options).toMatchObject({ replace: true });
  });

  it("reload 中按钮 disabled + className 含 reloading", async () => {
    // 让 refresh 永不 resolve 来观察中间态
    vi.spyOn(useSessionsStore.getState(), "refresh").mockReturnValue(new Promise(() => {}));
    renderParentRoute();
    const btn = await screen.findByTestId("reload-btn");
    await userEvent.click(btn);
    // 等 React rerender
    await waitFor(() => {
      expect(btn.classList.contains("reloading")).toBe(true);
    });
    expect(btn).toBeDisabled();
  });

  it("正在 reload 时再点 reload 按钮 → 被 reloading 短路,不重复触发", async () => {
    const refreshSpy = vi
      .spyOn(useSessionsStore.getState(), "refresh")
      .mockReturnValue(new Promise(() => {}));
    renderParentRoute();
    const btn = await screen.findByTestId("reload-btn");
    await userEvent.click(btn);
    await waitFor(() => {
      expect(btn.classList.contains("reloading")).toBe(true);
    });
    await userEvent.click(btn);
    await userEvent.click(btn);
    // 只 1 次 (后续被 reloading=true 短路)
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});
