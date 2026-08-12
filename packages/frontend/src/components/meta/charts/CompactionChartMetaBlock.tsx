/**
 * v0.9.18 (M2): CompactionChartMetaBlock — 从 MetaBlock.tsx 抽出
 *
 * v0.9.12 引入 context.apply_compaction 专属渲染。LLM 交接笔记 (summary)
 * 用 pre 渲染保持原始换行;max-height + overflow-y 限制在 ~240px 让多条
 * 压缩事件不撑爆详情页。compaction-meta 框整体加左侧 accent border 跟
 * 其他 meta block 区分 (teal v0.9.12)。
 *
 * M2 抽到独立 file,ChartBlock dispatcher 按 label 路由。
 */

import { UnknownBlockCard } from "../../UnknownBlockCard";
import type { NormalizedBlockFE } from "../../../lib/api";
import { num, formatTokens, readMetaField } from "./chart-utils";

export function CompactionChartMetaBlock({ block }: { block: NormalizedBlockFE }) {
  const summary =
    typeof readMetaField(block, "summary") === "string"
      ? (readMetaField(block, "summary") as string)
      : null;
  const contextSummary =
    typeof readMetaField(block, "contextSummary") === "string"
      ? (readMetaField(block, "contextSummary") as string)
      : null;
  const tokensBefore = num(readMetaField(block, "tokens_before", "tokensBefore"));
  const tokensAfter = num(readMetaField(block, "tokens_after", "tokensAfter"));
  const compactedCount = num(readMetaField(block, "compacted_count", "compactedCount"));
  const keptUserCount = num(
    readMetaField(block, "kept_user_message_count", "keptUserMessageCount")
  );

  // 缺 summary 也缺 stats — fallback 到 UnknownBlockCard,让老数据仍能看
  if (!summary && tokensBefore === null && tokensAfter === null) {
    return <UnknownBlockCard block={block} />;
  }

  return (
    <div className="block-meta-info meta-block-flat compaction-meta">
      <span className="meta-kind-badge">🗜️ compaction</span>
      {tokensBefore !== null && tokensAfter !== null && tokensAfter > 0 && (
        <span className="meta-primary-text" title={`tokensBefore / tokensAfter`}>
          {formatTokens(tokensBefore)} → {formatTokens(tokensAfter)}
          {(() => {
            const ratio = tokensBefore / tokensAfter;
            return ` · ${ratio.toFixed(1)}× 压缩`;
          })()}
        </span>
      )}
      {compactedCount !== null && (
        <span className="meta-sub" title="被压缩的消息数 (LLM 折叠掉)">
          {compactedCount} msgs compacted
        </span>
      )}
      {keptUserCount !== null && (
        <span className="meta-sub" title="保留的用户消息数">
          {keptUserCount} kept
        </span>
      )}
      {summary && (
        <div className="compaction-summary" data-testid="compaction-summary">
          <div className="compaction-summary-title">LLM 交接笔记</div>
          <pre className="compaction-summary-text">{summary}</pre>
        </div>
      )}
      {!summary && contextSummary && (
        <div className="compaction-summary">
          <div className="compaction-summary-title">context 系统提示</div>
          <pre className="compaction-summary-text">{contextSummary}</pre>
        </div>
      )}
    </div>
  );
}
