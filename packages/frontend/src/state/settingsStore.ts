/**
 * 设置 store
 */

import { create } from "zustand";
import { DEFAULT_SETTINGS, type AppSettings } from "@ocsv/shared";
import { apiGetSettings, apiSaveSettings } from "../lib/api";

interface SettingsStore {
  settings: AppSettings;
  loaded: boolean;
  load: () => Promise<void>;
  save: (s: AppSettings) => Promise<void>;
  update: (partial: Partial<AppSettings>) => void;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  load: async () => {
    try {
      const s = await apiGetSettings();
      set({ settings: s, loaded: true });
    } catch (e) {
      console.warn("加载设置失败,使用默认:", e);
      set({ loaded: true });
    }
  },
  save: async (s) => {
    await apiSaveSettings(s);
    set({ settings: s });
  },
  update: (partial) => {
    const next = { ...get().settings, ...partial };
    if (partial.anthropic) {
      next.anthropic = { ...get().settings.anthropic, ...partial.anthropic };
    }
    set({ settings: next });
  },
}));
