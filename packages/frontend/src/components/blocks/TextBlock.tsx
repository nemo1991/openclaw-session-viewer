/**
 * TextBlock — block kind === "text" 的 Presentational 包装
 *
 * 从 MessageBubble BlockRenderer (text arm) 抽出。
 */

import { Markdown } from "../Markdown";
import type { NormalizedBlockFE } from "../../lib/api";

export interface TextBlockProps {
  block: NormalizedBlockFE;
}

export function TextBlock({ block }: TextBlockProps) {
  return (
    <div className="block-text">
      <Markdown text={String(block.text ?? "")} />
    </div>
  );
}
