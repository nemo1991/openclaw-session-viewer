/**
 * v0.9.18: Meta layer accent palette token (集中化)
 *
 * 把所有 meta block 的 accent 配色集中到一个 token 表:
 * - 6 个 chart kind 各自独立 accent(沿用 v0.9.12-17)
 * - 13 个 attachment kind 统一 slate accent(新决策)
 * - event meta 默认 slate(预留扩展)
 *
 * 跟 `theme/tokens.css` 的 `--meta-accent-*` CSS variables 一一对应,
 * 后端 style 用 var(--meta-accent-X-border),React SVG / 内联 style 用
 * META_ACCENT.X.border。改一处颜色整套同步。
 *
 * 历史:
 * - v0.9.12: compaction=teal
 * - v0.9.13: tools_snapshot=indigo
 * - v0.9.14: usage.chart=amber
 * - v0.9.15: request.chart=violet
 * - v0.9.16: todos.chart=emerald
 * - v0.9.17: ai-title.chart=rose
 * - v0.9.18: 13 attachment kind 统一 slate (本文件)
 */

export interface MetaAccent {
  /** 左侧 3px border 颜色 */
  border: string;
  /** 浅色背景 (4% alpha) */
  bg: string;
  /** tag / badge 配色 (10% alpha 背景 + solid fg) */
  tagBg: string;
  tagFg: string;
  /** chart SVG stacked bar fill (alpha 0.7 + 1.0 两层) */
  barAlpha: string;
  barSolid: string;
  /** 显示用的 emoji + label(用于 legend / badge) */
  badge: string;
  /** 人类可读 label(用于 legend / meta-kind-badge) */
  displayName: string;
}

/**
 * 6 chart meta + 1 attachment + 1 eventMeta。Chart kind 用 label 字符串
 * 作 key;attachment / eventMeta 用 `*` 通配 label(任意 attachment kind)。
 */
export const META_ACCENT = {
  compaction: {
    border: "rgba(0, 181, 173, 0.6)",
    bg: "rgba(0, 181, 173, 0.04)",
    tagBg: "rgba(0, 181, 173, 0.1)",
    tagFg: "rgb(0, 131, 125)",
    barAlpha: "rgba(0, 181, 173, 0.7)",
    barSolid: "rgba(0, 181, 173, 1.0)",
    badge: "🗜",
    displayName: "compaction",
  },
  toolsSnapshot: {
    border: "rgba(99, 102, 241, 0.6)",
    bg: "rgba(99, 102, 241, 0.04)",
    tagBg: "rgba(99, 102, 241, 0.1)",
    tagFg: "rgb(67, 56, 202)",
    barAlpha: "rgba(99, 102, 241, 0.7)",
    barSolid: "rgba(99, 102, 241, 1.0)",
    badge: "🧰",
    displayName: "tools snapshot",
  },
  usageChart: {
    border: "rgba(245, 158, 11, 0.6)",
    bg: "rgba(245, 158, 11, 0.04)",
    tagBg: "rgba(245, 158, 11, 0.1)",
    tagFg: "rgb(180, 83, 9)",
    barAlpha: "rgba(245, 158, 11, 0.7)",
    barSolid: "rgba(245, 158, 11, 1.0)",
    badge: "💰",
    displayName: "usage chart",
  },
  requestChart: {
    border: "rgba(139, 92, 246, 0.6)",
    bg: "rgba(139, 92, 246, 0.04)",
    tagBg: "rgba(139, 92, 246, 0.1)",
    tagFg: "rgb(91, 33, 182)",
    barAlpha: "rgba(139, 92, 246, 0.35)",
    barSolid: "rgba(139, 92, 246, 0.95)",
    badge: "🧠",
    displayName: "request chart",
  },
  todoChart: {
    border: "rgba(16, 185, 129, 0.6)",
    bg: "rgba(16, 185, 129, 0.04)",
    tagBg: "rgba(16, 185, 129, 0.1)",
    tagFg: "rgb(6, 95, 70)",
    barAlpha: "rgba(16, 185, 129, 0.7)",
    barSolid: "rgba(16, 185, 129, 0.95)",
    badge: "✅",
    displayName: "todo chart",
  },
  aiTitleChart: {
    border: "rgba(244, 63, 94, 0.6)",
    bg: "rgba(244, 63, 94, 0.04)",
    tagBg: "rgba(244, 63, 94, 0.1)",
    tagFg: "rgb(159, 18, 57)",
    barAlpha: "rgba(244, 63, 94, 0.7)",
    barSolid: "rgba(244, 63, 94, 1.0)",
    badge: "📝",
    displayName: "ai-title chart",
  },
  /**
   * v0.9.18: 13 个 attachment kind (plan_mode / task_reminder / pr_link /
   * agent_name / agent_listing / skill_listing / file_snapshot /
   * invoked_skills / plan_file_reference / compact_file_reference /
   * attached_file / queued_command / queue_operation / file-history-snapshot)
   * 全部统一用 slate accent,作为一个"类别" 跟 6 chart 区分。
   */
  attachment: {
    border: "rgba(100, 116, 139, 0.6)",
    bg: "rgba(100, 116, 139, 0.04)",
    tagBg: "rgba(100, 116, 139, 0.1)",
    tagFg: "rgb(51, 65, 85)",
    barAlpha: "rgba(100, 116, 139, 0.4)",
    barSolid: "rgba(100, 116, 139, 0.95)",
    badge: "📎",
    displayName: "attachment",
  },
  /**
   * v0.9.18: 单事件 inline meta (Kimi metadata / config.update /
   * OpenClaw model_change / label / 等) 也归到 slate 类 — 跟
   * attachment 共享 slate,只是 accent 略弱(border 0.4 vs 0.6),
   * 让 chart / attachment / eventMeta 三层视觉上有梯度。
   */
  eventMeta: {
    border: "rgba(100, 116, 139, 0.4)",
    bg: "rgba(100, 116, 139, 0.03)",
    tagBg: "rgba(100, 116, 139, 0.08)",
    tagFg: "rgb(71, 85, 105)",
    barAlpha: "rgba(100, 116, 139, 0.3)",
    barSolid: "rgba(100, 116, 139, 0.7)",
    badge: "📄",
    displayName: "event meta",
  },
} as const satisfies Record<string, MetaAccent>;

export type MetaAccentKey = keyof typeof META_ACCENT;

/**
 * 6 chart meta block 的 label 集合(给 dispatcher 用)。Attachment /
 * eventMeta 是 catch-all 类别,不放在这里。
 */
export const CHART_META_LABELS: ReadonlySet<string> = new Set([
  "context.apply_compaction",
  "llm.tools_snapshot",
  "usage.chart",
  "request.chart",
  "todos.chart",
  "ai-title.chart",
]);

/**
 * v0.9.18: 13 个 attachment kind label 集合 — 走统一 slate accent 的
 * `attachment-block-meta` wrapper。所有 Claude attachment envelope 都
 * 落在这里,跟 6 chart 和单事件 inline meta 区分。
 */
export const ATTACHMENT_META_LABELS: ReadonlySet<string> = new Set([
  "agent_listing",
  "agent_listing_delta",
  "skill_listing",
  "plan_mode",
  "file_snapshot",
  "file-history-snapshot",
  "pr_link",
  "pr-link",
  "agent_name",
  "agent-name",
  "task_reminder",
  "invoked_skills",
  "plan_file_reference",
  "compact_file_reference",
  "attached_file",
  "queued_command",
  "queue_operation",
]);
