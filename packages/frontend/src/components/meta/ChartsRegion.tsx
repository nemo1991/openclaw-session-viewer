/**
 * v0.9.23 (M5): ChartsRegion — L2 层独立区域
 *
 * 6 个 chart meta blocks 抽离到独立 `<ChartsRegion>` 组件,位置在
 * `<SessionOverview>` 下、`<TranscriptView>` 上。原本 chart blocks 跟
 * 普通 meta event 一起塞在 transcript timeline 末尾,视觉混排语义不清;
 * 现在把它们在 L2 区域集中展示,用户视觉 tree 是:
 *
 *   <SessionOverview>     (L1, DB-aggregated SessionMeta)
 *   <ChartsRegion>         (L2, batch normalize 6 chart blocks)
 *   <TranscriptView>        (transcript timeline, L3/L4 event meta)
 *
 * 数据流:
 * - 后端 `commands/transcript.rs` batch normalize 把 6 chart blocks
 *   (`context.apply_compaction` / `llm.tools_snapshot` / `usage.chart` /
 *   `request.chart` / `todos.chart` / `ai-title.chart`) 从 `entries`
 *   抽离到 `StreamBatch.charts` 字段。
 * - 前端 `transcriptStore.charts` 收集所有 chart blocks,本组件读
 *   `entries[0].normalized.blocks[0]` 拿到 `NormalizedBlockFE`。
 * - 6 chart 各自保留独立 accent (compaction=teal / tools_snapshot=indigo /
 *   usage.chart=amber / request.chart=violet / todos.chart=emerald /
 *   ai-title.chart=rose),配色定义在 `theme/meta-palette.ts` 没变。
 *
 * 老 wire 兼容: `charts` 字段为空数组 → 整个 region 折叠(不渲染),
 * 不显示 "暂无 chart" 占位 (无视觉重量)。
 *
 * 布局: 2 列 responsive grid (窄屏单列),chart 按 label 顺序排放
 * (跟 batch normalize 末尾 emit 顺序一致: apply_compaction →
 * tools_snapshot → usage → request → todos → ai-title)。
 */

import type { NormalizedBlockFE, TranscriptEntryOut } from "../../lib/api";
import { ChartBlock } from "./ChartBlock";

interface ChartsRegionProps {
  /** 来自 transcriptStore.charts — 6 个 chart meta blocks 的 entry 集合 */
  charts: TranscriptEntryOut[];
}

/**
 * 从 chart entry 提取要渲染的 NormalizedBlockFE (即 block.kind ===
 * "meta",存了 label + payload)。
 */
function chartEntryToBlock(entry: TranscriptEntryOut): NormalizedBlockFE | null {
  const block = entry.normalized.blocks[0];
  if (!block || block.kind !== "meta") return null;
  return block;
}

export function ChartsRegion({ charts }: ChartsRegionProps) {
  // 0 chart → 不渲染 (老 wire / openclaw / 没 chart 数据的 session)
  if (charts.length === 0) return null;

  return (
    <div className="charts-region" data-testid="charts-region">
      <h3 className="charts-region-title">图表</h3>
      <div className="charts-region-grid">
        {charts.map((entry, i) => {
          const block = chartEntryToBlock(entry);
          if (!block) return null;
          // entry.index 当 React key (单调递增,稳定)
          return (
            <div
              key={entry.index}
              className="charts-region-cell"
              data-testid={`charts-region-cell-${i}`}
            >
              <ChartBlock block={block} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
