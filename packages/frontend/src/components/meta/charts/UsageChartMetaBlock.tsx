/**
 * v0.9.18 (M2): UsageChartMetaBlock — 从 MetaBlock.tsx 抽出
 *
 * v0.9.14 引入 usage.chart 专属渲染。bpm-large 645 个 usage.record 事件
 * (623 turn + 22 session) 折成 1 个聚合 meta。amber accent (跟 output
 * token 同色, 语义上 "cost" 关联)。SVG 60 bar stacked 横向铺
 * (inputCacheRead 底层 alpha + inputOther 中层 + output 顶层 amber)。
 *
 * M2 抽到独立 file,ChartBlock dispatcher 按 label 路由。
 */

import { useState } from "react";
import { UsageChartSvg } from "../UsageChart";
import { UnknownBlockCard } from "../../UnknownBlockCard";
import type { NormalizedBlockFE } from "../../../lib/api";
import { num, formatTokenShort, formatDurationMs, readMetaField } from "./chart-utils";

export function UsageChartMetaBlock({ block }: { block: NormalizedBlockFE }) {
  const pl = (block.payload ?? {}) as Record<string, unknown>;
  const total = num(readMetaField(block, "total_tokens", "totalTokens"));
  const inputOther = num(readMetaField(block, "input_other", "inputOther")) ?? 0;
  const output = num(readMetaField(block, "output")) ?? 0;
  const cacheRead = num(readMetaField(block, "input_cache_read", "inputCacheRead")) ?? 0;
  const cacheCreation =
    num(readMetaField(block, "input_cache_creation", "inputCacheCreation")) ?? 0;
  const cacheHitRatio = num(readMetaField(block, "cache_hit_ratio", "cacheHitRatio"));
  const turnCount = num(readMetaField(block, "turn_count", "turnCount")) ?? 0;
  const sessionScopeCount =
    num(readMetaField(block, "session_scope_count", "sessionScopeCount")) ?? 0;
  const durationMs = num(readMetaField(block, "duration_ms", "durationMs")) ?? 0;
  const model = String(readMetaField(block, "model") ?? "");
  const buckets = (readMetaField(block, "buckets") as Array<Record<string, unknown>>) ?? [];
  const sessionScopeEvents =
    (readMetaField(block, "session_scope_events", "sessionScopeEvents") as Array<
      Record<string, unknown>
    >) ?? [];
  const rawEvents = (pl.raw_events as Array<Record<string, unknown>>) ?? [];
  const rawCount = (pl.raw_count as number) ?? rawEvents.length;

  // 缺关键字段 → fallback (老 wire / 老 DB 缓存)
  if (total === null || buckets.length === 0) {
    return <UnknownBlockCard block={block} />;
  }

  const [showRawEvents, setShowRawEvents] = useState(false);

  return (
    <div
      className="block-meta-info meta-block-flat usage-chart-meta"
      data-testid="usage-chart-meta"
    >
      <span className="meta-kind-badge">📊 usage chart</span>
      <span className="meta-primary-text" data-testid="usage-chart-total">
        {total.toLocaleString()} tokens
      </span>
      <span
        className="meta-sub"
        title={`cache hit ratio (cacheRead / input): ${cacheHitRatio !== null ? (cacheHitRatio * 100).toFixed(1) + "%" : "n/a"}`}
        data-testid="usage-chart-cache-ratio"
      >
        cache {cacheHitRatio !== null ? (cacheHitRatio * 100).toFixed(1) + "%" : "n/a"}
      </span>
      <span
        className="meta-sub"
        title={`turn_count: ${turnCount} 个 turn-scope events, session_scope_count: ${sessionScopeCount} session-scope events`}
        data-testid="usage-chart-turn-count"
      >
        {turnCount} turns · {buckets.length} buckets
      </span>
      {model && (
        <span className="meta-sub" title={`模型: ${model}`}>
          {model}
        </span>
      )}
      {durationMs > 0 && (
        <span className="meta-sub" title="session 实际跨度">
          {formatDurationMs(durationMs)}
        </span>
      )}
      <UsageChartSvg buckets={buckets} />
      <div className="usage-chart-legend" data-testid="usage-chart-legend">
        <span className="usage-chart-legend-item">
          <span
            className="usage-chart-legend-dot"
            style={{ background: "rgba(245, 158, 11, 0.9)" }}
          />
          output ({output.toLocaleString()})
        </span>
        <span className="usage-chart-legend-item">
          <span
            className="usage-chart-legend-dot"
            style={{ background: "rgba(59, 130, 246, 0.9)" }}
          />
          input ({inputOther.toLocaleString()})
        </span>
        <span className="usage-chart-legend-item">
          <span
            className="usage-chart-legend-dot"
            style={{ background: "rgba(99, 102, 241, 0.4)" }}
          />
          cache read ({cacheRead.toLocaleString()})
        </span>
        {cacheCreation > 0 && (
          <span className="usage-chart-legend-item">
            <span
              className="usage-chart-legend-dot"
              style={{ background: "rgba(16, 185, 129, 0.9)" }}
            />
            cache write ({cacheCreation.toLocaleString()})
          </span>
        )}
      </div>
      {sessionScopeEvents.length > 0 && (
        <div className="meta-section" data-testid="usage-chart-session-scope">
          <strong className="meta-section-title">
            {sessionScopeEvents.length} 个 compaction 时刻 session 累计:
          </strong>
          <div className="meta-list meta-list-scrollable">
            {sessionScopeEvents.slice(0, 5).map((e, i) => (
              <span
                key={i}
                className="meta-tag"
                title={`time=${e.time}, inputOther=${e.input_other}, output=${e.output}, cacheRead=${e.input_cache_read}`}
              >
                {formatTokenShort(num(e.input_other) ?? 0)} in +{" "}
                {formatTokenShort(num(e.output) ?? 0)} out
              </span>
            ))}
          </div>
        </div>
      )}
      {rawEvents.length > 0 && (
        <button
          type="button"
          className="meta-show-more"
          data-testid="usage-chart-raw-toggle"
          onClick={() => setShowRawEvents((v) => !v)}
          title={showRawEvents ? "收起 raw events" : `展开 ${rawCount} raw events`}
        >
          {showRawEvents ? "收起" : `展开 ${rawCount} raw events`}
        </button>
      )}
      {showRawEvents && (
        <div className="usage-chart-raw-events" data-testid="usage-chart-raw-events">
          {rawEvents.map((e, i) => (
            <div key={i} className="usage-chart-raw-row">
              <span className="meta-tag">{String(e.usageScope ?? "turn")}</span>
              <span className="meta-sub">
                {formatTokenShort(
                  ((e.usage as Record<string, unknown>)?.inputOther as number) ?? 0
                )}{" "}
                in
              </span>
              <span className="meta-sub">
                {formatTokenShort(((e.usage as Record<string, unknown>)?.output as number) ?? 0)}{" "}
                out
              </span>
              <span className="meta-sub">
                cache{" "}
                {formatTokenShort(
                  ((e.usage as Record<string, unknown>)?.inputCacheRead as number) ?? 0
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
