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
  // --- v0.5.0:list_subagents 命令新增详情字段 ---
  /** "Explore" / "Plan" / "general-purpose"(从 .meta.json 提取) */
  agentType?: string;
  /** 任务描述(从 .meta.json 提取) */
  description?: string;
  /** 子 agent 自身消息数(jsonl 头部扫描) */
  messageCount?: number;
  /** 首条消息 ISO timestamp */
  firstTimestamp?: string;
  /** 末条消息 ISO timestamp */
  lastTimestamp?: string;
  // --- v0.6.0:递归子代理层级(从 .meta.json 的 spawnDepth) ---
  /** 0 = 主 session 直接派出, 1+ = 递归深度 */
  spawnDepth?: number;
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

/** v0.2.5: 用户在 settings 里添加的额外数据根目录 */
export type CustomRootKind = "Claude" | "OpenClaw" | "Both";

export interface CustomRootConfig {
  /** 用户起的标签(如 "Downloads") */
  label: string;
  /** 绝对路径 */
  path: string;
  /** 自动探测出的类型 */
  kind: CustomRootKind;
}

export interface AppSettings {
  anthropic: AnthropicConfig;
  theme: "dark" | "light" | "system";
  uiLanguage: "zh-CN" | "en-US";
  defaultExportDir?: string;
  /** v0.2.5: 用户自定义的额外数据根目录 */
  customRoots?: CustomRootConfig[];
  /**
   * v0.4.2: 时区设置。"auto" = 跟随浏览器(Intl 自动检测);
   * 具体 IANA 名(如 "Asia/Shanghai" / "America/New_York")则用该 TZ 显示。
   */
  timezone?: string;
  // --- v0.6.0:文件路径 reveal 安全策略 ---
  /**
   * 文件路径 reveal (apiRevealInFinder) 时的安全策略:
   * - allowRelaxed: false (默认) → 路径必须在调用时传入的 workspaceRoot 子树内,
   *                            越界返回 Err
   * - allowRelaxed: true          → 放宽到"在任一已知 root 下"
   *                              (paths::assert_within_any_root 兜底防 ~/.ssh 等)
   * 用户设置开关"允许 reveal 到会话主目录"实际就是 allowRelaxed=true
   */
  pathSecurity?: {
    allowRelaxed: boolean;
  };
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
  /**
   * v0.6.0: reveal in Finder/Explorer 加 workspace 安全沙箱
   * @param path 要 reveal 的文件或目录
   * @param workspaceRoot 调用方的 workspaceGuess(null/缺失 = 不检查, 由 allowRelaxed 决定)
   * @param allowRelaxed 来自 settings.pathSecurity.allowRelaxed
   */
  reveal_in_finder(args: {
    path: string;
    workspaceRoot?: string | null;
    allowRelaxed?: boolean;
  }): Promise<void>;
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
  customRoots: [],
  timezone: "auto",
  // v0.6.0:文件路径 reveal 默认锁紧在 workspace 内
  pathSecurity: { allowRelaxed: false },
};
