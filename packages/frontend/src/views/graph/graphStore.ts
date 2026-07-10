/**
 * graphStore — G1/G2/G3 共享 graph 数据
 *
 * v0.8.5 C: 数据源从 NDJSON 切到 DB (list_graph command)。UsedTool edges 从
 * session_meta.tool_usage_json 派生; 其它 edges (Spawned/ParentUuid/...) 留 v0.8.6+。
 *
 * 缓存:zustand 内存,App 生命周期内只 load 一次。sessions-updated 事件后用户
 * 主动 reload(点 ↻ 按钮)才能看到新数据 — load() 不自动 re-fetch (避免 IPC 风暴)。
 */

import { create } from "zustand";
import type { GraphEntry } from "./types";
import { apiListGraph } from "../../lib/overridesApi";

interface GraphState {
  entries: GraphEntry[] | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  reload: () => Promise<void>;
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
      const data = await apiListGraph();
      set({ entries: data as GraphEntry[], loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },
  reload: async () => {
    set({ loading: true, error: null });
    try {
      const data = await apiListGraph();
      set({ entries: data as GraphEntry[], loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },
}));
