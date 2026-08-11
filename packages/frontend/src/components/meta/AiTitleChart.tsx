/**
 * v0.9.17: Inline SVG stacked bar chart for Claude ai-title / custom-title 密度。
 *
 * 60 bucket,每 bucket 2 层 stacked:
 * - 底层: ai-title (rose 主色 0.7 alpha)
 * - 顶层: custom-title (rose 主色 1.0 alpha — 优先级 metadata 高亮)
 *
 * 视觉跟 v0.9.16 todos.chart 同 visual weight (viewBox 600×80, stacked bar)。
 * 区别是配色从 emerald 改为 rose,语义 "identity" 而非 "completion"。
 *
 * 0 buckets → null (跟 UsageChart / RequestChart / TodoChart 行为一致)。
 */

import { useMemo } from "react";

interface Bucket {
  bucket_start?: number;
  bucket_end?: number;
  event_count?: number;
  custom_count?: number;
  ai_count?: number;
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

export function AiTitleChartSvg({ buckets }: { buckets: Bucket[] }) {
  const maxTotal = useMemo(() => Math.max(1, ...buckets.map((b) => num(b.event_count))), [buckets]);

  if (buckets.length === 0) {
    return null;
  }

  const barW = (W - BAR_PAD * buckets.length) / buckets.length;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="ai-title-chart-svg"
      data-testid="ai-title-chart-svg"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${buckets.length} 个 bucket 的 ai-title 密度,峰值 ${maxTotal}`}
    >
      {buckets.map((b, i) => {
        const aiCount = num(b.ai_count);
        const customCount = num(b.custom_count);
        const aiH = (aiCount / maxTotal) * H;
        const customH = (customCount / maxTotal) * H;
        const x = i * (barW + BAR_PAD);
        return (
          <g key={i}>
            {/* ai-title 底 (rose 0.7) */}
            <rect x={x} y={H - aiH} width={barW} height={aiH} fill="rgba(244, 63, 94, 0.7)" />
            {/* custom-title 顶 (rose 1.0 — 优先级高亮) */}
            <rect
              x={x}
              y={H - aiH - customH}
              width={barW}
              height={customH}
              fill="rgba(244, 63, 94, 1.0)"
            />
          </g>
        );
      })}
    </svg>
  );
}
