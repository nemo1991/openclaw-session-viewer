/**
 * Analytics aggregations — 纯函数,无 React 依赖,易测
 *
 * 数据源: GraphEntry[] (NDJSON parse 后的数组)
 *
 * 6 个聚合:
 *  1. sessionsByDay × source — 每天几个 session,按 source (Claude/OpenClaw) 拆分
 *  2. tokenTopN — 按 token_total desc 排序前 N
 *  3. topToolsBar — 横着工具名 (top N 用 main rank) / 纵着使用次数 (跨 sessions 累加)
 *  4. modelAvg — x=primary_model, y=avg thinking per session
 *  5. retryRate — is_error / total tool_use (先得 edge 数据)— 简化改用 session.error_count / session.token_total proxy
 *  6. subagentChainDist — 1层 / 2层 / 3+ 层 subagent 数
 *
 * 注: 不引入 DuckDB,S2 跟 S1 同样的策略 — 35 sessions 全 in-memory 够用。
 */

import type { GraphEntry, SessionNode } from "./types";

export type Range = "24h" | "7d" | "30d" | "all";

const MS_PER_HOUR = 3600_000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export function cutoffMs(range: Range, now: number = Date.now()): number | null {
  switch (range) {
    case "24h":
      return now - MS_PER_HOUR * 24;
    case "7d":
      return now - MS_PER_DAY * 7;
    case "30d":
      return now - MS_PER_DAY * 30;
    case "all":
      return null;
  }
}

/** 过滤 entries 到时间范围内 */
export function filterByRange(entries: GraphEntry[], range: Range): GraphNode[] {
  const cutoff = cutoffMs(range);
  return entries
    .map((e) => e.node)
    .filter((n) => {
      if (cutoff === null) return true;
      const ts = n.last_timestamp_ms ?? n.first_timestamp_ms ?? n.mtime_ms;
      return ts >= cutoff;
    });
}

/** Alias: GraphEntry[] 取 node 的简写类型 */
export type GraphNode = SessionNode;

/** 1. sessions_per_day × source */
export type DayBucket = {
  day: string; // YYYY-MM-DD
  Claude: number;
  OpenClaw: number;
};

export function sessionsByDay(nodes: GraphNode[]): DayBucket[] {
  const map = new Map<string, DayBucket>();
  for (const n of nodes) {
    const ts = n.last_timestamp_ms ?? n.first_timestamp_ms ?? n.mtime_ms;
    if (!ts) continue;
    const day = new Date(ts).toISOString().slice(0, 10);
    if (!map.has(day)) map.set(day, { day, Claude: 0, OpenClaw: 0 });
    const b = map.get(day)!;
    if (n.source === "OpenClaw") b.OpenClaw += 1;
    else b.Claude += 1;
  }
  return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
}

/** 2. token_top N — 按 token_total desc, 返 top N 的 {session_id, title, tokens, when} */
export interface TokenTopRow {
  session_id: string;
  label: string;
  workspace: string | null;
  tokens: number;
  source: "Claude" | "OpenClaw";
  primary_model: string | null;
  when_ms: number;
}

export function tokenTopN(nodes: GraphNode[], n: number): TokenTopRow[] {
  return [...nodes]
    .filter((x) => x.token_total > 0)
    .sort((a, b) => b.token_total - a.token_total)
    .slice(0, n)
    .map((x) => ({
      session_id: x.session_id,
      label: (x.first_prompt ?? x.session_id.slice(0, 8)).slice(0, 80),
      workspace: x.workspace,
      tokens: x.token_total,
      source: x.source,
      primary_model: x.primary_model,
      when_ms: x.last_timestamp_ms ?? x.first_timestamp_ms ?? x.mtime_ms,
    }));
}

/** 3. top_tools_bar — 跨所有 sessions 累加 top_tools[3] 里每个 tool 的出现次数 (1 session 算 1) */
export interface ToolBarRow {
  tool: string;
  sessions_count: number;
  total_calls: number; // sum of count from UsedTool edges
}

