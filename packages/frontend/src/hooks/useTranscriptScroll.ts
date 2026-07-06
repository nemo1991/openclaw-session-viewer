/**
 * useTranscriptScroll — 简化的 transcript 滚动 hook
 *
 * v0.7.0 重构:放弃 @tanstack/react-virtual,改用 flex column + 原生 scrollIntoView。
 *
 * 原 virtualizer 设计 3 个脆弱点:
 * 1. position: absolute + transform translateY 定位,把元素踢出正常 layout flow
 * 2. getBoundingClientRect() 只返 border-box,不含 margin → 间距 bug
 * 3. measurement cache 按 index 存,filter 切换同 index 映射不同 entry → 高度错位
 *
 * 替代:flex column + gap 由浏览器原生 layout,filter / sort 变化 = React 重渲染,
 * 自动重排,无需任何 measurement cache / remeasure 副作用。
 *
 * 保留的滚动语义:
 * - 自动滚到底:用户已在底部 50px + 无搜索命中 + entries 增加
 * - 跳到搜索命中:scrollIntoView({ block: "center" })
 * - URL ?line=N 跳转:jumpToEntry
 * - SubagentMetaBlock LeafJumpButton:jumpTarget
 */

import { useCallback, useEffect, useRef } from "react";

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
  /** 跳到指定 entry.index(URL ?line=N 用),内部走 scrollIntoView */
  jumpToEntry: (entryIndex: number) => void;
}

const SCROLL_BOTTOM_THRESHOLD_PX = 50;

/** 滚到底 — 用 row 容器 (data-entry-index 属性) 找 DOM,没有时跳到 scroll bottom */
function scrollToEntryIndex(parent: HTMLElement, entryIndex: number): boolean {
  const row = parent.querySelector(`[data-entry-index="${entryIndex}"]`) as HTMLElement | null;
  if (row) {
    row.scrollIntoView({ block: "center", behavior: "smooth" });
    return true;
  }
  return false;
}

export function useTranscriptScroll({ sortedEntries, currentHit }: ScrollOpts): ScrollResult {
  const parentRef = useRef<HTMLDivElement | null>(null);

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
    const el = parentRef.current;
    if (!el) return;
    scrollToEntryIndex(el, currentHit.entryIndex);
  }, [currentHit, sortedEntries]);

  // URL ?line=N 跳转(稳定依赖 sortedEntries,无 virtualizer)
  const jumpToEntry = useCallback(
    (entryIndex: number) => {
      const el = parentRef.current;
      if (!el) return;
      scrollToEntryIndex(el, entryIndex);
    },
    [sortedEntries]
  );

  // v0.6.0:监听 useTranscriptStore.jumpTarget — 任意组件 (SubagentMetaBlock LeafJumpButton)
  // 可触发跳到 entry.index (last-prompt.leafUuid 等场景)
  const jumpTarget = useTranscriptStore((s) => s.jumpTarget);
  useEffect(() => {
    if (jumpTarget == null) return;
    const el = parentRef.current;
    if (!el) return;
    const found = scrollToEntryIndex(el, jumpTarget);
    if (!found) {
      // entries 还没加载 / 目标不在范围 — 不清空, 等 entries 加载完再试
      // (TranscriptView 会在 entries 变化时重新触发这个 effect)
      return;
    }
    const targetEntry = sortedEntries.find((e) => e.index === jumpTarget);
    // v0.6.0:跳到后高亮 1.5s — 视觉反馈
    if (targetEntry) {
      useTranscriptStore.getState().markJumped(targetEntry.normalized?.id ?? "");
    }
    // 触发后清空,避免重复触发
    useTranscriptStore.setState({ jumpTarget: null });
  }, [jumpTarget, sortedEntries]);

  return { parentRef, jumpToEntry };
}
