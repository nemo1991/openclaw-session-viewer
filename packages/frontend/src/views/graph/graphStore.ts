/**
 * graphStore — G1/G2/G3 共享 graph 数据
 *
 * M1 阶段:数据源走 fetch /sessions.ndjson(双源,experiment 那边继续跑生成 NDJSON)
 * M3 阶段:切换到 apiListGraph() (Tauri invoke) — 改 load() 函数即可
 *
 * 缓存:zustand 内存,App 生命周期内只 load 一次
 */

import { create } from "zustand";
import type { GraphEntry } from "./types";
import { loadNdjson } from "./loader";

interface GraphState {
  entries: GraphEntry[] | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  entries: null,
  loading: false,
  error: null,
  load: async () => {
    if (get().loading) return; // 防止并发
    if (get().entries) return; // 已加载
    set({ loading: true, error: null });
    try {
      // M1:fetch NDJSON(M3 后切 apiListGraph())
      const data = await loadNdjson("/sessions.ndjson");
      set({ entries: data, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },
}));
