/**
 * 转录 store — 管理流式加载的消息
 */

import { create } from "zustand";
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
      // v0.2.6 调查:Windows 上 [object Object] 的真凶 — invoke 抛 error
      // 对象时 String(e) 是 "[object Object]"。打印真实结构。
      console.error("[stream_transcript:error]", {
        e,
        typeofE: typeof e,
        keys: e && typeof e === "object" ? Object.keys(e) : null,
        json: JSON.stringify(e),
        toString: String(e),
      });
      set({ error: String(e), loading: false });
      unlisteners.forEach((u) => u());
    }
  },
}));

export type { NormalizedMessageFE };
