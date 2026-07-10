/**
 * applyTimeFilter 单元测试
 *
 * 覆盖:
 * - 无 range → 直通(返回原数组引用)
 * - 只 from / 只 to / 完整区间 / 区间无匹配
 * - 缺 timestamp 的 entry 保留
 * - timestamp 解析失败的 entry 保留
 * - 区间边界包含(>=, <=)
 * - 多次调用稳定(纯函数)
 */

import { describe, it, expect } from "vitest";
import { applyTimeFilter } from "./filterEntries";
import type { TranscriptEntryOut } from "./api";

function makeEntry(index: number, ts?: string): TranscriptEntryOut {
  return {
    index,
    byteOffset: index * 1000,
    raw: {},
    normalized: {
      id: `e-${index}`,
      role: "assistant",
      rawType: "test",
      timestamp: ts,
      blocks: [],
    },
  };
}

describe("applyTimeFilter", () => {
  it("无 range → 直通(元素全部保留)", () => {
    const entries = [makeEntry(0, "2026-06-25T10:00:00Z"), makeEntry(1)];
    const out = applyTimeFilter(entries, {});
    // .filter 始终返回新数组 — 断言内容而不是引用
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(entries[0]); // 元素引用复用
    expect(out[1]).toBe(entries[1]);
  });

  it("只 from:保留 >= from 的 entry", () => {
    const entries = [
      makeEntry(0, "2026-06-25T09:00:00Z"),
      makeEntry(1, "2026-06-25T10:00:00Z"),
      makeEntry(2, "2026-06-25T11:00:00Z"),
    ];
    const out = applyTimeFilter(entries, { from: "2026-06-25T10:00:00Z" });
    expect(out.map((e) => e.index)).toEqual([1, 2]);
  });

  it("只 to:保留 <= to 的 entry", () => {
    const entries = [
      makeEntry(0, "2026-06-25T09:00:00Z"),
      makeEntry(1, "2026-06-25T10:00:00Z"),
      makeEntry(2, "2026-06-25T11:00:00Z"),
    ];
    const out = applyTimeFilter(entries, { to: "2026-06-25T10:00:00Z" });
    expect(out.map((e) => e.index)).toEqual([0, 1]);
  });

  it("完整 from+to:闭区间 [from, to]", () => {
    const entries = [
      makeEntry(0, "2026-06-25T09:00:00Z"),
      makeEntry(1, "2026-06-25T10:00:00Z"),
      makeEntry(2, "2026-06-25T10:30:00Z"),
      makeEntry(3, "2026-06-25T11:00:00Z"),
    ];
    const out = applyTimeFilter(entries, {
      from: "2026-06-25T10:00:00Z",
      to: "2026-06-25T11:00:00Z",
    });
    expect(out.map((e) => e.index)).toEqual([1, 2, 3]);
  });

  it("区间内无匹配 → []", () => {
    const entries = [makeEntry(0, "2026-06-25T09:00:00Z"), makeEntry(1, "2026-06-25T11:00:00Z")];
    const out = applyTimeFilter(entries, {
      from: "2026-06-25T10:00:00Z",
      to: "2026-06-25T10:30:00Z",
    });
    expect(out).toEqual([]);
  });

  it("缺 timestamp 的 entry 保留", () => {
    const entries = [makeEntry(0), makeEntry(1, "2026-06-25T10:00:00Z")];
    const out = applyTimeFilter(entries, {
      from: "2026-06-25T09:00:00Z",
      to: "2026-06-25T11:00:00Z",
    });
    // e-0 没 timestamp → 保留;e-1 在区间 → 保留
    expect(out.map((e) => e.index)).toEqual([0, 1]);
  });

  it("timestamp 解析失败的 entry 保留", () => {
    const entries = [makeEntry(0, "not-a-date"), makeEntry(1, "2026-06-25T10:00:00Z")];
    const out = applyTimeFilter(entries, {
      from: "2026-06-25T09:00:00Z",
      to: "2026-06-25T11:00:00Z",
    });
    expect(out.map((e) => e.index)).toEqual([0, 1]);
  });

  it("边界包含(>=, <=):from/to 完全相等时该 entry 保留", () => {
    const entries = [makeEntry(0, "2026-06-25T10:00:00Z")];
    const out = applyTimeFilter(entries, {
      from: "2026-06-25T10:00:00Z",
      to: "2026-06-25T10:00:00Z",
    });
    expect(out).toHaveLength(1);
  });

  it("纯函数:相同输入多次调用结果引用稳定", () => {
    const entries = [makeEntry(0, "2026-06-25T10:00:00Z")];
    const out1 = applyTimeFilter(entries, { from: "2026-06-25T09:00:00Z" });
    const out2 = applyTimeFilter(entries, { from: "2026-06-25T09:00:00Z" });
    // 输入相同 → 不同数组但元素引用一致
    expect(out1).not.toBe(out2);
    expect(out1[0]).toBe(out2[0]);
  });
});

