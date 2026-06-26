/**
 * useTranscriptScroll — 虚拟滚动 + 自动跟随 + 跳到命中
 *
 * 解决 v0.4.x 累积的滚动相关问题:
 * 1. SessionDetailRoute 之前用 document.querySelector + scrollIntoView,
 *    与 virtualizer.scrollToIndex 冲突(v0.4.3 fix comment 提过),
 *    现在统一走 virtualizer.scrollToIndex
 * 2. 自动滚到底只在新 entry 流入 + 用户已在底部 50px + 无搜索命中 三条件全满足时触发
 * 3. jumpToEntry 用 local index(在 sortedEntries 里),不依赖 DOM,
 *    URL ?line=N 跳转稳定
 */

import { useCallback, useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { TranscriptEntryOut } from "../lib/api";
import type { InSessionHit } from "../state/searchInSessionStore";

interface ScrollOpts {
  sortedEntries: TranscriptEntryOut[];
  /** 当前搜索命中,跳转要用;传 null 时跳过 jump-to-hit effect */
  currentHit: InSessionHit | null;
}

export interface ScrollResult {
  parentRef: React.RefObject<HTMLDivElement>;
  virtualizer: ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>;
  /** 跳到指定 entry.index(URL ?line=N 用),内部走 virtualizer */
  jumpToEntry: (entryIndex: number) => void;
}

const SCROLL_BOTTOM_THRESHOLD_PX = 50;

export function useTranscriptScroll({ sortedEntries, currentHit }: ScrollOpts): ScrollResult {
  // React 18.3+ types: useRef<HTMLDivElement>(null) → MutableRefObject<HTMLDivElement | null>
  // 显式标注 null 避免传给 ref={} 时类型不匹配
  const parentRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: sortedEntries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 10,
  });

  // 自动滚到底(用户已在底部 + 无搜索命中)
  useEffect(() => {
    if (currentHit) return;
    const el = parentRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_THRESHOLD_PX;
    if (!atBottom) return;
    // 等 React 把新 entry 渲染到 DOM 高度更新后再滚
    requestAnimationFrame(() => {
      if (parentRef.current) {
        parentRef.current.scrollTop = parentRef.current.scrollHeight;
      }
    });
  }, [sortedEntries.length, currentHit]);

  // 跳到搜索命中
  useEffect(() => {
    if (!currentHit) return;
    const idx = sortedEntries.findIndex((e) => e.index === currentHit.entryIndex);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "center" });
  }, [currentHit, sortedEntries, virtualizer]);

  // URL ?line=N 跳转(稳定依赖 sortedEntries + virtualizer)
  const jumpToEntry = useCallback(
    (entryIndex: number) => {
      const idx = sortedEntries.findIndex((e) => e.index === entryIndex);
      if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "center" });
    },
    [sortedEntries, virtualizer]
  );

  return { parentRef, virtualizer, jumpToEntry };
}
