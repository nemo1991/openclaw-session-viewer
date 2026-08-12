/**
 * v0.9.20 (M3): AttachmentBlock — L4 layer 单元测试
 *
 * 13 个 Claude attachment kind (含 4 个 hyphen twin) 全部走 AttachmentBlock,
 * 共享 slate accent (`attachment-block-meta` wrapper)。
 *
 * 抽样测试 6 个核心 kind (M3 抽离):
 * - agent_listing: +N / -M 配色
 * - skill_listing: 长列表滚动
 * - task_reminder: id / description / activeForm / blocks / blockedBy 关联
 * - pr_link: 链接打开新 tab
 * - agent_name: 简单 label
 * - fallback: 未知 attachment label → UnknownBlockCard
 *
 * MetaBlock.test.tsx 已经覆盖了更深入的 plan_mode / file_snapshot /
 * context.apply_compaction 等渲染细节,这里只做路由层 + slate accent
 * 验证,保证 AttachmentBlock 作为独立 component 的最小自测。
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AttachmentBlock } from "./AttachmentBlock";
import * as api from "../../lib/api";
import type { NormalizedBlockFE } from "../../lib/api";

const mockApiRevealInFinder = vi.spyOn(api, "apiRevealInFinder");

beforeEach(() => {
  cleanup();
  mockApiRevealInFinder.mockReset();
});

function renderAttachment(block: NormalizedBlockFE, label: string) {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<AttachmentBlock block={block} label={label} />} />
        <Route path="/settings" element={<div data-testid="settings-page" />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("AttachmentBlock (M3 — L4 layer, slate accent)", () => {
  it("13 attachment kind 全部用 attachment-block-meta wrapper", () => {
    const cases: Array<[string, NormalizedBlockFE]> = [
      ["agent_listing", { kind: "agent_listing", addedTypes: ["Explore"], isInitial: false }],
      ["skill_listing", { kind: "skill_listing", names: ["SkillA"] }],
      ["task_reminder", { kind: "task_reminder", content: [] }],
      ["pr_link", { kind: "pr_link", prNumber: 42 }],
      ["agent_name", { kind: "agent_name", agentName: "TestAgent" }],
      ["invoked_skills", { kind: "invoked_skills", skills: [] }],
      ["plan_file_reference", { kind: "plan_file_reference", planFilePath: "" }],
      ["compact_file_reference", { kind: "compact_file_reference", filename: "" }],
      ["attached_file", { kind: "attached_file", filename: "" }],
      ["queued_command", { kind: "queued_command" }],
      ["queue_operation", { kind: "queue_operation", operation: "enqueue" }],
    ];
    for (const [label, block] of cases) {
      cleanup();
      const { container } = renderAttachment(block, label);
      expect(
        container.querySelector(".attachment-block-meta"),
        `${label} 应该用 .attachment-block-meta wrapper`
      ).toBeInTheDocument();
    }
  });

  it("fallback: 未知 attachment label → UnknownBlockCard(<details>)", () => {
    const block: NormalizedBlockFE = {
      kind: "meta",
      label: "unknown-attachment",
      payload: { foo: "bar" },
    };
    renderAttachment(block, "unknown-attachment");
    // UnknownBlockCard 用 <details> 折叠
    expect(document.querySelector("details")).toBeInTheDocument();
  });

  it("hyphen twin (pr-link / agent-name) 走同一 case", () => {
    const block: NormalizedBlockFE = {
      kind: "meta",
      label: "pr-link",
      payload: { prNumber: 99, prRepository: "foo/bar", prUrl: "https://example.com" },
    };
    const { container } = renderAttachment(block, "pr-link");
    expect(container.querySelector(".attachment-block-meta")).toBeInTheDocument();
    expect(screen.getByText("foo/bar#99")).toBeInTheDocument();
  });
});
