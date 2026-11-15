/**
 * 前端类型 — 镜像 ingest crate 输出
 */

export type Source = "Claude" | "OpenClaw" | "Kimi" | "DeepSeekHarness";

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
  /** v0.10 (FR-I1): Rust 聚合阶段算出的真实重试次数 / tool 调用总次数。
   * 老版 NDJSON 没有这两列,故可选,消费端一律 `?? 0`。 */
  retry_count?: number;
  tool_call_count?: number;
  subagent_count: number;
  subagent_ids: string[];
  is_subagent_root: boolean;
  parent_session_id: string | null;
  message_count: number;
  /** v0.10 (FR-I2): foldSubagents() 归并进本节点的 subagent 数(展示层派生,不入 DB) */
  folded_subagent_count?: number;
  /** v0.6.1 (S3 RAG): top 3 assistant 文本块 (≤200 chars),给 hash-embedding 提供语料 */
  assistant_text_snippets?: string[];
  /** S6: subagent 的 agent-id (e.g. "agent-a4aa77")。main session 永远为 null */
  agent_id?: string | null;
  /**
   * v0.11 (B1): 该会话出现过的 model id 列表(来自 `session_meta.available_models_json`)。
   * 用于「同会话模型漂移」体检规则。老库 / 部分 source 可能没有该列,故可选;
   * 缺失时该规则不参与判定,不臆造模型信息。
   */
  available_models?: string[];
}

export type Edge =
  | {
      type: "spawned";
      from_session: string;
      to_subagent_id: string;
      to_subagent_path: string;
      description: string | null;
    }
  | { type: "parent_uuid"; session: string; from_uuid: string; to_uuid: string }
  | { type: "used_tool"; session: string; tool_name: string; count: number }
  | { type: "attempted_fix"; session: string; error_count: number }
  | { type: "cross_session"; parent: string; child: string };

/** 一行 NDJSON 的物化:node + edges 平摊 */
export interface GraphEntry {
  node: SessionNode;
  edges: Edge[];
}

/** 整图:多个 session node */
export interface SessionGraph {
  entries: GraphEntry[];
}
