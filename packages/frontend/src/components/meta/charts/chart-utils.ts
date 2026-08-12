/**
 * v0.9.18: chart meta block 共享 utility
 *
 * 6 个 chart sub-component (CompactionChart / ToolsSnapshotChart /
 * UsageChart / RequestChart / TodoChart / AiTitleChart) 共用同一套:
 * - num: 把 unknown 转 number / null
 * - formatTokens / formatTokenShort / formatDurationMs: 数字格式化
 * - readMetaField: 顶层字段 + payload fallback + snake/camel 双查 (跟
 *   lib/meta.ts getMetaField 同 pattern,但暂留 local,待 M6 集中)
 *
 * 抽到独立 file 让 6 chart sub-component 复用,避免每个 file 重写 num /
 * get helper。
 */

import type { NormalizedBlockFE } from "../../../lib/api";

/** 把 unknown 转 number,失败返回 null(跟原 MetaBlock num() 行为一致)。 */
export function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 把 token 数格式化为短文本:1.2M / 3.4K / 567。 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** formatTokens 的轻量版,无小数:3M / 4K / 567。 */
export function formatTokenShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** 把毫秒格式化为短文本:1.2 min / 4.5 s / 800 ms。 */
export function formatDurationMs(ms: number): string {
  if (ms >= 3_600_000_000) return `${(ms / 3_600_000_000).toFixed(1)}M ms`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${ms} ms`;
}

/**
 * 跟原 MetaBlock 内联 get helper 同 pattern:先查顶层字段,再查 payload,
 * 支持 snake_case + camelCase 双查(后端 emit snake_case 平铺字段,
 * 老 wire / DB 缓存兼容)。
 *
 * 返回第一个非 null/undefined 的值;都没找到返回 undefined。
 */
export function readMetaField(block: NormalizedBlockFE, ...keys: string[]): unknown {
  const blk = block as Record<string, unknown>;
  const pl = (block.payload ?? {}) as Record<string, unknown>;
  for (const k of keys) {
    if (blk[k] !== undefined && blk[k] !== null) return blk[k];
    if (pl[k] !== undefined && pl[k] !== null) return pl[k];
  }
  return undefined;
}
