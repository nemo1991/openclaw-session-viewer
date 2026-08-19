import { describe, it, expect } from "vitest";
import type { ClaudeRecord } from "./claude-types.js";
import type { OpenClawEntry } from "./openclaw-types.js";
import {
  normalizeClaudeRecord,
  normalizeOpenClawEntry,
  normalizeDshRecord,
  emptyQuickMeta,
  mergeQuickMeta,
  guessWorkspaceFromProjectKey,
} from "./normalize.js";

describe("normalizeClaudeRecord", () => {
  it("normalizes user text message", () => {
    const r = normalizeClaudeRecord(
      {
        type: "user",
        uuid: "u1",
        timestamp: "2026-06-20T00:00:00Z",
        message: { role: "user", content: "Hello" },
      } as ClaudeRecord,
      0
    );
    expect(r).not.toBeNull();
    expect(r!.role).toBe("user");
    expect(r!.id).toBe("u1");
    expect(r!.blocks).toHaveLength(1);
    expect(r!.blocks[0]?.kind).toBe("text");
  });

  it("normalizes user with content blocks", () => {
    const r = normalizeClaudeRecord(
      {
        type: "user",
        uuid: "u2",
        message: {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "second" },
          ],
        },
      } as ClaudeRecord,
      0
    );
    expect(r!.blocks).toHaveLength(2);
    expect(r!.blocks.every((b) => b.kind === "text")).toBe(true);
  });

  it("normalizes assistant with tool_use and usage", () => {
    const r = normalizeClaudeRecord(
      {
        type: "assistant",
        uuid: "a1",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }],
          model: "claude-sonnet-4-6",
          stop_reason: "tool_use",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 20,
          },
        },
      } as ClaudeRecord,
      0
    );
    expect(r!.role).toBe("assistant");
    expect(r!.model).toBe("claude-sonnet-4-6");
    expect(r!.stopReason).toBe("tool_use");
    expect(r!.tokenUsage).toEqual({
      input: 100,
      output: 50,
      cacheRead: 20,
      cacheWrite: 0,
    });
    expect(r!.blocks[0]?.kind).toBe("tool_use");
  });

  it("normalizes thinking block", () => {
    const r = normalizeClaudeRecord(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "deep thoughts", signature: "sig" }],
          model: "claude-opus-4-8",
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      } as ClaudeRecord,
      0
    );
    expect(r!.blocks[0]?.kind).toBe("thinking");
  });

  it("normalizes meta records", () => {
    const types: Array<ClaudeRecord["type"]> = [
      "mode",
      "permission-mode",
      "custom-title",
      "ai-title",
      "task_reminder",
    ];
    for (const type of types) {
      const r = normalizeClaudeRecord({ type } as ClaudeRecord, 0);
      expect(r).not.toBeNull();
      expect(r!.role).toBe("meta");
    }
  });

  it("normalizes attachment", () => {
    const r = normalizeClaudeRecord(
      {
        type: "attachment",
        attachment: { type: "skill_listing", names: ["x"] },
      } as ClaudeRecord,
      0
    );
    expect(r!.role).toBe("meta");
    expect(r!.blocks[0]?.kind).toBe("meta");
  });

  it("uses index when uuid missing", () => {
    const r = normalizeClaudeRecord(
      { type: "user", message: { role: "user", content: "x" } } as ClaudeRecord,
      42
    );
    expect(r!.id).toBe("idx-42");
  });

  it("returns null for null/undefined record", () => {
    expect(normalizeClaudeRecord(null, 0)).toBeNull();
    expect(normalizeClaudeRecord(undefined, 0)).toBeNull();
  });

  it("handles empty record as unknown meta", () => {
    const r = normalizeClaudeRecord({} as ClaudeRecord, 0);
    expect(r).not.toBeNull();
    expect(r!.role).toBe("meta");
    // 无 type 字段 → rawType 是 undefined
    expect(r!.rawType).toBeUndefined();
  });
});

describe("normalizeOpenClawEntry", () => {
  it("returns null for session header", () => {
    expect(
      normalizeOpenClawEntry(
        {
          type: "session",
          version: 1,
          id: "s1",
          cwd: "/tmp",
          timestamp: "2026-06-20T00:00:00Z",
        } as OpenClawEntry,
        0
      )
    ).toBeNull();
  });

  it("normalizes message with role", () => {
    const r = normalizeOpenClawEntry(
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-06-20T00:00:00Z",
        message: { role: "user", content: "Hi" },
      } as OpenClawEntry,
      0
    );
    expect(r).not.toBeNull();
    expect(r!.role).toBe("user");
    expect(r!.blocks[0]?.kind).toBe("text");
  });

  it("handles camelCase toolUse in content", () => {
    const r = normalizeOpenClawEntry(
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-06-20T00:00:01Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Reading" },
            { type: "toolUse", id: "tu1", name: "Read", input: { path: "/tmp" } },
          ],
        },
      } as unknown as OpenClawEntry,
      1
    );
    expect(r!.blocks).toHaveLength(2);
    expect(r!.blocks[0]?.kind).toBe("text");
    expect(r!.blocks[1]?.kind).toBe("tool_use");
  });

  it("preserves parentId as parentUuid", () => {
    const r = normalizeOpenClawEntry(
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-06-20T00:00:00Z",
        message: { role: "user", content: "x" },
      } as OpenClawEntry,
      0
    );
    expect(r!.parentUuid).toBe("m1");
  });
});

