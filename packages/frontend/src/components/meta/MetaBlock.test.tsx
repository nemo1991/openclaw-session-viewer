/**
 * MetaBlock 组件可视化测试 (v0.6.x)
 *
 * 覆盖 (4 种代表性 meta label + 默认展开):
 * - agent_listing 顶层 kind + 平铺字段 (BlockRenderer 入口)
 * - agent_listing meta role + payload 嵌套 (meta 分支入口)
 * - task_reminder (含关联字段: id / description / activeForm / blocks / blockedBy)
 * - pr_link
 * - plan_mode reveal 错误显示
 * - 默认 fallback 走 UnknownBlockCard
 *
 * v0.6.x 关键回归:
 * - meta-block-flat 不再是 <details>
 * - skill_listing 长列表滚动
 * - file_snapshot 路径列出 + reveal 失败错误显示
 *
 * 关键:payload ?? block 双形 fallback 必须两条路径都通。
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MetaBlock } from "./MetaBlock";
import * as api from "../../lib/api";
import { useSettingsStore } from "../../state/settingsStore";
import type { NormalizedBlockFE } from "../../lib/api";

const mockApiRevealInFinder = vi.spyOn(api, "apiRevealInFinder");

beforeEach(() => {
  cleanup();
  mockApiRevealInFinder.mockReset();
  // 默认 pathSecurity.lock-down 模式 + workspaceRoot=null (没设 defaultExportDir)
  // → 后端会拒绝并返回 'PathSecurity: 需提供 workspace_root'
  mockApiRevealInFinder.mockRejectedValue(
    new Error("PathSecurity: 需提供 workspace_root (lock-down 模式)")
  );
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      pathSecurity: { allowRelaxed: false },
    } as typeof useSettingsStore extends never ? never : never,
  });
});

describe("MetaBlock (v0.6.x 默认展开)", () => {
  describe("agent_listing", () => {
    it("顶层 kind + addedTypes 直接显示 (不走 <details>)", () => {
      const block: NormalizedBlockFE = {
        kind: "agent_listing",
        addedTypes: ["Explore", "Plan"],
        isInitial: true,
      };
      const { container } = render(<MetaBlock block={block} label="agent_listing" />);
      expect(container.querySelector("details")).toBeNull();
      expect(container.querySelector(".meta-block-flat")).toBeInTheDocument();
      expect(screen.getByText("🤖 agent")).toBeInTheDocument();
      expect(screen.getByText(/初始化 2 个 agent/)).toBeInTheDocument();
    });

    it("agent_listing_delta: 显示 +N / -M 标配色", () => {
      const block: NormalizedBlockFE = {
        kind: "agent_listing_delta",
        addedTypes: ["NewAgent"],
        removedTypes: ["OldAgent"],
        isInitial: false,
      };
      const { container } = render(<MetaBlock block={block} label="agent_listing_delta" />);
      // 默认展开后 add/remove 标签直接可见
      expect(screen.getByText(/\+1 agent|\+1 \/ -1/)).toBeInTheDocument();
      // 配色 class
      expect(container.querySelector(".meta-tag-add")).toBeInTheDocument();
      expect(container.querySelector(".meta-tag-remove")).toBeInTheDocument();
    });
  });

  describe("v0.6.x task_reminder 关联字段", () => {
    it("显示 task id (#N), description, activeForm", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "task_reminder",
        payload: {
          itemCount: 1,
          pendingCount: 0,
          inProgressCount: 1,
          completedCount: 0,
          content: [
            {
              id: "4",
              subject: "Phase 0: 项目骨架",
              description: "初始化 pnpm workspace + Tauri 2 + React + TypeScript 项目结构",
              activeForm: "搭建项目骨架 (Phase 0)",
              status: "in_progress",
              blocks: [],
              blockedBy: [],
            },
          ],
        },
      };
      const { container } = render(<MetaBlock block={block} label="task_reminder" />);
      // task id 标签
      expect(screen.getByText("#4")).toBeInTheDocument();
      // description 截断显示
      expect(container.querySelector(".meta-task-desc")).toBeInTheDocument();
      // activeForm
      expect(screen.getByText(/搭建项目骨架 \(Phase 0\)/)).toBeInTheDocument();
      // status
      expect(screen.getByText("in_progress")).toBeInTheDocument();
    });

    it("blocks / blockedBy DAG 依赖显示为 task ref 标签", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "task_reminder",
        payload: {
          itemCount: 1,
          pendingCount: 0,
          inProgressCount: 1,
          completedCount: 0,
          content: [
            {
              id: "5",
              subject: "Phase 1",
              status: "in_progress",
              blocks: ["8", "9"],
              blockedBy: ["4"],
            },
          ],
        },
      };
      render(<MetaBlock block={block} label="task_reminder" />);
      expect(screen.getByText(/等待:/)).toBeInTheDocument();
      expect(screen.getByText(/阻塞:/)).toBeInTheDocument();
      // task ref 标签 #4 #8 #9
      const refs = screen.getAllByText(/^#\d+$/);
      expect(refs.length).toBeGreaterThanOrEqual(3);
    });

    it("task 空描述/无依赖时不显示 .meta-task-meta", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "task_reminder",
        payload: {
          itemCount: 1,
          pendingCount: 1,
          inProgressCount: 0,
          completedCount: 0,
          content: [
            {
              id: "1",
              subject: "简单任务",
              status: "pending",
              blocks: [],
              blockedBy: [],
            },
          ],
        },
      };
      const { container } = render(<MetaBlock block={block} label="task_reminder" />);
      expect(container.querySelector(".meta-task-meta")).toBeNull();
      expect(screen.getByText("简单任务")).toBeInTheDocument();
    });
  });

  describe("v0.6.x file_snapshot (默认展开路径)", () => {
    it("空 trackedFileBackups → 显示 '空 snapshot (无文件)' + 不渲染 ul", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "file-history-snapshot",
        payload: {
          messageId: "abc12345-6789-0abc-def0-123456789012",
          trackedFileBackups: {},
        },
      };
      const { container } = render(<MetaBlock block={block} label="file-history-snapshot" />);
      expect(screen.getByText(/空 snapshot/)).toBeInTheDocument();
      expect(container.querySelector("details")).toBeNull();
      expect(container.querySelector(".meta-file-list")).toBeNull();
    });

    it("有文件 → 默认展开 ul.meta-file-list 列出所有路径", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "file-history-snapshot",
        payload: {
          trackedFileBackups: {
            "/Users/foo/bar.ts": { version: 1 },
            "/Users/foo/baz.ts": { version: 2 },
          },
        },
      };
      const { container } = render(<MetaBlock block={block} label="file-history-snapshot" />);
      expect(screen.getByText(/2 个跟踪文件/)).toBeInTheDocument();
      const ul = container.querySelector(".meta-file-list")!;
      expect(ul).toBeInTheDocument();
      expect(ul.querySelectorAll("li").length).toBe(2);
    });

    it("点路径按钮 → 调 useFileRevealAndNotify; 失败显示内联错误", async () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "file-history-snapshot",
        payload: {
          trackedFileBackups: { "/Users/foo/bar.ts": { version: 1 } },
        },
      };
      const { container } = render(<MetaBlock block={block} label="file-history-snapshot" />);
      const pathBtn = container.querySelector("[data-testid='meta-file-path']")!;
      await userEvent.click(pathBtn);
      expect(mockApiRevealInFinder).toHaveBeenCalled();
      // 失败显示 .meta-reveal-error
      const error = await screen.findByTestId("meta-file-path-error");
      expect(error).toBeInTheDocument();
      expect(error.textContent).toMatch(/PathSecurity/);
    });
  });

  describe("v0.6.x skill_listing (长列表滚动)", () => {
    it("skill 列表默认展开在 .meta-list-scrollable 内, 无 <details>", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "skill_listing",
        payload: {
          names: Array.from({ length: 14 }, (_, i) => `skill-${i}`),
          skillCount: 14,
        },
      };
      const { container } = render(<MetaBlock block={block} label="skill_listing" />);
      expect(container.querySelector("details")).toBeNull();
      const scrollable = container.querySelector(".meta-list-scrollable")!;
      expect(scrollable).toBeInTheDocument();
      // 14 个全部渲染 (DOM 内, 滚动条控制视觉)
      expect(scrollable.querySelectorAll(".meta-tag").length).toBe(14);
      // data-count 用于 CSS 计算 max-height
      expect(scrollable.getAttribute("data-count")).toBe("14");
    });
  });

  describe("v0.6.x plan_mode reveal", () => {
    it("reminderType='full' → 蓝色 pill", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "plan_mode",
        payload: {
          reminderType: "full",
          planFilePath: "/path/to/plan.md",
          planExists: false,
        },
      };
      const { container } = render(<MetaBlock block={block} label="plan_mode" />);
      const pill = container.querySelector(".meta-reminder-full");
      expect(pill).toBeInTheDocument();
      expect(pill?.textContent).toContain("full");
    });

    it("planMode 路径 → .meta-plan-block 显示 + reveal 按钮", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "plan_mode",
        payload: {
          reminderType: "full",
          planFilePath: "/Users/foo/.claude/plans/my-plan.md",
          planExists: true,
        },
      };
      const { container } = render(<MetaBlock block={block} label="plan_mode" />);
      expect(container.querySelector(".meta-plan-block")).toBeInTheDocument();
      // basename 显示
      expect(container.textContent).toContain("my-plan.md");
      // reveal 按钮
      const revealBtn = container.querySelector("[data-testid='plan-mode-reveal']");
      expect(revealBtn).toBeInTheDocument();
      // 默认展开 (无 details)
      expect(container.querySelector("details")).toBeNull();
    });

    it("点 plan_mode reveal 失败 → 显示错误提示", async () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "plan_mode",
        payload: {
          reminderType: "full",
          planFilePath: "/Users/foo/.claude/plans/my-plan.md",
          planExists: true,
        },
      };
      const { container } = render(<MetaBlock block={block} label="plan_mode" />);
      const revealBtn = container.querySelector("[data-testid='plan-mode-reveal']")!;
      await userEvent.click(revealBtn);
      expect(mockApiRevealInFinder).toHaveBeenCalled();
      // 失败 → 内联红字提示
      const error = await screen.findByTestId("plan-mode-reveal-error");
      expect(error).toBeInTheDocument();
      expect(error.textContent).toMatch(/PathSecurity|reveal 失败/);
    });
  });

  describe("pr_link 仍可工作", () => {
    it("pr-link: payload 嵌套, 显示 PR URL 链接", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "pr-link",
        payload: {
          prNumber: 42,
          prRepository: "openclaw/session-viewer",
          prUrl: "https://github.com/openclaw/session-viewer/pull/42",
        },
      };
      render(<MetaBlock block={block} label="pr-link" />);
      expect(screen.getByText("🔗 pr_link")).toBeInTheDocument();
      const link = screen.getByRole("link");
      expect(link.getAttribute("href")).toBe("https://github.com/openclaw/session-viewer/pull/42");
      expect(link.textContent).toBe("openclaw/session-viewer#42");
    });
  });

  describe("fallback", () => {
    it("未知 label → 走 UnknownBlockCard(<details>)", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "totally-future",
        payload: { foo: "bar" },
      };
      render(<MetaBlock block={block} label="totally-future" />);
      expect(document.querySelector("details")).toBeInTheDocument();
    });
  });
});
