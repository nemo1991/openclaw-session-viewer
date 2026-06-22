import { describe, it, expect } from "vitest";
import {
  normalizeClaudeRecord,
  normalizeOpenClawEntry,
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
      },
      0
    );
    expect(r).not.toBeNull();
    expect(r!.role).toBe("user");
    expect(r!.id).toBe("u1");
    expect(r!.blocks).toHaveLength(1);
    expect(r!.blocks[0].kind).toBe("text");
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
      },
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
      },
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
    expect(r!.blocks[0].kind).toBe("tool_use");
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
      },
      0
    );
    expect(r!.blocks[0].kind).toBe("thinking");
  });

  it("normalizes meta records", () => {
    const cases = ["mode", "permission-mode", "custom-title", "ai-title", "task_reminder"];
    for (const type of cases) {
      const r = normalizeClaudeRecord({ type }, 0);
      expect(r).not.toBeNull();
      expect(r!.role).toBe("meta");
    }
  });

  it("normalizes attachment", () => {
    const r = normalizeClaudeRecord(
      {
        type: "attachment",
        attachment: { type: "skill_listing", names: ["x"] },
      },
      0
    );
    expect(r!.role).toBe("meta");
    expect(r!.blocks[0].kind).toBe("meta");
  });

  it("uses index when uuid missing", () => {
    const r = normalizeClaudeRecord(
      { type: "user", message: { role: "user", content: "x" } },
      42
    );
    expect(r!.id).toBe("idx-42");
  });

  it("returns null for null/undefined record", () => {
    expect(normalizeClaudeRecord(null, 0)).toBeNull();
    expect(normalizeClaudeRecord(undefined, 0)).toBeNull();
  });

  it("handles empty record as unknown meta", () => {
    const r = normalizeClaudeRecord({}, 0);
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
        { type: "session", version: 1, id: "s1", cwd: "/tmp", timestamp: "2026-06-20T00:00:00Z" },
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
      },
      0
    );
    expect(r).not.toBeNull();
    expect(r!.role).toBe("user");
    expect(r!.blocks[0].kind).toBe("text");
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
      },
      1
    );
    expect(r!.blocks).toHaveLength(2);
    expect(r!.blocks[0].kind).toBe("text");
    expect(r!.blocks[1].kind).toBe("tool_use");
  });

  it("preserves parentId as parentUuid", () => {
    const r = normalizeOpenClawEntry(
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-06-20T00:00:00Z",
        message: { role: "user", content: "x" },
      },
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
      models: new Map([["claude-sonnet-4-6", 3], ["claude-opus-4-8", 1]]),
      firstTimestamp: "2026-06-19T22:00:00Z",
      lastTimestamp: "2026-06-20T02:00:00Z",
    };
    const merged = mergeQuickMeta(a as any, b as any);
    expect(merged.messageCount).toBe(15);
    expect(merged.totalTokens.input).toBe(150);
    expect(merged.totalTokens.cacheRead).toBe(15);
    expect(merged.firstTimestamp).toBe("2026-06-19T22:00:00Z"); // earlier
    expect(merged.lastTimestamp).toBe("2026-06-20T02:00:00Z"); // later
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