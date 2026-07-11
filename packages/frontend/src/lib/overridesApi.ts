/**
 * v0.8.0 override / tag / link / sync utilities API 包装
 *
 * 所有命令都改走 observer.db;前端 store 通过这些函数 + listen "overrides-changed"
 * 保持 UI 同步。
 */

import { invoke } from "@tauri-apps/api/core";

export interface OverrideSnapshot {
  renames: Record<string, string>;
  hidden: Record<string, true>;
  pinned: Record<string, true>;
  archived: Record<string, true>;
  notes: Record<string, string>;
  tags: Record<string, Tag[]>;
  tagsAll: Tag[];
  linksTo: Record<string, Link[]>;
  linksFrom: Record<string, Link[]>;
}

export interface Tag {
  id: number;
  name: string;
  color: string | null;
}

export interface Link {
  fromSession: string;
  toSession: string;
  note: string | null;
  createdAt: number;
}

export interface SyncStatus {
  lastRunAt: number | null;
  lastError: string | null;
  filesSeen: number;
  filesSynced: number;
  inProgress: boolean;
}

export interface SearchHistoryEntry {
  id: number;
  query: string;
  hitCount: number;
  ts: number;
}

// ===== Override commands =====

export const apiRenameSession = (sid: string, newTitle: string): Promise<void> =>
  invoke("rename_session", { sid, newTitle });
export const apiHideSession = (sid: string, hidden: boolean): Promise<void> =>
  invoke("hide_session", { sid, hidden });
export const apiSetPinned = (sid: string, pinned: boolean): Promise<void> =>
  invoke("set_pinned", { sid, pinned });
export const apiSetArchived = (sid: string, archived: boolean): Promise<void> =>
  invoke("set_archived", { sid, archived });
export const apiSetNotes = (sid: string, notes: string): Promise<void> =>
  invoke("set_notes", { sid, notes });
// v0.8.1: 撤销 display_title(DB rename)。注意:legacy titleStore 是另一个本地
// 存储,这里只清 DB;legacy mirror 保留兼容老路径。
export const apiRemoveRename = (sid: string): Promise<void> => invoke("remove_rename", { sid });
export const apiListOverrides = (): Promise<OverrideSnapshot> => invoke("list_overrides");

// ===== Tag commands =====

export const apiListTags = (): Promise<Tag[]> => invoke("list_tags");
export const apiCreateTag = (name: string, color?: string): Promise<Tag> =>
  invoke("create_tag", { name, color });
export const apiDeleteTag = (tagId: number): Promise<void> => invoke("delete_tag", { tagId });
export const apiSetSessionTags = (sid: string, tagIds: number[]): Promise<void> =>
  invoke("set_session_tags", { sid, tagIds });

// ===== Link commands =====

export const apiAddSessionLink = (from: string, to: string, note?: string): Promise<void> =>
  invoke("add_session_link", { from, to, note });
export const apiRemoveSessionLink = (from: string, to: string): Promise<void> =>
  invoke("remove_session_link", { from, to });
export const apiListSessionLinks = (sid: string): Promise<Link[]> =>
  invoke("list_session_links", { sid });

// ===== Sync utilities =====

export const apiGetSyncStatus = (): Promise<SyncStatus> => invoke("get_sync_status");
export const apiGetDbPath = (): Promise<string> => invoke("get_db_path"); // v0.8.4 item 1
export const apiRebuildDb = (): Promise<void> => invoke("rebuild_db");

// ===== v0.8.5 B: 全局 tool 聚合 =====
export interface ToolAggregateRow {
  toolName: string;
  totalCalls: number;
  sessionCount: number;
  errorCount: number;
  errorRate: number;
  firstSeenMs: number | null;
  lastSeenMs: number | null;
}
export interface ToolSessionRef {
  sessionId: string;
  callCount: number;
  errorCount: number;
  lastTsMs: number | null;
}
export const apiGetToolAggregate = (
  sortBy?: "calls" | "sessions" | "errors",
  limit?: number
): Promise<ToolAggregateRow[]> => invoke("get_tool_aggregate", { sortBy, limit });
export const apiGetToolSessions = (toolName: string, limit?: number): Promise<ToolSessionRef[]> =>
  invoke("get_tool_sessions", { toolName, limit });
export const apiRebuildToolStats = (): Promise<void> => invoke("rebuild_tool_stats");

// ===== v0.8.5 C: G1/G2 NDJSON → DB 切换 =====
// 跟 packages/frontend/src/views/graph/types.ts::GraphEntry 兼容
// v0.8.5 C 只派生 UsedTool edges, 其它 edges (Spawned/ParentUuid/...) 留 v0.8.6+
export const apiListGraph = (): Promise<unknown[]> => invoke("list_graph");

// ===== Export/Import =====

// v0.8.6 D: include_private 控制 hidden/archived/notes 是否导出 (隐私保护,
// 默认 false = 不导出, debugging 时可选 true)
export const apiExportOverrides = (
  path: string,
  includePrivate: boolean = false
): Promise<number> => invoke("export_overrides", { path, includePrivate });
export const apiImportOverrides = (
  path: string,
  mode: "keepboth" | "overwrite" | "merge"
): Promise<number> => invoke("import_overrides", { path, mode });

// ===== Search history =====

export const apiRecordSearch = (query: string, hitCount: number): Promise<void> =>
  invoke("record_search", { query, hitCount });
export const apiListSearchHistory = (limit = 20): Promise<SearchHistoryEntry[]> =>
  invoke("list_search_history", { limit });
