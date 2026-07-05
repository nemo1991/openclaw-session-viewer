/**
 * sessionInsights — 聚合 + 去噪函数单元测试
 *
 * 覆盖:
 * 1. summarizeSession:tool 分布 / 错误 / 阶段提示
 * 2. findRepeatRuns:连续 3+ 同 tool 检测
 * 3. findIdleGaps:> 5min 间隔检测
 * 4. parseMessageText:command-message / local-command / system-reminder 去噪
 * 5. formatIdleGap:人类可读
 */

import { describe, expect, it } from "vitest";
import {
  findIdleGaps,
  findRepeatRuns,
  formatIdleGap,
  parseMessageText,
  summarizeSession,
} from "./sessionInsights";
import type { TranscriptEntryOut, NormalizedMessageFE } from "../lib/api";

/** 构造 mock entry helper */
function mkEntry(
  role: "user" | "assistant" | "tool" | "system",
  blocks: { kind: string; name?: string; text?: string; thinking?: string }[] = [],
  opts: { ts?: string; stopReason?: string | null; id?: string } = {}
): TranscriptEntryOut {
  const id = opts.id ?? `e_${Math.random().toString(36).slice(2, 8)}`;
  const normalized: NormalizedMessageFE = {
    id,
    role,
    timestamp: opts.ts,
    blocks: blocks.map((b) => ({ kind: b.kind, name: b.name, text: b.text, thinking: b.thinking })),
    stopReason: opts.stopReason ?? null,
    rawType: role,
  };
  return { index: 0, byteOffset: 0, raw: null, normalized };
}

describe("summarizeSession", () => {
  it("counts tool usage and orders descending", () => {
    const entries = [
      mkEntry("assistant", [{ kind: "tool_use", name: "Bash" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Bash" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Read" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Edit" }]),
    ];
    const s = summarizeSession(entries);
    expect(s.toolUsage[0]).toEqual({ tool: "Bash", count: 2 });
    expect(s.toolUsage.find((t) => t.tool === "Read")?.count).toBe(1);
    expect(s.textMessageCount).toBe(4);
  });

  it("detects implement phase when Edit/Write > Read", () => {
    const entries = [
      mkEntry("user"),
      mkEntry("assistant", [{ kind: "tool_use", name: "Read" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Edit" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Edit" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Write" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Edit" }]),
    ];
    const s = summarizeSession(entries);
    expect(s.phaseHint).toBe("implement");
    expect(s.phaseDetail).toContain("写");
  });

  it("detects explore phase when Read dominates", () => {
    const entries = [
      mkEntry("user"),
      mkEntry("assistant", [{ kind: "tool_use", name: "Read" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Read" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Read" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Read" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Edit" }]),
    ];
    const s = summarizeSession(entries);
    expect(s.phaseHint).toBe("explore");
  });

  it("short session is < 5 messages", () => {
    const entries = [mkEntry("user"), mkEntry("assistant")];
    const s = summarizeSession(entries);
    expect(s.phaseHint).toBe("short");
  });

  it("counts thinking blocks", () => {
    const entries = [
      mkEntry("assistant", [
        { kind: "thinking", thinking: "x" },
        { kind: "text", text: "y" },
      ]),
      mkEntry("assistant", [{ kind: "thinking", thinking: "z" }]),
    ];
    expect(summarizeSession(entries).thinkingCount).toBe(2);
  });

  it("counts subagent calls (Agent/Task tool_use)", () => {
    const entries = [
      mkEntry("assistant", [{ kind: "tool_use", name: "Agent" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Task" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Bash" }]),
    ];
    expect(summarizeSession(entries).subagentCount).toBe(2);
  });
});

describe("findRepeatRuns", () => {
  it("detects 3+ consecutive same tool", () => {
    const entries = [
      mkEntry("assistant", [{ kind: "tool_use", name: "Bash" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Bash" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Bash" }]),
    ];
    const runs = findRepeatRuns(entries, 3);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ tool: "Bash", count: 3, startIndex: 0, endIndex: 2 });
  });

  it("does not collapse different tools", () => {
    const entries = [
      mkEntry("assistant", [{ kind: "tool_use", name: "Bash" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Read" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Bash" }]),
    ];
    expect(findRepeatRuns(entries, 3)).toHaveLength(0);
  });

  it("breaks run on user message", () => {
    const entries = [
      mkEntry("assistant", [{ kind: "tool_use", name: "Bash" }]),
      mkEntry("user"),
      mkEntry("assistant", [{ kind: "tool_use", name: "Bash" }]),
    ];
    expect(findRepeatRuns(entries, 2)).toHaveLength(0);
  });

  it("only emits runs >= minCount", () => {
    const entries = [
      mkEntry("assistant", [{ kind: "tool_use", name: "Bash" }]),
      mkEntry("assistant", [{ kind: "tool_use", name: "Bash" }]),
    ];
    expect(findRepeatRuns(entries, 3)).toHaveLength(0);
    expect(findRepeatRuns(entries, 2)).toHaveLength(1);
  });
});

describe("findIdleGaps", () => {
  it("detects gaps > 5 min", () => {
    const entries = [
      mkEntry("user", [], { ts: "2026-07-01T10:00:00Z" }),
      mkEntry("assistant", [], { ts: "2026-07-01T10:03:00Z" }), // 3min - skip
      mkEntry("user", [], { ts: "2026-07-01T10:20:00Z" }), // 17min - detected
    ];
    const gaps = findIdleGaps(entries, 5 * 60_000);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.durationMs).toBe(17 * 60_000);
  });

  it("ignores entries without timestamp", () => {
    const entries = [mkEntry("user", [], {}), mkEntry("user", [], {})];
    expect(findIdleGaps(entries)).toHaveLength(0);
  });

  it("uses custom threshold", () => {
    const entries = [
      mkEntry("user", [], { ts: "2026-07-01T10:00:00Z" }),
      mkEntry("user", [], { ts: "2026-07-01T10:01:30Z" }), // 90s
    ];
    expect(findIdleGaps(entries, 60_000)).toHaveLength(1);
    expect(findIdleGaps(entries, 120_000)).toHaveLength(0);
  });
});

