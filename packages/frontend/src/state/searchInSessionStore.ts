/**
 * 会话内搜索 store
 *
 * 在已经流式加载的 transcript entries 上做客户端搜索,
 * 不需要再次调用后端 (后端的 search_session 主要用于全局跨会话搜索)。
 */

import { create } from "zustand";
import type { TranscriptEntryOut } from "../lib/api";

export interface InSessionHit {
  entryIndex: number;
  byteOffset: number;
  /** 在 entry.normalized 字符串中的字符位置 */
  charOffset: number;
  /** 上下文片段(命中位置前后 ±60 字符) */
  snippet: string;
}

interface SearchInSessionStore {
  open: boolean;
  query: string;
  hits: InSessionHit[];
  currentHitIndex: number;
  show: () => void;
  hide: () => void;
  setQuery: (q: string) => void;
  /** 在 entries 上运行搜索 */
  search: (entries: TranscriptEntryOut[]) => void;
  next: () => void;
  prev: () => void;
  /** v0.4.3: 直接跳到指定 hit(drowdown row 点击用) */
  setCurrentHitIndex: (i: number) => void;
}

export const useSearchInSessionStore = create<SearchInSessionStore>((set, get) => ({
  open: false,
  query: "",
  hits: [],
  currentHitIndex: -1,
  show: () => set({ open: true }),
  hide: () => set({ open: false, query: "", hits: [], currentHitIndex: -1 }),
  setQuery: (q) => set({ query: q }),
  search: (entries) => {
    const q = get().query.trim().toLowerCase();
    if (!q) {
      set({ hits: [], currentHitIndex: -1 });
      return;
    }
    const hits: InSessionHit[] = [];
    for (const entry of entries) {
      const serialized = JSON.stringify(entry.normalized).toLowerCase();
      let pos = 0;
      while (true) {
        const idx = serialized.indexOf(q, pos);
        if (idx === -1) break;
        hits.push({
          entryIndex: entry.index,
          byteOffset: entry.byteOffset,
          charOffset: idx,
          snippet: extractSnippet(serialized, idx, q.length),
        });
        pos = idx + q.length;
      }
    }
    set({ hits, currentHitIndex: hits.length > 0 ? 0 : -1 });
  },
  next: () => {
    const { hits, currentHitIndex } = get();
    if (hits.length === 0) return;
    set({ currentHitIndex: (currentHitIndex + 1) % hits.length });
  },
  prev: () => {
    const { hits, currentHitIndex } = get();
    if (hits.length === 0) return;
    set({ currentHitIndex: (currentHitIndex - 1 + hits.length) % hits.length });
  },
  setCurrentHitIndex: (i) => {
    const { hits } = get();
    if (hits.length === 0) {
      set({ currentHitIndex: -1 });
      return;
    }
    const clamped = Math.max(0, Math.min(hits.length - 1, i));
    set({ currentHitIndex: clamped });
  },
}));

function extractSnippet(s: string, pos: number, qLen: number): string {
  const PAD = 60;
  const start = Math.max(0, pos - PAD);
  const end = Math.min(s.length, pos + qLen + PAD);
  let snippet = s.slice(start, end);
  // 把连续空白压缩成单个空格,让 snippet 可读
  snippet = snippet.replace(/\s+/g, " ");
  if (start > 0) snippet = "…" + snippet;
  if (end < s.length) snippet = snippet + "…";
  return snippet;
}
