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
    agentType?: string;
    description?: string;
    messageCount?: number;
    firstTimestamp?: string;
    lastTimestamp?: string;
  }>
> => invoke("list_subagents", { sessionDir });

/** v0.5.0:便利 helper — 直接传 SessionMeta。
 *
 * ⚠️ 关键约定:后端 `list_subagents(session_dir)` 期望的是**父 session 目录**,
 * 内部会 `dir.join("subagents")`。
 * 而 SessionMeta.subagentDir 在后端 `build_claude_session_meta` 里被填成
 * `<sessionId>/subagents` (已带 subagents/ 后缀,见 sessions.rs:371-381),
 * 所以这里要去掉尾部的 "/subagents" 再传,否则后端会再 join 一次变成
 * "<sessionId>/subagents/subagents" — 必然不存在 → 返回 [] → panel 空。
 *
 * 修复 commit: feat(subagent): 修 apiListSubagentsByMeta 路径双 join — panel 显示 N 行
 */
export const apiListSubagentsByMeta = (meta: {
  subagentDir?: string | null;
}): Promise<
  Array<{
    agentId: string;
    jsonlPath: string;
    metaPath: string;
    meta?: Record<string, unknown>;
    agentType?: string;
    description?: string;
    messageCount?: number;
    firstTimestamp?: string;
    lastTimestamp?: string;
  }>
> => {
  if (!meta.subagentDir) return Promise.resolve([]);
  // 把 ".../<sessionId>/subagents" 变回 ".../<sessionId>"
  // (path 风格分隔,Windows 上前端的 path.sep 是 "/",Tauri 传来的是 "/")
  const parent = meta.subagentDir.replace(/\/subagents\/?$/, "");
  if (!parent || parent === meta.subagentDir) return Promise.resolve([]);
  return apiListSubagents(parent);
};

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

/**
 * 从 invoke error 对象提取可读消息。
 * Tauri 抛的错误通常有结构:`{ kind: "PathSecurity", message: "..." }`
 * 优先用 `message` 字段,避免 `String(obj)` 出 "[object Object]"。
 */
export function extractErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.kind === "string") {
      return typeof obj.message === "string" ? `${obj.kind}: ${obj.message}` : String(obj.kind);
    }
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}
