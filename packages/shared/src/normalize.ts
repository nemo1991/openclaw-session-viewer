/**
 * 归一化层:把 Claude 记录和 OpenClaw 记录都转成统一形状,前端只关心 NormalizedMessage
 */

import type { ClaudeRecord, ContentBlock, ToolResultItem } from "./claude-types.js";
import type { OpenClawEntry } from "./openclaw-types.js";
import { decodeClaudeProjectKey } from "./paths.js";

export type SessionSource = "claude" | "openclaw";

/** 单个会话的元数据 */
export interface SessionMeta {
  sessionId: string;
  projectKey: string;
  /** 从 projectKey 反推的猜测路径(可能含数字混淆) */
  workspaceGuess: string | null;
  source: SessionSource;
  jsonlPath: string;
  sizeBytes: number;
  mtimeMs: number;
  firstTimestamp?: string;
  lastTimestamp?: string;
  messageCount: number;
  /** custom-title > ai-title > 首条 user 文本 */
  title?: string;
  /** 命中 sessions/<pid>.json 时填入 */
  livePid?: number;
  /** 存在 subagents/ 时填入 */
  subagentDir?: string;
  /** 累计 token 用量 */
  totalTokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** 主要使用的模型 */
  primaryModel?: string;
  // --- v0.2.4 多 agent 支持 ---
  /** OpenClaw agentId(如 "main" / "liushuyou");Claude 始终为 undefined */
  agentId?: string;
  /** 来自 sessions.json 的友好标签,如 "forcetone (@forcetone) id:6030344417" */
  agentLabel?: string;
  /** 渠道: "telegram" / "feishu" / "main" */
  agentChannel?: string;
  /** 渠道 target,如 "telegram:6030344417" */
  agentTarget?: string;
}

/** 归一化后的内容块 */
export type NormalizedBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | {
      kind: "tool_result";
      toolUseId: string;
      content: string;
      isError?: boolean;
      /** 工具结果中文件路径(若涉及 Read/Edit/Write) */
      filePath?: string;
    }
  | { kind: "image"; mediaType: string; dataBase64?: string }
  | { kind: "meta"; label: string; payload?: unknown };

/** 归一化后的消息 */
export interface NormalizedMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system" | "meta";
  timestamp?: string;
  blocks: NormalizedBlock[];
  model?: string;
  stopReason?: string | null;
  tokenUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** 用户/子代理 */
  isSidechain?: boolean;
  /** 来自子代理时填入,前端用于缩进 */
  subagentId?: string;
  /** 子代理归一化用,标记父消息 */
  parentUuid?: string | null;
  /** 原始 type 字段,UI 用于分组/折叠 */
  rawType: string;
}

/** 解析后的转录条目(含位置) */
export interface TranscriptEntry {
  index: number;
  byteOffset: number;
  raw: ClaudeRecord | OpenClawEntry;
  normalized: NormalizedMessage;
}

