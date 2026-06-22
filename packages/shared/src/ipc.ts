/**
 * Tauri IPC 命令契约 — 前端和后端共享
 */

import type { SessionMeta, TranscriptEntry } from "./normalize.js";

/** 实时 PID 元数据 (来自 ~/.claude/sessions/<pid>.json) */
export interface LivePidMeta {
  pid: number;
  sessionId: string;
  cwd: string;
  status: string;
  startedAt: number;
  version?: string;
  waitingFor?: string;
}

/** 子代理元数据 */
export interface SubagentMeta {
  agentId: string;
  jsonlPath: string;
  metaPath: string;
  meta?: {
    agentType?: string;
    description?: string;
    toolUseId?: string;
    [k: string]: unknown;
  };
}

/** 搜索结果 */
export interface SearchHit {
  sessionPath: string;
  sessionId: string;
  index: number;
  byteOffset: number;
  snippet: string;
  /** 在 transcript 中的字符位置 */
  charOffset?: number;
}

/** 跨会话搜索结果 */
export interface GlobalSearchHit {
  meta: SessionMeta;
  hit: SearchHit;
}

/** 工具溢出文件 */
export interface SpilloverFile {
  path: string;
  sizeBytes: number;
  content: string;
}

/** 应用设置 */
export interface AnthropicConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface AppSettings {
  anthropic: AnthropicConfig;
  theme: "dark" | "light" | "system";
  uiLanguage: "zh-CN" | "en-US";
  defaultExportDir?: string;
}

/** 分析范围 */
export interface AnalyzeRange {
  fromIndex?: number;
  toIndex?: number;
  /** 仅用户消息 */
  onlyUser?: boolean;
}

/** 分析模板 */
export type AnalysisTemplate = "summary" | "code-changes" | "errors" | "custom";

/** 分析流式响应 */
export type AnalyzeChunk =
  | { kind: "delta"; text: string }
  | { kind: "done"; totalInputTokens?: number; totalOutputTokens?: number }
  | { kind: "error"; message: string };

/** Tauri 命令完整列表 */
export interface IpcApi {
  // ---- 会话列表 ----
  list_sessions(): Promise<SessionMeta[]>;
  get_session_meta(path: string): Promise<SessionMeta>;
  refresh_sessions(): Promise<SessionMeta[]>;

  // ---- 转录 ----
  stream_transcript(path: string): AsyncIterable<TranscriptEntry>;
  count_entries(path: string): Promise<number>;

  // ---- 子代理 ----
  list_subagents(sessionDir: string): Promise<SubagentMeta[]>;

  // ---- 工具溢出 ----
  get_tool_result_file(path: string): Promise<SpilloverFile>;

  // ---- 实时 ----
  list_live_pids(): Promise<LivePidMeta[]>;

  // ---- 搜索 ----
  search_session(args: { path: string; query: string }): AsyncIterable<SearchHit>;
  search_all(args: { query: string }): AsyncIterable<GlobalSearchHit>;

  // ---- 导出 ----
  export_markdown(args: { path: string; outPath: string }): Promise<void>;
  export_html(args: { path: string; outPath: string }): Promise<void>;

  // ---- 大模型分析 ----
  analyze_session(args: {
    path: string;
    template: AnalysisTemplate;
    customPrompt?: string;
    range: AnalyzeRange;
  }): AsyncIterable<AnalyzeChunk>;

  // ---- 设置 ----
  get_settings(): Promise<AppSettings>;
  save_settings(s: AppSettings): Promise<void>;

  // ---- 文件系统 ----
  pick_export_dir(): Promise<string | null>;
  reveal_in_finder(path: string): Promise<void>;
}

/** 默认设置 */
export const DEFAULT_SETTINGS: AppSettings = {
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    apiKey: "",
    model: "claude-sonnet-4-6",
    maxTokens: 4096,
  },
  theme: "dark",
  uiLanguage: "zh-CN",
};
