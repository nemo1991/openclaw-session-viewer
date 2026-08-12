/**
 * v0.9.15: Inline SVG line chart for kimi `llm.request` maxTokens context
 * headroom timeline.
 *
 * 每个 bucket 一个点 (min/max/avg 三条线,跟 matplotlib errorbar 不同 —
 * 这里直接画 3 条独立折线):
 * - 顶线 (avg): avg, 紫色 (主信号)
 * - 上界 (max): max, 紫色 alpha 0.4
 * - 下界 (min): min, 紫色 alpha 0.4
 *
 * viewBox 600×80,跟 v0.9.14 UsageChart 同尺寸 (保持视觉对齐)。
 *
 * 0 buckets → null (跟 UsageChart 行为一致)。
 */

import { useMemo } from "react";
// v0.9.21 (M6): numOrZero 从 lib/meta.ts 集中,删本地 num 函数
import { numOrZero } from "../../lib/meta";

interface Bucket {
  bucket_start?: number;
  bucket_end?: number;
  max_tokens_min?: number;
  max_tokens_max?: number;
  max_tokens_avg?: number;
  request_count?: number;
  kind_compaction_count?: number;
}

const W = 600;
const H = 80;
const PAD = 4;

export function RequestChartSvg({ buckets }: { buckets: Bucket[] }) {
  const data = useMemo(
    () =>
      buckets.map((b) => ({
        min: numOrZero(b.max_tokens_min),
        max: numOrZero(b.max_tokens_max),
        avg: numOrZero(b.max_tokens_avg),
        compactionCount: numOrZero(b.kind_compaction_count),
      })),
    [buckets]
  );

  const yMax = useMemo(() => {
    const allMax = data.flatMap((d) => [d.min, d.max, d.avg]);
    return Math.max(1, ...allMax);
  }, [data]);

  if (buckets.length === 0) {
    return null;
  }

  const usableH = H - PAD * 2;
  const usableW = W - PAD * 2;
  const xStep = usableW / Math.max(1, data.length - 1);

  const points = (accessor: (d: { min: number; max: number; avg: number }) => number): string =>
    data
      .map((d, i) => {
        const x = PAD + i * xStep;
        const y = PAD + usableH - (accessor(d) / yMax) * usableH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  const compactionXs: number[] = [];
  data.forEach((d, i) => {
    if (d.compactionCount > 0) {
      compactionXs.push(PAD + i * xStep);
    }
  });

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="request-chart-svg"
      data-testid="request-chart-svg"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${buckets.length} 个 bucket 的 maxTokens 趋势, 峰值 ${yMax}`}
    >
      {/* 下界 min (alpha) */}
      <polyline
        points={points((d) => d.min)}
        fill="none"
        stroke="rgba(139, 92, 246, 0.35)"
        strokeWidth={1}
        data-testid="request-chart-line-min"
      />
      {/* 上界 max (alpha) */}
      <polyline
        points={points((d) => d.max)}
        fill="none"
        stroke="rgba(139, 92, 246, 0.35)"
        strokeWidth={1}
        data-testid="request-chart-line-max"
      />
      {/* avg 主线 */}
      <polyline
        points={points((d) => d.avg)}
        fill="none"
        stroke="rgba(139, 92, 246, 0.95)"
        strokeWidth={1.5}
        data-testid="request-chart-line-avg"
      />
      {/* compaction 时刻 marker */}
      {compactionXs.map((x, i) => (
        <circle
          key={i}
          cx={x}
          cy={PAD + 2}
          r={2}
          fill="rgba(245, 158, 11, 0.9)"
          data-testid={`request-chart-compaction-${i}`}
        />
      ))}
    </svg>
  );
}
