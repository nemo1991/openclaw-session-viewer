/**
 * v0.12 (C2 / FR-C2): 首页风险徽标的数据桥
 *
 * 设计约束(对齐 PRD §5.2 与 §八):
 * - **强制复用** v0.11 的 foldGraphEntries + evaluateHealth,不引入第二套体检口径(RK-V1)。
 * - 输入必须是 useGraphStore.entries(本地 DB 聚合),输出 Map<session_id, FlaggedSession>
 *   供首页卡片 O(1) 查询;整体 O(n) 单次遍历,由调用方 useMemo 缓存。
 * - 空数据 / 加载中 / 脏数据一律返回空 Map,绝不抛错阻塞首屏(§十二)。
 *
 * 映射规则(按代码事实修正 PRD §5.2 的一处描述偏差):
 *   foldGraphEntries 已把 subagent 归并进 parent,因此 nodes 里的 session_id 都是
 *   **parent** 的 id;首页卡片按 sessionId 精确匹配即可。子会话卡片(若出现在
 *   list_sessions 中)的 id 不在 index 内,自然不会被标,不会重复计数。
 *   PRD 原文写的「带 subagentDir 的卡片是子会话、不单独标」与代码语义不符 ——
 *   SessionMeta.subagentDir 表示该会话**拥有**子会话目录(即它正是 parent,
 *   SessionsRoute 用它渲染 `⎇ N` 徽标)。若按字面排除,会把全部 parent 卡片排除,
 *   徽标几乎不显示,与 C2 目标相悖。故此处以 session_id 精确匹配为准。
 */

import type { HealthRulesConfig } from "@ocsv/shared";
import { foldGraphEntries } from "./analytics";
import type { GraphEntry } from "./types";
import { evaluateHealth } from "./health";
import type { FlaggedSession } from "./health";

/**
 * 由 graph entries + 本机体检阈值构建首页风险索引。
 * @param entries useGraphStore.entries,可为 null(未加载)/空数组(空库)
 * @param rules   settings.json 的 healthRules,允许缺失(evaluateHealth 内会 normalize)
 */
export function buildRiskIndex(
  entries: GraphEntry[] | null | undefined,
  rules?: Partial<HealthRulesConfig> | null
): Map<string, FlaggedSession> {
  const index = new Map<string, FlaggedSession>();
  if (!Array.isArray(entries) || entries.length === 0) return index;

  let nodes;
  try {
    nodes = foldGraphEntries(entries).nodes;
  } catch {
    // 脏 wire / 缺字段时不让首页崩,徽标暂缺即可
    return index;
  }

  const report = evaluateHealth(nodes, rules);
  for (const flagged of report.flagged) {
    const id = flagged.node?.session_id;
    if (!id) continue;
    // 理论上折叠后 session_id 唯一;若重复,保留命中规则数更高的一条
    const prev = index.get(id);
    if (!prev || flagged.score > prev.score) index.set(id, flagged);
  }
  return index;
}
