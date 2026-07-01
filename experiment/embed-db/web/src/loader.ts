/**
 * 加载 NDJSON 文件并构建图
 *
 * 数据来源:cargo run -- ingest --out stdout > public/sessions.ndjson
 * 然后 web fetch 同一文件。
 */

import type { GraphEntry, SessionNode } from "./types";

/**
 * 解析 NDJSON (每行一个 JSON object: { ...SessionNode, edges: Edge[] })
 */
export async function loadNdjson(url: string): Promise<GraphEntry[]> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`fetch ${url} → ${resp.status}`);
  }
  const text = await resp.text();
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const out: GraphEntry[] = [];
  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      // 验证必要字段
      if (!d.node_id || !d.session_id) continue;
      out.push(d as GraphEntry);
    } catch (e) {
      console.warn("skip malformed NDJSON line:", e);
    }
  }
  return out;
}

/**
 * 把 GraphEntry[] 转为 react-force-graph 期望的 { nodes, links } 结构
 *
 * 节点:
 * - 每个 main session 一个 node
 * - 每个 subagent (出现在 Spawned edge 里) 也一个 node (类型不同)
 *
 * 边:
 * - Spawned: main → subagent
 * - UsedTool: session → tool(label)
 */
export function buildForceGraph(entries: GraphEntry[]) {
  type GNode = {
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
  };
  type GLink = {
    source: string;
    target: string;
    label?: string;
    weight?: number;
    edgeType: "Spawned" | "UsedTool" | "AttemptedFix" | "CrossSession";
  };

  const nodes = new Map<string, GNode>();
  const links: GLink[] = [];

  for (const e of entries) {
    const n: SessionNode = e.node;

    // 1. main / subagent root 节点
    nodes.set(n.node_id, {
      id: n.node_id,
      type: n.is_subagent_root ? "subagent" : "main",
      label: n.first_prompt?.slice(0, 60) || n.session_id.slice(0, 8),
      session_id: n.session_id,
      workspace: n.workspace,
      token_total: n.token_total,
      primary_model: n.primary_model,
      thinking_count: n.thinking_count,
      error_count: n.error_count,
      subagent_count: n.subagent_count,
      top_tools: n.top_tools,
    });

    // 2. Spawned 边:为每个 subagent 建节点 + Spawned 边
    for (const sa_id of n.subagent_ids) {
      const sa_node_id = `subagent:${sa_id}`;
      if (!nodes.has(sa_node_id)) {
        // 拉 description
        let desc: string | null = null;
        for (const e2 of e.edges) {
          if (e2.type === "Spawned" && e2.to_subagent_id === sa_id) {
            desc = e2.description ?? null;
            break;
          }
        }
        nodes.set(sa_node_id, {
          id: sa_node_id,
          type: "subagent",
          label: sa_id,
          description: desc,
        });
      }
      links.push({
        source: n.node_id,
        target: sa_node_id,
        label: "spawned",
        edgeType: "Spawned",
      });
    }
  }

  return { nodes: Array.from(nodes.values()), links };
}

export type { GNode, GLink } from "./graph-types";
