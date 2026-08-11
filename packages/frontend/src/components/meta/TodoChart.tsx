/**
 * v0.9.16: Inline SVG stacked bar chart for kimi tools.update_store todo status
 * 时间线。
 *
 * 60 个 bucket,每 bucket 3 层 stacked:
 * - 底层: pending (灰, 0.4 alpha)
 * - 中层: in_progress (蓝, 0.9 alpha)
 * - 顶层: done (绿, 0.95 alpha)
 *
 * 视觉跟 v0.9.14 usage.chart (60 bar stacked) 完全对齐,区别是配色从
 * amber (cost) 改为 emerald (completion)。
 *
 * 0 buckets → null (跟 UsageChart / RequestChart 行为一致)。
 */

import { useMemo } from "react";

interface Bucket {
  bucket_start?: number;
  bucket_end?: number;
  item_count?: number;
  done_count?: number;
  in_progress_count?: number;
  pending_count?: number;
}

const W = 600;
const H = 80;
const BAR_PAD = 1;

function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function TodoChartSvg({ buckets }: { buckets: Bucket[] }) {
  const maxTotal = useMemo(
    () =>
      Math.max(
        1,
        ...buckets.map((b) => num(b.done_count) + num(b.in_progress_count) + num(b.pending_count))
      ),
    [buckets]
  );

  if (buckets.length === 0) {
    return null;
  }

  const barW = (W - BAR_PAD * buckets.length) / buckets.length;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="todos-chart-svg"
      data-testid="todos-chart-svg"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${buckets.length} 个 bucket 的 todo 状态趋势,峰值 ${maxTotal}`}
    >
      {buckets.map((b, i) => {
        const done = num(b.done_count);
        const inProgress = num(b.in_progress_count);
        const pending = num(b.pending_count);
        const doneH = (done / maxTotal) * H;
        const inProgressH = (inProgress / maxTotal) * H;
        const pendingH = (pending / maxTotal) * H;
        const x = i * (barW + BAR_PAD);
        return (
          <g key={i}>
            {/* pending 底 */}
            <rect
              x={x}
              y={H - pendingH}
              width={barW}
              height={pendingH}
              fill="rgba(156, 163, 175, 0.4)"
            />
            {/* in_progress 中 */}
            <rect
              x={x}
              y={H - pendingH - inProgressH}
              width={barW}
              height={inProgressH}
              fill="rgba(59, 130, 246, 0.9)"
            />
            {/* done 顶 */}
            <rect
              x={x}
              y={H - pendingH - inProgressH - doneH}
              width={barW}
              height={doneH}
              fill="rgba(16, 185, 129, 0.95)"
            />
          </g>
        );
      })}
    </svg>
  );
}
