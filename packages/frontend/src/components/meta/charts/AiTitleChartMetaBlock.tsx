/**
 * v0.9.18 (M2): AiTitleChartMetaBlock — 从 MetaBlock.tsx 抽出
 *
 * v0.9.17 引入 ai-title.chart 专属渲染。<redacted-session-id> 真实 sample: 1185 个
 * ai-title event (Claude Code 每 turn 自动重命名 session 标题) + 若干
 * custom-title (用户手动 rename)。rose accent (跟 identity 语义关联)。
 *
 * 区别 vs todos.chart:
 * - todos.chart: 状态机信号 (pending/in_progress/done 生命周期 + churn)
 * - ai-title.chart: identity 信号 (session 标题变更轨迹 + 优先级 metadata)
 * - todos.chart: 3 layer stacked bar (pending/in_progress/done)
 * - ai-title.chart: 2 layer stacked bar (ai-title 底 + custom-title 顶 — 优先级高亮)
 *
 * M2 抽到独立 file,ChartBlock dispatcher 按 label 路由。
 */

import { useState } from "react";
import { AiTitleChartSvg } from "../AiTitleChart";
import { UnknownBlockCard } from "../../UnknownBlockCard";
import type { NormalizedBlockFE } from "../../../lib/api";
import { num, formatDurationMs, readMetaField } from "./chart-utils";

