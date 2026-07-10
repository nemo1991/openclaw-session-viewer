/**
 * v0.8.5 B: 全局 tool 聚合 store
 *
 * 缓存 `get_tool_aggregate` 结果 + `sessions-updated` 事件触发 invalidate。
 * 类似 `overridesStore` 的 sync listener pattern。
 */

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import {
  apiGetToolAggregate,
  type ToolAggregateRow,
  type ToolSessionRef,
} from "../lib/overridesApi";

interface ToolStatsStore {
  /** null = 还没加载 */
  aggregate: ToolAggregateRow[] | null;
  /** 当前 sort_by */
  sortBy: "calls" | "sessions" | "errors";
  /** 加载状态 */
  loading: boolean;
  /** 上次加载时间 (ms epoch) */
  loadedAt: number | null;

  setSortBy: (sortBy: "calls" | "sessions" | "errors") => void;
  load: () => Promise<void>;
  /** 强制重载 (忽略缓存) */
  reload: () => Promise<void>;
  /** 单 tool 跨 session 查询 (不缓存,每次现调) */
  loadSessions: (toolName: string, limit?: number) => Promise<ToolSessionRef[]>;
}

export const useToolStatsStore = create<ToolStatsStore>((set, get) => ({
  aggregate: null,
  sortBy: "calls",
  loading: false,
  loadedAt: null,

  setSortBy: (sortBy) => {
    set({ sortBy });
    void get().load();
  },

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const aggregate = await apiGetToolAggregate(get().sortBy, 100);
      set({ aggregate, loading: false, loadedAt: Date.now() });
    } catch (e) {
      console.error("toolStatsStore.load failed:", e);
      set({ loading: false });
    }
  },

  reload: async () => {
    set({ loading: true, loadedAt: null });
    try {
      const aggregate = await apiGetToolAggregate(get().sortBy, 100);
      set({ aggregate, loading: false, loadedAt: Date.now() });
    } catch (e) {
      console.error("toolStatsStore.reload failed:", e);
      set({ loading: false });
    }
  },

  loadSessions: async (toolName, limit) => {
    const { apiGetToolSessions } = await import("../lib/overridesApi");
    return apiGetToolSessions(toolName, limit);
  },
}));

// listen sessions-updated 触发自动 reload
let _listenerStarted = false;
export function startToolStatsListener() {
  if (_listenerStarted) return;
  _listenerStarted = true;
  void listen("sessions-updated", () => {
    void useToolStatsStore.getState().reload();
  });
}
