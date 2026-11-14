import type { NormalizedBlock } from "@ocsv/shared";
/**
 * ToolResultBlock — block kind === "tool_result" 的 Presentational 包装
 *
 * 从 MessageBubble BlockRenderer (tool_result arm) 抽出。
 * 内部调用现有的 ToolResultCard。
 *
 * v0.6.x: 透传 parentJsonlPath, 让 useFileReveal 推 workspaceRoot
 */

import { ToolResultCard } from "../ToolResultCard";

export interface ToolResultBlockProps {
  block: NormalizedBlock;
  parentJsonlPath?: string;
}

export function ToolResultBlock({ block, parentJsonlPath }: ToolResultBlockProps) {
  return (
    <ToolResultCard
      toolUseId={String(block.tool_use_id ?? "")}
      content={block.content}
      isError={Boolean(block.is_error)}
      filePath={block.filePath as string | undefined}
      parentJsonlPath={parentJsonlPath}
    />
  );
}
