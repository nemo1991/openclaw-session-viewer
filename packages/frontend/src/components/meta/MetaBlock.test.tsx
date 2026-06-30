/**
 * MetaBlock 组件可视化测试
 *
 * 覆盖 4 种代表性 meta label(7 种里的关键路径):
 * - agent_listing(顶层 kind + 平铺字段,BlockRenderer 入口风格)
 * - agent_listing(meta role + payload 嵌套,meta 分支入口风格)
 * - task_reminder
 * - pr_link
 * - 默认 fallback 走 UnknownBlockCard
 *
 * v0.6.0 增强覆盖:
 * - file_snapshot: 路径列表 + reveal 点击
 * - skill_listing: 长列表折叠 (>6)
 * - plan_mode: reminder 配色 + reveal 路径按钮
 *
 * 关键回归:`payload ?? block` 双形 fallback 必须两条路径都通。
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MetaBlock } from "./MetaBlock";
import * as api from "../../lib/api";
import { useSettingsStore } from "../../state/settingsStore";
import type { NormalizedBlockFE } from "../../lib/api";

const mockApiRevealInFinder = vi.spyOn(api, "apiRevealInFinder").mockResolvedValue(undefined);

beforeEach(() => {
  cleanup();
  mockApiRevealInFinder.mockClear();
  // 关闭 settings.pathSecurity.allowRelaxed 让 reveal 走默认锁紧模式 (workspaceRoot=null)
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      pathSecurity: { allowRelaxed: false },
    } as typeof useSettingsStore extends never ? never : never,
  });
});

describe("MetaBlock", () => {
  describe("顶层平铺字段 (BlockRenderer 入口)", () => {
    it("agent_listing:顶层 kind + addedTypes 直接显示", () => {
      const block: NormalizedBlockFE = {
        kind: "agent_listing",
        addedTypes: ["Explore", "Plan"],
        isInitial: true,
      };
      render(<MetaBlock block={block} label="agent_listing" />);
      expect(screen.getByText("🤖 agent")).toBeInTheDocument();
      expect(screen.getByText(/初始化 2 个 agent/)).toBeInTheDocument();
    });

    it("agent_listing_delta:顶层 kind + addedTypes 增量", () => {
      const block: NormalizedBlockFE = {
        kind: "agent_listing_delta",
        addedTypes: ["NewAgent"],
        removedTypes: ["OldAgent"],
        isInitial: false,
      };
      render(<MetaBlock block={block} label="agent_listing_delta" />);
      expect(screen.getByText("🤖 agent")).toBeInTheDocument();
      expect(screen.getByText(/\+1 agent|\+1 \/ -1/)).toBeInTheDocument();
      expect(screen.getByText(/-1 agent|\+1 \/ -1/)).toBeInTheDocument();
    });

    it("v0.6.0: agent_listing details summary = '查看 agent 列表'", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "agent_listing",
        payload: {
          addedTypes: ["Explore", "Plan"],
          removedTypes: ["OldAgent"],
          isInitial: false,
        },
      };
      render(<MetaBlock block={block} label="agent_listing" />);
      // summary 文案存在
      expect(screen.getByText(/查看 agent 列表/)).toBeInTheDocument();
    });
  });

  describe("payload 嵌套字段 (meta 分支入口)", () => {
    it("task_reminder:meta role → payload 嵌套,显示统计 + 折叠列表", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "task_reminder",
        payload: {
          itemCount: 3,
          pendingCount: 1,
          inProgressCount: 1,
          completedCount: 1,
          content: [
            { id: "t1", status: "pending", subject: "task A" },
            { id: "t2", status: "in_progress", subject: "task B" },
            { id: "t3", status: "completed", subject: "task C" },
          ],
        },
      };
      render(<MetaBlock block={block} label="task_reminder" />);
      expect(screen.getByText("📝 task_reminder")).toBeInTheDocument();
      expect(screen.getByText(/1 待办 · 1 进行 · 1 完成/)).toBeInTheDocument();
      expect(screen.getByText(/3 个 task/)).toBeInTheDocument();
    });

    it("pr-link:payload 嵌套,显示 PR URL 链接", () => {
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

  // v0.6.0 增强覆盖
  describe("v0.6.0 file_snapshot", () => {
    it("空 trackedFileBackups → 显示 '空 snapshot (无文件)'", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "file-history-snapshot",
        payload: {
          messageId: "abc12345-6789-0abc-def0-123456789012",
          trackedFileBackups: {},
        },
      };
      render(<MetaBlock block={block} label="file-history-snapshot" />);
      expect(screen.getByText(/空 snapshot/)).toBeInTheDocument();
    });

    it("有文件 → 显示 'N 个跟踪文件' + 折叠路径列表", () => {
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
      // 列表被包在 <details> 内: 默认 <details> 是折叠的, 真实浏览器不展开
      // jsdom 同样默认 open=false; summary 显示 "查看路径 (2)"
      expect(screen.getByText(/查看路径 \(2\)/)).toBeInTheDocument();
      // 默认未展开 details → ul.meta-file-list 不存在 (hidden via DOM)
      const details = container.querySelector(".meta-details")!;
      expect(details).toBeInTheDocument();
    });

    it("点 summary 展开 details → 列出可点击 reveal 路径", async () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "file-history-snapshot",
        payload: {
          trackedFileBackups: { "/Users/foo/bar.ts": { version: 1 } },
        },
      };
      const { container } = render(<MetaBlock block={block} label="file-history-snapshot" />);
      const summary = container.querySelector(".meta-details summary")!;
      await userEvent.click(summary);
      // 展开后 meta-file-list 出现 (div summary 此时 click 触发 details[open]=true)
      // 在 jsdom 中 userEvent.click 真实切换 open
      expect(container.querySelector(".meta-file-list")).toBeInTheDocument();
      const pathBtns = container.querySelectorAll("[data-testid='meta-file-path']");
      expect(pathBtns.length).toBe(1);
    });

    it("点路径按钮 → 调 useFileReveal", async () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "file-history-snapshot",
        payload: {
          trackedFileBackups: { "/Users/foo/bar.ts": { version: 1 } },
        },
      };
      const { container } = render(<MetaBlock block={block} label="file-history-snapshot" />);
      const summary = container.querySelector(".meta-details summary")!;
      await userEvent.click(summary);
      const pathBtn = container.querySelector("[data-testid='meta-file-path']")!;
      await userEvent.click(pathBtn);
      expect(mockApiRevealInFinder).toHaveBeenCalled();
    });
  });

  describe("v0.6.0 skill_listing", () => {
    it("skill 数 ≤ 6 → 不折叠,inline 显示", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "skill_listing",
        payload: {
          names: ["drawio", "verify", "init"],
          skillCount: 3,
        },
      };
      const { container } = render(<MetaBlock block={block} label="skill_listing" />);
      expect(container.querySelector(".meta-list-inline")).toBeInTheDocument();
      expect(screen.getByText("drawio")).toBeInTheDocument();
    });

    it("skill 数 > 6 → 显示 details summary 提示 '查看全部 N 个'", () => {
      const block: NormalizedBlockFE = {
        kind: "meta",
        label: "skill_listing",
        payload: {
          names: Array.from({ length: 14 }, (_, i) => `skill-${i}`),
          skillCount: 14,
        },
      };
      const { container } = render(<MetaBlock block={block} label="skill_listing" />);
      // summary 上写 "查看全部 14 个"
      expect(screen.getByText(/查看全部 14 个/)).toBeInTheDocument();
      // inline list 不存在 (因为走 details 分支)
      expect(container.querySelector(".meta-list-inline")).toBeNull();
      // 折叠状态下 details 元素存在但 open=false
      const details = container.querySelector(".meta-details")!;
      expect(details).toBeInTheDocument();
    });
  });

  describe("v0.6.0 plan_mode", () => {
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

    it("planMode 有路径 → details summary 显示文件名 + reveal 按钮", () => {
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
      expect(container.textContent).toContain("my-plan.md");
      const revealBtn = container.querySelector("[data-testid='plan-mode-reveal']");
      expect(revealBtn).toBeInTheDocument();
    });

    it("点 plan_mode reveal → 调 apiRevealInFinder", async () => {
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
      const summary = container.querySelector(".meta-details-plan summary")!;
      await userEvent.click(summary);
      const revealBtn = container.querySelector("[data-testid='plan-mode-reveal']")!;
      await userEvent.click(revealBtn);
      expect(mockApiRevealInFinder).toHaveBeenCalled();
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
      // UnknownBlockCard 是 <details>
      expect(document.querySelector("details")).toBeInTheDocument();
    });
  });
});