/** 归一化 Claude 记录 */
export function normalizeClaudeRecord(
  record: ClaudeRecord | null | undefined,
  index: number
): NormalizedMessage | null {
  if (!record || typeof record !== "object") return null;
  const base = {
    id: record.uuid ?? `idx-${index}`,
    timestamp: record.timestamp,
    parentUuid: record.parentUuid ?? null,
    isSidechain: record.isSidechain,
  };

  switch (record.type) {
    case "user": {
      const content = record.message.content;
      if (typeof content === "string") {
        return {
          ...base,
          role: "user",
          blocks: [{ kind: "text", text: content }],
          rawType: "user",
        };
      }
      return {
        ...base,
        role: "user",
        blocks: content
          .map((b) => normalizeContentBlock(b))
          .filter((b): b is NormalizedBlock => b !== null),
        rawType: "user",
      };
    }
    case "assistant": {
      const m = record.message;
      return {
        ...base,
        role: "assistant",
        model: m.model,
        stopReason: m.stop_reason,
        tokenUsage: {
          input: m.usage.input_tokens ?? 0,
          output: m.usage.output_tokens ?? 0,
          cacheRead: m.usage.cache_read_input_tokens ?? 0,
          cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
        },
        blocks: m.content
          .map((b) => normalizeContentBlock(b))
          .filter((b): b is NormalizedBlock => b !== null),
        rawType: "assistant",
      };
    }
    case "system":
      return {
        ...base,
        role: "system",
        blocks: [{ kind: "text", text: record.content ?? "" }],
        rawType: "system",
      };
    case "attachment":
      return {
        ...base,
        role: "meta",
        blocks: [{ kind: "meta", label: record.attachment.type, payload: record.attachment }],
        rawType: "attachment",
      };
    case "mode":
      return {
        ...base,
        role: "meta",
        blocks: [{ kind: "meta", label: `mode: ${record.mode}` }],
        rawType: "mode",
      };
    case "permission-mode":
      return {
        ...base,
        role: "meta",
        blocks: [{ kind: "meta", label: `permission: ${record.permissionMode}` }],
        rawType: "permission-mode",
      };
    case "ai-title":
    case "custom-title":
      return {
        ...base,
        role: "meta",
        blocks: [{ kind: "meta", label: "title", payload: record.title }],
        rawType: record.type,
      };
    case "last-prompt":
      return {
        ...base,
        role: "meta",
        blocks: [{ kind: "meta", label: "last-prompt", payload: record.prompt }],
        rawType: "last-prompt",
      };
    case "file-history-snapshot":
      return {
        ...base,
        role: "meta",
        blocks: [{ kind: "meta", label: "file-history-snapshot", payload: record.snapshot }],
        rawType: "file-history-snapshot",
      };
    case "task_reminder":
      return {
        ...base,
        role: "meta",
        blocks: [{ kind: "meta", label: "task-reminder", payload: record }],
        rawType: "task_reminder",
      };
    default:
      return {
        ...base,
        role: "meta",
        blocks: [{ kind: "meta", label: record.type, payload: record }],
        rawType: (record as { type: string }).type,
      };
  }
}

function normalizeContentBlock(block: ContentBlock): NormalizedBlock | null {
  switch (block.type) {
    case "text":
      return { kind: "text", text: block.text };
    case "thinking":
      return { kind: "thinking", text: block.thinking };
    case "tool_use":
      return { kind: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result": {
      const c = block.content;
      if (typeof c === "string") {
        return {
          kind: "tool_result",
          toolUseId: block.tool_use_id,
          content: c,
          isError: block.is_error,
        };
      }
      const text = c
        .map((it) => toolResultItemToString(it))
        .filter(Boolean)
        .join("\n");
      // 提取 Read/Edit/Write 等工具的文件路径
      const fileItem = c.find((it) => "type" in it && it.type === "text" && it.file?.filePath);
      const filePath = fileItem && "file" in fileItem ? fileItem.file?.filePath : undefined;
      return {
        kind: "tool_result",
        toolUseId: block.tool_use_id,
        content: text,
        isError: block.is_error,
        filePath,
      };
    }
  }
}

function toolResultItemToString(item: ToolResultItem): string {
  if ("stdout" in item) {
    return item.stdout ?? "";
  }
  if ("type" in item && item.type === "text") {
    return item.file?.content ?? "";
  }
  return "";
}

/** 归一化 OpenClaw 记录 */
export function normalizeOpenClawEntry(
  entry: OpenClawEntry,
  index: number
): NormalizedMessage | null {
  const base = {
    id: entry.id,
    timestamp: entry.timestamp,
    parentUuid: entry.parentId as string | null | undefined,
  };

  switch (entry.type) {
    case "session":
      return null; // header,不渲染
    case "message": {
      const role = entry.message.role;
      const content = entry.message.content;
      if (typeof content === "string") {
        return {
          ...base,
          role: role === "tool" ? "tool" : role,
          blocks: [{ kind: "text", text: content }],
          rawType: "message",
        };
      }
      // content 是 ContentBlock[] (from pi-agent-core)
      return {
        ...base,
        role: role === "tool" ? "tool" : role,
        blocks: openClawContentToBlocks(content),
        rawType: "message",
      };
    }
    case "model_change":
      return {
        ...base,
        role: "meta",
        blocks: [{ kind: "meta", label: `model: ${entry.provider}/${entry.modelId}` }],
        rawType: "model_change",
      };
    case "thinking_level_change":
      return {
        ...base,
        role: "meta",
        blocks: [{ kind: "meta", label: `thinking: ${entry.thinkingLevel}` }],
        rawType: "thinking_level_change",
      };
    case "compaction":
      return {
        ...base,
        role: "meta",
        blocks: [
          {
            kind: "meta",
            label: "compaction",
            payload: { summary: entry.summary, tokensBefore: entry.tokensBefore },
          },
        ],
        rawType: "compaction",
      };
    case "branch_summary":
      return {
        ...base,
        role: "meta",
        blocks: [
          {
            kind: "meta",
            label: "branch-summary",
            payload: { fromId: entry.fromId, summary: entry.summary },
          },
        ],
        rawType: "branch_summary",
      };
    case "label":
      return {
        ...base,
        role: "meta",
        blocks: [
          {
            kind: "meta",
            label: "label",
            payload: { targetId: entry.targetId, text: entry.label },
          },
        ],
        rawType: "label",
      };
    case "session_info":
      return {
        ...base,
        role: "meta",
        blocks: [{ kind: "meta", label: "session-info", payload: { name: entry.name } }],
        rawType: "session_info",
      };
    case "custom":
      return {
        ...base,
        role: "meta",
        blocks: [{ kind: "meta", label: `custom: ${entry.customType}`, payload: entry.data }],
        rawType: "custom",
      };
    case "custom_message":
      return {
        ...base,
        role: "meta",
        blocks: [
          { kind: "meta", label: `custom-msg: ${entry.customType}`, payload: entry.content },
        ],
        rawType: "custom_message",
      };
  }
}