export function AiTitleChartMetaBlock({ block }: { block: NormalizedBlockFE }) {
  const eventCount = num(readMetaField(block, "event_count", "eventCount")) ?? 0;
  const uniqueTitleCount = num(readMetaField(block, "unique_title_count", "uniqueTitleCount")) ?? 0;
  const customTitleCount = num(readMetaField(block, "custom_title_count", "customTitleCount")) ?? 0;
  const aiTitleCount = num(readMetaField(block, "ai_title_count", "aiTitleCount")) ?? 0;
  const titleChangesCount =
    num(readMetaField(block, "title_changes_count", "titleChangesCount")) ?? 0;
  const currentTitle = String(readMetaField(block, "current_title", "currentTitle") ?? "");
  const firstSeenTitle = String(readMetaField(block, "first_seen_title", "firstSeenTitle") ?? "");
  const durationMs = num(readMetaField(block, "duration_ms", "durationMs")) ?? 0;
  const buckets = (readMetaField(block, "buckets") as Array<Record<string, unknown>>) ?? [];
  const titleTimeline =
    (readMetaField(block, "title_timeline", "titleTimeline") as Array<Record<string, unknown>>) ??
    [];
  const topTitles =
    (readMetaField(block, "top_titles", "topTitles") as Array<Record<string, unknown>>) ?? [];
  const pl = (block.payload ?? {}) as Record<string, unknown>;
  const rawEvents = (pl.raw_events as Array<Record<string, unknown>>) ?? [];
  const rawCount = (pl.raw_count as number) ?? rawEvents.length;

  // 缺关键字段 → fallback (老 wire / 老 DB 缓存)
  if (eventCount === 0 || buckets.length === 0) {
    return <UnknownBlockCard block={block} />;
  }

  const TIMELINE_VISIBLE = 10;
  const TOP_VISIBLE = 10;
  const [showRawEvents, setShowRawEvents] = useState(false);
  const [showAllTimeline, setShowAllTimeline] = useState(false);
  const [showAllTop, setShowAllTop] = useState(false);

  const visibleTimeline = showAllTimeline
    ? titleTimeline
    : titleTimeline.slice(0, TIMELINE_VISIBLE);
  const timelineOverflow = titleTimeline.length - TIMELINE_VISIBLE;
  const visibleTop = showAllTop ? topTitles : topTitles.slice(0, TOP_VISIBLE);
  const topOverflow = topTitles.length - TOP_VISIBLE;

  return (
    <div
      className="block-meta-info meta-block-flat ai-title-chart-meta"
      data-testid="ai-title-chart-meta"
    >
      <span className="meta-kind-badge">📝 ai-title chart</span>
      <span className="meta-primary-text" data-testid="ai-title-chart-count">
        {eventCount.toLocaleString()} events · {uniqueTitleCount} unique titles
      </span>
      <span
        className="meta-sub"
        title={`末次 title (custom>ai 优先级): "${currentTitle}"`}
        data-testid="ai-title-chart-current"
      >
        current "{currentTitle}"
      </span>
      <span
        className="meta-sub"
        title={`first seen title: "${firstSeenTitle}"`}
        data-testid="ai-title-chart-first"
      >
        first "{firstSeenTitle}"
      </span>
      <span
        className="meta-sub"
        title={`custom-title ${customTitleCount} / ai-title ${aiTitleCount}, ${titleChangesCount} 次标题变更`}
        data-testid="ai-title-chart-split"
      >
        {customTitleCount} custom · {aiTitleCount} ai · {titleChangesCount} changes
      </span>
      {durationMs > 0 && (
        <span className="meta-sub" title="session 实际跨度">
          {formatDurationMs(durationMs)}
        </span>
      )}
      <AiTitleChartSvg buckets={buckets} />
      <div className="ai-title-chart-legend" data-testid="ai-title-chart-legend">
        <span className="ai-title-chart-legend-item">
          <span
            className="ai-title-chart-legend-dot"
            style={{ background: "rgba(244, 63, 94, 0.7)" }}
          />
          ai-title
        </span>
        <span className="ai-title-chart-legend-item">
          <span
            className="ai-title-chart-legend-dot"
            style={{ background: "rgba(244, 63, 94, 1.0)" }}
          />
          custom-title
        </span>
      </div>
      {topTitles.length > 0 && (
        <div className="meta-section" data-testid="ai-title-chart-top">
          <strong className="meta-section-title">top {topTitles.length} titles (by 频率):</strong>
          <div className="meta-list meta-list-scrollable">
            {visibleTop.map((t, i) => (
              <span
                key={i}
                className={`meta-tag ${t.raw_type === "custom-title" ? "meta-tag-add" : ""}`}
                title={`${t.raw_type} · 出现 ${t.event_count} 次`}
              >
                {String(t.title ?? "?").slice(0, 40)} ({num(t.event_count)})
              </span>
            ))}
          </div>
          {topOverflow > 0 && !showAllTop && (
            <button
              type="button"
              className="meta-show-more"
              onClick={() => setShowAllTop(true)}
              data-testid="ai-title-chart-top-toggle"
            >
              展开剩余 {topOverflow} 个
            </button>
          )}
        </div>
      )}
      {titleTimeline.length > 0 && (
        <div className="meta-section" data-testid="ai-title-chart-timeline">
          <strong className="meta-section-title">title timeline (按 first-seen):</strong>
          <div className="meta-list meta-list-scrollable">
            {visibleTimeline.map((t, i) => (
              <span
                key={i}
                className={`meta-tag ${t.raw_type === "custom-title" ? "meta-tag-add" : ""}`}
                title={`${t.raw_type} · first seen at #${t.first_seen_index}`}
              >
                #{num(t.first_seen_index)} {String(t.title ?? "?").slice(0, 30)}
              </span>
            ))}
          </div>
          {timelineOverflow > 0 && !showAllTimeline && (
            <button
              type="button"
              className="meta-show-more"
              onClick={() => setShowAllTimeline(true)}
              data-testid="ai-title-chart-timeline-toggle"
            >
              展开剩余 {timelineOverflow} 个
            </button>
          )}
        </div>
      )}
      {rawEvents.length > 0 && (
        <button
          type="button"
          className="meta-show-more"
          data-testid="ai-title-chart-raw-toggle"
          onClick={() => setShowRawEvents((v) => !v)}
          title={showRawEvents ? "收起 raw events" : `展开 ${rawCount} raw events`}
        >
          {showRawEvents ? "收起" : `展开 ${rawCount} raw events`}
        </button>
      )}
      {showRawEvents && (
        <div className="ai-title-chart-raw-events" data-testid="ai-title-chart-raw-events">
          {rawEvents.map((e, i) => (
            <div key={i} className="ai-title-chart-raw-row">
              <span className="meta-sub">{String(e.type ?? "?")}</span>
              <span className="meta-sub">{String(e.aiTitle ?? e.title ?? "?")}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
