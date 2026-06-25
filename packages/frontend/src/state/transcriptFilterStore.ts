/**
 * 会话详情时间筛选 store
 *
 * 在已加载的 transcript entries 上做客户端时间范围过滤。
 * 不需要后端,前提是 entries 已经全量在内存 (loadedCount === totalCount)。
 *
 * - `preset`: 快捷选择 (all / 1h / 24h / 7d / custom)
 * - `from` / `to`: ISO 8601 字符串,定义时间范围闭区间
 *
 * URL 持久化: SessionDetailRoute 解析 ?from=ISO&to=ISO 后调用 setRange。
 */

import { create } from "zustand";

export type FilterPreset = "all" | "1h" | "24h" | "7d" | "custom";

interface TranscriptFilterStore {
  preset: FilterPreset;
  /** ISO 8601 string, inclusive lower bound */
  from?: string;
  /** ISO 8601 string, inclusive upper bound */
  to?: string;

  /** 切换 preset (1h/24h/7d/all 时同步设置 from) */
  setPreset: (p: FilterPreset) => void;
  /** 直接设置 from/to (自定义模式) */
  setRange: (from?: string, to?: string) => void;
  /** 清空所有过滤 */
  clear: () => void;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function presetToRange(p: Exclude<FilterPreset, "all" | "custom">): {
  from: string;
} {
  const now = Date.now();
  let fromMs: number;
  switch (p) {
    case "1h":
      fromMs = now - HOUR_MS;
      break;
    case "24h":
      fromMs = now - DAY_MS;
      break;
    case "7d":
      fromMs = now - 7 * DAY_MS;
      break;
  }
  return { from: new Date(fromMs).toISOString() };
}

export const useTranscriptFilterStore = create<TranscriptFilterStore>((set, get) => ({
  preset: "all",
  from: undefined,
  to: undefined,

  setPreset: (p) => {
    if (p === "all") {
      set({ preset: "all", from: undefined, to: undefined });
    } else if (p === "custom") {
      // 切换到自定义时保留现有 from/to,让用户编辑
      set({ preset: "custom" });
    } else {
      // 1h / 24h / 7d: 计算 from,to 留 undefined (= now)
      const { from } = presetToRange(p);
      set({ preset: p, from, to: undefined });
    }
  },

  setRange: (from, to) => {
    const hasRange = Boolean(from || to);
    set({
      preset: hasRange ? "custom" : "all",
      from,
      to,
    });
  },

  clear: () => {
    set({ preset: "all", from: undefined, to: undefined });
  },
}));

/** 当前 store 是否实际生效 (preset !== "all" 或 from/to 设置) */
export function isFilterActive(s: TranscriptFilterStore): boolean {
  return s.preset !== "all" || Boolean(s.from || s.to);
}
