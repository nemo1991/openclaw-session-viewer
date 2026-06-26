/**
 * ThinkingBlockWrap — block kind === "thinking" 的 Presentational 包装
 *
 * 从 MessageBubble BlockRenderer (thinking arm) 抽出。
 * 内部调用现有的 ThinkingBlock 组件(自带 open/useState)。
 */

import { ThinkingBlock } from "../ThinkingBlock";
import type { NormalizedBlockFE } from "../../lib/api";

export interface ThinkingBlockWrapProps {
  block: NormalizedBlockFE;
}

export function ThinkingBlockWrap({ block }: ThinkingBlockWrapProps) {
  return <ThinkingBlock text={String(block.thinking ?? block.text ?? "")} />;
}
