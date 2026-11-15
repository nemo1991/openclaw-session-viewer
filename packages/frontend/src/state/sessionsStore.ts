/**
 * 会话列表 store
 * v0.9.0: 加 "kimi" 作为第三种 source
 * v0.12 (B1 / FR-F1, FR-F3): source 增加 "all" 并设为默认值(修复开箱只能看
 * openclaw 的硬伤),新增 resetFilter 供首页「重置筛选」一键归位。
 */

import { create } from "zustand";
import type { SessionMeta } from "@ocsv/shared";
import { apiListSessions, apiRefreshSessions, extractErrorMessage } from "../lib/api";

/** v0.12: "all" 表示不按 source 过滤,四源同屏 */
export type SourceFilter = "all" | "claude" | "openclaw" | "kimi" | "dsh";

export interface SessionsFilter {
  query: string;
  liveOnly: boolean;
  hasSubagents: boolean;
  last7Days: boolean;
  /** v0.9.28 (M11): 加 "dsh";v0.12 (FR-F1): 加 "all" 且成为默认值 */
  source: SourceFilter;
  /** 按 agentId 过滤(openclaw 多 agent / kimi 仅 "main");undefined 不过滤 */
  agentId?: string;
}

/** v0.12 (FR-F1/F3): 单一默认定义,create() 与 resetFilter() 共用,避免两处漂移 */
export const DEFAULT_SESSIONS_FILTER: SessionsFilter = {
  query: "",
  liveOnly: false,
  hasSubagents: false,
  last7Days: false,
  source: "all",
  agentId: undefined,
};

interface SessionsStore {
  sessions: SessionMeta[];
  loading: boolean;
  error: string | null;
  filter: SessionsFilter;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  setFilter: (f: Partial<SessionsFilter>) => void;
  /** v0.12 (FR-F3): 一键回到默认筛选视图 */
  resetFilter: () => void;
  filteredSessions: () => SessionMeta[];
  /** 当前 sessions 中出现的所有 agentId(去重) */
  availableAgentIds: () => string[];
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  sessions: [],
  loading: false,
  error: null,
  filter: { ...DEFAULT_SESSIONS_FILTER },
  load: async () => {
    set({ loading: true, error: null });
    try {
      const s = await apiListSessions();
      set({ sessions: s, loading: false });
    } catch (e) {
      set({ error: extractErrorMessage(e), loading: false });
    }
  },
  refresh: async () => {
    try {
      const s = await apiRefreshSessions();
      set({ sessions: s });
    } catch (e) {
      set({ error: extractErrorMessage(e) });
    }
  },
  setFilter: (f) => set({ filter: { ...get().filter, ...f } }),
  // 用新对象而非就地改,保证 zustand 触发订阅更新;组件侧另需重置
  // showHidden/showArchived 本地 state(见 SessionsRoute.handleResetFilter)。
  resetFilter: () => set({ filter: { ...DEFAULT_SESSIONS_FILTER } }),
  filteredSessions: () => {
    const { sessions, filter } = get();
    const q = filter.query.toLowerCase().trim();
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return sessions.filter((s) => {
      // v0.12 (FR-F1): "all" 跳过 source 过滤,四源同屏
      if (filter.source !== "all" && s.source !== filter.source) return false;
      // v0.9.0: agentId 过滤仍只对 openclaw 生效 (claude 无 agentId,kimi 永远 "main")。
      // 之前条件 `s.source === filter.source` 在 source=claude 时也命中,会拿 undefined 比 "main"
      // 把所有 claude session 过滤掉 — 回归到 "agentId 过滤只对 openclaw 生效" 旧契约。
      // "all" 下 availableAgentIds() 返回空,首页隐藏 agent 组,不会出现"选了没反应"。
      if (filter.agentId && filter.source === "openclaw" && s.agentId !== filter.agentId)
        return false;
      if (filter.liveOnly && !s.livePid) return false;
      if (filter.hasSubagents && !s.subagentDir) return false;
      if (filter.last7Days && s.mtimeMs < cutoff) return false;
      if (q) {
        const hay = [
          s.title ?? "",
          s.sessionId,
          s.projectKey,
          s.workspaceGuess ?? "",
          s.agentId ?? "",
          s.agentLabel ?? "",
          s.agentTarget ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  },
  availableAgentIds: () => {
    const seen = new Set<string>();
    const { filter } = get();
    // v0.9.0: 跟随当前 filter.source — openclaw 多 agent / kimi 永远 "main" / claude 无 agentId
    // SessionsRoute 用 agents.length > 1 决定是否渲染 agent 选择器,kimi 单 agent 自动隐藏。
    // v0.12: source="all" 时没有任何 s.source === "all",自然返回空 → 首页隐藏低频 agent 组;
    // 用户切到 openclaw 后该组自动出现,原有单 source 行为完全不变。
    for (const s of get().sessions) {
      if (s.source === filter.source && s.agentId) seen.add(s.agentId);
    }
    return Array.from(seen).sort();
  },
}));
