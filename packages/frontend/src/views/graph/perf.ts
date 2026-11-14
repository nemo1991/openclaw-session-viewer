/**
 * v0.11 (A3): 分析页首屏性能 P95 计算与可选门槛断言(纯函数,无 React / Tauri 依赖)
 *
 * 口径与 Rust `db/event_log.rs::duration_p95` 完全一致:nearest-rank,
 * 排序后取 `ceil(0.95 * n)` 个样本(1-based)。前端只用来在 DEV 模式给单样本
 * 提示;真实 P95 由本地 `event_log` 的 `analytics_ready.duration_ms` 样本
 * 在 Rust 侧 `check_p95_budget` 计算,两侧定义必须保持一致。
 *
 * 500ms 是 PRD 自标的**估算目标**,不是实测 SLA;生产环境不做硬失败。
 */

/** PRD 估算预算,待真实数据校正 */
export const PERF_P95_BUDGET_MS = 500;

/** nearest-rank P95;空样本返回 null */
export function p95(samples: number[]): number | null {
  const valid = samples.filter((v) => Number.isFinite(v) && v >= 0);
  if (valid.length === 0) return null;
  const sorted = [...valid].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  const index = Math.max(0, Math.min(rank - 1, sorted.length - 1));
  return sorted[index] ?? null;
}

export interface P95Verdict {
  sampleCount: number;
  p95Ms: number | null;
  budgetMs: number;
  ok: boolean;
  reason: string;
}

/**
 * 可选性能断言。无样本时 ok=true 并标注「跳过」,避免 CI 因未采集到数据假失败。
 * 该断言只做提示 / 单测门禁,不抛异常、不阻断生产渲染。
 */
export function checkP95Budget(
  samples: number[],
  budgetMs: number = PERF_P95_BUDGET_MS
): P95Verdict {
  const valid = samples.filter((v) => Number.isFinite(v) && v >= 0);
  const p95Ms = p95(samples);
  if (p95Ms === null) {
    return {
      sampleCount: 0,
      p95Ms: null,
      budgetMs,
      ok: true,
      reason: "无耗时样本,跳过门槛",
    };
  }
  const ok = p95Ms < budgetMs;
  return {
    sampleCount: valid.length,
    p95Ms,
    budgetMs,
    ok,
    reason: ok
      ? `P95 ${p95Ms.toFixed(1)}ms < ${budgetMs}ms (估算预算)`
      : `P95 ${p95Ms.toFixed(1)}ms ≥ ${budgetMs}ms — 疑似性能回归`,
  };
}
