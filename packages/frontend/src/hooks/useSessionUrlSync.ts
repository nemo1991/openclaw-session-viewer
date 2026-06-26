/**
 * useSessionUrlSync — URL → store / scroll 同步 hook
 *
 * 修真实 bug:SessionDetailRoute (v0.4.4) 把 ?line=N 和 ?from=?to= 放在同一个
 * useEffect,依赖 entries.length,首次进入 entries.length===0 时 ?line=N
 * 永不生效。拆成两个 effect:
 *
 * 1. ?from=ISO&to=ISO → 仅依赖 location.search,进入页面立即 setRange
 * 2. ?line=N → 依赖 entries.length>0 + location.search,等第一条 entry 到达
 *    再触发 jumpToEntry(virtualizer.scrollToIndex,非 DOM query)
 *
 * jumpToEntry 由调用方传入(从 useTranscriptScroll 取),保证滚动统一走
 * virtualizer(避免 scrollIntoView vs scrollToIndex 冲突 — v0.4.3 comment)。
 */

import { useEffect } from "react";

import { useTranscriptFilterStore } from "../state/transcriptFilterStore";

interface UrlSyncOpts {
  /** 当前 location.search 字符串 */
  search: string;
  /** entries 是否已流入(供 ?line=N 等待) */
  entriesLoaded: boolean;
  /** 从 useTranscriptScroll 取得的跳到指定 entry 的回调 */
  jumpToEntry: (entryIndex: number) => void;
}

export function useSessionUrlSync({ search, entriesLoaded, jumpToEntry }: UrlSyncOpts): void {
  // 1. ?from=?to= → 立即同步 filter
  useEffect(() => {
    const params = new URLSearchParams(search);
    const from = params.get("from");
    const to = params.get("to");
    if (from || to) {
      useTranscriptFilterStore.getState().setRange(from ?? undefined, to ?? undefined);
    }
  }, [search]);

  // 2. ?line=N → 等 entries 流入后跳
  useEffect(() => {
    if (!entriesLoaded) return;
    const params = new URLSearchParams(search);
    const line = params.get("line");
    if (!line) return;
    const target = parseInt(line, 10);
    if (isNaN(target)) return;
    // rAF 等 React 把新 entry 渲染到 DOM,virtualizer 有尺寸后再滚
    requestAnimationFrame(() => jumpToEntry(target));
  }, [entriesLoaded, search, jumpToEntry]);
}
