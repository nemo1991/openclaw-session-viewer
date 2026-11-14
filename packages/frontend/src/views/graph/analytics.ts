/**
 * Analytics aggregations — 纯函数,无 React 依赖,易测
 *
 * 数据源: GraphEntry[] (NDJSON parse 后的数组)
 *
 * v0.10 (FR-I1/I2/I3):
 *  - 重试率改吃 Rust 聚合阶段算好的 retry_count / tool_call_count,不再用 error_count 分桶冒充
 *  - foldSubagents() 把 subagent 的用量/错误/工具调用归并到 parent (dsh / 孤儿降级独立计)
 *  - crossSourceByModel() 补"同模型跨 source"对齐维度,sessionsByDay 拆全 4 个 source
 *
 * 注: 不引入 DuckDB,聚合已在 Rust 侧算完,这里只做展示级汇总。
 */

import type { GraphEntry, SessionNode, Edge } from "./types";

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

/**
 * v0.10 (FR-I3): 4 个 source 的规范化 key。
 * Rust `GraphNodeFE.source` 对 dsh 输出 "DeepSeek Harness",而前端别处历史
 * 上写过 "DeepSeekHarness" — 两种拼写都归一到同一 key,避免分组串源。
 */
export const SOURCE_KEYS = ["Claude", "OpenClaw", "Kimi", "DeepSeekHarness"] as const;
export type SourceKey = (typeof SOURCE_KEYS)[number];

export function sourceKey(source: string): SourceKey {
  if (source === "OpenClaw" || source === "openclaw") return "OpenClaw";
  if (source === "Kimi" || source === "kimi") return "Kimi";
  if (source === "DeepSeekHarness" || source === "DeepSeek Harness" || source === "dsh")
    return "DeepSeekHarness";
  return "Claude";
}

/** 1. sessions_per_day × source (4 个 source 各自独立计数,不再把 Kimi/dsh 混进 Claude) */
export type DayBucket = { day: string } & Record<SourceKey, number>;

function emptyDayBucket(day: string): DayBucket {
  return { day, Claude: 0, OpenClaw: 0, Kimi: 0, DeepSeekHarness: 0 };
}

export function sessionsByDay(nodes: GraphNode[]): DayBucket[] {
  const map = new Map<string, DayBucket>();
  for (const n of nodes) {
    const ts = n.last_timestamp_ms ?? n.first_timestamp_ms ?? n.mtime_ms;
    if (!ts) continue;
    const day = new Date(ts).toISOString().slice(0, 10);
    if (!map.has(day)) map.set(day, emptyDayBucket(day));
    const b = map.get(day)!;
    b[sourceKey(n.source)] += 1;
  }
  return Array.from(map.values()).sort((a, b) => a.day.localeCompare(b.day));
}

/** v0.10 (FR-I3): 按 source 独立汇总,给 KPI / 跨 source 对比做口径核对 */
export interface SourceBucket {
  source: SourceKey;
  sessions_count: number;
  total_tokens: number;
  total_errors: number;
}

export function sessionsBySource(nodes: GraphNode[]): SourceBucket[] {
  const map = new Map<SourceKey, SourceBucket>();
  for (const key of SOURCE_KEYS) {
    map.set(key, { source: key, sessions_count: 0, total_tokens: 0, total_errors: 0 });
  }
  for (const n of nodes) {
    const b = map.get(sourceKey(n.source))!;
    b.sessions_count += 1;
    b.total_tokens += n.token_total;
    b.total_errors += n.error_count;
  }
  return SOURCE_KEYS.map((k) => map.get(k)!).filter((b) => b.sessions_count > 0);
}

