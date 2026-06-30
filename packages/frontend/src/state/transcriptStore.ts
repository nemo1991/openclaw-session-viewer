/**
 * 转录 store — 管理流式加载的消息
 */

import { create } from "zustand";
import { extractErrorMessage } from "../lib/api";
import type { NormalizedMessageFE, TranscriptEntryOut } from "../lib/api";
import { listenTranscriptBatches, apiCountEntries } from "../lib/api";

interface TranscriptStore {
  path: string | null;
  entries: TranscriptEntryOut[];
  loading: boolean;
  totalCount: number;
  loadedCount: number;
  error: string | null;
  /** v0.6.0: 跳转目标 entry.index — 任意组件可 set, TranscriptView 监听滚动 */
  jumpTarget: number | null;
  /**
   * v0.6.0: 最近一次跳到的 entry.id (uuid), 用于 MessageBubble 高亮闪烁 1.5s
   * null = 无高亮; 其它 = 目标 entry 的 normalized.id
   */
  lastJumpedId: string | null;
  /** 跳发生的时间戳(ms) — 配合 lastJumpedId 决定 1.5s 内是否还高亮 */
  lastJumpedAt: number;
  start: (path: string) => Promise<void>;
  reset: () => void;
  /** v0.6.0: 触发跳到 entry.index(被 useTranscriptScroll 在 TranscriptView 监听) */
  jumpTo: (entryIndex: number) => void;
  /** v0.6.0: 高亮跳到的 entry 1.5s */
  markJumped: (entryId: string) => void;
}

export const useTranscriptStore = create<TranscriptStore>((set, get) => ({
  path: null,
  entries: [],
  loading: false,
  totalCount: 0,
  loadedCount: 0,
  error: null,
  jumpTarget: null,
  lastJumpedId: null,
  lastJumpedAt: 0,
  reset: () =>
    set({
      path: null,
      entries: [],
      loading: false,
      totalCount: 0,
      loadedCount: 0,
      error: null,
      jumpTarget: null,
      lastJumpedId: null,
      lastJumpedAt: 0,
    }),
  jumpTo: (entryIndex: number) => set({ jumpTarget: entryIndex }),
  markJumped: (entryId: string) => set({ lastJumpedId: entryId, lastJumpedAt: Date.now() }),
  start: async (path: string) => {
    if (get().path === path) return;
    get().reset();
    set({ path, loading: true });

    try {
      const total = await apiCountEntries(path);
      set({ totalCount: total });
    } catch (e) {
      console.warn("count_entries 失败:", e);
    }

    // 监听事件
    const unlisteners = await listenTranscriptBatches(
      (batch) => {
        set((s) => ({
          entries: [...s.entries, ...batch.entries],
          loadedCount: s.entries.length + batch.entries.length,
        }));
      },
      () => {
        set({ loading: false });
      }
    );

    // 触发后端流
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      await invoke("stream_transcript", { path });
    } catch (e) {
      // v0.2.6: 提取真实 error 消息 — invoke 抛 error 对象时
      // String(e) 是 "[object Object]"。用 message / kind 字段优先。
      const errMsg = extractErrorMessage(e);
      set({ error: errMsg, loading: false });
      unlisteners.forEach((u) => u());
    }
  },
}));

export type { NormalizedMessageFE };

// 重新导出共享工具(原文件 private 定义)
export { extractErrorMessage };
