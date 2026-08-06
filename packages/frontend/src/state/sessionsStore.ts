/**
 * 会话列表 store
 * v0.9.0: 加 "kimi" 作为第三种 source
 */

import { create } from "zustand";
import type { SessionMeta } from "@ocsv/shared";
import { apiListSessions, apiRefreshSessions, extractErrorMessage } from "../lib/api";

interface SessionsFilter {
  query: string;
  liveOnly: boolean;
  hasSubagents: boolean;
  last7Days: boolean;
  /** v0.9.0: 加 "kimi" 联合,跟 SessionSource union 对齐 */
  source: "claude" | "openclaw" | "kimi";
  /** 按 agentId 过滤(openclaw 多 agent / kimi 仅 "main");undefined 不过滤 */
  agentId?: string;
}

interface SessionsStore {
  sessions: SessionMeta[];
  loading: boolean;
  error: string | null;
  filter: SessionsFilter;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  setFilter: (f: Partial<SessionsFilter>) => void;
  filteredSessions: () => SessionMeta[];
  /** 当前 sessions 中出现的所有 agentId(去重) */
  availableAgentIds: () => string[];
}

export const useSessionsStore = create<SessionsStore>((set, get) => ({
  sessions: [],
  loading: false,
  error: null,
  filter: {
    query: "",
    liveOnly: false,
    hasSubagents: false,
    last7Days: false,
    source: "openclaw",
    agentId: undefined,
  },
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
  filteredSessions: () => {
    const { sessions, filter } = get();
    const q = filter.query.toLowerCase().trim();
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return sessions.filter((s) => {
      if (s.source !== filter.source) return false;
      // v0.9.0: agentId 过滤仍只对 openclaw 生效 (claude 无 agentId,kimi 永远 "main")。
      // 之前条件 `s.source === filter.source` 在 source=claude 时也命中,会拿 undefined 比 "main"
      // 把所有 claude session 过滤掉 — 回归到 "agentId 过滤只对 openclaw 生效" 旧契约。
      if (filter.agentId && filter.source === "openclaw" && s.agentId !== filter.agentId) return false;
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
    for (const s of get().sessions) {
      if (s.source === filter.source && s.agentId) seen.add(s.agentId);
    }
    return Array.from(seen).sort();
  },
}));