/** 2. token_top N — 按 token_total desc, 返 top N 的 {session_id, title, tokens, when} */
export interface TokenTopRow {
  session_id: string;
  label: string;
  workspace: string | null;
  tokens: number;
  source: "Claude" | "OpenClaw" | "Kimi" | "DeepSeekHarness";
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
      if (ed.type === "used_tool") {
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

/**
 * 5. v0.10 (FR-I1) 真实重试率 — 分子 retry_count / 分母 tool_call_count
 * 由 Rust `meta_aggregator::RetryTracker` 在聚合阶段按 wire 顺序算出,
 * 口径:某 tool 调用失败后,紧随其后出现同名 tool 的下一次调用计 1 次重试。
 * 这里不再用 error_count 分桶估值。
 */
export interface RetrySummary {
  /** 重试次数 (分子) */
  retry_count: number;
  /** tool 调用总次数 (分母) */
  tool_call_count: number;
  /** 0..1;分母为 0 时记 0,不产生 NaN */
  retry_rate: number;
  /** 至少发生过 1 次重试的会话数 */
  sessions_with_retry: number;
  /** 有 tool 调用的会话数 */
  sessions_with_tool_calls: number;
}

export function retryRateSummary(nodes: GraphNode[]): RetrySummary {
  let retry_count = 0;
  let tool_call_count = 0;
  let sessions_with_retry = 0;
  let sessions_with_tool_calls = 0;
  for (const n of nodes) {
    const retries = n.retry_count ?? 0;
    const calls = n.tool_call_count ?? 0;
    retry_count += retries;
    tool_call_count += calls;
    if (retries > 0) sessions_with_retry += 1;
    if (calls > 0) sessions_with_tool_calls += 1;
  }
  return {
    retry_count,
    tool_call_count,
    retry_rate: tool_call_count > 0 ? retry_count / tool_call_count : 0,
    sessions_with_retry,
    sessions_with_tool_calls,
  };
}

export interface SourceRetryRow {
  source: SourceKey;
  sessions_count: number;
  retry_count: number;
  tool_call_count: number;
  retry_rate: number;
}

/** 按 source 独立汇总真实重试率 — 分组 key 含 source,保证不串源 */
export function retryRateBySource(nodes: GraphNode[]): SourceRetryRow[] {
  const map = new Map<SourceKey, SourceRetryRow>();
  for (const key of SOURCE_KEYS) {
    map.set(key, {
      source: key,
      sessions_count: 0,
      retry_count: 0,
      tool_call_count: 0,
      retry_rate: 0,
    });
  }
  for (const n of nodes) {
    const row = map.get(sourceKey(n.source))!;
    row.sessions_count += 1;
    row.retry_count += n.retry_count ?? 0;
    row.tool_call_count += n.tool_call_count ?? 0;
  }
  return SOURCE_KEYS.map((k) => map.get(k)!)
    .filter((r) => r.sessions_count > 0)
    .map((r) => ({
      ...r,
      retry_rate: r.tool_call_count > 0 ? r.retry_count / r.tool_call_count : 0,
    }));
}

/**
 * v0.10 (FR-I3) 同模型跨 source 对齐 — 一行 = (model, source)。
 * model 缺失的会话不参与对齐 (无模型可比),避免产生空模型分组。
 */
export interface CrossSourceModelRow extends SourceRetryRow {
  primary_model: string;
  total_tokens: number;
  total_errors: number;
}

export function crossSourceByModel(nodes: GraphNode[]): CrossSourceModelRow[] {
  const map = new Map<string, CrossSourceModelRow>();
  for (const n of nodes) {
    if (!n.primary_model) continue;
    const source = sourceKey(n.source);
    const key = `${n.primary_model}\u0000${source}`;
    let row = map.get(key);
    if (!row) {
      row = {
        primary_model: n.primary_model,
        source,
        sessions_count: 0,
        total_tokens: 0,
        total_errors: 0,
        retry_count: 0,
        tool_call_count: 0,
        retry_rate: 0,
      };
      map.set(key, row);
    }
    row.sessions_count += 1;
    row.total_tokens += n.token_total;
    row.total_errors += n.error_count;
    row.retry_count += n.retry_count ?? 0;
    row.tool_call_count += n.tool_call_count ?? 0;
  }
  return Array.from(map.values())
    .map((r) => ({
      ...r,
      retry_rate: r.tool_call_count > 0 ? r.retry_count / r.tool_call_count : 0,
    }))
    .sort(
      (a, b) =>
        a.primary_model.localeCompare(b.primary_model) ||
        SOURCE_KEYS.indexOf(a.source) - SOURCE_KEYS.indexOf(b.source)
    );
}

/** 出现在 ≥2 个 source 的 model — "同模型跨 source" 视图只展示这些 */
export function modelsAcrossSources(rows: CrossSourceModelRow[]): string[] {
  const byModel = new Map<string, Set<SourceKey>>();
  for (const r of rows) {
    if (!byModel.has(r.primary_model)) byModel.set(r.primary_model, new Set());
    byModel.get(r.primary_model)!.add(r.source);
  }
  return Array.from(byModel.entries())
    .filter(([, sources]) => sources.size >= 2)
    .map(([model]) => model)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * v0.10 (FR-I2) subagent → parent 折叠。
 *
 * 规则:
 * - is_subagent_root=true 且 parent_session_id 能在本批数据里找到 → 用量/错误/
 *   tool 调用/retry 归并到 (递归上溯后的) 顶层 parent,子会话从汇总列表移除。
 * - 孤儿 (parent 不在本批) 按独立会话计。
 * - dsh 缺 parent_uuid 上游字段,按 PRD 降级为独立计 (不折叠)。
 * - 纯函数:不修改入参节点。
 */
export interface FoldedSubagent {
  child_session_id: string;
  parent_session_id: string;
}

export interface FoldResult {
  nodes: GraphNode[];
  folded: FoldedSubagent[];
  /** 未按 parent 归并的 subagent 数(孤儿 + dsh 降级) */
  independent_subagents: number;
}

interface FoldDelta {
  token_total: number;
  error_count: number;
  thinking_count: number;
  message_count: number;
  retry_count: number;
  tool_call_count: number;
  children: number;
}

function emptyDelta(): FoldDelta {
  return {
    token_total: 0,
    error_count: 0,
    thinking_count: 0,
    message_count: 0,
    retry_count: 0,
    tool_call_count: 0,
    children: 0,
  };
}

export function foldSubagents(nodes: GraphNode[]): FoldResult {
  const byId = new Map<string, GraphNode>();
  for (const n of nodes) {
    byId.set(n.node_id, n);
    byId.set(n.session_id, n);
  }

  const isDsh = (n: GraphNode) => sourceKey(n.source) === "DeepSeekHarness";
  const foldedTargets = new Map<string, string>(); // child.node_id → root.node_id
  const deltas = new Map<string, FoldDelta>();
  let independent_subagents = 0;

  for (const n of nodes) {
    if (!n.is_subagent_root) continue;
    const parentId = n.parent_session_id;
    if (!parentId || isDsh(n)) {
      independent_subagents += 1;
      continue;
    }
    let root = byId.get(parentId);
    if (!root) {
      independent_subagents += 1;
      continue;
    }
    // 递归上溯到顶层 parent,带环保护 (父链可能成环或指向自己)
    const seen = new Set<string>([n.node_id]);
    while (root.is_subagent_root && root.parent_session_id && !seen.has(root.node_id)) {
      seen.add(root.node_id);
      const next = byId.get(root.parent_session_id);
      if (!next || next.node_id === root.node_id) break;
      root = next;
    }
    if (root.node_id === n.node_id || isDsh(root)) {
      independent_subagents += 1;
      continue;
    }

    foldedTargets.set(n.node_id, root.node_id);
    const d = deltas.get(root.node_id) ?? emptyDelta();
    d.token_total += n.token_total;
    d.error_count += n.error_count;
    d.thinking_count += n.thinking_count;
    d.message_count += n.message_count;
    d.retry_count += n.retry_count ?? 0;
    d.tool_call_count += n.tool_call_count ?? 0;
    d.children += 1;
    deltas.set(root.node_id, d);
  }

  const out: GraphNode[] = [];
  for (const n of nodes) {
    if (foldedTargets.has(n.node_id)) continue;
    const d = deltas.get(n.node_id);
    if (!d) {
      out.push(n);
      continue;
    }
    out.push({
      ...n,
      token_total: n.token_total + d.token_total,
      error_count: n.error_count + d.error_count,
      thinking_count: n.thinking_count + d.thinking_count,
      message_count: n.message_count + d.message_count,
      retry_count: (n.retry_count ?? 0) + d.retry_count,
      tool_call_count: (n.tool_call_count ?? 0) + d.tool_call_count,
      folded_subagent_count: (n.folded_subagent_count ?? 0) + d.children,
    });
  }

  return {
    nodes: out,
    folded: Array.from(foldedTargets.entries()).map(([child, parent]) => ({
      child_session_id: child,
      parent_session_id: parent,
    })),
    independent_subagents,
  };
}

/**
 * 在 GraphEntry 层折叠:节点用 foldSubagents 的结果,被折叠子会话的 edges
 * (tool 调用等)挂到 parent 的 entry 上 — 保证 topTools / toolsByCategory
 * 既不丢 subagent 的调用,也不会把子会话再当独立节点重复计。
 */
export function foldGraphEntries(entries: GraphEntry[]): FoldResult & { entries: GraphEntry[] } {
  const fold = foldSubagents(entries.map((e) => e.node));
  const foldedNodeById = new Map(fold.nodes.map((n) => [n.node_id, n]));
  const childToRoot = new Map(fold.folded.map((f) => [f.child_session_id, f.parent_session_id]));
  const extraEdges = new Map<string, Edge[]>();
  const roots: GraphEntry[] = [];

  for (const e of entries) {
    const root = childToRoot.get(e.node.node_id);
    if (root) {
      extraEdges.set(root, [...(extraEdges.get(root) ?? []), ...e.edges]);
      continue;
    }
    if (foldedNodeById.has(e.node.node_id)) roots.push(e);
  }

  return {
    ...fold,
    entries: roots.map((e) => {
      const node = foldedNodeById.get(e.node.node_id)!;
      const extra = extraEdges.get(e.node.node_id) ?? [];
      return { node, edges: extra.length ? [...e.edges, ...extra] : e.edges };
    }),
  };
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
  /** v0.10 (FR-I1): 真实重试率分子/分母/比值 */
  total_retry_count: number;
  total_tool_call_count: number;
  retry_rate: number;
  /** 无错误 session 数 / 总数 — 成功率 */
  clean_sessions: number;
  /** 平均 session 持续时间(ms) */
  avg_duration_ms: number;
  date_range: { from_ms: number; to_ms: number };
}

export function summary(nodes: GraphNode[]): Summary {
  let total_tokens = 0;
  let total_subagents = 0;
  let total_errors = 0;
  let total_retry_count = 0;
  let total_tool_call_count = 0;
  let clean_sessions = 0;
  let duration_sum = 0;
  let duration_count = 0;
  let from_ms = Infinity;
  let to_ms = -Infinity;
  for (const n of nodes) {
    total_tokens += n.token_total;
    total_subagents += n.subagent_count;
    total_errors += n.error_count;
    total_retry_count += n.retry_count ?? 0;
    total_tool_call_count += n.tool_call_count ?? 0;
    if (n.error_count === 0) clean_sessions += 1;
    if (n.first_timestamp_ms && n.last_timestamp_ms && n.last_timestamp_ms > n.first_timestamp_ms) {
      duration_sum += n.last_timestamp_ms - n.first_timestamp_ms;
      duration_count += 1;
    }
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
    total_retry_count,
    total_tool_call_count,
    retry_rate: total_tool_call_count > 0 ? total_retry_count / total_tool_call_count : 0,
    clean_sessions,
    avg_duration_ms: duration_count ? duration_sum / duration_count : 0,
    date_range: {
      from_ms: from_ms === Infinity ? 0 : from_ms,
      to_ms: to_ms === -Infinity ? 0 : to_ms,
    },
  };
}

/** 7. 按 workspace 错误数 / session 数 — 看哪条 work stream 最不稳 */
export interface WorkspaceErrorRow {
  workspace: string;
  sessions_count: number;
  total_errors: number;
  err_per_session: number;
}

export function errorsByWorkspace(nodes: GraphNode[]): WorkspaceErrorRow[] {
  const map = new Map<string, { sessions: number; errors: number }>();
  for (const n of nodes) {
    const ws = n.workspace ?? "(unknown)";
    const m = map.get(ws) ?? { sessions: 0, errors: 0 };
    m.sessions += 1;
    m.errors += n.error_count;
    map.set(ws, m);
  }
  return Array.from(map.entries())
    .map(([workspace, v]) => ({
      workspace,
      sessions_count: v.sessions,
      total_errors: v.errors,
      err_per_session: v.sessions ? v.errors / v.sessions : 0,
    }))
    .sort((a, b) => b.total_errors - a.total_errors);
}

/** 8. 工具按"类别"分组 — 简单启发式,基于工具名首段 */
const TOOL_CATEGORY_RULES: Array<[RegExp, string]> = [
  [/^(Read|Write|Edit|Glob|Grep|LS)$/i, "文件"],
  [/^(Bash|Shell)$/i, "Shell"],
  [/^(TaskUpdate|TaskCreate|TaskOutput|TaskStop|TaskList)$/i, "Task 管理"],
  [/^(Agent|Task)$/i, "子代理"],
  [/^(WebFetch|WebSearch)$/i, "Web"],
  [/^(AskUserQuestion|AskUser)$/i, "交互"],
  [/^(TodoWrite|TODOs)$/i, "TODO"],
];

export interface ToolCategoryRow {
  category: string;
  total_calls: number;
  sessions_count: number;
}

export function toolsByCategory(entries: GraphEntry[]): ToolCategoryRow[] {
  const byTool = new Map<string, { sessions: Set<string>; calls: number }>();
  for (const e of entries) {
    for (const ed of e.edges) {
      if (ed.type !== "used_tool") continue;
      let m = byTool.get(ed.tool_name);
      if (!m) {
        m = { sessions: new Set(), calls: 0 };
        byTool.set(ed.tool_name, m);
      }
      m.sessions.add(e.node.node_id);
      m.calls += ed.count;
    }
  }
  const byCat = new Map<string, { calls: number; sessions: Set<string> }>();
  for (const [tool, v] of byTool) {
    let cat = "其他";
    for (const [re, name] of TOOL_CATEGORY_RULES) {
      if (re.test(tool)) {
        cat = name;
        break;
      }
    }
    let bucket = byCat.get(cat);
    if (!bucket) {
      bucket = { calls: 0, sessions: new Set() };
      byCat.set(cat, bucket);
    }
    bucket.calls += v.calls;
    for (const s of v.sessions) bucket.sessions.add(s);
  }
  return Array.from(byCat.entries())
    .map(([category, v]) => ({
      category,
      total_calls: v.calls,
      sessions_count: v.sessions.size,
    }))
    .sort((a, b) => b.total_calls - a.total_calls);
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