// ===== v0.7.0: applyContentFilter =====

import { applyContentFilter } from "./filterEntries";

function makeBlockEntry(
  index: number,
  blocks: Array<{ kind: string; name?: string; thinking?: string; text?: string }>,
  opts: {
    role?: string;
    stopReason?: string | null;
    subagentId?: string;
    isSidechain?: boolean;
    model?: string;
  } = {}
): TranscriptEntryOut {
  return {
    index,
    byteOffset: index * 1000,
    raw: {},
    normalized: {
      id: `e-${index}`,
      role: opts.role ?? "assistant",
      rawType: "test",
      timestamp: undefined,
      blocks: blocks as TranscriptEntryOut["normalized"]["blocks"],
      stopReason: opts.stopReason ?? null,
      subagentId: opts.subagentId,
      isSidechain: opts.isSidechain,
      model: opts.model,
    },
  };
}

describe("applyContentFilter", () => {
  it("全部维度空 → 直通(返回 entries 引用)", () => {
    const entries = [makeBlockEntry(0, [{ kind: "text", text: "hi" }])];
    const out = applyContentFilter(entries, {});
    expect(out).toBe(entries); // 没 filter 时 .filter 也不创建 — 用 === 直接返回原引用
  });

  it("tool 多选:任一 tool_use.name 命中即保留", () => {
    const entries = [
      makeBlockEntry(0, [{ kind: "tool_use", name: "Bash" }]),
      makeBlockEntry(1, [{ kind: "tool_use", name: "Read" }]),
      makeBlockEntry(2, [{ kind: "text", text: "no tool" }]),
      makeBlockEntry(3, [{ kind: "tool_use", name: "Edit" }]),
    ];
    const out = applyContentFilter(entries, { tools: ["Bash", "Read"] });
    expect(out.map((e) => e.index)).toEqual([0, 1]);
  });

  it("tool_use 块没 name 字段(损坏数据)→ 当成不命中,跳过", () => {
    const entries = [
      makeBlockEntry(0, [{ kind: "tool_use" }]), // no name
      makeBlockEntry(1, [{ kind: "tool_use", name: "Bash" }]),
    ];
    const out = applyContentFilter(entries, { tools: ["Bash"] });
    expect(out.map((e) => e.index)).toEqual([1]);
  });

  it("role 单选:仅保留匹配 role 的 entry", () => {
    const entries = [
      makeBlockEntry(0, [{ kind: "text" }], { role: "user" }),
      makeBlockEntry(1, [{ kind: "text" }], { role: "assistant" }),
      makeBlockEntry(2, [{ kind: "tool_result" }], { role: "user" }),
    ];
    const out = applyContentFilter(entries, { role: "user" });
    expect(out.map((e) => e.index)).toEqual([0, 2]);
  });

  it("role=undefined → role 维度不限,所有 entry 保留", () => {
    const entries = [
      makeBlockEntry(0, [{ kind: "text" }], { role: "user" }),
      makeBlockEntry(1, [{ kind: "text" }], { role: "assistant" }),
    ];
    const out = applyContentFilter(entries, { role: undefined });
    expect(out).toHaveLength(2);
  });

  it("has=thinking:含 thinking block 的 entry 命中", () => {
    const entries = [
      makeBlockEntry(0, [{ kind: "thinking" }, { kind: "text" }]),
      makeBlockEntry(1, [{ kind: "text" }]),
    ];
    const out = applyContentFilter(entries, { has: ["thinking"] });
    expect(out.map((e) => e.index)).toEqual([0]);
  });

  it("has=error:stopReason='error' 的 assistant entry 命中", () => {
    const entries = [
      makeBlockEntry(0, [{ kind: "text" }], { stopReason: "end_turn" }),
      makeBlockEntry(1, [{ kind: "text" }], { stopReason: "error" }),
      makeBlockEntry(2, [{ kind: "text" }], { stopReason: "max_tokens" }),
    ];
    const out = applyContentFilter(entries, { has: ["error"] });
    expect(out.map((e) => e.index)).toEqual([1]);
  });

  it("has=subagent:subagentId 存在 OR isSidechain OR 调 Agent/Task", () => {
    const entries = [
      makeBlockEntry(0, [{ kind: "tool_use", name: "Bash" }]),
      makeBlockEntry(1, [{ kind: "tool_use", name: "Agent" }]), // 通过 tool_use name
      makeBlockEntry(2, [{ kind: "tool_use", name: "Read" }], { subagentId: "abc" }),
      makeBlockEntry(3, [{ kind: "tool_use", name: "Read" }], { isSidechain: true }),
      makeBlockEntry(4, [{ kind: "tool_use", name: "Read" }], { isSidechain: false }), // not sidechain
    ];
    const out = applyContentFilter(entries, { has: ["subagent"] });
    expect(out.map((e) => e.index)).toEqual([1, 2, 3]);
  });

  it("has 多选:维内 OR,任一 attr 命中即保留", () => {
    const entries = [
      makeBlockEntry(0, [{ kind: "thinking" }]),
      makeBlockEntry(1, [{ kind: "text" }], { stopReason: "error" }),
      makeBlockEntry(2, [{ kind: "text" }]), // both not
    ];
    const out = applyContentFilter(entries, { has: ["thinking", "error"] });
    expect(out.map((e) => e.index)).toEqual([0, 1]);
  });

  it("has=tool_use:含 tool_use block 的 entry 命中", () => {
    const entries = [
      makeBlockEntry(0, [{ kind: "tool_use", name: "Bash" }]),
      makeBlockEntry(1, [{ kind: "text" }]),
      makeBlockEntry(2, [{ kind: "tool_result" }]),
    ];
    const out = applyContentFilter(entries, { has: ["tool_use"] });
    expect(out.map((e) => e.index)).toEqual([0]);
  });

  it("has=[]:空数组 = 不限,保留全部", () => {
    const entries = [
      makeBlockEntry(0, [{ kind: "text" }]),
      makeBlockEntry(1, [{ kind: "tool_use", name: "Bash" }]),
    ];
    const out = applyContentFilter(entries, { has: [] });
    expect(out).toHaveLength(2);
  });

  it("跨维 AND:tool + role + has 三维同时应用", () => {
    const entries = [
      // 0: tool=Bash, role=assistant, has=thinking ✓
      makeBlockEntry(0, [{ kind: "thinking" }, { kind: "tool_use", name: "Bash" }]),
      // 1: tool=Bash, role=user, has=thinking ✗ (role 不对)
      makeBlockEntry(1, [{ kind: "thinking" }], { role: "user" }),
      // 2: tool=Read, role=assistant, has=thinking ✗ (tool 不对)
      makeBlockEntry(2, [{ kind: "thinking" }, { kind: "tool_use", name: "Read" }]),
      // 3: tool=Bash, role=assistant, has=none ✗ (has 不对)
      makeBlockEntry(3, [{ kind: "text" }, { kind: "tool_use", name: "Bash" }]),
    ];
    const out = applyContentFilter(entries, {
      tools: ["Bash"],
      role: "assistant",
      has: ["thinking"],
    });
    expect(out.map((e) => e.index)).toEqual([0]);
  });

  it("tools=[] 空数组 = tool 维度不限,只受其它维度约束", () => {
    const entries = [
      makeBlockEntry(0, [{ kind: "tool_use", name: "Bash" }], { role: "assistant" }),
      makeBlockEntry(1, [{ kind: "tool_use", name: "Read" }], { role: "user" }),
      makeBlockEntry(2, [{ kind: "text" }], { role: "user" }),
    ];
    // tools=[] (不限) + role=assistant → 只保留 entry 0
    const out = applyContentFilter(entries, { tools: [], role: "assistant" });
    expect(out.map((e) => e.index)).toEqual([0]);
  });

  // ===== v0.7.0: model 维度 =====
  it("model 多选:entry.normalized.model 命中任一即保留", () => {
    const entries = [
      makeBlockEntry(0, [], { model: "claude-opus-4-7" }),
      makeBlockEntry(1, [], { model: "claude-sonnet-4-5" }),
      makeBlockEntry(2, [], { model: "claude-haiku-4-5" }),
      makeBlockEntry(3, [], { model: undefined }), // 老 session 缺 model
    ];
    const out = applyContentFilter(entries, { models: ["claude-opus-4-7", "claude-haiku-4-5"] });
    expect(out.map((e) => e.index)).toEqual([0, 2]);
  });

  it("model 缺(undefined)→ 当成不命中,跳过", () => {
    const entries = [
      makeBlockEntry(0, [], { model: "claude-opus-4-7" }),
      makeBlockEntry(1, [], { model: undefined }),
    ];
    const out = applyContentFilter(entries, { models: ["claude-opus-4-7"] });
    expect(out.map((e) => e.index)).toEqual([0]);
  });

  it("model + 其它维度:跨维 AND", () => {
    const entries = [
      // 0: model=opus + role=assistant ✓
      makeBlockEntry(0, [], { model: "claude-opus-4-7", role: "assistant" }),
      // 1: model=opus + role=user ✗
      makeBlockEntry(1, [], { model: "claude-opus-4-7", role: "user" }),
      // 2: model=sonnet + role=assistant ✗
      makeBlockEntry(2, [], { model: "claude-sonnet-4-5", role: "assistant" }),
    ];
    const out = applyContentFilter(entries, {
      models: ["claude-opus-4-7"],
      role: "assistant",
    });
    expect(out.map((e) => e.index)).toEqual([0]);
  });

  it("models=[] 空数组 = model 维度不限", () => {
    const entries = [
      makeBlockEntry(0, [], { model: "claude-opus-4-7" }),
      makeBlockEntry(1, [], { model: undefined }),
    ];
    const out = applyContentFilter(entries, { models: [] });
    expect(out).toBe(entries); // 全部不限 → 直通引用
  });

  // ===== v0.7.0: sidechainMode 维度 =====
  it("sidechainMode='main' → 只保留 isSidechain !== true 的 entry", () => {
    const entries = [
      makeBlockEntry(0, [], { isSidechain: undefined }), // 主链
      makeBlockEntry(1, [], { isSidechain: false }), // 主链(显式 false)
      makeBlockEntry(2, [], { isSidechain: true }), // 子链
    ];
    const out = applyContentFilter(entries, { sidechainMode: "main" });
    expect(out.map((e) => e.index)).toEqual([0, 1]);
  });

  it("sidechainMode='sidechain' → 只保留 isSidechain === true 的 entry", () => {
    const entries = [
      makeBlockEntry(0, [], { isSidechain: undefined }),
      makeBlockEntry(1, [], { isSidechain: true }),
      makeBlockEntry(2, [], { isSidechain: true, subagentId: "agent-a4aa77" }),
    ];
    const out = applyContentFilter(entries, { sidechainMode: "sidechain" });
    expect(out.map((e) => e.index)).toEqual([1, 2]);
  });

  it("sidechainMode='all'(默认)→ 全部保留", () => {
    const entries = [
      makeBlockEntry(0, [], { isSidechain: undefined }),
      makeBlockEntry(1, [], { isSidechain: true }),
    ];
    expect(applyContentFilter(entries, { sidechainMode: "all" })).toBe(entries);
  });

  it("sidechain + model 跨维 AND", () => {
    const entries = [
      // 0: 主链 + opus ✓
      makeBlockEntry(0, [], { isSidechain: false, model: "claude-opus-4-7" }),
      // 1: 子链 + opus ✗
      makeBlockEntry(1, [], { isSidechain: true, model: "claude-opus-4-7" }),
      // 2: 主链 + sonnet ✗
      makeBlockEntry(2, [], { isSidechain: false, model: "claude-sonnet-4-5" }),
    ];
    const out = applyContentFilter(entries, {
      sidechainMode: "main",
      models: ["claude-opus-4-7"],
    });
    expect(out.map((e) => e.index)).toEqual([0]);
  });

  // ===== v0.8.5 A: errorMode 过滤 =====
  // 直接 inline 写带 isError 的 entry, 因为 makeBlockEntry 不支持 tool_result block
  function makeEntryWithToolResult(index: number, isError: boolean): TranscriptEntryOut {
    return {
      index,
      byteOffset: index * 1000,
      raw: {},
      normalized: {
        id: `e-${index}`,
        role: "user",
        rawType: "user",
        timestamp: undefined,
        blocks: [{ kind: "tool_result", toolUseId: "tu_x", content: "x", isError }],
      },
      subagentId: undefined,
    } as unknown as TranscriptEntryOut;
  }

  it("errorMode='errors' 只留含 tool_result.is_error 的 entries", () => {
    const entries = [
      makeEntryWithToolResult(0, true), // 失败 → 保留
      makeEntryWithToolResult(1, false), // 成功 → 过滤
      makeEntryWithToolResult(2, true), // 失败 → 保留
    ];
    const out = applyContentFilter(entries, { errorMode: "errors" });
    expect(out.map((e) => e.index)).toEqual([0, 2]);
  });

  it("errorMode='no_errors' 排除含 tool_result.is_error 的 entries", () => {
    const entries = [
      makeEntryWithToolResult(0, true), // 失败 → 排除
      makeEntryWithToolResult(1, false), // 成功 → 保留
      makeEntryWithToolResult(2, false), // 成功 → 保留
    ];
    const out = applyContentFilter(entries, { errorMode: "no_errors" });
    expect(out.map((e) => e.index)).toEqual([1, 2]);
  });

  it("errorMode='all'(默认)→ 全部保留", () => {
    const entries = [makeEntryWithToolResult(0, true), makeEntryWithToolResult(1, false)];
    expect(applyContentFilter(entries, { errorMode: "all" })).toBe(entries);
  });

  it("errorMode 跟其它维度 AND (errors + tool_use=Bash)", () => {
    // 1 个 entry 同时含 Bash tool_use + tool_result.is_error → 保留
    // 1 个 entry 只有 Bash tool_use 但无 tool_result → 排除
    const entries: TranscriptEntryOut[] = [
      {
        index: 0,
        byteOffset: 0,
        raw: {},
        normalized: {
          id: "e-0",
          role: "assistant",
          rawType: "assistant",
          timestamp: undefined,
          blocks: [
            { kind: "tool_use", id: "tu_x", name: "Bash", input: {} },
            { kind: "tool_result", toolUseId: "tu_x", content: "failed", isError: true },
          ],
        },
        subagentId: undefined,
      } as unknown as TranscriptEntryOut,
      {
        index: 1,
        byteOffset: 0,
        raw: {},
        normalized: {
          id: "e-1",
          role: "assistant",
          rawType: "assistant",
          timestamp: undefined,
          blocks: [{ kind: "tool_use", id: "tu_y", name: "Bash", input: {} }],
        },
        subagentId: undefined,
      } as unknown as TranscriptEntryOut,
    ];
    const out = applyContentFilter(entries, {
      errorMode: "errors",
      tools: ["Bash"],
    });
    // entry 0: tool_use=Bash ✓ AND tool_result.is_error=true ✓ → 保留
    // entry 1: tool_use=Bash ✓ AND 无 tool_result.is_error ✗ → 排除
    expect(out.map((e) => e.index)).toEqual([0]);
  });
});
