/**
 * v0.8.10: DatabasePanel component test (item G)
 *
 * 数据库管理面板的 render 路径 + rebuild / export / import 按钮交互。
 * 通过 vi.mock 隔离 Tauri 运行时 (invoke / save / open)。
 */
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// vi.mock 必须在 import DatabasePanel 之前 — 用 hoisting 友好的 factory
const mockInvoke = vi.fn();
const mockSave = vi.fn();
const mockOpen = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => mockInvoke(cmd, args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (opts: unknown) => mockSave(opts),
  open: (opts: unknown) => mockOpen(opts),
}));

import { DatabasePanel, type SyncStatusRow } from "./DatabasePanel";

function queueStatus(overrides: Partial<SyncStatusRow> = {}) {
  const s: SyncStatusRow = {
    lastRunAt: Date.now() - 30_000,
    lastError: null,
    filesSeen: 50,
    filesSynced: 50,
    inProgress: false,
    ...overrides,
  };
  mockInvoke.mockResolvedValueOnce(s);
}

beforeEach(() => {
  cleanup();
  mockInvoke.mockReset();
  mockSave.mockReset();
  mockOpen.mockReset();
  // 默认 init 时 get_sync_status 返正常状态
  queueStatus();
  // 默认 confirm = true
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("v0.8.10 DatabasePanel", () => {
  it("渲染 panel + 显示 sync stats", async () => {
    render(<DatabasePanel />);
    const panel = await screen.findByTestId("db-panel");
    expect(panel).toBeInTheDocument();
    expect(panel.textContent).toContain("50");
  });

  it("status 显示 inProgress 时渲染 '同步中…'", async () => {
    mockInvoke.mockReset();
    queueStatus({ inProgress: true });
    render(<DatabasePanel />);
    expect(await screen.findByText("同步中…")).toBeInTheDocument();
  });

  it("status 有 lastError 时显示错误", async () => {
    mockInvoke.mockReset();
    queueStatus({ lastError: "磁盘满" });
    render(<DatabasePanel />);
    expect(await screen.findByText(/错误: 磁盘满/)).toBeInTheDocument();
  });

  it("rebuild 按钮调 rebuild_db command", async () => {
    queueStatus(); // init
    mockInvoke.mockResolvedValueOnce(undefined); // rebuild_db
    queueStatus(); // refresh after rebuild
    render(<DatabasePanel />);
    const btn = await screen.findByTestId("db-rebuild");
    await userEvent.click(btn);
    const calls = mockInvoke.mock.calls.filter((c) => c[0] === "rebuild_db");
    expect(calls.length).toBe(1);
  });

  it("rebuild confirm 取消时不调 rebuild_db", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<DatabasePanel />);
    const btn = await screen.findByTestId("db-rebuild");
    await userEvent.click(btn);
    const calls = mockInvoke.mock.calls.filter((c) => c[0] === "rebuild_db");
    expect(calls.length).toBe(0);
  });

  it("export 按钮调 save dialog + export_overrides", async () => {
    mockSave.mockResolvedValueOnce("/tmp/out.json");
    mockInvoke.mockResolvedValueOnce(5);
    render(<DatabasePanel />);
    const btn = await screen.findByTestId("db-export");
    await userEvent.click(btn);
    expect(mockSave).toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith("export_overrides", { path: "/tmp/out.json" });
  });

  it("import merge 按钮调 open dialog + import_overrides with mode merge", async () => {
    mockOpen.mockResolvedValueOnce("/tmp/in.json");
    mockInvoke.mockResolvedValueOnce(3);
    render(<DatabasePanel />);
    const btn = await screen.findByTestId("db-import-merge");
    await userEvent.click(btn);
    expect(mockOpen).toHaveBeenCalled();
    expect(mockInvoke).toHaveBeenCalledWith("import_overrides", {
      path: "/tmp/in.json",
      mode: "merge",
    });
  });

  it("import keepboth 按钮传 mode=keepboth", async () => {
    mockOpen.mockResolvedValueOnce("/tmp/in.json");
    mockInvoke.mockResolvedValueOnce(0);
    render(<DatabasePanel />);
    const btn = await screen.findByTestId("db-import-keepboth");
    await userEvent.click(btn);
    expect(mockInvoke).toHaveBeenCalledWith("import_overrides", {
      path: "/tmp/in.json",
      mode: "keepboth",
    });
  });

  it("import overwrite 按钮传 mode=overwrite", async () => {
    mockOpen.mockResolvedValueOnce("/tmp/in.json");
    mockInvoke.mockResolvedValueOnce(0);
    render(<DatabasePanel />);
    const btn = await screen.findByTestId("db-import-overwrite");
    await userEvent.click(btn);
    expect(mockInvoke).toHaveBeenCalledWith("import_overrides", {
      path: "/tmp/in.json",
      mode: "overwrite",
    });
  });

  it("export 用户取消 (save 返 null) 时不调 export_overrides", async () => {
    mockSave.mockResolvedValueOnce(null as unknown as string);
    render(<DatabasePanel />);
    const btn = await screen.findByTestId("db-export");
    await userEvent.click(btn);
    const calls = mockInvoke.mock.calls.filter((c) => c[0] === "export_overrides");
    expect(calls.length).toBe(0);
  });

  it("rebuild 成功显示 hint '数据库已重建'", async () => {
    queueStatus();
    mockInvoke.mockResolvedValueOnce(undefined);
    queueStatus();
    render(<DatabasePanel />);
    const btn = await screen.findByTestId("db-rebuild");
    await userEvent.click(btn);
    expect(await screen.findByTestId("db-hint")).toHaveTextContent("数据库已重建");
  });
});
