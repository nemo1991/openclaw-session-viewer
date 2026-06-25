/**
 * Tauri 命令调用包装器
 * 所有 invoke 调用集中在这一层
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AppSettings, SearchHit, SessionMeta } from "@ocsv/shared";

// ===== 会话 =====
export const apiListSessions = (): Promise<SessionMeta[]> => invoke("list_sessions");

export const apiGetSessionMeta = (path: string): Promise<SessionMeta> =>
  invoke("get_session_meta", { path });

export const apiRefreshSessions = (): Promise<SessionMeta[]> => invoke("refresh_sessions");

// ===== 转录 =====
export const apiCountEntries = (path: string): Promise<number> => invoke("count_entries", { path });

/** 订阅流式转录批次 */
export function listenTranscriptBatches(
  onBatch: (batch: { startIndex: number; entries: TranscriptEntryOut[] }) => void,
  onDone: () => void
): Promise<UnlistenFn[]> {
  return Promise.all([
    listen<{ startIndex: number; entries: TranscriptEntryOut[] }>("transcript-batch", (e) =>
      onBatch(e.payload)
    ),
    listen("transcript-done", () => onDone()),
  ]).then((arr) => arr);
}

export interface TranscriptEntryOut {
  index: number;
  byteOffset: number;
  raw: unknown;
  normalized: NormalizedMessageFE;
}

export interface NormalizedMessageFE {
  id: string;
  role: string;
  timestamp?: string;
  blocks: NormalizedBlockFE[];
  model?: string;
  stopReason?: string | null;
  tokenUsage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  isSidechain?: boolean;
  subagentId?: string;
  parentUuid?: string | null;
  rawType: string;
}

export interface NormalizedBlockFE {
  kind: string;
  [k: string]: unknown;
}

// ===== 实时 PID =====
export const apiListLivePids = (): Promise<
  Array<{
    pid: number;
    sessionId: string;
    cwd: string;
    status: string;
    startedAt: number;
    version?: string;
    waitingFor?: string;
  }>
> => invoke("list_live_pids");

// ===== 子代理 =====
export const apiListSubagents = (
  sessionDir: string
): Promise<
  Array<{
    agentId: string;
    jsonlPath: string;
    metaPath: string;
    meta?: Record<string, unknown>;
  }>
> => invoke("list_subagents", { sessionDir });

// ===== 工具溢出 =====
export const apiGetToolResultFile = (
  path: string
): Promise<{
  path: string;
  sizeBytes: number;
  content: string;
}> => invoke("get_tool_result_file", { path });

// ===== 搜索 =====
export interface SearchHitOut {
  sessionPath: string;
  sessionId: string;
  index: number;
  byteOffset: number;
  snippet: string;
  charOffset: number;
}

export interface GlobalSearchHitOut {
  sessionPath: string;
  sessionId: string;
  projectKey: string;
  workspaceGuess?: string | null;
  source: string;
  title?: string | null;
  hit: SearchHitOut;
}

export function listenSearchSession(
  onHit: (hit: SearchHitOut) => void,
  onDone: () => void
): Promise<UnlistenFn[]> {
  return Promise.all([
    listen<SearchHitOut>("search-hit", (e) => onHit(e.payload)),
    listen("search-done", () => onDone()),
  ]).then((arr) => arr);
}

export function listenSearchAll(
  onHit: (hit: GlobalSearchHitOut) => void,
  onDone: () => void
): Promise<UnlistenFn[]> {
  return Promise.all([
    listen<GlobalSearchHitOut>("global-search-hit", (e) => onHit(e.payload)),
    listen("global-search-done", () => onDone()),
  ]).then((arr) => arr);
}

// ===== 导出 =====
export const apiExportMarkdown = (path: string, outPath: string): Promise<void> =>
  invoke("export_markdown", { path, outPath });
export const apiExportHtml = (path: string, outPath: string): Promise<void> =>
  invoke("export_html", { path, outPath });

// ===== 大模型分析 =====
export type AnalyzeEvent =
  | { kind: "delta"; text: string }
  | { kind: "done"; totalInputTokens?: number; totalOutputTokens?: number }
  | { kind: "error"; message: string };

export function listenAnalyze(
  onEvent: (e: AnalyzeEvent) => void,
  onDone: () => void
): Promise<UnlistenFn[]> {
  return Promise.all([
    listen<AnalyzeEvent>("analyze-event", (e) => onEvent(e.payload)),
    listen("analyze-done", () => onDone()),
  ]).then((arr) => arr);
}

export const apiCancelAnalyze = (): Promise<void> => invoke("cancel_analyze");

// ===== 设置 =====
export const apiGetSettings = (): Promise<AppSettings> => invoke("get_settings");
export const apiSaveSettings = (settings: AppSettings): Promise<void> =>
  invoke("save_settings", { settings });

// ===== 文件系统 =====
export const apiPickExportDir = (): Promise<string | null> => invoke("pick_export_dir");
export const apiRevealInFinder = (path: string): Promise<void> =>
  invoke("reveal_in_finder", { path });

// ===== Trajectory (OpenClaw) =====

export interface TrajectoryInfoOut {
  exists: boolean;
  path?: string;
  sizeBytes?: number;
  lineCount?: number;
}

export interface TrajectoryEventFE {
  /** 原始 seq (1-based) */
  seq: number;
  /** 事件类型,如 "session.started" */
  eventType: string;
  /** ISO 8601 时间戳 */
  ts: string;
  /** 事件特定 payload */
  data: unknown;
  /** envelope 透传字段(provider / modelId / entryId / parentEntryId 等) */
  [key: string]: unknown;
}

export const apiGetTrajectoryInfo = (path: string): Promise<TrajectoryInfoOut> =>
  invoke("get_trajectory_info", { path });

export const apiStreamTrajectory = (path: string): Promise<void> =>
  invoke("stream_trajectory", { path });

export function listenTrajectoryBatches(
  onBatch: (batch: { startIndex: number; events: TrajectoryEventFE[] }) => void,
  onDone: () => void
): Promise<UnlistenFn[]> {
  return Promise.all([
    listen<{ startIndex: number; events: TrajectoryEventFE[] }>("trajectory-batch", (e) =>
      onBatch(e.payload)
    ),
    listen("trajectory-done", () => onDone()),
  ]).then((arr) => arr);
}

// re-export for convenience
export type { AppSettings, SearchHit, SessionMeta };
