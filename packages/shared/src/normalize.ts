/**
 * 归一化层:把 Claude 记录和 OpenClaw 记录都转成统一形状,前端只关心 NormalizedMessage
 */

import type { ClaudeRecord, ContentBlock, ToolResultItem } from "./claude-types.js";
import type { OpenClawEntry } from "./openclaw-types.js";
import type { KimiRecord } from "./kimi-types.js";
import { decodeClaudeProjectKey } from "./paths.js";

/** v0.9.0: 加 Kimi Code (Moonshot Kimi CLI) 作为第三种 source */
export type SessionSource = "claude" | "openclaw" | "kimi";

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
  // --- v0.4.0 列表增强 ---
  /** 首条 user 文本, ≤ 80 字符(独立于 title,title 可来自 custom-title/ai-title) */
  firstPrompt?: string;
  /** 末条消息 ISO timestamp(可空,首末 timestamp 来自 entry 而非文件 mtime) */
  lastMessageAt?: string;
  /** thinking 块数 */
  thinkingCount?: number;
  /** tool_use 块数 */
  toolUseCount?: number;
  /** top 3 工具名(按出现频次) */
  topTools?: string[];
  // --- v0.4.0 trajectory 支持 ---
  /** OpenClaw session 是否有 trajectory 文件(关联入口按钮显示) */
  hasTrajectory?: boolean;
  /** trajectory 文件大小(字节) */
  trajectorySizeBytes?: number;
  // --- v0.5.0 subagent 关联 ---
  /** 子 agent 文件数量(<sessionId>/subagents/agent-*.jsonl) */
  subagentCount?: number;
  /** 子 agent id 列表(已排序去重) */
  subagentIds?: string[];
  // --- v0.8.0 用户 override + 关系型 DB 同步结果 ---
  /** 用户重写的显示名(覆盖 title 优先级 1) */
  displayTitle?: string;
  /** 用户标记为隐藏 */
  hidden?: boolean;
  /** 用户标记为置顶 */
  pinned?: boolean;
  /** 用户标记为归档 */
  archived?: boolean;
  /** 用户自由笔记(Markdown) */
  notes?: string;
  /** tag 名列表 */
  tags?: string[];
  // --- v0.8.4: 由 build_meta_full 二阶段填的派生指标 (item 2) ---
  /** assistant 消息中 stop_reason=="error" 或 is_error==true 的计数 */
  errorCount?: number;
  /** 顶层 user 消息计数 (排除 sidechain) */
  userMessageCount?: number;
  /** 顶层 assistant 消息计数 (排除 sidechain) */
  assistantMessageCount?: number;
  /** 会话跨度(秒) */
  durationSeconds?: number;
  /** 首次响应延迟(毫秒) */
  firstResponseLatencyMs?: number;
  /** jsonl 里 agent-name envelope 的 agentName 值 (本会话自己的别名) */
  agentName?: string;
  /** invoked_skills 计数 */
  invokedSkillsCount?: number;
  /** plan_file_reference 计数 */
  planFileRefCount?: number;
  /** compact_file_reference 计数 */
  compactFileRefCount?: number;
  /** queued_command 计数 */
  queuedCommandCount?: number;
  /** attached_file 计数 */
  attachedFileCount?: number;
  // --- v0.8.4 item 2': SessionSummaryStrip 全固化 (从 DB 读, 不再实时算) ---
  /** 文本消息数 (user + assistant + tool 角色), 替代前端 summarizeSession.textMessageCount */
  textMessageCount?: number;
  /** 全量 tool 分布, 按 count 降序: [["Bash", 286], ["Read", 50], ...] */
  toolUsage?: [string, number][];
  /** 阶段提示: "explore" | "implement" | "mixed" | "short" */
  phaseHint?: "explore" | "implement" | "mixed" | "short";
  /** 阶段详情, 例 "47% 写操作" / "短 session" */
  phaseDetail?: string;
  /** 相邻 assistant tool_use 同 tool ≥3 次的 run 段数 */
  repeatRunCount?: number;
  /** 占比最大 run 的 tool name (tooltip) */
  repeatRunMaxTool?: string;
  /** 占比最大 run 的次数 (tooltip) */
  repeatRunMaxCount?: number;
  /** 相邻 entry ts gap ≥5 分钟的次数 */
  idleGapCount?: number;
  /** 最长间隔 ms */
  idleGapMaxMs?: number;
  /** v0.8.4 item 2'': 该 session 用过的 model id(去重,字典序),给 ContentFilterPanel chip */
  availableModels?: string[];
  // --- v0.8.5 A: per-tool 失败计数 ---
  /** per-tool error count, 按 count 降序: `[["Bash", 3], ["WebFetch", 1], ...]`
   * 跟 `errorCount` (message 级 stop_reason=="error") 正交互补, 互补的是 tool_result.is_error==true */
  toolError?: [string, number][];
  // --- v0.8.7 A: parent_uuids 累积 ---
  /** 该 session 出现过的全部 parent_uuid 引用 (去重), newline-separated text
   * 给 GraphView 派生 ParentUuid edges (G1 跨 session 关联可视化) */
  parentUuidsText?: string;
  // --- v0.9.8: kimi 专属聚合 (TodoWrite + token + MetaBanner) ---
  /** Kimi TodoWrite 末次状态 — `tools.update_store{key:"todo"}` 解析 */
  todoSummary?: { total: number; done: number; current?: string; updatedAtMs?: number };
  /** Kimi session token 聚合 — `usage.record{usageScope:"turn"}` 累加 input/output/cache */
  kimiTokenUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Meta Banner 配置/权限/压缩快照(详情页折叠面板用) */
  metaBanner?: {
    protocolVersion?: string;
    profileName?: string;
    modelAlias?: string;
    thinkingEffort?: string;
    permissionMode?: string;
    activeToolCount?: number;
    configChangeCount: number;
    approvalCount: number;
    compactionCount: number;
    lastCompactionDurationMs?: number;
  };
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

