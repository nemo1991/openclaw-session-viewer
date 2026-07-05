/**
 * ToolUseBlock — block kind === "tool_use" 的 Presentational 包装
 *
 * 从 MessageBubble BlockRenderer (tool_use arm) 抽出。
 * 内部调用现有的 ToolUseCard。
 *
 * v0.5.0:透传 parentJsonlPath + parentSessionId 到 ToolUseCard,
 * 让 Claude Agent 卡片能调用 apiListSubagentsByMeta 找匹配子代理。
 */

import { ToolUseCard } from "../ToolUseCard";
import type { NormalizedBlockFE } from "../../lib/api";

export interface ToolUseBlockProps {
  block: NormalizedBlockFE;
  parentJsonlPath?: string;
  parentSessionId?: string;
}

export function ToolUseBlock({ block, parentJsonlPath, parentSessionId }: ToolUseBlockProps) {
  return (
    <ToolUseCard
      id={String(block.id ?? "")}
      name={String(block.name ?? "?")}
      input={(block.input as Record<string, unknown>) ?? {}}
      parentJsonlPath={parentJsonlPath}
      parentSessionId={parentSessionId}
    />
  );
}
