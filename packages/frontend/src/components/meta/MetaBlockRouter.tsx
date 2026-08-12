/**
 * v0.9.21 (M6): `MetaBlock` → `MetaBlockRouter` rename
 *
 * v0.9.18 (M1) 之前 `MetaBlock.tsx` 是 1692 行的上帝组件 — 6 chart 渲染
 * 内联 + 13 attachment case 内联 + 4 chart utility + 4 SVG import + 4 helper。
 *
 * v0.9.18 (M1) — 13 attachment kind 统一 slate accent (UI 层)
 * v0.9.19 (M2) — 6 chart 抽到 `<ChartBlock>` dispatcher + 6 个独立 sub-component
 * v0.9.20 (M3) — 13 attachment 抽到 `<AttachmentBlock>`,
 *                inline meta 落到 `<EventMetaBlock>`,
 *                `<MetaBlock>` 自身只剩 4 路 router
 * v0.9.21 (M6, 本版) — 改为 `MetaBlockRouter` 命名,消除它历史上作为
 *                "monolithic meta renderer" 的歧义;现在 4 个 layer
 *                (L2 ChartBlock / L3 EventMetaBlock / L4 AttachmentBlock
 *                + UnknownBlockCard fallback) 都各自有独立 component,
 *                这个文件只剩纯 router 路由职责
 *
 * 路由表(基于 `theme/meta-palette.ts` 的两个 Set):
 * - L2 chart: `CHART_META_LABELS` (6 个 chart kind)  → `<ChartBlock>`
 * - L4 attachment: `ATTACHMENT_META_LABELS` (13+4 个 Claude attachment) → `<AttachmentBlock>`
 * - L3 event meta: 其他(走 inline meta) → `<EventMetaBlock>`
 * - fallback: 任何 throw / 解析失败 → `<UnknownBlockCard>`
 *
 * 边界:
 * - 入口来自 `MessageBubble` `role === "meta"` 分支,`isKnownMetaLabel`
 *   决定是否进来(13 attachment + 6 chart = 19 label)
 * - 路由在 `<MetaBlockRouter>` 顶层做,每个 layer component 自己负责自己
 *   layer 的渲染逻辑,职责单一
 */

import type { NormalizedBlockFE } from "../../lib/api";
import { UnknownBlockCard } from "../UnknownBlockCard";
// v0.9.19 (M2): 6 chart kind 路由
import { ChartBlock } from "./ChartBlock";
// v0.9.20 (M3): 13 attachment kind 抽到独立 component
import { AttachmentBlock } from "./AttachmentBlock";
// v0.9.20 (M3): inline meta(Kimi metadata / config.update / 等)通用渲染
import { EventMetaBlock } from "./EventMetaBlock";
// v0.9.18: 路由表 Set — 19 个已知 label
import { ATTACHMENT_META_LABELS, CHART_META_LABELS } from "../../theme/meta-palette";

export interface MetaBlockRouterProps {
  block: NormalizedBlockFE;
  label: string;
  /** v0.6.x: 透传 parentJsonlPath, 让 useFileReveal (file_snapshot / plan_mode reveal) 推 workspaceRoot */
  parentJsonlPath?: string;
}

/**
 * 4 路 router,基于 block.label 分发到 L2 / L3 / L4 layer 之一:
 * - L2 chart (6 kind): 过程可视化,走 `<ChartBlock>` (M2 dispatcher)
 * - L4 attachment (13+4 kind): Claude attachment envelope,走 `<AttachmentBlock>` (M3)
 * - L3 event meta (其他): inline meta,走 `<EventMetaBlock>` (M3)
 * - 兜底: 未知 label 走 `<UnknownBlockCard>` (老 wire / 老 DB 缓存)
 */
export function MetaBlockRouter({ block, label, parentJsonlPath }: MetaBlockRouterProps) {
  if (CHART_META_LABELS.has(label)) {
    return <ChartBlock block={block} />;
  }
  if (ATTACHMENT_META_LABELS.has(label)) {
    return <AttachmentBlock block={block} label={label} parentJsonlPath={parentJsonlPath} />;
  }
  // 既不是 chart 也不是 attachment → inline meta
  return <EventMetaBlock block={block} />;
}