// --- v0.6.0: 单个子代理摘要(Agent 卡片内嵌展开) ---
/**
 * 单个子代理的轻量级摘要,在 Agent 卡片内嵌展开时调用,
 * 避免 navigate 跳到独立子 session 详情页。
 *
 * 由 Rust `get_subagent_summary` 命令返回。
 */
export interface SubagentSummary {
  agentId: string;
  description: string | null;
  agentType: string | null;
  messageCount: number | null;
  /** 工具使用分布,按 count 降序: `[["Bash", 8], ["Read", 5], ...]` */
  toolDistribution: Array<[string, number]>;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /** 从 first 到 last 的秒数 */
  durationSeconds: number | null;
}

/** 解析后的转录条目(含位置) */
export interface TranscriptEntry {
  index: number;
  byteOffset: number;
  /** v0.9.0: 加 kimi 联合 — 前端 replay / search hit 场景需要 */
  raw: ClaudeRecord | OpenClawEntry | KimiRecord;
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
    case "last-prompt": {
      // v0.6.0: 真实数据字段是 `lastPrompt` (camelCase), 不是 `prompt`。
      // 优先取 lastPrompt, fallback 到 prompt (老版本兼容)。
      const promptText = record.lastPrompt ?? record.prompt ?? "";
      // leafUuid 指向最后一条 user message (实测 5/5 命中 type=user) — /resume 触发的恢复点
      // 透传到 payload 里, UI 可点击跳到那条 message
      const payload: Record<string, unknown> = { prompt: promptText };
      if (record.leafUuid) {
        payload.leafUuid = record.leafUuid;
      }
      return {
        ...base,
        role: "meta",
        blocks: [{ kind: "meta", label: "last-prompt", payload }],
        rawType: "last-prompt",
      };
    }
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

// === v0.9.0: Kimi Code wire.jsonl normalize ===

/**
 * Kimi 单条 wire event → NormalizedMessage (前端 replay 路径)
 *
 * 跟后端 `parser/kimi.rs::normalize_kimi_record` 行为对齐:
 * - `turn.prompt` → role=user
 * - `context.append_message` → role=message.role
 * - `metadata` / `config.update` / `permission.set_mode` / `tools.set_active_tools` →
 *   role=meta,block.label=type
 * - `step.begin` / `step.end` / `content.part` / `tool.call` / `tool.result` →
 *   role=meta(loop event 在 streaming replay 路径无法 collapse;前端显示为元信息)
 * - 协议层(llm.request / usage.record / permission.record_approval_result 等) → null 跳过
 * - 未知 event type → role=meta,不 panic
 */
export function normalizeKimiRecord(
  record: KimiRecord | null | undefined,
  index: number
): NormalizedMessage | null {
  if (!record || typeof record !== "object") return null;
  const obj = record as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";
  if (!type) return null;

  const id = `kimi-${type}-${index}`;
  const timestamp =
    typeof obj.time === "number"
      ? new Date(obj.time).toISOString()
      : typeof obj.timestamp === "string"
        ? obj.timestamp
        : undefined;

  switch (type) {
    case "turn.prompt": {
      const input = Array.isArray(obj.input) ? obj.input : [];
      const text = input
        .map((b) =>
          b &&
          typeof b === "object" &&
          "text" in b &&
          typeof (b as { text: unknown }).text === "string"
            ? (b as { text: string }).text
            : ""
        )
        .join("");
      return {
        id,
        role: "user",
        timestamp,
        blocks: [{ kind: "text", text }],
        rawType: "turn.prompt",
      };
    }
    case "context.append_message": {
      const msg = (obj.message ?? {}) as { role?: string; content?: unknown };
      const rawRole = typeof msg.role === "string" ? msg.role : "user";
      // NormalizedMessage.role 只接受 user|assistant|system|tool|meta — kimi 可能给任意字符串,降级到 "user"
      const role: NormalizedMessage["role"] =
        rawRole === "user" || rawRole === "assistant" || rawRole === "system" || rawRole === "tool"
          ? rawRole
          : "user";
      return {
        id,
        role,
        timestamp,
        blocks: [{ kind: "text", text: stringifyUnknown(msg.content) }],
        rawType: "context.append_message",
      };
    }
    case "metadata":
    case "config.update":
    case "permission.set_mode":
    case "tools.set_active_tools":
    case "step.begin":
    case "step.end":
    case "content.part":
    case "tool.call":
    case "tool.result":
      return {
        id,
        role: "meta",
        timestamp,
        blocks: [{ kind: "meta", label: `kimi.${type}`, payload: obj }],
        rawType: type,
      };
    // 协议层 — 跳过
    case "llm.request":
    case "llm.tools_snapshot":
    case "usage.record":
    case "permission.record_approval_result":
    case "tools.update_store":
    case "turn.steer":
    case "turn.cancel":
    case "full_compaction.begin":
    case "full_compaction.complete":
    case "context.apply_compaction":
    case "plan_mode.enter":
    case "plan_mode.cancel":
      return null;
    default:
      // 未知 event — emit meta 不 panic
      return {
        id,
        role: "meta",
        timestamp,
        blocks: [{ kind: "meta", label: `kimi.${type}`, payload: obj }],
        rawType: type,
      };
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
