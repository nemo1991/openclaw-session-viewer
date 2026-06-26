/**
 * ToolUseBlock — block kind === "tool_use" 的 Presentational 包装
 *
 * 从 MessageBubble BlockRenderer (tool_use arm) 抽出。
 * 内部调用现有的 ToolUseCard。
 */

import { ToolUseCard } from "../ToolUseCard";
import type { NormalizedBlockFE } from "../../lib/api";

export interface ToolUseBlockProps {
  block: NormalizedBlockFE;
}

export function ToolUseBlock({ block }: ToolUseBlockProps) {
  return (
    <ToolUseCard
      id={String(block.id ?? "")}
      name={String(block.name ?? "?")}
      input={(block.input as Record<string, unknown>) ?? {}}
    />
  );
}
