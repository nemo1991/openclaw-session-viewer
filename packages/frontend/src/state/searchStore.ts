/**
 * 全局搜索 store
 */

import { create } from "zustand";
import { listenSearchAll, type GlobalSearchHitOut } from "../lib/api";
import { invoke } from "@tauri-apps/api/core";

interface SearchStore {
  open: boolean;
  query: string;
  hits: GlobalSearchHitOut[];
  searching: boolean;
  show: () => void;
  hide: () => void;
  setQuery: (q: string) => void;
  search: (q: string) => Promise<void>;
  clear: () => void;
}

export const useSearchStore = create<SearchStore>((set) => ({
  open: false,
  query: "",
  hits: [],
  searching: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false, hits: [], query: "" }),
  setQuery: (q) => set({ query: q }),
  clear: () => set({ hits: [], query: "" }),
  search: async (q: string) => {
    if (!q.trim()) {
      set({ hits: [], searching: false });
      return;
    }
    set({ query: q, hits: [], searching: true });

    const unlisteners = await listenSearchAll(
      (hit) => {
        set((s) => ({ hits: [...s.hits, hit] }));
      },
      () => {
        set({ searching: false });
      }
    );

    try {
      await invoke("search_all", { query: q });
    } catch (e) {
      console.error("search_all 失败:", e);
      set({ searching: false });
      unlisteners.forEach((u) => u());
    }
  },
}));
