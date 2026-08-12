/**
 * v0.9.18 (M2): ChartBlock dispatcher
 *
 * L2 层 dispatcher:根据 `block.label` 路由到 6 个 chart sub-component 之一。
 * 6 个 chart sub-component 都在 `charts/` 子目录下,各 < 300 行,职责单一
 * (一处 SVG 渲染 + 关联 stats panel)。
 *
 * 路由表 (跟 `theme/meta-palette.ts` 的 `CHART_META_LABELS` 一致):
 * - context.apply_compaction → CompactionChartMetaBlock
 * - llm.tools_snapshot       → ToolsSnapshotChartMetaBlock
 * - usage.chart              → UsageChartMetaBlock
 * - request.chart            → RequestChartMetaBlock
 * - todos.chart              → TodoChartMetaBlock
 * - ai-title.chart           → AiTitleChartMetaBlock
 *
 * 兜底:未知 label 走 UnknownBlockCard(老 wire / 老 DB 缓存兼容)。
 */

import type { NormalizedBlockFE } from "../../lib/api";
import { UnknownBlockCard } from "../UnknownBlockCard";
import { CompactionChartMetaBlock } from "./charts/CompactionChartMetaBlock";
import { ToolsSnapshotChartMetaBlock } from "./charts/ToolsSnapshotChartMetaBlock";
import { UsageChartMetaBlock } from "./charts/UsageChartMetaBlock";
import { RequestChartMetaBlock } from "./charts/RequestChartMetaBlock";
import { TodoChartMetaBlock } from "./charts/TodoChartMetaBlock";
import { AiTitleChartMetaBlock } from "./charts/AiTitleChartMetaBlock";

export function ChartBlock({ block }: { block: NormalizedBlockFE }) {
  switch (block.label) {
    case "context.apply_compaction":
      return <CompactionChartMetaBlock block={block} />;
    case "llm.tools_snapshot":
      return <ToolsSnapshotChartMetaBlock block={block} />;
    case "usage.chart":
      return <UsageChartMetaBlock block={block} />;
    case "request.chart":
      return <RequestChartMetaBlock block={block} />;
    case "todos.chart":
      return <TodoChartMetaBlock block={block} />;
    case "ai-title.chart":
      return <AiTitleChartMetaBlock block={block} />;
    default:
      return <UnknownBlockCard block={block} />;
  }
}
