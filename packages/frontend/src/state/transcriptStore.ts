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
  start: (path: string) => Promise<void>;
  reset: () => void;
}

export const useTranscriptStore = create<TranscriptStore>((set, get) => ({
  path: null,
  entries: [],
  loading: false,
  totalCount: 0,
  loadedCount: 0,
  error: null,
  reset: () =>
    set({
      path: null,
      entries: [],
      loading: false,
      totalCount: 0,
      loadedCount: 0,
      error: null,
    }),
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
