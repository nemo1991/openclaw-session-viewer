/**
 * OpenClaw JSONL 记录类型
 *
 * 数据来源: ~/.openclaw/agents/<agentId>/sessions/<sessionId>.jsonl
 * 协议来源: @earendil-works/pi-coding-agent 的 SessionEntry 联合类型
 */

export type OpenClawEntry =
  /** 会话 header (首行) */
  | {
      type: "session";
      version: number;
      id: string;
      cwd: string;
      timestamp: string;
      [k: string]: unknown;
    }
  | {
      type: "message";
      id: string;
      parentId: string | null;
      timestamp: string;
      message: { role: "user" | "assistant" | "tool"; content: unknown };
    }
  | {
      type: "model_change";
      id: string;
      parentId: string | null;
      timestamp: string;
      provider: string;
      modelId: string;
    }
  | {
      type: "thinking_level_change";
      id: string;
      parentId: string | null;
      timestamp: string;
      thinkingLevel: string;
    }
  | {
      type: "compaction";
      id: string;
      parentId: string | null;
      timestamp: string;
      summary: string;
      firstKeptEntryId: string;
      tokensBefore: number;
      details?: unknown;
      fromHook?: boolean;
    }
  | {
      type: "branch_summary";
      id: string;
      parentId: string | null;
      timestamp: string;
      fromId: string;
      summary: string;
      details?: unknown;
      fromHook?: boolean;
    }
  | {
      type: "label";
      id: string;
      parentId: string | null;
      timestamp: string;
      targetId: string;
      label?: string;
    }
  | {
      type: "session_info";
      id: string;
      parentId: string | null;
      timestamp: string;
      name: string;
    }
  | {
      type: "custom";
      id: string;
      parentId: string | null;
      timestamp: string;
      customType: string;
      data?: unknown;
    }
  | {
      type: "custom_message";
      id: string;
      parentId: string | null;
      timestamp: string;
      customType: string;
      content: unknown;
      display: boolean;
      details?: unknown;
    };

export type OpenClawEntryType = OpenClawEntry["type"];

export function isOpenClawHeader(e: OpenClawEntry): e is Extract<OpenClawEntry, { type: "session" }> {
  return e.type === "session";
}
