/**
 * ToolResultBlock — block kind === "tool_result" 的 Presentational 包装
 *
 * 从 MessageBubble BlockRenderer (tool_result arm) 抽出。
 * 内部调用现有的 ToolResultCard。
 */

import { ToolResultCard } from "../ToolResultCard";
import type { NormalizedBlockFE } from "../../lib/api";

export interface ToolResultBlockProps {
  block: NormalizedBlockFE;
}

export function ToolResultBlock({ block }: ToolResultBlockProps) {
  return (
    <ToolResultCard
      toolUseId={String(block.tool_use_id ?? "")}
      content={block.content}
      isError={Boolean(block.is_error)}
      filePath={block.filePath as string | undefined}
    />
  );
}
