/**
 * v0.8.0 overridesStore — 用户视角状态
 *
 * 涵盖 rename/hide/pin/archive/notes/tags/links 全部 override 维度。
 *
 * 设计:
 * - zustand store 持有 OverrideSnapshot
 * - App.tsx mount 时 refresh + listen "overrides-changed"
 * - 所有写操作 invoke 后端 → 后端 emit "overrides-changed" → store refresh
 * - 写操作不做 optimistic update(写少读多,简单一致;若体验有问题再加)
 *
 * titleStore 兼容层:
 * - getTitle(sessionId, fallback) 优先 snap.renames,fallback legacy localStorage
 * - setTitle 走 snap 写路径 + mirror 一份到 localStorage 作 fallback
 */

import { useEffect } from "react";
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";

import * as api from "../lib/overridesApi";
import type { OverrideSnapshot, Tag, Link } from "../lib/overridesApi";

const LEGACY_LOCALSTORAGE_KEY = "ocsv.titles.legacy.v1";

function loadLegacyTitles(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LEGACY_LOCALSTORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed && (parsed as any).v === 1) {
      return (parsed as any).m || {};
    }
  } catch {
    // ignore
  }
  return {};
}

function saveLegacyTitles(m: Record<string, string>) {
  try {
    localStorage.setItem(LEGACY_LOCALSTORAGE_KEY, JSON.stringify({ v: 1, m }));
  } catch {
    // ignore quota / privacy
  }
}

interface OverridesState {
  snap: OverrideSnapshot;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  rename: (sid: string, newTitle: string) => Promise<void>;
  toggleHide: (sid: string, hidden: boolean) => Promise<void>;
  togglePinned: (sid: string, pinned: boolean) => Promise<void>;
  setArchived: (sid: string, archived: boolean) => Promise<void>;
  setNotes: (sid: string, notes: string) => Promise<void>;
  createTag: (name: string, color?: string) => Promise<Tag>;
  deleteTag: (tagId: number) => Promise<void>;
  setSessionTags: (sid: string, tagIds: number[]) => Promise<void>;
  addLink: (from: string, to: string, note?: string) => Promise<void>;
  removeLink: (from: string, to: string) => Promise<void>;
  /** 业务 API:按 sessionId 拿 display_title,snap 优先,fallback legacy */
  getTitle: (sid: string, fallback: string) => string;
  /** 业务 API:写 display_title,DB + legacy mirror */
  setTitle: (sid: string, title: string) => Promise<void>;
  hasOverride: (sid: string) => boolean;
}

const emptySnap: OverrideSnapshot = {
  renames: {},
  hidden: {},
  pinned: {},
  archived: {},
  notes: {},
  tags: {},
  tagsAll: [],
  linksTo: {},
  linksFrom: {},
};

export const useOverrides = create<OverridesState>((set, get) => ({
  snap: emptySnap,
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const snap = await api.apiListOverrides();
      set({ snap, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  rename: async (sid, newTitle) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    await api.apiRenameSession(sid, trimmed);
    // 后端 emit overrides-changed,bridge 会 refresh。这里也 mirror 到 legacy 作 fallback
    const legacy = loadLegacyTitles();
    legacy[sid] = trimmed;
    saveLegacyTitles(legacy);
    await get().refresh();
  },

  toggleHide: async (sid, hidden) => {
    await api.apiHideSession(sid, hidden);
    await get().refresh();
  },

  togglePinned: async (sid, pinned) => {
    await api.apiSetPinned(sid, pinned);
    await get().refresh();
  },

  setArchived: async (sid, archived) => {
    await api.apiSetArchived(sid, archived);
    await get().refresh();
  },

  setNotes: async (sid, notes) => {
    await api.apiSetNotes(sid, notes);
    await get().refresh();
  },

  createTag: async (name, color) => {
    const t = await api.apiCreateTag(name, color);
    await get().refresh();
    return t;
  },

  deleteTag: async (tagId) => {
    await api.apiDeleteTag(tagId);
    await get().refresh();
  },

  setSessionTags: async (sid, tagIds) => {
    await api.apiSetSessionTags(sid, tagIds);
    await get().refresh();
  },

  addLink: async (from, to, note) => {
    await api.apiAddSessionLink(from, to, note);
    await get().refresh();
  },

  removeLink: async (from, to) => {
    await api.apiRemoveSessionLink(from, to);
    await get().refresh();
  },

  getTitle: (sid, fallback) => {
    const { snap } = get();
    return snap.renames[sid] ?? loadLegacyTitles()[sid] ?? fallback;
  },

  setTitle: async (sid, title) => {
    await get().rename(sid, title);
  },

  hasOverride: (sid) => {
    const { snap } = get();
    return Boolean(snap.renames[sid] || snap.hidden[sid] || snap.pinned[sid] || snap.archived[sid]);
  },
}));

/**
 * App.tsx mount 时调一次,把 overrides-changed 事件桥接到 store.refresh
 */
export function useOverridesBridge() {
  const refresh = useOverrides((s) => s.refresh);
  useEffect(() => {
    void refresh();
    let unlisten: (() => void) | null = null;
    listen("overrides-changed", () => {
      void refresh();
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, [refresh]);
}
