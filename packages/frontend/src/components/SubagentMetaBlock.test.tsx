// @vitest-environment jsdom
/**
 * SubagentMetaBlock 单元测试 (v0.6.x)
 *
 * 覆盖:
 * - mode / permission / title / last-prompt 4 种 label 走对应解析
 * - last-prompt 跳按钮 ready/disabled 视觉态 (单一按钮)
 * - title 复制按钮
 * - 默认展开 (无 details 折叠)
 * - 上/下结构 (prompt 上, 跳按钮下)
 * - leafUuid 命中 entries → 跳按钮 enabled
 * - leafUuid 不命中 → 跳按钮 disabled + console.warn
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SubagentMetaBlock } from "./SubagentMetaBlock";
import { useTranscriptStore } from "../state/transcriptStore";
import type { NormalizedBlockFE, TranscriptEntryOut } from "../lib/api";

// 提供 :sessionId 给 useParams
function renderInRoute(element: React.ReactNode, path = "/session/test-id") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/session/:sessionId" element={element} />
      </Routes>
    </MemoryRouter>
  );
}

function makeBlock(label: string, payload: unknown): NormalizedBlockFE {
  return { kind: "meta", label, payload };
}

function makeEntry(index: number, id: string, role = "user"): TranscriptEntryOut {
  return {
    index,
    byteOffset: 0,
    raw: {},
    normalized: {
      id,
      role,
      blocks: [{ kind: "text", text: "hi" }],
      rawType: role,
    },
  };
}

beforeEach(() => {
  cleanup();
  useTranscriptStore.setState({
    path: null,
    entries: [],
    loading: false,
    totalCount: 0,
    loadedCount: 0,
    error: null,
    jumpTarget: null,
    lastJumpedId: null,
    lastJumpedAt: 0,
  });
});

describe("SubagentMetaBlock", () => {
  describe("v0.6.x: 默认展开 (无 <details>)", () => {
    it("mode 块 → 不是 <details> 元素, 是平面 <div>", () => {
      const { container } = renderInRoute(
        <SubagentMetaBlock block={makeBlock("mode: normal", "normal")} />
      );
      expect(container.querySelector("details")).toBeNull();
      expect(container.querySelector(".subagent-meta-block-flat")).toBeInTheDocument();
    });

    it("title 块 → 不是 <details>, 内容直接显示", () => {
      const { container } = renderInRoute(
        <SubagentMetaBlock block={makeBlock("title", "我的会话标题")} />
      );
      expect(container.querySelector("details")).toBeNull();
      // 内容 (不是折叠隐藏)
      expect(container.querySelector(".subagent-meta-text-title")).toBeInTheDocument();
    });
  });

  describe("v0.6.x: mode/permission chip 配色", () => {
    it("mode 'plan' → chip tone='plan' (蓝色)", () => {
      const { container } = renderInRoute(
        <SubagentMetaBlock block={makeBlock("mode: plan", "plan")} />
      );
      const chip = container.querySelector(".subagent-meta-value")!;
      expect(chip.getAttribute("data-tone")).toBe("plan");
      expect(chip.className).toMatch(/subagent-meta-value-plan/);
    });

    it("mode 'bypass-permissions' → chip tone='danger' (红色)", () => {
      const { container } = renderInRoute(
        <SubagentMetaBlock block={makeBlock("mode: bypass-permissions", "bypass-permissions")} />
      );
      const chip = container.querySelector(".subagent-meta-value")!;
      expect(chip.getAttribute("data-tone")).toBe("danger");
    });

    it("mode 'normal' → chip tone='neutral' (灰色)", () => {
      const { container } = renderInRoute(
        <SubagentMetaBlock block={makeBlock("mode: normal", "normal")} />
      );
      const chip = container.querySelector(".subagent-meta-value")!;
      expect(chip.getAttribute("data-tone")).toBe("neutral");
    });

    it("permission 'plan' → chip 显示 + 同样 plan tone", () => {
      const { container } = renderInRoute(
        <SubagentMetaBlock block={makeBlock("permission: plan", "plan")} />
      );
      const chip = container.querySelector(".subagent-meta-value")!;
      expect(chip?.textContent).toContain("plan");
      expect(chip.getAttribute("data-tone")).toBe("plan");
    });
  });

  describe("v0.6.x: title 复制按钮", () => {
    it("title 渲染 [复制] 按钮", () => {
      const { container } = renderInRoute(
        <SubagentMetaBlock block={makeBlock("title", "我的会话标题")} />
      );
      const copyBtn = container.querySelector("[data-testid='subagent-meta-copy']");
      expect(copyBtn).toBeInTheDocument();
      expect(copyBtn?.textContent).toContain("复制");
    });

    it("title 文本用 .subagent-meta-text-title (无 ellipsis 截断)", () => {
      const { container } = renderInRoute(
        <SubagentMetaBlock block={makeBlock("title", "很长的会话标题用来测试不截断")} />
      );
      const span = container.querySelector(".subagent-meta-text-title");
      expect(span?.textContent).toContain("很长的会话标题用来测试不截断");
    });
  });

  describe("v0.6.x: last-prompt 上下结构", () => {
    it("last-prompt → prompt 在上, 跳按钮在下", () => {
      const targetUuid = "a1b2c3d4-5e6f-7890-abcd-ef0123456789";
      useTranscriptStore.setState({
        entries: [makeEntry(0, targetUuid)],
      });
      const { container } = renderInRoute(
        <SubagentMetaBlock
          block={makeBlock("last-prompt", {
            prompt: "测试 prompt 全文",
            leafUuid: targetUuid,
          })}
        />
      );
      // detail 和 button 都存在
      const detail = container.querySelector(".subagent-meta-detail");
      const jumpBtn = container.querySelector(".subagent-meta-jump-btn");
      expect(detail?.textContent).toContain("测试 prompt 全文");
      expect(jumpBtn).toBeInTheDocument();

      // 跳按钮在 .subagent-meta-action-row 内 (扁平结构, 在 detail 下方)
      const actionRow = container.querySelector(".subagent-meta-action-row");
      expect(actionRow).toBeInTheDocument();
      expect(actionRow?.contains(jumpBtn!)).toBe(true);
    });

    it("last-prompt 上方 summary 显示 'N 字' 标签", () => {
      const { container } = renderInRoute(
        <SubagentMetaBlock
          block={makeBlock("last-prompt", { prompt: "测试 prompt", leafUuid: "abc" })}
        />
      );
      const summaryTags = container.querySelectorAll(".subagent-meta-tag");
      // "N 字" tag (用了 .subagent-meta-tag,不含 -length class 区分)
      const lengthTag = Array.from(summaryTags).find((t) => t.textContent?.includes("字"));
      expect(lengthTag?.textContent).toContain("字");
    });
  });

  describe("v0.6.x: 单一跳按钮 (用户报: 只保留一个)", () => {
    it("命中 → 跳按钮 data-state='ready'", () => {
      const targetUuid = "a1b2c3d4-5e6f-7890-abcd-ef0123456789";
      useTranscriptStore.setState({
        entries: [makeEntry(0, targetUuid)],
      });
      const { container } = renderInRoute(
        <SubagentMetaBlock
          block={makeBlock("last-prompt", { prompt: "p", leafUuid: targetUuid })}
        />
      );
      const btn = container.querySelector("[data-testid='last-prompt-jump']");
      expect(btn).toBeInTheDocument();
      expect(btn?.getAttribute("data-state")).toBe("ready");
    });

    it("不命中 → 跳按钮 data-state='disabled' + disabled class", () => {
      const { container } = renderInRoute(
        <SubagentMetaBlock
          block={makeBlock("last-prompt", { prompt: "p", leafUuid: "missing-uuid" })}
        />
      );
      const btn = container.querySelector("[data-testid='last-prompt-jump']");
      expect(btn?.getAttribute("data-state")).toBe("disabled");
      expect(btn?.className).toMatch(/subagent-meta-jump-btn-disabled/);
    });

    it("命中时点按钮 → store.jumpTarget = matched index", async () => {
      const targetUuid = "a1b2c3d4-5e6f-7890-abcd-ef0123456789";
      useTranscriptStore.setState({
        entries: [makeEntry(7, targetUuid)],
      });
      const { container } = renderInRoute(
        <SubagentMetaBlock
          block={makeBlock("last-prompt", { prompt: "p", leafUuid: targetUuid })}
        />
      );
      const btn = container.querySelector("[data-testid='last-prompt-jump']")!;
      await userEvent.click(btn);
      expect(useTranscriptStore.getState().jumpTarget).toBe(7);
    });

    it("不命中时点按钮 → 不调 jumpTo, console.warn", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { container } = renderInRoute(
        <SubagentMetaBlock
          block={makeBlock("last-prompt", { prompt: "p", leafUuid: "missing-uuid" })}
        />
      );
      const btn = container.querySelector("[data-testid='last-prompt-jump']")!;
      await userEvent.click(btn);
      expect(useTranscriptStore.getState().jumpTarget).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it("只渲染一个跳按钮 (用户报: 只保留一个)", () => {
      const targetUuid = "a1b2c3d4-5e6f-7890-abcd-ef0123456789";
      useTranscriptStore.setState({
        entries: [makeEntry(0, targetUuid)],
      });
      const { container } = renderInRoute(
        <SubagentMetaBlock
          block={makeBlock("last-prompt", { prompt: "p", leafUuid: targetUuid })}
        />
      );
      const allJumpBtns = container.querySelectorAll("[data-testid='last-prompt-jump']");
      expect(allJumpBtns.length).toBe(1);
      // summary-jump 按钮已移除
      const summaryJumpBtns = container.querySelectorAll(
        "[data-testid='last-prompt-summary-jump']"
      );
      expect(summaryJumpBtns.length).toBe(0);
    });
  });
});