function openClawContentToBlocks(content: unknown): NormalizedBlock[] {
  if (!Array.isArray(content)) return [];
  const out: NormalizedBlock[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const it = item as { type?: string; text?: string; thinking?: string; [k: string]: unknown };
    switch (it.type) {
      case "text":
        if (typeof it.text === "string") out.push({ kind: "text", text: it.text });
        break;
      case "thinking":
        if (typeof it.thinking === "string") out.push({ kind: "thinking", text: it.thinking });
        break;
      case "tool_use":
      case "toolUse":
      case "tool_call":
      case "function_call":
        out.push({
          kind: "tool_use",
          id: String(it.id ?? ""),
          name: String(it.name ?? ""),
          input: it.input,
        });
        break;
      case "tool_result":
      case "toolResult":
        out.push({
          kind: "tool_result",
          toolUseId: String(it.tool_use_id ?? it.toolCallId ?? ""),
          content: stringifyUnknown(it.content),
          isError: Boolean(it.is_error),
        });
        break;
      case "image":
        out.push({
          kind: "image",
          mediaType: String(it.mediaType ?? "image/png"),
          dataBase64: it.data as string | undefined,
        });
        break;
      default:
        // 未知块,原样塞到 meta
        out.push({ kind: "meta", label: it.type ?? "unknown", payload: it });
    }
  }
  return out;
}

function stringifyUnknown(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** 从 projectKey 推 workspace 路径 */
export function guessWorkspaceFromProjectKey(projectKey: string): string | null {
  return decodeClaudeProjectKey(projectKey);
}

/** 从 JSONL 头部 N 条记录提取会话元信息 */
export interface QuickMeta {
  firstTimestamp?: string;
  lastTimestamp?: string;
  messageCount: number;
  customTitle?: string;
  aiTitle?: string;
  totalTokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  primaryModel?: string;
  models: Map<string, number>;
}

/** 累加统计 (用于跨文件聚合) */
export function mergeQuickMeta(acc: QuickMeta, other: QuickMeta): QuickMeta {
  const models = new Map<string, number>([...acc.models, ...other.models]);
  return {
    firstTimestamp: earliest(acc.firstTimestamp, other.firstTimestamp),
    lastTimestamp: latest(acc.lastTimestamp, other.lastTimestamp),
    messageCount: acc.messageCount + other.messageCount,
    customTitle: acc.customTitle ?? other.customTitle,
    aiTitle: acc.aiTitle ?? other.aiTitle,
    totalTokens: {
      input: acc.totalTokens.input + other.totalTokens.input,
      output: acc.totalTokens.output + other.totalTokens.output,
      cacheRead: acc.totalTokens.cacheRead + other.totalTokens.cacheRead,
      cacheWrite: acc.totalTokens.cacheWrite + other.totalTokens.cacheWrite,
    },
    primaryModel: acc.primaryModel ?? other.primaryModel,
    models,
  };
}

export function emptyQuickMeta(): QuickMeta {
  return {
    messageCount: 0,
    totalTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    models: new Map(),
  };
}

function earliest(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function latest(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