describe("emptyQuickMeta + mergeQuickMeta", () => {
  it("creates empty meta", () => {
    const m = emptyQuickMeta();
    expect(m.messageCount).toBe(0);
    expect(m.totalTokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("merges two metas", () => {
    const a = {
      messageCount: 10,
      totalTokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
      models: new Map([["claude-sonnet-4-6", 5]]),
      firstTimestamp: "2026-06-20T00:00:00Z",
      lastTimestamp: "2026-06-20T01:00:00Z",
    };
    const b = {
      messageCount: 5,
      totalTokens: { input: 50, output: 25, cacheRead: 5, cacheWrite: 0 },
      models: new Map([
        ["claude-sonnet-4-6", 3],
        ["claude-opus-4-8", 1],
      ]),
      firstTimestamp: "2026-06-19T22:00:00Z",
      lastTimestamp: "2026-06-20T02:00:00Z",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const merged = mergeQuickMeta(a as any, b as any);
    expect(merged.messageCount).toBe(15);
    expect(merged.totalTokens.input).toBe(150);
    expect(merged.totalTokens.cacheRead).toBe(15);
    expect(merged.firstTimestamp).toBe("2026-06-19T22:00:00Z");
    expect(merged.lastTimestamp).toBe("2026-06-20T02:00:00Z");
  });
});

describe("guessWorkspaceFromProjectKey", () => {
  it("returns null for non-prefixed key", () => {
    expect(guessWorkspaceFromProjectKey("Users-foo")).toBeNull();
  });

  it("decodes standard key", () => {
    expect(guessWorkspaceFromProjectKey("-Users-foo-bar")).toBe("/Users/foo/bar");
  });
});

// v0.9.28 (M11): dsh wire normalize
describe("normalizeDshRecord", () => {
  it("returns null for null/undefined input", () => {
    expect(normalizeDshRecord(null, 0)).toBeNull();
    expect(normalizeDshRecord(undefined, 0)).toBeNull();
  });

  it("returns null for object missing type", () => {
    expect(normalizeDshRecord({ foo: "bar" }, 0)).toBeNull();
  });

  it("normalizes user/message with text content", () => {
    const r = normalizeDshRecord(
      {
        type: "user/message",
        seq: 1,
        time: 1787100701000,
        data: { content: [{ type: "text", text: "hi" }] },
      },
      0
    );
    expect(r).not.toBeNull();
    expect(r!.role).toBe("user");
    expect(r!.blocks).toHaveLength(1);
    expect(r!.blocks[0]?.kind).toBe("text");
    expect(r!.timestamp).toBe(new Date(1787100701000).toISOString());
  });

  it("normalizes assistant/message with reasoning+text+tool-call", () => {
    const r = normalizeDshRecord(
      {
        type: "assistant/message",
        seq: 2,
        time: 1787100704000,
        data: {
          message: {
            source: { model: "deepseek-v4-flash" },
            content: [
              { type: "reasoning", text: "thinking" },
              { type: "text", text: "hello" },
              { type: "tool-call", id: "c1", name: "Bash", arguments: '{"command":"ls"}' },
            ],
          },
          usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200 },
        },
      },
      1
    );
    expect(r).not.toBeNull();
    expect(r!.role).toBe("assistant");
    expect(r!.model).toBe("deepseek-v4-flash");
    expect(r!.blocks).toHaveLength(3);
    expect(r!.tokenUsage).toEqual({
      input: 100,
      output: 50,
      cacheRead: 200,
      cacheWrite: 0,
    });
    const tool = r!.blocks.find((b) => b.kind === "tool_use");
    expect(tool?.kind).toBe("tool_use");
    if (tool?.kind === "tool_use") {
      expect(tool.name).toBe("Bash");
      expect(tool.input).toEqual({ command: "ls" });
    }
  });

  it("normalizes tool/result with isError=false", () => {
    const r = normalizeDshRecord(
      {
        type: "tool/result",
        seq: 4,
        time: 100,
        data: {
          message: {
            source: { callId: "call_00_1" },
            content: [{ type: "tool-result", isError: false }],
          },
        },
      },
      3
    );
    expect(r).not.toBeNull();
    expect(r!.role).toBe("tool");
    expect(r!.blocks).toHaveLength(1);
    const block = r!.blocks[0]!;
    expect(block.kind).toBe("tool_result");
    if (block.kind === "tool_result") {
      expect(block.toolUseId).toBe("call_00_1");
      expect(block.isError).toBe(false);
    }
  });

  it("filters streaming chunks to null", () => {
    expect(
      normalizeDshRecord({ type: "assistant/chunk" }, 0)
    ).toBeNull();
    expect(
      normalizeDshRecord({ type: "reasoning-chunks" }, 0)
    ).toBeNull();
    expect(
      normalizeDshRecord({ type: "text-chunks" }, 0)
    ).toBeNull();
    expect(
      normalizeDshRecord({ type: "tool-call-chunks" }, 0)
    ).toBeNull();
  });

  it("emits session header as meta", () => {
    const r = normalizeDshRecord(
      { type: "session", id: "s1", agentPreset: "cordis" },
      0
    );
    expect(r).not.toBeNull();
    expect(r!.role).toBe("meta");
    expect(r!.rawType).toBe("session");
    expect(r!.blocks[0]?.kind).toBe("meta");
  });

  it("emits unknown types as meta without panicking", () => {
    const r = normalizeDshRecord(
      { type: "permission/preset", data: { foo: 1 } },
      0
    );
    expect(r).not.toBeNull();
    expect(r!.role).toBe("meta");
    expect(r!.rawType).toBe("permission/preset");
  });
});
