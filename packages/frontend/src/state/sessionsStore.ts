/**
 * 会话列表 store
 */

import { create } from "zustand";
import type { SessionMeta } from "@ocsv/shared";
import { apiListSessions, apiRefreshSessions } from "../lib/api";

interface SessionsFilter {
  query: string;
  liveOnly: boolean;
  hasSubagents: boolean;
  last7Days: boolean;
  source: "all" | "claude" | "openclaw";
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
    source: "all",
  },
  load: async () => {
    set({ loading: true, error: null });
    try {
      const s = await apiListSessions();
      set({ sessions: s, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },
  refresh: async () => {
    try {
      const s = await apiRefreshSessions();
      set({ sessions: s });
    } catch (e) {
      set({ error: String(e) });
    }
  },
  setFilter: (f) => set({ filter: { ...get().filter, ...f } }),
  filteredSessions: () => {
    const { sessions, filter } = get();
    const q = filter.query.toLowerCase().trim();
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return sessions.filter((s) => {
      if (filter.source !== "all" && s.source !== filter.source) return false;
      if (filter.liveOnly && !s.livePid) return false;
      if (filter.hasSubagents && !s.subagentDir) return false;
      if (filter.last7Days && s.mtimeMs < cutoff) return false;
      if (q) {
        const hay = [
          s.title ?? "",
          s.sessionId,
          s.projectKey,
          s.workspaceGuess ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  },
}));
