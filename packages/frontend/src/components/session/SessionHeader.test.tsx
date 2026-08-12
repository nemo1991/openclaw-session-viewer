// @vitest-environment jsdom
/**
 * v0.9.24 (M7-B): SessionHeader — L0 层 chrome 单元测试
 *
 * 覆盖:
 * - back button (subCtx vs default)
 * - title 双击 → 进入编辑态 → input 显示
 * - archived / pinned / hidden badge 条件渲染
 * - tags chip 显示
 * - workspaceGuess / primaryModel / agentName pill
 * - stats row (messages / bytes / firstTimestamp / totalTokens /
 *   duration / latency / user-assistant / errorCount / toolError / meta-counts)
 * - actions row 12 button visibility + 触发回调
 * - onNotesToggle 收到正确的 toggle 调用
 * - actions row "重命名" 按钮 触发 HeaderInfo 切到编辑态
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SessionHeader } from "./SessionHeader";
import type { SessionMeta } from "@ocsv/shared";

// ===== Mock api =====
vi.mock("../../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../lib/api")>("../../lib/api");
  return {
    ...actual,
    apiExportMarkdown: vi.fn(),
    apiExportHtml: vi.fn(),
    apiRevealInFinder: vi.fn(),
    apiListLivePids: vi.fn(() => Promise.resolve([])),
  };
});

// ===== Mock plugin-dialog save =====
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(() => Promise.resolve(null)),
}));

// ===== Mock useModifierLabel =====
vi.mock("../../hooks/useIsMac", () => ({
  useModifierLabel: () => "Cmd" as const,
}));

// ===== Mock useLivePids — 取消轮询 timer =====
vi.mock("../../hooks/useLivePids", () => ({
  useLivePids: () => ({ livePids: [] }),
}));

// ===== Mock i18n =====
// 处理 i18next 的 {{key}} 插值: 把 `{{count}}` 替换成 params.count 的字符串表示。
// e.g. `t("detail.messages", { count: 25 })` → "25 条消息" (key 不带前缀)
// 由于 key 来自 i18n 资源, 真值需要 i18n bundle。这里用最小化策略:
// 关键 key ("detail.messages", "detail.pid", "detail.trajectory") 给硬编码中文;
// 其他直接返回 key (避免测试里 false positive)。
vi.mock("react-i18next", () => ({
  useTranslation: () => {
    const dict: Record<string, string> = {
      "detail.messages": "{{count}} 条消息",
      "detail.pid": "PID {{pid}}",
      "detail.trajectory": "运行轨迹",
      "detail.analyze": "🤖 大模型分析",
      "search.inSession": "search.inSession",
      "detail.back": "返回",
      "detail.subagentPanel.backToParent": "返回父会话",
    };
    return {
      t: (k: string, params?: Record<string, unknown>) => {
        const tmpl = dict[k] ?? k;
        if (!params) return tmpl;
        return Object.entries(params).reduce(
          (acc, [key, val]) => acc.replace(`{{${key}}}`, String(val)),
          tmpl
        );
      },
      i18n: { language: "zh-CN" },
    };
  },
}));

// ===== Mock overridesStore =====
const mockRename = vi.fn(async () => {});
const mockTogglePinned = vi.fn(async () => {});
const mockToggleHide = vi.fn(async () => {});
const mockSetArchived = vi.fn(async () => {});
const mockRemoveLink = vi.fn(async () => {});
const baseSnap = {
  renames: {} as Record<string, string>,
  hidden: {} as Record<string, boolean>,
  pinned: {} as Record<string, boolean>,
  archived: {} as Record<string, boolean>,
  notes: {} as Record<string, string>,
  tags: {} as Record<string, Array<{ id: number; name: string; color: string | null }>>,
  tagsAll: [] as Array<{ id: number; name: string; color: string | null }>,
  linksTo: {} as Record<
    string,
    Array<{ fromSession: string; toSession: string; note: string | null; createdAt: number }>
  >,
  linksFrom: {} as Record<
    string,
    Array<{ fromSession: string; toSession: string; note: string | null; createdAt: number }>
  >,
};
vi.mock("../../state/overridesStore", () => ({
  useOverrides: () => ({
    snap: baseSnap,
    rename: mockRename,
    togglePinned: mockTogglePinned,
    toggleHide: mockToggleHide,
    setArchived: mockSetArchived,
    removeLink: mockRemoveLink,
  }),
}));

// ===== Mock sessionsStore =====
// zustand 的 create 返回的是 callable hook + .getState() / .setState() 静态方法
const mockLoad = vi.fn(async () => {});
const mockSessionsState = { sessions: [], load: mockLoad };
vi.mock("../../state/sessionsStore", () => ({
  useSessionsStore: Object.assign(
    (selector: (s: typeof mockSessionsState) => unknown) => selector(mockSessionsState),
    {
      getState: () => mockSessionsState,
      setState: vi.fn(),
    }
  ),
}));

// ===== Mock searchInSessionStore =====
const mockShowSearchBar = vi.fn();
vi.mock("../../state/searchInSessionStore", () => ({
  useSearchInSessionStore: (selector: (s: { show: () => void }) => unknown) =>
    selector({ show: mockShowSearchBar }),
}));

// ===== Helper =====
const baseMeta: SessionMeta = {
  sessionId: "s1",
  projectKey: "p1",
  workspaceGuess: "/tmp/proj",
  source: "claude",
  jsonlPath: "/tmp/s1.jsonl",
  sizeBytes: 4096,
  mtimeMs: 0,
  messageCount: 25,
  title: "Test Session",
  hasTrajectory: false,
};

function renderHeader(props: Partial<React.ComponentProps<typeof SessionHeader>> = {}) {
  const navigate = vi.fn();
  const onNotesToggle = vi.fn();
  return {
    navigate,
    onNotesToggle,
    ...render(
      <MemoryRouter>
        <SessionHeader
          meta={baseMeta}
          navigate={navigate}
          onNotesToggle={onNotesToggle}
          {...props}
        />
      </MemoryRouter>
    ),
  };
}

describe("SessionHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    baseSnap.renames = {};
    baseSnap.pinned = {};
    baseSnap.hidden = {};
    baseSnap.archived = {};
  });

  it("渲染 header 容器 + back-to-list 按钮 (无 subCtx)", () => {
    renderHeader();
    expect(screen.getByTestId("session-header")).toBeInTheDocument();
    expect(screen.getByTestId("back-to-list")).toBeInTheDocument();
    expect(screen.queryByTestId("back-to-parent")).not.toBeInTheDocument();
  });

  it("subCtx 时显示 back-to-parent 按钮 + 父 sessionId 截断", () => {
    renderHeader({
      subagentContext: {
        parentSessionId: "parent-session-12345",
        agentId: "agent-1",
      },
    });
    expect(screen.getByTestId("back-to-parent")).toBeInTheDocument();
    // slice(0, 12) → "parent-sessi" + "…" = "parent-sessi…"
    expect(screen.getByText(/parent-sessi…/)).toBeInTheDocument();
  });

  it("双击 title → 进入编辑态显示 input", () => {
    renderHeader();
    const titleSpan = screen.getByText("Test Session");
    fireEvent.doubleClick(titleSpan);
    const input = document.querySelector(".title-rename-input") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe("Test Session");
  });

  it("actions row '重命名' 按钮触发 HeaderInfo 切到编辑态", () => {
    renderHeader();
    // 双击 rename button: title="重命名"
    const renameBtn = screen.getByTitle("重命名");
    fireEvent.click(renameBtn);
    expect(document.querySelector(".title-rename-input")).toBeInTheDocument();
  });

  it("archived / pinned / hidden badge 条件渲染", () => {
    const { rerender } = render(
      <MemoryRouter>
        <SessionHeader
          meta={{ ...baseMeta, archived: true, pinned: true, hidden: true }}
          navigate={vi.fn()}
          onNotesToggle={vi.fn()}
        />
      </MemoryRouter>
    );
    expect(screen.getByText(/已归档/)).toBeInTheDocument();
    expect(screen.getByText("📌")).toBeInTheDocument();
    expect(screen.getByText("🙈")).toBeInTheDocument();

    rerender(
      <MemoryRouter>
        <SessionHeader meta={baseMeta} navigate={vi.fn()} onNotesToggle={vi.fn()} />
      </MemoryRouter>
    );
    expect(screen.queryByText(/已归档/)).not.toBeInTheDocument();
  });

  it("tags chip 显示", () => {
    baseSnap.tags = { s1: [{ id: 1, name: "important", color: null }] };
    renderHeader();
    expect(screen.getByText("important")).toBeInTheDocument();
  });

  it("workspaceGuess 显示 + primaryModel pill + agentName pill", () => {
    render(
      <MemoryRouter>
        <SessionHeader
          meta={{ ...baseMeta, primaryModel: "claude-opus-4-5", agentName: "forcetone" }}
          navigate={vi.fn()}
          onNotesToggle={vi.fn()}
        />
      </MemoryRouter>
    );
    expect(screen.getByText("/tmp/proj")).toBeInTheDocument();
    expect(screen.getByText("claude-opus-4-5")).toBeInTheDocument();
    expect(screen.getByTestId("agent-name-pill")).toBeInTheDocument();
    expect(screen.getByText(/forcetone/)).toBeInTheDocument();
  });

  it("stats row: messages + bytes + totalTokens + duration + errorCount + toolError", () => {
    render(
      <MemoryRouter>
        <SessionHeader
          meta={{
            ...baseMeta,
            firstTimestamp: "2025-01-01T00:00:00Z",
            totalTokens: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10 },
            durationSeconds: 3600,
            errorCount: 2,
            toolError: [["Bash", 5]],
          }}
          navigate={vi.fn()}
          onNotesToggle={vi.fn()}
        />
      </MemoryRouter>
    );
    expect(screen.getByText(/25 条消息/)).toBeInTheDocument();
    expect(screen.getByText("4.0 KB")).toBeInTheDocument();
    expect(screen.getByText(/Tokens/)).toBeInTheDocument();
    expect(screen.getByText(/1h/)).toBeInTheDocument();
    expect(screen.getByText(/2 errors/)).toBeInTheDocument();
    expect(screen.getByTestId("stat-tool-error")).toBeInTheDocument();
  });

  it("actions row 12 button visibility + 触发回调", () => {
    const { onNotesToggle } = renderHeader();

    // 1. reload
    expect(screen.getByTestId("reload-btn")).toBeInTheDocument();

    // 2. search
    fireEvent.click(screen.getByTitle("search.inSession"));
    expect(mockShowSearchBar).toHaveBeenCalled();

    // 3. pin / 4. hide / 5. archive
    fireEvent.click(screen.getByTitle("置顶"));
    expect(mockTogglePinned).toHaveBeenCalledWith("s1", true);

    fireEvent.click(screen.getByTitle("隐藏"));
    expect(mockToggleHide).toHaveBeenCalledWith("s1", true);

    fireEvent.click(screen.getByTitle("归档"));
    expect(mockSetArchived).toHaveBeenCalledWith("s1", true);

    // 6. rename → 编辑态
    fireEvent.click(screen.getByTitle("重命名"));
    expect(document.querySelector(".title-rename-input")).toBeInTheDocument();

    // 7. notes (sticky note) → onNotesToggle 收到调用
    fireEvent.click(screen.getByTitle("笔记"));
    expect(onNotesToggle).toHaveBeenCalled();

    // 8. link (link2)
    expect(screen.getByTitle("链接到其他 session")).toBeInTheDocument();

    // 9. trajectory — hasTrajectory=false 时不显示
    expect(screen.queryByTitle("detail.trajectory")).not.toBeInTheDocument();

    // 10. export MD / 11. export HTML
    expect(screen.getByTestId("export-md")).toBeInTheDocument();
    expect(screen.getByTestId("export-html")).toBeInTheDocument();

    // 12. analyze (primary class)
    const analyzeBtn = screen.getByText(/🤖 大模型分析/);
    expect(analyzeBtn).toBeInTheDocument();
  });

  it("analyze 按钮 navigate 到 /analyze/<sessionId>", () => {
    const { navigate } = renderHeader();
    const analyzeBtn = screen.getByText(/🤖 大模型分析/);
    fireEvent.click(analyzeBtn);
    expect(navigate).toHaveBeenCalledWith(
      "/analyze/s1",
      expect.objectContaining({ state: { session: baseMeta } })
    );
  });

  it("hasTrajectory=true 时 trajectory 按钮显示", () => {
    render(
      <MemoryRouter>
        <SessionHeader
          meta={{ ...baseMeta, hasTrajectory: true }}
          navigate={vi.fn()}
          onNotesToggle={vi.fn()}
        />
      </MemoryRouter>
    );
    // i18n mock 把 detail.trajectory → "运行轨迹"
    expect(screen.getByTitle("运行轨迹")).toBeInTheDocument();
  });

  it("reload 按钮 disabled + reloading class (默认 false)", () => {
    renderHeader();
    const reloadBtn = screen.getByTestId("reload-btn") as HTMLButtonElement;
    expect(reloadBtn.disabled).toBe(false);
    expect(reloadBtn.className).not.toContain("reloading");
  });

  it("loadingProgress 显示在 stats row messages count 旁", () => {
    render(
      <MemoryRouter>
        <SessionHeader
          meta={baseMeta}
          navigate={vi.fn()}
          onNotesToggle={vi.fn()}
          loadingProgress={{ loaded: 12, total: 25 }}
        />
      </MemoryRouter>
    );
    expect(screen.getByText(/25 条消息 \(12\/25\)/)).toBeInTheDocument();
  });
});
