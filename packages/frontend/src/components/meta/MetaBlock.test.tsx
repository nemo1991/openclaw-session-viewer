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
 * 关键回归:`payload ?? block` 双形 fallback 必须两条路径都通。
 */

// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MetaBlock } from "./MetaBlock";
import type { NormalizedBlockFE } from "../../lib/api";

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
      expect(screen.getByText(/\+1 agent/)).toBeInTheDocument();
      expect(screen.getByText(/-1 agent/)).toBeInTheDocument();
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
