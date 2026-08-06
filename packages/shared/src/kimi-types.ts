/**
 * v0.9.0: Kimi Code (Moonshot Kimi CLI) wire.jsonl 类型
 *
 * 跟后端 `parser/kimi.rs` 对齐。轻量 typing + escape hatches。
 * Kimi wire protocol 文档: 见 dcwin11 样本参考。
 */

/** Kimi wire event 顶层 type 字段值 */
export type KimiWireType =
  | "metadata"
  | "config.update"
  | "tools.set_active_tools"
  | "permission.set_mode"
  | "turn.prompt"
  | "context.append_message"
  | "context.append_loop_event"
  | "llm.request"
  | "llm.tools_snapshot"
  | "usage.record"
  | "permission.record_approval_result"
  | "tools.update_store"
  | "turn.steer"
  | "turn.cancel"
  | "full_compaction.begin"
  | "full_compaction.complete"
  | "context.apply_compaction"
  | "plan_mode.enter"
  | "plan_mode.cancel";

/** Loop event 子类型 — `context.append_loop_event.event.type` */
export type KimiLoopEventType =
  | "step.begin"
  | "step.end"
  | "content.part"
  | "tool.call"
  | "tool.result";

/** turn.prompt.input[] 元素 */
export interface KimiPromptBlock {
  type: "text" | string;
  text?: string;
}

/** `context.append_loop_event.event` */
export interface KimiLoopEvent {
  type: KimiLoopEventType | string;
  uuid?: string;
  turnId?: string | number;
  step?: number;
  stepUuid?: string;
  toolCallId?: string;
  /** tool.call 专用 */
  name?: string;
  args?: unknown;
  description?: string;
  display?: unknown;
  /** tool.result 专用 — 配对回 tool.call.uuid */
  parentUuid?: string;
  result?: { output?: unknown; error?: unknown };
  /** content.part 专用 */
  role?: string;
  part?: string;
  text?: string;
  content?: unknown;
  [key: string]: unknown;
}

/** `context.append_loop_event` 顶层 */
export interface KimiLoopEventRecord {
  type: "context.append_loop_event";
  event: KimiLoopEvent;
  time?: number;
  [key: string]: unknown;
}

/** `context.append_message.message` */
export interface KimiMessage {
  role: "user" | "assistant" | "tool" | "system" | string;
  content?: unknown;
  toolCalls?: unknown[];
  [key: string]: unknown;
}

/** `context.append_message` 顶层 */
export interface KimiAppendMessageRecord {
  type: "context.append_message";
  message: KimiMessage;
  time?: number;
  [key: string]: unknown;
}

/** `turn.prompt` */
export interface KimiTurnPromptRecord {
  type: "turn.prompt";
  input: KimiPromptBlock[];
  origin?: { kind: "user" | string };
  time?: number;
  [key: string]: unknown;
}

/** `metadata` — 协议头 */
export interface KimiMetadataRecord {
  type: "metadata";
  protocol_version: string;
  created_at: number;
}

/** `config.update` / `permission.set_mode` / `tools.set_active_tools` */
export interface KimiConfigRecord {
  type: "config.update" | "permission.set_mode" | "tools.set_active_tools";
  profileName?: string;
  systemPrompt?: string;
  modelAlias?: string;
  thinkingEffort?: string;
  mode?: string;
  names?: string[];
  time?: number;
  [key: string]: unknown;
}

/** `llm.request` / `usage.record` / `llm.tools_snapshot` — 协议层 */
export interface KimiProtocolRecord {
  type: "llm.request" | "llm.tools_snapshot" | "usage.record"
    | "permission.record_approval_result" | "tools.update_store"
    | "turn.steer" | "turn.cancel"
    | "full_compaction.begin" | "full_compaction.complete"
    | "context.apply_compaction" | "plan_mode.enter" | "plan_mode.cancel";
  time?: number;
  [key: string]: unknown;
}

/** Kimi 单条 wire event 联合 */
export type KimiRecord =
  | KimiMetadataRecord
  | KimiConfigRecord
  | KimiTurnPromptRecord
  | KimiAppendMessageRecord
  | KimiLoopEventRecord
  | KimiProtocolRecord
  | { type: string; time?: number; [key: string]: unknown };