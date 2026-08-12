// @vitest-environment jsdom
/**
 * v0.9.24 (M7-C): SessionNotesPanel — L0 层 notes + links + link dialog 单元测试
 *
 * 覆盖:
 * - notes 隐藏 (无 override + notesEditing=false)
 * - notes 显示 (有 override)
 * - notes 显示 (notesEditing=true)
 * - notes 编辑模式 → 保存 → 调 overrides.setNotes
 * - link dialog 渲染 (linkDialogOpen=true)
 * - link dialog 提交 → 调 overrides.addLink + onLinkDialogClose + 清空 input
 * - link dialog 取消 → onLinkDialogClose (不调 addLink)
 * - links 列表渲染 (linksTo / linksFrom)
 * - 删除 link → 调 overrides.removeLink
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionNotesPanel } from "./SessionNotesPanel";
import type { SessionMeta } from "@ocsv/shared";

// ===== Mock overridesStore =====
const mockSetNotes = vi.fn(async () => {});
const mockAddLink = vi.fn(async () => {});
const mockRemoveLink = vi.fn(async () => {});
const snap: {
  renames: Record<string, string>;
  hidden: Record<string, boolean>;
  pinned: Record<string, boolean>;
  archived: Record<string, boolean>;
  notes: Record<string, string>;
  tags: Record<string, Array<{ id: number; name: string; color: string | null }>>;
  tagsAll: Array<{ id: number; name: string; color: string | null }>;
  linksTo: Record<
    string,
    Array<{ fromSession: string; toSession: string; note: string | null; createdAt: number }>
  >;
  linksFrom: Record<
    string,
    Array<{ fromSession: string; toSession: string; note: string | null; createdAt: number }>
  >;
} = {
  renames: {},
  hidden: {},
  pinned: {},
  archived: {},
  notes: {},
  tags: {},
  tagsAll: [],
  linksTo: {},
  linksFrom: {},
};
vi.mock("../../state/overridesStore", () => ({
  useOverrides: () => ({
    snap,
    setNotes: mockSetNotes,
    addLink: mockAddLink,
    removeLink: mockRemoveLink,
  }),
}));

// ===== Helper =====
const baseMeta: SessionMeta = {
  sessionId: "s1",
  projectKey: "p1",
  workspaceGuess: "/tmp",
  source: "claude",
  jsonlPath: "/tmp/s1.jsonl",
  sizeBytes: 1024,
  mtimeMs: 0,
  messageCount: 5,
  title: "Test",
  hasTrajectory: false,
};

function renderPanel(props: Partial<React.ComponentProps<typeof SessionNotesPanel>> = {}) {
  const onNotesToggle = vi.fn();
  const onLinkAdd = vi.fn();
  const onLinkDialogClose = vi.fn();
  return {
    onNotesToggle,
    onLinkAdd,
    onLinkDialogClose,
    ...render(
      <SessionNotesPanel
        meta={baseMeta}
        notesEditing={false}
        onNotesToggle={onNotesToggle}
        linkDialogOpen={false}
        onLinkAdd={onLinkAdd}
        onLinkDialogClose={onLinkDialogClose}
        {...props}
      />
    ),
  };
}

describe("SessionNotesPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snap.notes = {};
    snap.linksTo = {};
    snap.linksFrom = {};
  });

  it("无 override + notesEditing=false → 不渲染 notes panel", () => {
    const { container } = renderPanel();
    expect(container.querySelector('[data-testid="session-notes-panel"]')).toBeNull();
  });

  it("有 override.notes → 渲染 notes panel (read-only 模式)", () => {
    snap.notes = { s1: "我的笔记" };
    renderPanel();
    expect(screen.getByTestId("session-notes-panel")).toBeInTheDocument();
    expect(screen.getByText("我的笔记")).toBeInTheDocument();
    // 编辑 button 可见 (因 notesEditing=false)
    expect(screen.getByText("编辑")).toBeInTheDocument();
    // textarea 不显示
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("notesEditing=true → 显示 textarea + 保存 button", () => {
    renderPanel({ notesEditing: true });
    expect(screen.getByTestId("session-notes-panel")).toBeInTheDocument();
    const textarea = document.querySelector("textarea");
    expect(textarea).toBeInTheDocument();
    expect(screen.getByText("保存")).toBeInTheDocument();
    expect(screen.queryByText("编辑")).toBeNull();
  });

  it("编辑模式下点保存 → 调 overrides.setNotes + onNotesToggle", () => {
    const { onNotesToggle } = renderPanel({ notesEditing: true });
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "新笔记内容" } });
    fireEvent.click(screen.getByText("保存"));
    expect(mockSetNotes).toHaveBeenCalledWith("s1", "新笔记内容");
    expect(onNotesToggle).toHaveBeenCalled();
  });

  it("点 notes '编辑' button → 调 onNotesToggle", () => {
    snap.notes = { s1: "已有笔记" };
    const { onNotesToggle } = renderPanel();
    fireEvent.click(screen.getByText("编辑"));
    expect(onNotesToggle).toHaveBeenCalled();
  });

  it("linksTo.length > 0 → 渲染 links 列表 + 删除 button", () => {
    snap.linksTo = {
      s1: [{ fromSession: "s1", toSession: "target-session-12345", note: "看这里", createdAt: 0 }],
    };
    renderPanel();
    expect(screen.getByText(/target-sessi…/)).toBeInTheDocument();
    expect(screen.getByText(/(看这里)/)).toBeInTheDocument();
    // 删除 button
    expect(screen.getByTitle("删除链接")).toBeInTheDocument();
  });

  it("删除 link → 调 overrides.removeLink", () => {
    snap.linksTo = {
      s1: [{ fromSession: "s1", toSession: "t1", note: null, createdAt: 0 }],
    };
    renderPanel();
    fireEvent.click(screen.getByTitle("删除链接"));
    expect(mockRemoveLink).toHaveBeenCalledWith("s1", "t1");
  });

  it("linksFrom 渲染但不显示删除 button", () => {
    snap.linksFrom = {
      s1: [{ fromSession: "from-session-1", toSession: "s1", note: null, createdAt: 0 }],
    };
    renderPanel();
    // "from-session-1" → slice(0, 12) = "from-session" + "…" = "from-session…"
    expect(screen.getByText(/from-session…/)).toBeInTheDocument();
    // 被链接区域只有文字, 没有 删除 button (linksFrom 是被动的)
    expect(screen.queryByTitle("删除链接")).toBeNull();
  });

  it("无 links → 不渲染 links 面板", () => {
    const { container } = renderPanel();
    expect(container.querySelector(".session-links-panel")).toBeNull();
  });

  it("linkDialogOpen=true → 显示 link dialog backdrop", () => {
    renderPanel({ linkDialogOpen: true });
    expect(document.querySelector(".link-dialog-backdrop")).toBeInTheDocument();
    expect(document.querySelector(".link-dialog")).toBeInTheDocument();
    expect(screen.getByText("链接到其他 session")).toBeInTheDocument();
  });

  it("linkDialogOpen=false → 不渲染 link dialog", () => {
    const { container } = renderPanel({ linkDialogOpen: false });
    expect(container.querySelector(".link-dialog-backdrop")).toBeNull();
  });

  it("link dialog 点 backdrop → 调 onLinkDialogClose", () => {
    renderPanel({ linkDialogOpen: true });
    const backdrop = document.querySelector(".link-dialog-backdrop") as HTMLElement;
    fireEvent.click(backdrop);
    expect(mockAddLink).not.toHaveBeenCalled();
  });

  it("link dialog 提交 → 调 overrides.addLink + onLinkDialogClose", async () => {
    const { onLinkDialogClose } = renderPanel({ linkDialogOpen: true });
    const inputs = document.querySelectorAll(".link-dialog input");
    const targetInput = inputs[0] as HTMLInputElement;
    const noteInput = inputs[1] as HTMLInputElement;
    fireEvent.change(targetInput, { target: { value: "target-1" } });
    fireEvent.change(noteInput, { target: { value: "备注内容" } });
    fireEvent.click(screen.getByText("添加"));
    expect(mockAddLink).toHaveBeenCalledWith("s1", "target-1", "备注内容");
    // addLink 是 async, 等 await mockAddLink resolve 后才调 onLinkDialogClose
    await waitFor(() => {
      expect(onLinkDialogClose).toHaveBeenCalled();
    });
  });

  it("link dialog 取消 → 调 onLinkDialogClose (不调 addLink)", () => {
    const { onLinkDialogClose } = renderPanel({ linkDialogOpen: true });
    fireEvent.click(screen.getByText("取消"));
    expect(mockAddLink).not.toHaveBeenCalled();
    expect(onLinkDialogClose).toHaveBeenCalled();
  });
});
