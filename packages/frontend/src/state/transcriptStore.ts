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
      // v0.2.6: 提取真实 error 消息 — invoke 抛 error 对象时
      // String(e) 是 "[object Object]"。用 message / kind 字段优先。
      const errMsg = extractErrorMessage(e);
      set({ error: errMsg, loading: false });
      unlisteners.forEach((u) => u());
    }
  },
}));

export type { NormalizedMessageFE };

/**
 * 从 invoke error 对象提取可读消息。
 * Tauri 抛的错误通常有结构:`{ kind: "PathSecurity", message: "..." }`
 * 优先用 `message` 字段,避免 `String(obj)` 出 "[object Object]"。
 */
function extractErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.kind === "string") {
      return typeof obj.message === "string" ? `${obj.kind}: ${obj.message}` : String(obj.kind);
    }
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}
