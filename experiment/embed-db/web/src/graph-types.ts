/** 内部 react-force-graph shape */
export interface GNode {
  id: string;
  type: "main" | "subagent" | "tool";
  label: string;
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
