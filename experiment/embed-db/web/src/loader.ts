/**
 * 加载 NDJSON 文件并构建图
 *
 * 数据来源:cargo run -- ingest --out stdout > public/sessions.ndjson
 * 然后 web fetch 同一文件。
 */

import type { GraphEntry, SessionNode } from "./types";
import type { GNode, GLink, SubagentRole } from "./graph-types";

/**
 * 解析 NDJSON — ingest crate stdout sink 输出是 **flat**:
 *   { node_id, session_id, ..., edges: Edge[] }
 *
 * 上层 GraphEntry 类型契约是 nested:
 *   { node: SessionNode, edges: Edge[] }
 *
 * 这里在 loader 边界把 flat 适配成 nested,让 views 一致用 e.node。
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
      const { edges, ...nodeFields } = d;
      out.push({
        node: nodeFields as SessionNode,
        edges: Array.isArray(edges) ? edges : [],
      });
    } catch (e) {
      console.warn("skip malformed NDJSON line:", e);
    }
  }
  return out;
}

/**
 * 从 subagent description 前缀启发式分类角色
 *
 * 优先级:Implement > Validate > Design > Explore > Other
 * (具体动词优先,避免 "fix something after explore" 误分类)
 *
 * 中文 / 英文都支持;首字切到空白。
 */
export function classifyRole(desc: string | null | undefined): SubagentRole {
  if (!desc) return "Other";
  const d = desc.trim().toLowerCase();
  // Implement 最具体(动词直接动对象)
  if (/^(implement|fix|build|ship|修复|实施|修改|实现|修复|改动|执行|run|execute)/.test(d))
    return "Implement";
  // Validate
  if (/^(validate|verify|test|check|audit|验证|测试|核查)/.test(d)) return "Validate";
  // Design
  if (/^(design|map|plan|architect|outline|规划|设计|制定|构思|起草|set up)/.test(d))
    return "Design";
  // Explore (默认 subagent 行为)
  if (
    /^(explore|research|investigate|survey|look ?into|调研|探索|研究|查找|调查|分析|了解|理解)/.test(
      d
    )
  )
    return "Explore";
  return "Other";
}

/** main 节点半径 ∝ sqrt(token_total / 1e6),clamp [4, 14] */
function tokenRadius(tokenTotal: number | undefined | null): number {
  const t = Math.max(0, tokenTotal ?? 0);
  return Math.min(14, Math.max(4, Math.sqrt(t / 1e6)));
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
  const nodes = new Map<string, GNode>();
  const links: GLink[] = [];

  for (const e of entries) {
    const n: SessionNode = e.node;

    // 1. main / subagent root 节点
    nodes.set(n.node_id, {
      id: n.node_id,
      type: n.is_subagent_root ? "subagent" : "main",
      label: n.first_prompt?.slice(0, 60) || n.session_id.slice(0, 8),
      radius: tokenRadius(n.token_total),
      first_timestamp_ms: n.first_timestamp_ms ?? undefined,
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
        // 拉 description (从 Spawned edge)
        let desc: string | null = null;
        for (const e2 of e.edges) {
          if (e2.type === "Spawned" && e2.to_subagent_id === sa_id) {
            desc = e2.description ?? null;
            break;
          }
        }
        // 试着找 subagent 自己 entry 的 first_timestamp(若有)
        const saEntry = entries.find(
          (x) => x.node.session_id === sa_id || x.node.node_id === sa_id
        );
        nodes.set(sa_node_id, {
          id: sa_node_id,
          type: "subagent",
          label: desc?.slice(0, 36) || sa_id,
          radius: 4,
          first_timestamp_ms: saEntry?.node.first_timestamp_ms ?? n.first_timestamp_ms ?? undefined,
          role: classifyRole(desc),
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

export type { GNode, GLink, SubagentRole } from "./graph-types";
