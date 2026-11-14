import type { NormalizedBlock } from "@ocsv/shared";
/**
 * ImageBlock — block kind === "image" 的 Presentational 包装
 *
 * 从 MessageBubble BlockRenderer (image arm) 抽出。
 * 内联 JSX 简单,不调外部组件。
 */

export interface ImageBlockProps {
  block: NormalizedBlock;
}

export function ImageBlock({ block }: ImageBlockProps) {
  return (
    <div className="block-image">
      <em>
        📷 图片 (data:{String(block.mediaType ?? "image/png")},{" "}
        {String((block.data as string) ?? "").length} 字符)
      </em>
    </div>
  );
}
