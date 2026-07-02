/** 内部 react-force-graph shape */
export type SubagentRole = "Explore" | "Design" | "Validate" | "Implement" | "Other";

export interface GNode {
  id: string;
  type: "main" | "subagent" | "tool";
  label: string;
  /** main ∝ sqrt(token_total); subagent 固定 = 4 */
  radius?: number;
  /** 节点首次时间戳(epoch ms)— 时序纵轴用 */
  first_timestamp_ms?: number;
  /** subagent 角色分类 — Explore/Design/Validate/Implement/Other */
  role?: SubagentRole;
  /** S6: subagent 的 agent-id (e.g. "agent-a4aa77"),用于关联自己的 JSONL entry */
  agent_id?: string;
  session_id?: string;
  workspace?: string | null;
  token_total?: number;
  primary_model?: string | null;
  thinking_count?: number;
  error_count?: number;
  subagent_count?: number;
  top_tools?: string[];
  description?: string | null;
  parent_session_id?: string | null;
}

export interface GLink {
  source: string;
  target: string;
  label?: string;
  weight?: number;
  edgeType: "Spawned" | "UsedTool" | "AttemptedFix" | "CrossSession";
}
