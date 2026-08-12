/**
 * v0.9.18 (M2): TodoChartMetaBlock — 从 MetaBlock.tsx 抽出
 *
 * v0.9.16 引入 todos.chart 专属渲染。57 个 tools.update_store 事件
 * (跨 1 个 dcwin11 bpm-large session, 5834 行) 折成 1 个聚合 meta。
 * emerald accent (跟 plan execution narrative 语义关联)。SVG 60 bar
 * stacked 横向铺 (pending 灰底 + in_progress 蓝中 + done 绿顶)。
 *
 * M2 抽到独立 file,ChartBlock dispatcher 按 label 路由。
 */

import { useState } from "react";
import { TodoChartSvg } from "../TodoChart";
import { UnknownBlockCard } from "../../UnknownBlockCard";
import type { NormalizedBlockFE } from "../../../lib/api";
import { num, formatDurationMs, readMetaField } from "./chart-utils";

export function TodoChartMetaBlock({ block }: { block: NormalizedBlockFE }) {
  const updateCount = num(readMetaField(block, "update_count", "updateCount"));
  const uniqueTaskCount = num(readMetaField(block, "unique_task_count", "uniqueTaskCount")) ?? 0;
  const currentDone = num(readMetaField(block, "current_done", "currentDone")) ?? 0;
  const currentInProgress =
    num(readMetaField(block, "current_in_progress", "currentInProgress")) ?? 0;
  const currentPending = num(readMetaField(block, "current_pending", "currentPending")) ?? 0;
  const totalDone = num(readMetaField(block, "total_done", "totalDone")) ?? 0;
  const churnCount = num(readMetaField(block, "churn_count", "churnCount")) ?? 0;
  const churnAddCount = num(readMetaField(block, "churn_add_count", "churnAddCount")) ?? 0;
  const churnRemoveCount = num(readMetaField(block, "churn_remove_count", "churnRemoveCount")) ?? 0;
  const durationMs = num(readMetaField(block, "duration_ms", "durationMs")) ?? 0;
  const buckets = (readMetaField(block, "buckets") as Array<Record<string, unknown>>) ?? [];
  const completedTasks =
    (readMetaField(block, "completed_tasks", "completedTasks") as Array<Record<string, unknown>>) ??
    [];
  const churnEvents =
    (readMetaField(block, "churn_events", "churnEvents") as Array<Record<string, unknown>>) ?? [];
  const pl = (block.payload ?? {}) as Record<string, unknown>;
  const rawEvents = (pl.raw_events as Array<Record<string, unknown>>) ?? [];
  const rawCount = (pl.raw_count as number) ?? rawEvents.length;

  // 缺关键字段 → fallback (老 wire / 老 DB 缓存)
  if (updateCount === null || buckets.length === 0) {
    return <UnknownBlockCard block={block} />;
  }

  const COMPLETED_VISIBLE = 8;
  const CHURN_VISIBLE = 10;
  const [showRawEvents, setShowRawEvents] = useState(false);
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  const [showAllChurn, setShowAllChurn] = useState(false);

  const visibleCompleted = showAllCompleted
    ? completedTasks
    : completedTasks.slice(0, COMPLETED_VISIBLE);
  const completedOverflow = completedTasks.length - COMPLETED_VISIBLE;
  const visibleChurn = showAllChurn ? churnEvents : churnEvents.slice(0, CHURN_VISIBLE);
  const churnOverflow = churnEvents.length - CHURN_VISIBLE;

  return (
    <div
      className="block-meta-info meta-block-flat todos-chart-meta"
      data-testid="todos-chart-meta"
    >
      <span className="meta-kind-badge">📋 todo chart</span>
      <span className="meta-primary-text" data-testid="todos-chart-count">
        {updateCount.toLocaleString()} updates · {uniqueTaskCount} unique tasks
      </span>
      <span
        className="meta-sub"
        title={`末次 snapshot 状态: ${currentDone} done / ${currentInProgress} in_progress / ${currentPending} pending`}
        data-testid="todos-chart-current"
      >
        now {currentDone} done · {currentInProgress} in_progress · {currentPending} pending
      </span>
      <span
        className="meta-sub"
        title={`跨 session 累计: ${totalDone} done · ${churnCount} churn events (${churnAddCount} add / ${churnRemoveCount} remove)`}
        data-testid="todos-chart-churn"
      >
        {churnCount} churn ({churnAddCount} + / {churnRemoveCount} -)
      </span>
      {durationMs > 0 && (
        <span className="meta-sub" title="session 实际跨度">
          {formatDurationMs(durationMs)}
        </span>
      )}
      <TodoChartSvg buckets={buckets} />
      <div className="todos-chart-legend" data-testid="todos-chart-legend">
        <span className="todos-chart-legend-item">
          <span
            className="todos-chart-legend-dot"
            style={{ background: "rgba(16, 185, 129, 0.95)" }}
          />
          done
        </span>
        <span className="todos-chart-legend-item">
          <span
            className="todos-chart-legend-dot"
            style={{ background: "rgba(59, 130, 246, 0.9)" }}
          />
          in_progress
        </span>
        <span className="todos-chart-legend-item">
          <span
            className="todos-chart-legend-dot"
            style={{ background: "rgba(156, 163, 175, 0.4)" }}
          />
          pending
        </span>
      </div>
      {completedTasks.length > 0 && (
        <div className="meta-section" data-testid="todos-chart-completed">
          <strong className="meta-section-title">{completedTasks.length} 个完成的任务:</strong>
          <div className="meta-list meta-list-scrollable">
            {visibleCompleted.map((t, i) => (
              <span key={i} className="meta-tag" title={`done at update #${t.update_index}`}>
                ✓ {String(t.title ?? "?").slice(0, 40)}
              </span>
            ))}
          </div>
          {completedOverflow > 0 && !showAllCompleted && (
            <button
              type="button"
              className="meta-show-more"
              onClick={() => setShowAllCompleted(true)}
              data-testid="todos-chart-completed-toggle"
            >
              展开剩余 {completedOverflow} 个
            </button>
          )}
        </div>
      )}
      {churnEvents.length > 0 && (
        <div className="meta-section" data-testid="todos-chart-churn-events">
          <strong className="meta-section-title">{churnEvents.length} 个 churn events:</strong>
          <div className="meta-list meta-list-scrollable">
            {visibleChurn.map((e, i) => {
              const isAdd = e.action === "add";
              return (
                <span
                  key={i}
                  className={`meta-tag ${isAdd ? "meta-tag-add" : "meta-tag-remove"}`}
                  title={`${isAdd ? "added" : "removed"} at update #${e.update_index}`}
                >
                  {isAdd ? "+" : "−"} {String(e.title ?? "?").slice(0, 30)}
                </span>
              );
            })}
          </div>
          {churnOverflow > 0 && !showAllChurn && (
            <button
              type="button"
              className="meta-show-more"
              onClick={() => setShowAllChurn(true)}
              data-testid="todos-chart-churn-toggle"
            >
              展开剩余 {churnOverflow} 个
            </button>
          )}
        </div>
      )}
      {rawEvents.length > 0 && (
        <button
          type="button"
          className="meta-show-more"
          data-testid="todos-chart-raw-toggle"
          onClick={() => setShowRawEvents((v) => !v)}
          title={showRawEvents ? "收起 raw events" : `展开 ${rawCount} raw events`}
        >
          {showRawEvents ? "收起" : `展开 ${rawCount} raw events`}
        </button>
      )}
      {showRawEvents && (
        <div className="todos-chart-raw-events" data-testid="todos-chart-raw-events">
          {rawEvents.map((e, i) => {
            const items = (e.value as Array<Record<string, string>>) ?? [];
            const doneInRow = items.filter((it) => it.status === "done").length;
            return (
              <div key={i} className="todos-chart-raw-row">
                <span className="meta-sub">{items.length} items</span>
                <span className="meta-sub">{doneInRow} done</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
