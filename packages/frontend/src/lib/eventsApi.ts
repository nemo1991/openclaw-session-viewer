/**
 * v0.11 (A1 / A3): 本地事件日志 API 包装
 *
 * 战略 D-2「本地优先、零上传」:这里只有 Tauri IPC → 本地 SQLite `event_log`,
 * **没有任何网络请求**。`scripts/assert-local-events.mjs` 会在 CI 里扫描本文件,
 * 出现 fetch / XMLHttpRequest / sendBeacon / WebSocket 等即失败。
 *
 * 埋点是 fire-and-forget:纯 web / E2E / vitest 环境没有 Tauri runtime,
 * invoke 可能同步抛错或返回 rejected Promise,一律静默吞掉,绝不阻断 UI。
 */

import { invoke } from "@tauri-apps/api/core";

export type LocalEventName =
  | "analytics_view_open"
  | "source_dimension_select"
  | "retry_rate_displayed"
  | "analytics_ready"
  | "health_view_open";

/** 字段与 Rust `commands/events.rs::LocalEventInput` 对齐 (camelCase ↔ snake_case) */
export interface LocalEventInput {
  eventName: LocalEventName;
  source?: string | null;
  sessionCount?: number;
  /** 指标是否使用真实口径(v0.10 PRD 第十章原「埋点上报」字段) */
  realMetric?: boolean;
  /** A3:「打开 → 首屏可交互」耗时,毫秒 */
  durationMs?: number;
  detail?: string;
}

export interface LocalEventRow {
  id: number;
  eventName: string;
  tsMs: number;
  source: string | null;
  sessionCount: number | null;
  realMetric: boolean | null;
  durationMs: number | null;
  detail: string | null;
}

/** 与 Rust `db/event_log.rs::P95Gate` 对齐 */
export interface LocalP95Gate {
  eventName: string;
  sampleCount: number;
  p95Ms: number | null;
  budgetMs: number;
  ok: boolean;
  reason: string;
}

/** 写一条本地事件。失败静默,不影响渲染。 */
export function trackLocalEvent(input: LocalEventInput): void {
  try {
    const p = invoke<void>("append_local_event", { input });
    void Promise.resolve(p).catch(() => {});
  } catch {
    // 没有 Tauri runtime(纯 web / E2E / vitest) — 跳过
  }
}

/** 自查用:读回本地事件(最新在前) */
export const apiListLocalEvents = (eventName?: string, limit = 100): Promise<LocalEventRow[]> =>
  invoke("list_local_events", { eventName, limit });

/** A3:读回最近样本的 P95 与 <500ms 门槛判定 */
export const apiLocalEventP95 = (eventName: LocalEventName, limit = 100): Promise<LocalP95Gate> =>
  invoke("local_event_p95", { eventName, limit });
