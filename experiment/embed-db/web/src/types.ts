/**
 * 前端类型 — 镜像 ingest crate 输出
 */

export type Source = "Claude" | "OpenClaw";

export interface SessionNode {
  node_id: string;
  source: Source;
  session_id: string;
  workspace: string | null;
  jsonl_path: string;
  size_bytes: number;
  mtime_ms: number;
  first_prompt: string | null;
  first_timestamp_ms: number | null;
  last_timestamp_ms: number | null;
  token_total: number;
  thinking_count: number;
  primary_model: string | null;
  top_tools: string[];
  error_count: number;
  subagent_count: number;
  subagent_ids: string[];
  is_subagent_root: boolean;
  parent_session_id: string | null;
  message_count: number;
  /** v0.6.1 (S3 RAG): top 3 assistant 文本块 (≤200 chars),给 hash-embedding 提供语料 */
  assistant_text_snippets?: string[];
  /** S6: subagent 的 agent-id (e.g. "agent-a4aa77")。main session 永远为 null */
  agent_id?: string | null;
}

export type Edge =
  | {
      type: "Spawned";
      from_session: string;
      to_subagent_id: string;
      to_subagent_path: string;
      description: string | null;
    }
  | { type: "ParentUuid"; session: string; from_uuid: string; to_uuid: string }
  | { type: "UsedTool"; session: string; tool_name: string; count: number }
  | { type: "AttemptedFix"; session: string; error_count: number }
  | { type: "CrossSession"; parent: string; child: string };

/** 一行 NDJSON 的物化:node + edges 平摊 */
export interface GraphEntry {
  node: SessionNode;
  edges: Edge[];
}

/** 整图:多个 session node */
export interface SessionGraph {
  entries: GraphEntry[];
}
