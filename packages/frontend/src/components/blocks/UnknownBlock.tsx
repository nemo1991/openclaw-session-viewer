/**
 * UnknownBlock — block kind 未知时的兜底 Presentational 包装
 *
 * 从 MessageBubble BlockRenderer (default arm) 抽出。
 * 内部调用现有的 UnknownBlockCard(自带 inferHints / 折叠 details)。
 */

import { UnknownBlockCard } from "../UnknownBlockCard";
import type { NormalizedBlockFE } from "../../lib/api";

export interface UnknownBlockProps {
  block: NormalizedBlockFE;
}

export function UnknownBlock({ block }: UnknownBlockProps) {
  return <UnknownBlockCard block={block} />;
}
