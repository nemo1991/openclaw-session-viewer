/**
 * Entry 时间筛选纯函数
 *
 * 设计:Strategy 模式的轻量化落地 — 不引入 FilterStrategy 接口(避免 1h/24h/7d
 * 的 now 锚点穿透 memo),只把"按时间区间筛选"这一步抽成纯函数。
 *
 * 配套:
 * - 区间 math(setPreset / setRange)在 transcriptFilterStore 里,now 在点击瞬间冻结
 * - apply 步骤统一在本函数,被 TranscriptView 渲染管线 + SearchInSessionBar
 *   搜索范围共同消费,消除原本两处 ~12 行重复代码
 *
 * 边界:
 * - 缺 timestamp 的 entry 保留(meta 之类没时间戳)
 * - timestamp 解析失败(entry 损坏)的保留(不让破损数据把整段过滤掉)
 * - from 缺省 = -Infinity(不限制下界),to 缺省 = +Infinity(不限制上界)
 */

import type { TranscriptEntryOut } from "./api";

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
