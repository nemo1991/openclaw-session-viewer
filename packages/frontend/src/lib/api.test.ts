/**
 * api.extractErrorMessage 单元测试
 *
 * 覆盖:
 * - 字符串 error 原样返回
 * - { message: "..." } 用 message
 * - { kind: "X" } 用 kind
 * - { kind: "X", message: "Y" } 合并 "X: Y"
 * - 其它对象 JSON.stringify
 * - null / undefined / number 转 String()
 *
 * 关键:不能是 "[object Object]"
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri core so we can spy on `invoke` calls (the path correction happens
// before invoke, so we just want to verify the arguments reach the bridge).
const mockInvoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { extractErrorMessage, apiListSubagentsByMeta } from "./api";

describe("extractErrorMessage", () => {
  it("字符串原样返回", () => {
    expect(extractErrorMessage("connection failed")).toBe("connection failed");
    expect(extractErrorMessage("")).toBe("");
  });

  it("{message} 用 message 字段", () => {
    expect(extractErrorMessage({ message: "not found" })).toBe("not found");
  });

  it("{kind} 单独用 kind", () => {
    expect(extractErrorMessage({ kind: "PathSecurity" })).toBe("PathSecurity");
  });

  it("{kind, message} message 优先,只用 message (不合并)", () => {
    // 实际行为: 先 check message,有就用;不再回头合并 kind
    expect(extractErrorMessage({ kind: "PathSecurity", message: "traversal blocked" })).toBe(
      "traversal blocked"
    );
  });

  it("空对象 → JSON 序列化", () => {
    expect(extractErrorMessage({})).toBe("{}");
  });

  it("复杂对象 → JSON 序列化", () => {
    expect(extractErrorMessage({ code: 42, retry: true, msg: "wait" })).toBe(
      '{"code":42,"retry":true,"msg":"wait"}'
    );
  });

  it("null → 'null'", () => {
    expect(extractErrorMessage(null)).toBe("null");
  });

  it("undefined → 'undefined'", () => {
    expect(extractErrorMessage(undefined)).toBe("undefined");
  });

  it("number → 字符串", () => {
    expect(extractErrorMessage(42)).toBe("42");
    expect(extractErrorMessage(0)).toBe("0");
  });

  it("boolean → 字符串", () => {
    expect(extractErrorMessage(false)).toBe("false");
  });

  it("核心保证:不返回 '[object Object]'", () => {
    // Tauri invoke 抛 error 时直接 String(e) 会得到这个
    expect(extractErrorMessage({ kind: "X", message: "Y" })).not.toBe("[object Object]");
    expect(extractErrorMessage({})).not.toBe("[object Object]");
    expect(extractErrorMessage({ foo: "bar" })).not.toBe("[object Object]");
  });

  it("message 字段非字符串时 (number) 走 JSON 路径", () => {
    // e.g. { message: 42 } — 不应当作字符串
    expect(extractErrorMessage({ message: 42 })).toBe('{"message":42}');
  });

  it("嵌套对象 (有 kind 但没 message → 用 kind)", () => {
    expect(extractErrorMessage({ kind: "X", context: { a: 1 } })).toBe("X");
  });
});

/**
 * apiListSubagentsByMeta 路径修复回归测试
 *
 * Bug: 之前 `apiListSubagentsByMeta({ subagentDir: ".../session/subagents" })`
 *      直接把 ".../session/subagents" 传给 `list_subagents` 命令,
 *      后端内部又 `.join("subagents")` → ".../session/subagents/subagents"
 *      → 不存在 → 返回 [] → panel 显示 "该会话无子代理" 而非 N 行。
 *
 * 修复: helper 内 `replace(/\/subagents\/?$/, "")` 去掉尾部 `/subagents`。
 */
describe("apiListSubagentsByMeta — 路径修复 v0.5.0", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
    mockInvoke.mockResolvedValue([]);
  });

  it("subagentDir = '/parent/session/subagents' → invoke sessionDir = '/parent/session'", async () => {
    // 这是导致 panel 空显示的真 bug 场景
    mockInvoke.mockResolvedValue([
      {
        agentId: "a1d92",
        jsonlPath: "/parent/session/subagents/agent-a1d92.jsonl",
        metaPath: "/parent/session/subagents/agent-a1d92.meta.json",
        agentType: "Explore",
        description: "Test",
      },
    ]);
    await apiListSubagentsByMeta({
      subagentDir: "/parent/session/subagents",
    });
    expect(mockInvoke).toHaveBeenCalledWith("list_subagents", {
      sessionDir: "/parent/session",
    });
  });

  it("subagentDir 尾带 / 也能正确剥掉", async () => {
    await apiListSubagentsByMeta({
      subagentDir: "/parent/session/subagents/",
    });
    expect(mockInvoke).toHaveBeenCalledWith("list_subagents", {
      sessionDir: "/parent/session",
    });
  });

  it("subagentDir 缺失 → 不调 invoke,直接返 []", async () => {
    const result = await apiListSubagentsByMeta({ subagentDir: undefined });
    expect(result).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("subagentDir 是 null → 不调 invoke,直接返 []", async () => {
    const result = await apiListSubagentsByMeta({ subagentDir: null });
    expect(result).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("subagentDir 不以 /subagents 结尾 → 防御性 short-circuit(不调 invoke)", async () => {
    // 比如后端数据 schema 变化导致 subagentDir 直接是父目录 — helper 不知道
    // 该用哪条路径,保守起见 return [],避免给后端发怪路径造成 500。
    const result = await apiListSubagentsByMeta({
      subagentDir: "/parent/session",
    });
    expect(result).toEqual([]);
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
