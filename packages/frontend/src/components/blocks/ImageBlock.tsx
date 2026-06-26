/**
 * ImageBlock — block kind === "image" 的 Presentational 包装
 *
 * 从 MessageBubble BlockRenderer (image arm) 抽出。
 * 内联 JSX 简单,不调外部组件。
 */

import type { NormalizedBlockFE } from "../../lib/api";

export interface ImageBlockProps {
  block: NormalizedBlockFE;
}

export function ImageBlock({ block }: ImageBlockProps) {
  return (
    <div className="block-image">
      <em>
        📷 图片 (data:{String(block.mediaType ?? "image/png")},{" "}
        {String(block.dataBase64 ?? "").length} 字符)
      </em>
    </div>
  );
}
