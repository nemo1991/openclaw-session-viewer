import type { NormalizedBlock } from "@ocsv/shared";
/**
 * ThinkingBlockWrap — block kind === "thinking" 的 Presentational 包装
 *
 * 从 MessageBubble BlockRenderer (thinking arm) 抽出。
 * 内部调用现有的 ThinkingBlock 组件(自带 open/useState)。
 */

import { ThinkingBlock } from "../ThinkingBlock";

export interface ThinkingBlockWrapProps {
  block: NormalizedBlock;
}

export function ThinkingBlockWrap({ block }: ThinkingBlockWrapProps) {
  return <ThinkingBlock text={String(block.thinking ?? block.text ?? "")} />;
}
