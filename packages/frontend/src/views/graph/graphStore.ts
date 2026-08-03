/**
 * graphStore — G1/G2/G3 共享 graph 数据
 *
 * v0.8.5 C: 数据源从 NDJSON 切到 DB (list_graph command)。UsedTool edges 从
 * session_meta.tool_usage_json 派生; 其它 edges (Spawned/ParentUuid/...) 留 v0.8.6+。
 *
 * v0.8.12 G: 加 listen_sessions_updated — mount 时 wire,200ms debounce 触发 reload。
 * 解决用户进入 Graph/Analytics 后 sync_loop 跑完 sessions-updated 但 Graph 还显示
 * 旧数据的问题(之前必须手动点 ↻)。
 * teardown 解除监听,避免 component unmount 后 timer / listener 泄漏。
 *
 * 缓存:zustand 内存,App 生命周期内只 load 一次(除非 invalidated → reload)。
 */

import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import type { GraphEntry } from "./types";
import { apiListGraph } from "../../lib/overridesApi";

interface GraphState {
  entries: GraphEntry[] | null;
  loading: boolean;
  error: string | null;
  /** v0.8.12 G: 收到 sessions-updated 后置 true,下次 reload 前清 */
  invalidated: boolean;
  load: () => Promise<void>;
  reload: () => Promise<void>;
  /** v0.8.12 G: 注册 sessions-updated 监听,debounce 200ms 后 reload; 返回 unlisten */
  listen_sessions_updated: () => Promise<() => void>;
  /** v0.8.12 G: 解除 listen + 清 debounce timer,component unmount 时调 */
  teardown: () => void;
}

// v0.8.12 G: module-singleton state, 多个 G1/G2/G3 mount 共享同一 listen 句柄
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let unlistenFn: (() => void) | null = null;
const DEBOUNCE_MS = 200;

export const useGraphStore = create<GraphState>((set, get) => ({
  entries: null,
  loading: false,
  error: null,
  invalidated: false,
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
      set({ entries: data as GraphEntry[], loading: false, invalidated: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },
  listen_sessions_updated: async () => {
    // v0.8.12 G: 防重复 register — 已 listen 过直接返 unlisten (singleton 模式)
    if (unlistenFn) {
      return unlistenFn;
    }
    const unlisten = await listen("sessions-updated", () => {
      // 标记 invalidated,让上层 UI 知道"数据可能过期"
      set({ invalidated: true });
      // 200ms debounce — sync_loop 一次跑完会发 N 个 sessions-updated (per sub-system),
      // debounce 让 reload 只跑 1 次,避免 IPC 风暴
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        // 已加载过才 reload;fresh state 还没 entries 时不主动触发(让 load 走首加载路径)
        if (get().entries !== null) {
          void get().reload();
        }
      }, DEBOUNCE_MS);
    });
    unlistenFn = unlisten;
    return unlisten;
  },
  teardown: () => {
    if (unlistenFn) {
      unlistenFn();
      unlistenFn = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  },
}));
