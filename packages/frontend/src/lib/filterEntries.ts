/**
 * Entry 筛选纯函数
 *
 * 设计:Strategy 模式的轻量化落地 — 不引入 FilterStrategy 接口(避免 1h/24h/7d
 * 的 now 锚点穿透 memo),只把"按时间区间 / 内容维度筛选"这两步抽成纯函数。
 *
 * 配套:
 * - 区间 math(setPreset / setRange)在 transcriptFilterStore 里,now 在点击瞬间冻结
 * - apply 步骤统一在本文件,被 TranscriptView 渲染管线 + SearchInSessionBar
 *   搜索范围共同消费,消除原本两处 ~12 行重复代码
 *
 * 边界:
 * - 缺 timestamp 的 entry 保留(meta 之类没时间戳)
 * - timestamp 解析失败(entry 损坏)的保留(不让破损数据把整段过滤掉)
 * - from 缺省 = -Infinity(不限制下界),to 缺省 = +Infinity(不限制上界)
 *
 * v0.7.0: 内容维度 filter(tool / role / has-attribute)— 与 time filter 正交,
 *   pipeline 串联(time → content),content 维度内 OR、跨维度 AND。
 */

import type { TranscriptEntryOut, NormalizedBlockFE } from "./api";

export interface TimeRange {
  from?: string;
  to?: string;
}

export function applyTimeFilter(
  entries: TranscriptEntryOut[],
  range: TimeRange
): TranscriptEntryOut[] {
  const fromMs = range.from ? new Date(range.from).getTime() : -Infinity;
  const toMs = range.to ? new Date(range.to).getTime() : Infinity;
  return entries.filter((e) => {
    const ts = e.normalized.timestamp;
    if (!ts) return true; // 没时间戳的保留
    const ms = new Date(ts).getTime();
    if (isNaN(ms)) return true; // 解析失败保留
    return ms >= fromMs && ms <= toMs;
  });
}

// ===== v0.7.0: 内容维度 =====

/** has-* 过滤项 — entry 是否带某属性 */
export type HasAttribute = "thinking" | "tool_use" | "error" | "subagent";

export interface ContentFilterOptions {
  /** 多选 tool name:任一 block.kind==='tool_use' 且 name in tools → 命中 */
  tools?: string[];
  /** 单选 role:entry.normalized.role === role → 命中(undefined = 不限) */
  role?: string;
  /** 多选 has-attribute:任一 attr 命中 → 命中(空数组 = 不限) */
  has?: HasAttribute[];
  /** v0.7.0: 多选 model:entry.normalized.model 命中任一 → 命中(空数组 = 不限) */
  models?: string[];
  /** v0.7.0: 单选 sidechain mode:"all" 不限; "main" 只看主链(isSidechain !== true);
   *  "sidechain" 只看子链(isSidechain === true)。undefined = "all"。 */
  sidechainMode?: "all" | "main" | "sidechain";
}

/** 一个 block 的 kind === expected? — 读 open-index 的 name 字段 */
function blockHasToolUse(blocks: NormalizedBlockFE[], expected: string): boolean {
  return blocks.some((b) => b.kind === "tool_use" && String(b.name ?? "") === expected);
}

function blockHasKind(blocks: NormalizedBlockFE[], kind: string): boolean {
  return blocks.some((b) => b.kind === kind);
}

function entryHasAttr(entry: TranscriptEntryOut, attr: HasAttribute): boolean {
  switch (attr) {
    case "thinking":
      return blockHasKind(entry.normalized.blocks, "thinking");
    case "tool_use":
      return blockHasKind(entry.normalized.blocks, "tool_use");
    case "error":
      return entry.normalized.stopReason === "error";
    case "subagent":
      // subagentId 是 Agent/Task tool_use 的最直接信号;isSidechain 也算(老 session 偶尔缺 subagentId)
      return (
        entry.normalized.subagentId != null ||
        entry.normalized.isSidechain === true ||
        blockHasToolUse(entry.normalized.blocks, "Agent") ||
        blockHasToolUse(entry.normalized.blocks, "Task")
      );
  }
}

/**
 * 内容维度过滤 — 维内 OR,跨维 AND。
 *
 * 例:tools=["Bash","Read"], has=["thinking"] →
 *   保留 entries:有 Bash tool_use **或** Read tool_use,**且**含 thinking block
 *
 * 空 opts / 各字段空数组 / undefined → 全部保留(对应维度不限)。
 */
export function applyContentFilter(
  entries: TranscriptEntryOut[],
  opts: ContentFilterOptions
): TranscriptEntryOut[] {
  const tools = opts.tools ?? [];
  const has = opts.has ?? [];
  const models = opts.models ?? [];
  const role = opts.role;
  const sidechainMode = opts.sidechainMode ?? "all";
  // 全部维度都不限 → 直通(返回 entries,filter 上游 memo 引用复用)
  if (
    tools.length === 0 &&
    has.length === 0 &&
    models.length === 0 &&
    !role &&
    sidechainMode === "all"
  ) {
    return entries;
  }
  return entries.filter((e) => {
    if (role && e.normalized.role !== role) return false;
    if (tools.length > 0 && !tools.some((t) => blockHasToolUse(e.normalized.blocks, t))) {
      return false;
    }
    if (has.length > 0 && !has.some((h) => entryHasAttr(e, h))) {
      return false;
    }
    if (models.length > 0) {
      const m = e.normalized.model;
      if (!m || !models.includes(m)) return false;
    }
    if (sidechainMode === "main" && e.normalized.isSidechain === true) return false;
    if (sidechainMode === "sidechain" && e.normalized.isSidechain !== true) return false;
    return true;
  });
}
