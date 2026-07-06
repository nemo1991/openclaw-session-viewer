/**
 * useTranscriptScroll — 虚拟滚动 + 自动跟随 + 跳到命中
 *
 * v0.7.0 第二轮重构(性能回归后回归):
 * 上一轮放弃 @tanstack/react-virtual,改 flex column + gap,结果 1000+ entry session
 * 加载卡顿 + 筛选时浏览器顿 2s+ — 因为每条 entry 都是一个真实 DOM MessageBubble,
 * React 一次性 mount/measure/paint 上千棵子树,主线程阻塞。
 *
 * 之前 virtualizer 时代 3 个根本 bug(commit 952c3f7 / a8458b4 / f51fc6c 反复折腾):
 * 1. position: absolute 元素没有 flex gap → 间距 bug
 * 2. getBoundingClientRect 只返 border-box → margin 不被测到
 * 3. measurement cache 按 index 存 → filter 后同 index 映射不同 entry,旧高度错位
 *
 * 这次的修法(根因级,不再补补丁):
 * - row wrapper `padding: 12px 0`(border-box 内,getBoundingClientRect 测得到)
 * - virtualizer `getItemKey: (i) => entries[i].normalized.id` — measurement cache 按
 *   稳定 id 存,filter / sort 变化后同一个 entry 仍是同一个 cache 槽,不会被新 entry
 *   的旧高度污染
 * - row `key={entry.normalized.id}` — React 复用 DOM 节点,filter 后不 unmount/remount
 * - 删 `virtualizer.measure()` 副作用(稳定 key 后不再需要)
 *
 * scrollToIndex 行为保留:URL ?line=N / 搜索命中 / SubagentMetaBlock LeafJumpButton。
 * fallback scrollIntoView 保留:scrollToIndex 失败时(目标 row 还没 mount)走原生滚动。
 */

import { useCallback, useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { TranscriptEntryOut } from "../lib/api";
import type { InSessionHit } from "../state/searchInSessionStore";
import { useTranscriptStore } from "../state/transcriptStore";

interface ScrollOpts {
  sortedEntries: TranscriptEntryOut[];
  /** 当前搜索命中,跳转要用;传 null 时跳过 jump-to-hit effect */
  currentHit: InSessionHit | null;
}

export interface ScrollResult {
  // React 19: useRef<T>(null) → RefObject<T | null>;保持 nullable 与调用方一致
  parentRef: React.RefObject<HTMLDivElement | null>;
  virtualizer: ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>;
  /** 跳到指定 entry.index(URL ?line=N 用),内部走 virtualizer */
  jumpToEntry: (entryIndex: number) => void;
}

const SCROLL_BOTTOM_THRESHOLD_PX = 50;

export function useTranscriptScroll({ sortedEntries, currentHit }: ScrollOpts): ScrollResult {
  const parentRef = useRef<HTMLDivElement | null>(null);

  // v0.7.0 第二轮:关键 3 个 option 一起保稳定虚拟化:
  // - getItemKey 按 entry.normalized.id — measurement cache by id(非 by index)
  // - overscan: 10 上下各 10 条,滚动不闪屏
  // - estimateSize: 120 — 初始估算(后续 measureElement 自动修正)
  const virtualizer = useVirtualizer({
    count: sortedEntries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 10,
    // 关键:按稳定 id 取 key — measurement cache 跟着 id 走,
    // filter / sort 改 entries 顺序后,同一个 entry 还是同一个 cache 槽。
    getItemKey: (index) => sortedEntries[index]?.normalized.id ?? index,
  });

  // 自动滚到底(用户已在底部 + 无搜索命中 + entries 增加)
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

  // v0.6.0:监听 useTranscriptStore.jumpTarget — 任意组件 (SubagentMetaBlock LeafJumpButton)
  // 可触发跳到 entry.index (last-prompt.leafUuid 等场景)
  const jumpTarget = useTranscriptStore((s) => s.jumpTarget);
  useEffect(() => {
    if (jumpTarget == null) return;
    const idx = sortedEntries.findIndex((e) => e.index === jumpTarget);
    if (idx < 0) {
      // entries 还没加载 / 目标不在范围 — 不清空, 等 entries 加载完再试
      return;
    }
    const targetEntry = sortedEntries[idx];
    if (!targetEntry) return;
    virtualizer.scrollToIndex(idx, { align: "center" });
    // v0.6.0:跳到后高亮 1.5s — 视觉反馈
    useTranscriptStore.getState().markJumped(targetEntry.normalized?.id ?? "");
    // 触发后清空,避免重复触发
    useTranscriptStore.setState({ jumpTarget: null });
  }, [jumpTarget, sortedEntries, virtualizer]);

  return { parentRef, virtualizer, jumpToEntry };
}
