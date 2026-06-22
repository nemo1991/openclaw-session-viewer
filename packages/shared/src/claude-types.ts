/**
 * Claude Code JSONL 记录类型
 *
 * 数据来源: ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl
 * 每行一个 JSON 对象,以下为观察到的所有 type 字段值。
 */

/** 顶层 type 字段值 */
export type ClaudeRecordType =
  | "user"
  | "assistant"
  | "system"
  | "mode"
  | "permission-mode"
  | "ai-title"
  | "custom-title"
  | "last-prompt"
  | "attachment"
  | "file-history-snapshot"
  | "task_reminder"
  | "create"
  | "file"
  | "update"
  | "edited_text_file";

/** 多数记录共有的 envelope 字段 */
export interface ClaudeEnvelope {
  parentUuid?: string | null;
  isSidechain?: boolean;
  promptId?: string;
  uuid?: string;
  timestamp?: string;
  userType?: string;
  entrypoint?: string;
  cwd?: string;
  sessionId?: string;
  version?: string;
  gitBranch?: string;
  slug?: string;
}

/** 内容块 */
export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string; signature?: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };

/** 工具结果内容项 (tool_result.content 数组的成员) */
export type ToolResultItem =
  | {
      stdout: string;
      stderr?: string;
      interrupted?: boolean;
      isImage?: boolean;
      noOutputExpected?: boolean;
    }
  | {
      type: "text";
      file?: {
        filePath: string;
        content: string;
        numLines: number;
        startLine: number;
        totalLines: number;
      };
    };

export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | ToolResultItem[];
  is_error?: boolean;
};

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

/** 助手消息 token 用量 */
export interface AssistantUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
}

/** 主记录类型 */
export interface UserRecord extends ClaudeEnvelope {
  type: "user";
  message: { role: "user"; content: string | ContentBlock[] };
}

export interface AssistantRecord extends ClaudeEnvelope {
  type: "assistant";
  message: {
    role: "assistant";
    content: ContentBlock[];
    model: string;
    stop_reason: string | null;
    usage: AssistantUsage;
    id?: string;
  };
}

export interface SystemRecord extends ClaudeEnvelope {
  type: "system";
  subtype?: "local_command";
  content: string;
  level?: "info" | "warn" | "error";
}

export interface AttachmentRecord extends ClaudeEnvelope {
  type: "attachment";
  attachment: {
    type:
      | "agent_listing_delta"
      | "skill_listing"
      | "command_permissions"
      | "task_reminder"
      | "hook_success"
      | string;
    [k: string]: unknown;
  };
}

export interface ModeRecord extends ClaudeEnvelope {
  type: "mode";
  mode: string;
}

export interface PermissionModeRecord extends ClaudeEnvelope {
  type: "permission-mode";
  permissionMode: string;
}

export interface AiTitleRecord extends ClaudeEnvelope {
  type: "ai-title";
  title: string;
}

export interface CustomTitleRecord extends ClaudeEnvelope {
  type: "custom-title";
  title: string;
}

export interface LastPromptRecord extends ClaudeEnvelope {
  type: "last-prompt";
  prompt?: string;
  leafUuid?: string;
}

export interface FileHistorySnapshotRecord extends ClaudeEnvelope {
  type: "file-history-snapshot";
  messageId?: string;
  snapshot?: {
    messageId?: string;
    trackedFileBackups?: Record<string, unknown>;
    timestamp?: string;
  };
  isSnapshotUpdate?: boolean;
}

export interface TaskReminderRecord extends ClaudeEnvelope {
  type: "task_reminder";
  content?: unknown;
  itemCount?: number;
}

/** Claude 记录联合类型 */
export type ClaudeRecord =
  | UserRecord
  | AssistantRecord
  | SystemRecord
  | AttachmentRecord
  | ModeRecord
  | PermissionModeRecord
  | AiTitleRecord
  | CustomTitleRecord
  | LastPromptRecord
  | FileHistorySnapshotRecord
  | TaskReminderRecord
  | (ClaudeEnvelope & { type: Exclude<ClaudeRecordType, "user" | "assistant" | "system" | "attachment" | "mode" | "permission-mode" | "ai-title" | "custom-title" | "last-prompt" | "file-history-snapshot" | "task_reminder">; [k: string]: unknown });

/** 类型守卫 */
export function isUserRecord(r: ClaudeRecord): r is UserRecord {
  return r.type === "user";
}
export function isAssistantRecord(r: ClaudeRecord): r is AssistantRecord {
  return r.type === "assistant";
}
export function isSystemRecord(r: ClaudeRecord): r is SystemRecord {
  return r.type === "system";
}
export function isAttachmentRecord(r: ClaudeRecord): r is AttachmentRecord {
  return r.type === "attachment";
}
