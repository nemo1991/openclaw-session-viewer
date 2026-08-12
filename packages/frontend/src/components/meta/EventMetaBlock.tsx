/**
 * v0.9.20 (M3): EventMetaBlock — L3 layer
 *
 * 单事件 inline meta(Kimi metadata / config.update /
 * permission.set_mode / tools.set_active_tools /
 * permission.record_approval_result / OpenClaw model_change /
 * compaction / label / 等)的通用渲染。
 *
 * 这些事件:
 * - 在 `MessageBubble` 的 `role === "meta"` 分支里被识别为 meta (kind === "meta")
 * - 不是 attachment kind(不是 `ATTACHMENT_META_LABELS` 之一)
 * - 不是 chart kind(不是 `CHART_META_LABELS` 之一)
 * - 也不属于 `SubagentMetaBlock` 范畴(mode:* / permission:* / title / last-prompt)
 *
 * 之前这些事件要么走 `<UnknownBlockCard>` (兜底, payload 字段丰富时),
 * 要么被简化成 `<span className="msg-meta-pill">{labelStr}</span>` (无 payload)。
 * v0.9.20 引入 `<EventMetaBlock>` 作为这两个兜底的"中间层":
 * - 有 payload → 渲染 `label + payload 字段表` (key-value + JSON fallback)
 * - 无 payload → 渲染 `label + 简短摘要`
 *
 * accent: 共享 slate (但 border 0.4 比 attachment 0.6 略弱 — 跟
 * `theme/meta-palette.ts` 的 `META_ACCENT.eventMeta` 一致)。
 *
 * 路由:`MetaBlock` 顶层 switch 通过排除法判断(非 chart 非 attachment) →
 * 走 `<EventMetaBlock block={block} />`。
 *
 * fallback: 任何 throw 或解析失败 → `<UnknownBlockCard>` 兜底。
 */

import { useState } from "react";
import type { NormalizedBlockFE } from "../../lib/api";
import { formatPreviewValue } from "../../lib/meta";
import { UnknownBlockCard } from "../UnknownBlockCard";

export interface EventMetaBlockProps {
  block: NormalizedBlockFE;
}

const MAX_TABLE_ROWS = 16;

export function EventMetaBlock({ block }: EventMetaBlockProps) {
  const label = String(block.label ?? block.kind ?? "(无 label)");
  const payload = (block.payload ?? {}) as Record<string, unknown>;
  const payloadKeys = Object.keys(payload);

  // 完全空:无 label 无 payload → UnknownBlockCard 兜底
  if (payloadKeys.length === 0 && !block.label) {
    return <UnknownBlockCard block={block} />;
  }

  // 顶层字段(非 payload) — Kimi metadata 等直接在 block 顶层
  const topFields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
    if (k === "kind" || k === "label" || k === "payload" || k === "id") continue;
    if (v !== undefined) topFields[k] = v;
  }

  const hasPayload = payloadKeys.length > 0;
  const hasTopFields = Object.keys(topFields).length > 0;
  const totalFields = payloadKeys.length + Object.keys(topFields).length;

  const [expanded, setExpanded] = useState(false);
  const showToggle = totalFields > MAX_TABLE_ROWS;
  const visiblePayloadKeys = expanded ? payloadKeys : payloadKeys.slice(0, MAX_TABLE_ROWS);
  const visibleTopEntries = expanded
    ? Object.entries(topFields)
    : Object.entries(topFields).slice(0, Math.max(0, MAX_TABLE_ROWS - payloadKeys.length));

  // 渲染一个 key-value 行
  const renderRow = (key: string, value: unknown) => (
    <div key={key} className="meta-event-row" data-testid={`event-meta-row-${key}`}>
      <span className="meta-event-key" title={key}>
        {key}
      </span>
      <span
        className="meta-event-value"
        title={typeof value === "string" ? value : formatPreviewValue(value)}
      >
        {formatPreviewValue(value)}
      </span>
    </div>
  );

  return (
    <div
      className="block-meta-info meta-block-flat event-meta-block-meta"
      data-testid="event-meta-block"
    >
      <span className="meta-kind-badge">📄 {label}</span>
      {!hasPayload && !hasTopFields && <span className="meta-sub">(空 inline meta)</span>}
      {(hasPayload || hasTopFields) && (
        <>
          <span className="meta-sub">{totalFields} 字段 · inline meta</span>
          <div className="meta-event-table">
            {visiblePayloadKeys.map((k) => renderRow(k, payload[k]))}
            {visibleTopEntries.map(([k, v]) => renderRow(k, v))}
          </div>
          {showToggle && (
            <button
              type="button"
              className="meta-show-more"
              data-testid="event-meta-toggle"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? "收起字段表" : `展开剩余 ${totalFields - MAX_TABLE_ROWS} 个字段`}
            >
              {expanded ? "收起" : `展开剩余 ${totalFields - MAX_TABLE_ROWS} 个字段`}
            </button>
          )}
        </>
      )}
    </div>
  );
}
