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
  /**
   * v0.9.23 (M5): 6 个 chart meta blocks (context.apply_compaction /
   * llm.tools_snapshot / usage.chart / request.chart / todos.chart /
   * ai-title.chart)。从 transcript timeline 抽离到独立 `<ChartsRegion>`
   * 组件(在 SessionOverview 下、TranscriptView 上)。
   *
   * 老 wire 兼容: 老 payload 没 `charts` 字段 → `?? []` 兜底。
   * 永远有值(空数组即"session 无 chart"),store reset 同步清空。
   */
  charts: TranscriptEntryOut[];
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
  charts: [],
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
      charts: [],
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

    // v0.8.14 item F: 把 listen 放到 invoke 之前,**中间不插任何 await** —
    // 之前 count_entries 在 listen 和 invoke 之间,backend 一发
    // transcript-batch 可能早于 listener 注册完成 → 前几批丢失。
    // count 只是 progress UI hint,移到 invoke 之后即可。
    // v0.9.23 (M5): batch 里多带 `charts` 字段 — 6 chart blocks 由后端
    // 抽离,前端同时 append 到 `charts` state。timeline 不会渲染 chart blocks。
    const unlisteners = await listenTranscriptBatches(
      (batch) => {
        // 老 wire 兼容: 老 batch payload 没有 charts 字段 → 按 [] 处理
        const newCharts = batch.charts ?? [];
        set((s) => ({
          entries: [...s.entries, ...batch.entries],
          charts: [...s.charts, ...newCharts],
          loadedCount: s.entries.length + batch.entries.length,
        }));
      },
      // v0.8.14 item D: done 事件现在带 error 字段,后端 stream_batches
      // 失败时通过这里把错误信息塞进 store error state。
      (errMsg) => {
        if (errMsg) {
          set({ error: errMsg, loading: false });
        } else {
          set({ loading: false });
        }
      }
    );

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

    // count 移到 invoke 之后 — 只是 UI hint,不影响数据流
    try {
      const total = await apiCountEntries(path);
      set({ totalCount: total });
    } catch (e) {
      console.warn("count_entries 失败:", e);
    }
  },
}));

export type { NormalizedMessageFE };

// 重新导出共享工具(原文件 private 定义)
export { extractErrorMessage };