export function topToolsBar(entries: GraphEntry[], topN: number): ToolBarRow[] {
  const sessionWithTool = new Map<string, Set<string>>(); // tool -> set(session_id)
  const totalCalls = new Map<string, number>();
  for (const e of entries) {
    if (!e.node.node_id) continue;
    for (const ed of e.edges) {
      if (ed.type === "UsedTool") {
        let set = sessionWithTool.get(ed.tool_name);
        if (!set) {
          set = new Set();
          sessionWithTool.set(ed.tool_name, set);
        }
        set.add(e.node.node_id);
        totalCalls.set(ed.tool_name, (totalCalls.get(ed.tool_name) ?? 0) + ed.count);
      }
    }
  }
  const rows: ToolBarRow[] = [];
  for (const [tool, sessions] of sessionWithTool) {
    rows.push({
      tool,
      sessions_count: sessions.size,
      total_calls: totalCalls.get(tool) ?? 0,
    });
  }
  return rows.sort((a, b) => b.total_calls - a.total_calls).slice(0, topN);
}

/** 4. model_avg_thinking — x=primary_model, y=avg thinking_count per session */
export interface ModelAvgRow {
  primary_model: string;
  sessions_count: number;
  avg_thinking: number;
  total_tokens: number;
}

export function modelAvgThinking(nodes: GraphNode[]): ModelAvgRow[] {
  const map = new Map<string, { count: number; total_thinking: number; total_tokens: number }>();
  for (const n of nodes) {
    if (!n.primary_model) continue;
    const m = map.get(n.primary_model) ?? { count: 0, total_thinking: 0, total_tokens: 0 };
    m.count += 1;
    m.total_thinking += n.thinking_count;
    m.total_tokens += n.token_total;
    map.set(n.primary_model, m);
  }
  return Array.from(map.entries())
    .map(([primary_model, v]) => ({
      primary_model,
      sessions_count: v.count,
      avg_thinking: v.count === 0 ? 0 : Math.round(v.total_thinking / v.count),
      total_tokens: v.total_tokens,
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens);
}

/** 5. retry_rate — proxy by error_count/token_total per session (低 = 失败少的 session) */
export interface RetryRow {
  bucket: string; // "<N errors" / "N-M errors" / "M+ errors"
  sessions_count: number;
}

export function retryRateDistribution(nodes: GraphNode[]): RetryRow[] {
  const low = nodes.filter((n) => n.error_count === 0).length;
  const mid = nodes.filter((n) => n.error_count > 0 && n.error_count <= 5).length;
  const high = nodes.filter((n) => n.error_count > 5 && n.error_count <= 20).length;
  const huge = nodes.filter((n) => n.error_count > 20).length;
  return [
    { bucket: "0 errors", sessions_count: low },
    { bucket: "1-5 errors", sessions_count: mid },
    { bucket: "6-20 errors", sessions_count: high },
    { bucket: "20+ errors", sessions_count: huge },
  ];
}

/** 6. subagent_chain_dist — 按 subagent_count 分桶 */
export interface ChainRow {
  bucket: string;
  sessions_count: number;
}

export function subagentChainDist(nodes: GraphNode[]): ChainRow[] {
  const none = nodes.filter((n) => n.subagent_count === 0).length;
  const one2two = nodes.filter((n) => n.subagent_count > 0 && n.subagent_count <= 2).length;
  const threeTen = nodes.filter((n) => n.subagent_count > 2 && n.subagent_count <= 10).length;
  const elevenUp = nodes.filter((n) => n.subagent_count > 10).length;
  return [
    { bucket: "0 个 subagent", sessions_count: none },
    { bucket: "1-2 个", sessions_count: one2two },
    { bucket: "3-10 个", sessions_count: threeTen },
    { bucket: "10+ 个(深度子代理)", sessions_count: elevenUp },
  ];
}

/** summary 一行 */
export interface Summary {
  total_sessions: number;
  total_tokens: number;
  total_subagents: number;
  total_errors: number;
  date_range: { from_ms: number; to_ms: number };
}

export function summary(nodes: GraphNode[]): Summary {
  let total_tokens = 0;
  let total_subagents = 0;
  let total_errors = 0;
  let from_ms = Infinity;
  let to_ms = -Infinity;
  for (const n of nodes) {
    total_tokens += n.token_total;
    total_subagents += n.subagent_count;
    total_errors += n.error_count;
    const ts = n.last_timestamp_ms ?? n.first_timestamp_ms ?? n.mtime_ms;
    if (ts) {
      if (ts < from_ms) from_ms = ts;
      if (ts > to_ms) to_ms = ts;
    }
  }
  return {
    total_sessions: nodes.length,
    total_tokens,
    total_subagents,
    total_errors,
    date_range: {
      from_ms: from_ms === Infinity ? 0 : from_ms,
      to_ms: to_ms === -Infinity ? 0 : to_ms,
    },
  };
}

export function formatNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}
