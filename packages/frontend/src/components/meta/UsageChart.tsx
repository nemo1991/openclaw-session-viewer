/**
 * v0.9.14: Inline SVG stacked bar chart for kimi `usage.record` per-turn token
 * 趋势。
 *
 * 60 个 bar (最多), 每 bar 三段堆叠:
 * - 底层 (indigo alpha 0.4): inputCacheRead (cache hit 部分)
 * - 中层 (blue): inputOther (cache miss 实际计费)
 * - 顶层 (amber): output
 *
 * viewBox 600×80, 视觉权重跟 v0.9.13 .tools-snapshot-list (max-height 200px)
 * 对齐。总 bar 数固定, max 60, 即使 buckets.length !== 60 也正常渲染。
 *
 * 注: 不画坐标轴 / 数值 — 头部 stats pill 已显示总数 + cache ratio,chart 仅
 * 视觉趋势对比。
 */

import { useMemo } from "react";
// v0.9.21 (M6): numOrZero 从 lib/meta.ts 集中,删本地 num 函数
import { numOrZero } from "../../lib/meta";

interface Bucket {
  bucket_start?: number;
  bucket_end?: number;
  input_other?: number;
  output?: number;
  input_cache_read?: number;
  input_cache_creation?: number;
  turn_count?: number;
}

const W = 600;
const H = 80;
const BAR_PAD = 1;

const COLORS = {
  cacheRead: "rgba(99, 102, 241, 0.4)", // indigo alpha — cache hit
  inputOther: "rgba(59, 130, 246, 0.9)", // blue — 实际计费 input
  output: "rgba(245, 158, 11, 0.9)", // amber — output
  cacheCreation: "rgba(16, 185, 129, 0.9)", // green — cache write (rare)
};

export function UsageChartSvg({ buckets }: { buckets: Bucket[] }) {
  const data = useMemo(() => {
    return buckets.map((b) => ({
      inputOther: numOrZero(b.input_other),
      output: numOrZero(b.output),
      cacheRead: numOrZero(b.input_cache_read),
      cacheCreation: numOrZero(b.input_cache_creation),
      total:
        numOrZero(b.input_other) +
        numOrZero(b.output) +
        numOrZero(b.input_cache_read) +
        numOrZero(b.input_cache_creation),
    }));
  }, [buckets]);

  const maxTotal = useMemo(() => Math.max(1, ...data.map((d) => d.total)), [data]);

  if (buckets.length === 0) {
    return null;
  }

  const barW = (W - BAR_PAD * buckets.length) / buckets.length;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="usage-chart-svg"
      data-testid="usage-chart-svg"
      preserveAspectRatio="none"
      role="img"
      aria-label={`${buckets.length} bar 趋势图, 总 token 数 ${maxTotal}`}
    >
      {data.map((d, i) => {
        const cacheH = (d.cacheRead / maxTotal) * H;
        const inputH = (d.inputOther / maxTotal) * H;
        const outH = (d.output / maxTotal) * H;
        const cacheCreationH = (d.cacheCreation / maxTotal) * H;
        const x = i * (barW + BAR_PAD);
        return (
          <g key={i} data-testid={`usage-chart-bar-${i}`}>
            {/* 底层 — cache read (alpha indigo) */}
            <rect x={x} y={H - cacheH} width={barW} height={cacheH} fill={COLORS.cacheRead} />
            {/* 中层 — inputOther (cache miss 计费) */}
            <rect
              x={x}
              y={H - cacheH - inputH}
              width={barW}
              height={inputH}
              fill={COLORS.inputOther}
            />
            {/* 顶层 — output (amber) */}
            <rect
              x={x}
              y={H - cacheH - inputH - outH}
              width={barW}
              height={outH}
              fill={COLORS.output}
            />
            {/* cache creation (绿色, 罕见) — 在 cache read 之内,但视觉上叠 */}
            {cacheCreationH > 0 && (
              <rect
                x={x}
                y={H - cacheH - cacheCreationH}
                width={barW}
                height={cacheCreationH}
                fill={COLORS.cacheCreation}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