describe("formatIdleGap", () => {
  it("formats seconds", () => {
    expect(formatIdleGap(30_000)).toBe("30 秒");
  });
  it("formats minutes", () => {
    expect(formatIdleGap(5 * 60_000)).toBe("5 分钟");
  });
  it("formats hours + minutes", () => {
    expect(formatIdleGap(2 * 3600_000 + 15 * 60_000)).toBe("2 小时 15 分");
  });
  it("formats days + hours", () => {
    expect(formatIdleGap(3 * 86400_000 + 5 * 3600_000)).toBe("3 天 5 小时");
  });
  it("formats exact hours", () => {
    expect(formatIdleGap(2 * 3600_000)).toBe("2 小时");
  });
  it("formats exact days", () => {
    expect(formatIdleGap(3 * 86400_000)).toBe("3 天");
  });
});

describe("parseMessageText", () => {
  it("extracts /cmd from command-message", () => {
    const r = parseMessageText(
      "<command-message>init</command-message>\n<command-name>/init</command-name>"
    );
    expect(r.clean).toBe("/init");
    expect(r.commandName).toBe("/init");
  });

  it("normalizes command name without leading slash", () => {
    const r = parseMessageText(
      "<command-message>drawio</command-message>\n<command-name>drawio</command-name>"
    );
    expect(r.clean).toBe("/drawio");
  });

  it("detects local-command-caveat", () => {
    const r = parseMessageText("<local-command-caveat>Caveat: ...</local-command-caveat>");
    expect(r.isLocalCommand).toBe(true);
    expect(r.clean).toBe("");
  });

  it("strips <system-reminder> blocks and counts them", () => {
    const r = parseMessageText(
      "before\n<system-reminder>x</system-reminder>\nmiddle\n<system-reminder>y</system-reminder>\nafter"
    );
    expect(r.systemReminderCount).toBe(2);
    expect(r.clean).toContain("before");
    expect(r.clean).toContain("after");
    expect(r.clean).not.toContain("<system-reminder>");
    expect(r.hasSystemReminder).toBe(true);
  });

  it("handles mixed command-message + system-reminder", () => {
    const r = parseMessageText(
      "<system-reminder>context</system-reminder>\n<command-message>init</command-message>\n<command-name>/init</command-name>"
    );
    expect(r.clean).toBe("/init");
    expect(r.systemReminderCount).toBe(1);
  });

  it("passes through clean text unchanged", () => {
    const r = parseMessageText("hello world\n\nsecond paragraph");
    expect(r.clean).toBe("hello world\n\nsecond paragraph");
    expect(r.hasSystemReminder).toBe(false);
  });

  it("collapses excessive blank lines", () => {
    const r = parseMessageText("a\n\n\n\n\n\nb");
    expect(r.clean).toBe("a\n\nb");
  });

  it("returns empty parsed for null/empty", () => {
    expect(parseMessageText(null).clean).toBe("");
    expect(parseMessageText(undefined).clean).toBe("");
    expect(parseMessageText("").clean).toBe("");
  });
});
