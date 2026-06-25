/**
 * Trajectory store (OpenClaw)
 *
 * 与 transcriptStore 平行,流式加载 trajectory 事件 (8 种类型)。
 * 每次 start(sessionPath) 重置并启动新的 stream。
 */

import { create } from "zustand";
import type { TrajectoryEventFE } from "../lib/api";
import { apiStreamTrajectory, listenTrajectoryBatches } from "../lib/api";

interface TrajectoryStore {
  sessionPath: string | null;
  events: TrajectoryEventFE[];
  loading: boolean;
  totalCount: number;
  loadedCount: number;
  error: string | null;

  start: (sessionPath: string) => Promise<void>;
  reset: () => void;
}

let unlistenBatch: (() => void) | null = null;
let unlistenDone: (() => void) | null = null;

export const useTrajectoryStore = create<TrajectoryStore>((set, get) => ({
  sessionPath: null,
  events: [],
  loading: false,
  totalCount: 0,
  loadedCount: 0,
  error: null,

  start: async (sessionPath) => {
    // 幂等:相同 path 不重启
    if (get().sessionPath === sessionPath && get().events.length > 0) return;

    // 清理旧订阅
    if (unlistenBatch) unlistenBatch();
    if (unlistenDone) unlistenDone();
    unlistenBatch = null;
    unlistenDone = null;

    set({
      sessionPath,
      events: [],
      loading: true,
      totalCount: 0,
      loadedCount: 0,
      error: null,
    });

    try {
      const unlisteners = await listenTrajectoryBatches(
        (batch) => {
          set((s) => ({
            events: [...s.events, ...batch.events],
            loadedCount: s.loadedCount + batch.events.length,
            totalCount: Math.max(s.totalCount, s.loadedCount + batch.events.length),
          }));
        },
        () => {
          set({ loading: false });
        }
      );
      unlistenBatch = unlisteners[0] ?? null;
      unlistenDone = unlisteners[1] ?? null;

      await apiStreamTrajectory(sessionPath);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ error: msg, loading: false });
    }
  },

  reset: () => {
    if (unlistenBatch) unlistenBatch();
    if (unlistenDone) unlistenDone();
    unlistenBatch = null;
    unlistenDone = null;
    set({
      sessionPath: null,
      events: [],
      loading: false,
      totalCount: 0,
      loadedCount: 0,
      error: null,
    });
  },
}));
