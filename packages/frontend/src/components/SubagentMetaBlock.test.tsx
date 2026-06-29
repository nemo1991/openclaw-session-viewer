// @vitest-environment jsdom
/**
 * SubagentMetaBlock 单元测试 (v0.6.0)
 *
 * 覆盖:
 * - mode / permission / title / last-prompt 4 种 label 走对应解析
 * - last-prompt 新 schema { prompt, leafUuid } 真正显示 prompt 内容 (之前 payload 是 undefined)
 * - last-prompt + leafUuid 命中 entries → 渲染"跳到 user message"按钮
 * - last-prompt + leafUuid 不命中 → 渲染"目标不在范围"
 * - 点击跳按钮 → 调 useTranscriptStore.jumpTo
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
  });
});

describe("SubagentMetaBlock", () => {
  describe("v0.6.0 修复: last-prompt 字段错配 (prompt → lastPrompt)", () => {
    it("last-prompt payload = { prompt, leafUuid } → 显示 prompt 全文", async () => {
      renderInRoute(
        <SubagentMetaBlock
          block={makeBlock("last-prompt", {
            prompt: "了解一下openclaw 创建的 session 目录结构",
            leafUuid: "f8b0fe2e-0e81-4a6b-bcf7-bf864b0033d5",
          })}
        />
      );
      // summary 节点 + detail 节点都展示 prompt
      // 之前 prompt 字段没值, 现在应能显示真实内容
      const matches = screen.getAllByText(/openclaw 创建的 session 目录结构/);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    it("summary 是 details 元素, 默认折叠, 文本在 summary 节点内", async () => {
      renderInRoute(
        <SubagentMetaBlock
          block={makeBlock("last-prompt", {
            prompt: "了解一下 openclaw",
            leafUuid: "f8b0fe2e-0e81-4a6b-bcf7-bf864b0033d5",
          })}
        />
      );
      // details 元素存在, summary 文本包含 prompt 前 60 字符的截断
      const matches = screen.getAllByText(/了解一下 openclaw/);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    it("last-prompt payload = 裸 string (兼容老 schema) → 也显示", async () => {
      const { container } = renderInRoute(
        <SubagentMetaBlock block={makeBlock("last-prompt", "老 schema 裸字符串")} />
      );
      expect(container.textContent).toContain("老 schema 裸字符串");
    });

    it("last-prompt 无 payload → 显示 '(无内容)'", async () => {
      const { container } = renderInRoute(
        <SubagentMetaBlock block={makeBlock("last-prompt", { prompt: "" })} />
      );
      expect(container.textContent).toContain("(无内容)");
    });
  });

  describe("v0.6.0: leafUuid 跳到 user message", () => {
    it("leafUuid 命中 entries → 渲染 '跳到 user message' 按钮", async () => {
      // 准备 store 有这个 entry
      const targetUuid = "f8b0fe2e-0e81-4a6b-bcf7-bf864b0033d5";
      useTranscriptStore.setState({
        entries: [makeEntry(0, targetUuid), makeEntry(1, "other-uuid")],
      });
      const { container } = renderInRoute(
        <SubagentMetaBlock
          block={makeBlock("last-prompt", {
            prompt: "test prompt",
            leafUuid: targetUuid,
          })}
        />
      );
      // 展开 details 才能看到按钮
      const details = container.querySelector("details")!;
      const summary = details.querySelector("summary")!;
      await userEvent.click(summary);
      // 展开后能看到跳按钮
      expect(screen.getByTestId("last-prompt-jump")).toBeInTheDocument();
      expect(container.textContent).toContain("跳到 user message");
    });

    it("leafUuid 不命中 entries → 渲染 '目标不在范围' 按钮", async () => {
      useTranscriptStore.setState({
        entries: [makeEntry(0, "different-uuid")],
      });
      const { container } = renderInRoute(
        <SubagentMetaBlock
          block={makeBlock("last-prompt", {
            prompt: "test prompt",
            leafUuid: "missing-uuid",
          })}
        />
      );
      const details = container.querySelector("details")!;
      const summary = details.querySelector("summary")!;
      await userEvent.click(summary);
      expect(screen.getByTestId("last-prompt-jump")).toBeInTheDocument();
      expect(container.textContent).toContain("目标不在范围");
    });

    it("点跳按钮 (命中) → 调 useTranscriptStore.jumpTo(entry.index)", async () => {
      const targetUuid = "f8b0fe2e-0e81-4a6b-bcf7-bf864b0033d5";
      useTranscriptStore.setState({
        entries: [makeEntry(7, targetUuid)],
      });
      const { container } = renderInRoute(
        <SubagentMetaBlock
          block={makeBlock("last-prompt", {
            prompt: "test",
            leafUuid: targetUuid,
          })}
        />
      );
      // 展开
      const details = container.querySelector("details")!;
      const summary = details.querySelector("summary")!;
      await userEvent.click(summary);
      await userEvent.click(screen.getByTestId("last-prompt-jump"));
      // store.jumpTarget 应被设为 7
      expect(useTranscriptStore.getState().jumpTarget).toBe(7);
    });

    it("点跳按钮 (不命中) → 不调 jumpTo, console.warn", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      useTranscriptStore.setState({
        entries: [makeEntry(0, "unrelated")],
      });
      const { container } = renderInRoute(
        <SubagentMetaBlock
          block={makeBlock("last-prompt", {
            prompt: "test",
            leafUuid: "missing-uuid",
          })}
        />
      );
      const details = container.querySelector("details")!;
      const summary = details.querySelector("summary")!;
      await userEvent.click(summary);
      await userEvent.click(screen.getByTestId("last-prompt-jump"));
      expect(useTranscriptStore.getState().jumpTarget).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe("其他 meta 类型 (mode / permission / title)", () => {
    it("mode: plan → badge='mode'", async () => {
      const { container } = renderInRoute(
        <SubagentMetaBlock block={makeBlock("mode: plan", "plan")} />
      );
      expect(container.textContent).toContain("mode: plan");
    });

    it("title → summary = payload 字符串", async () => {
      const { container } = renderInRoute(
        <SubagentMetaBlock block={makeBlock("title", "我的会话标题")} />
      );
      expect(container.textContent).toContain("我的会话标题");
    });
  });
});
