/**
 * v0.9.18 (M2): RequestChartMetaBlock — 从 MetaBlock.tsx 抽出
 *
 * v0.9.15 引入 request.chart 专属渲染。bpm-large 648 个 llm.request 事件
 * (625 loop + 23 compaction)。揭示 **context headroom** 趋势 +
 * **config drift detection** (system_prompt_hash / tools_hash)。violet
 * accent (跟 amber cost / teal compaction / indigo tools 区分)。
 *
 * M2 抽到独立 file,ChartBlock dispatcher 按 label 路由。
 */

import { useState } from "react";
import { RequestChartSvg } from "../RequestChart";
import { UnknownBlockCard } from "../../UnknownBlockCard";
import type { NormalizedBlockFE } from "../../../lib/api";
import { num, formatDurationMs, readMetaField } from "./chart-utils";

export function RequestChartMetaBlock({ block }: { block: NormalizedBlockFE }) {
  const pl = (block.payload ?? {}) as Record<string, unknown>;
  const requestCount = num(readMetaField(block, "request_count", "requestCount"));
  const kindLoop = num(readMetaField(block, "kind_loop", "kindLoop")) ?? 0;
  const kindCompaction = num(readMetaField(block, "kind_compaction", "kindCompaction")) ?? 0;
  const compactionPct = num(readMetaField(block, "compaction_pct", "compactionPct"));
  const maxTokensMin = num(readMetaField(block, "max_tokens_min", "maxTokensMin")) ?? 0;
  const maxTokensMax = num(readMetaField(block, "max_tokens_max", "maxTokensMax")) ?? 0;
  const maxTokensAvg = num(readMetaField(block, "max_tokens_avg", "maxTokensAvg")) ?? 0;
  const messageCountMin = num(readMetaField(block, "message_count_min", "messageCountMin")) ?? 0;
  const messageCountMax = num(readMetaField(block, "message_count_max", "messageCountMax")) ?? 0;
  const turnIndexMin = num(readMetaField(block, "turn_index_min", "turnIndexMin")) ?? 0;
  const turnIndexMax = num(readMetaField(block, "turn_index_max", "turnIndexMax")) ?? 0;
  const toolsHashBaseline = String(
    readMetaField(block, "tools_hash_baseline", "toolsHashBaseline") ?? ""
  );
  const toolsHashDriftCount =
    num(readMetaField(block, "tools_hash_drift_count", "toolsHashDriftCount")) ?? 0;
  const systemPromptHashDistinct =
    num(readMetaField(block, "system_prompt_hash_distinct", "systemPromptHashDistinct")) ?? 0;
  const model = String(readMetaField(block, "model") ?? "");
  const provider = String(readMetaField(block, "provider") ?? "");
  const durationMs = num(readMetaField(block, "duration_ms", "durationMs")) ?? 0;
  const buckets = (readMetaField(block, "buckets") as Array<Record<string, unknown>>) ?? [];
  const driftEvents =
    (readMetaField(block, "system_prompt_drift_events", "systemPromptDriftEvents") as Array<
      Record<string, unknown>
    >) ?? [];
  const rawEvents = (pl.raw_events as Array<Record<string, unknown>>) ?? [];
  const rawCount = (pl.raw_count as number) ?? rawEvents.length;

  // 缺关键字段 → fallback
  if (requestCount === null || buckets.length === 0) {
    return <UnknownBlockCard block={block} />;
  }

  const [showRawEvents, setShowRawEvents] = useState(false);
  const [showAllDrift, setShowAllDrift] = useState(false);
  const DRIFT_VISIBLE = 8;
  const visibleDrift = showAllDrift ? driftEvents : driftEvents.slice(0, DRIFT_VISIBLE);
  const driftOverflow = driftEvents.length - DRIFT_VISIBLE;

  return (
    <div
      className="block-meta-info meta-block-flat request-chart-meta"
      data-testid="request-chart-meta"
    >
      <span className="meta-kind-badge">🧭 request chart</span>
      <span className="meta-primary-text" data-testid="request-chart-count">
        {requestCount.toLocaleString()} requests
      </span>
      <span
        className="meta-sub"
        title={`maxTokens min/max/avg (剩余上下文 token 预算): ${maxTokensMin} / ${maxTokensMax} / ${maxTokensAvg}`}
        data-testid="request-chart-headroom"
      >
        headroom {(maxTokensAvg / 1000).toFixed(1)}K avg
      </span>
      <span
        className="meta-sub"
        title={`loop: ${kindLoop} 次常规 turn LLM 调用, compaction: ${kindCompaction} 次 compaction LLM 调用 (${compactionPct !== null ? (compactionPct * 100).toFixed(1) + "%" : "n/a"})`}
        data-testid="request-chart-kinds"
      >
        {kindLoop} loop · {kindCompaction} compaction
      </span>
      <span
        className="meta-sub"
        title={`messageCount: ${messageCountMin} → ${messageCountMax}, turnIndex: ${turnIndexMin} → ${turnIndexMax}`}
        data-testid="request-chart-session-length"
      >
        msg {messageCountMin}→{messageCountMax} · turn {turnIndexMin}→{turnIndexMax}
      </span>
      {model && (
        <span className="meta-sub" title={`model: ${model}, provider: ${provider}`}>
          {model}
        </span>
      )}
      {durationMs > 0 && (
        <span className="meta-sub" title="session 实际跨度">
          {formatDurationMs(durationMs)}
        </span>
      )}
      <RequestChartSvg buckets={buckets} />
      <div className="request-chart-legend" data-testid="request-chart-legend">
        <span className="request-chart-legend-item">
          <span
            className="request-chart-legend-dot"
            style={{ background: "rgba(139, 92, 246, 0.95)" }}
          />
          avg maxTokens
        </span>
        <span className="request-chart-legend-item">
          <span
            className="request-chart-legend-dot"
            style={{ background: "rgba(139, 92, 246, 0.35)" }}
          />
          min/max range
        </span>
        <span className="request-chart-legend-item">
          <span
            className="request-chart-legend-dot"
            style={{ background: "rgba(245, 158, 11, 0.9)" }}
          />
          compaction 时刻
        </span>
      </div>
      {driftEvents.length > 0 && (
        <div className="meta-section" data-testid="request-chart-drift">
          <strong className="meta-section-title">
            system_prompt_hash drift ({driftEvents.length} 个独立 hash
            {toolsHashDriftCount > 0
              ? `, tools_hash drift ${toolsHashDriftCount}`
              : ", tools_hash 稳定"}
            ):
          </strong>
          <div className="meta-list meta-list-scrollable">
            {visibleDrift.map((e, i) => {
              const hash = String(e.hash ?? "?");
              const short = hash.length > 12 ? hash.slice(0, 12) + "…" : hash;
              const inline = e.system_prompt_inline === true;
              const idx = num(e.request_index) ?? i;
              return (
                <span
                  key={i}
                  className="meta-tag"
                  title={`request #${idx}, hash=${hash}, inline=${inline}, kind=${String(e.kind ?? "?")}`}
                >
                  #{idx} {short} {inline ? "📝" : ""}
                </span>
              );
            })}
          </div>
          {driftOverflow > 0 && !showAllDrift && (
            <button
              type="button"
              className="meta-show-more"
              onClick={() => setShowAllDrift(true)}
              data-testid="request-chart-drift-toggle"
            >
              展开剩余 {driftOverflow} 个 hash 切换
            </button>
          )}
          {toolsHashBaseline && (
            <span
              className="meta-sub"
              title={`toolsHash baseline (取最高频 hash): ${toolsHashBaseline}`}
              data-testid="request-chart-tools-hash"
            >
              tools_hash {toolsHashBaseline.slice(0, 12)}…
            </span>
          )}
        </div>
      )}
      {rawEvents.length > 0 && (
        <button
          type="button"
          className="meta-show-more"
          data-testid="request-chart-raw-toggle"
          onClick={() => setShowRawEvents((v) => !v)}
          title={showRawEvents ? "收起 raw events" : `展开 ${rawCount} raw events`}
        >
          {showRawEvents ? "收起" : `展开 ${rawCount} raw events`}
        </button>
      )}
      {showRawEvents && (
        <div className="request-chart-raw-events" data-testid="request-chart-raw-events">
          {rawEvents.map((e, i) => {
            const kind = String(e.kind ?? "loop");
            return (
              <div key={i} className="request-chart-raw-row">
                <span
                  className="meta-tag"
                  style={{
                    background:
                      kind === "compaction"
                        ? "rgba(245, 158, 11, 0.18)"
                        : "rgba(139, 92, 246, 0.18)",
                  }}
                >
                  {kind}
                </span>
                <span className="meta-sub">mt {((num(e.maxTokens) ?? 0) / 1000).toFixed(1)}K</span>
                <span className="meta-sub">msg {num(e.messageCount) ?? 0}</span>
                <span className="meta-sub">{String(e.turnStep ?? "?")}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
