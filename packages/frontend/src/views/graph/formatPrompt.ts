/**
 * first_prompt 解析工具
 *
 * 处理 3 种噪音模式 (本地数据观察结果):
 * 1. `<command-message>init</command-message>\n<command-name>/init</command-name>` → "/init"
 * 2. `<local-command-caveat>Caveat: ...` → "[local command]" (整段跳过,无价值)
 * 3. 正常文本 — 原样返回
 *
 * 解析后用做:
 * - 标题(原 first_prompt 截 60 字符 → 解析后截)
 * - GraphDetailPanel 的首问展示
 * - RAG 召回的 query 源(直接用解析后的更精确)
 */

const COMMAND_MESSAGE_RE =
  /<command-message>([\s\S]*?)<\/command-message>\s*<command-name>([\s\S]*?)<\/command-name>/;
const LOCAL_COMMAND_RE = /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g;

export interface ParsedPrompt {
  /** 干净的、可读的首问文本(命令消息提取命令名,local 命令标记为占位) */
  clean: string;
  /** 解析出的命令名(e.g. "init"/"drawio"),仅 command-message 模式;否则 null */
  commandName: string | null;
  /** 是否是 local 命令(噪音) */
  isLocalCommand: boolean;
}

export function parseFirstPrompt(raw: string | null | undefined): ParsedPrompt {
  if (!raw) return { clean: "", commandName: null, isLocalCommand: false };
  const trimmed = raw.trim();
  // 1. local-command-caveat — 整段是机器噪音
  if (LOCAL_COMMAND_RE.test(trimmed) || trimmed.startsWith("<local-command-caveat>")) {
    return { clean: "", commandName: null, isLocalCommand: true };
  }
  // 2. command-message / command-name 配对
  const m = COMMAND_MESSAGE_RE.exec(trimmed);
  if (m) {
    const cmdName = (m[2] || "").trim();
    // 命令名常带斜杠(/init、/drawio)— 规范化:保留下划线和斜杠
    const normalized = cmdName.startsWith("/") ? cmdName : `/${cmdName}`;
    return { clean: normalized, commandName: cmdName, isLocalCommand: false };
  }
  // 3. 正常文本
  return { clean: trimmed, commandName: null, isLocalCommand: false };
}

/** 计算 session 持续时间(人类可读)— 从 first 到 last */
export function formatDuration(
  firstMs: number | null | undefined,
  lastMs: number | null | undefined
): string {
  if (!firstMs || !lastMs) return "—";
  const deltaMs = lastMs - firstMs;
  if (deltaMs < 0) return "—";
  const min = Math.floor(deltaMs / 60_000);
  if (min < 1) return "<1 分钟";
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时 ${min % 60} 分`;
  const day = Math.floor(hr / 24);
  return `${day} 天 ${hr % 24} 小时`;
}

/** 与全图其它 session 对比 — 返回"超过中位数 X%" */
export function vsMedianPct(
  value: number | null | undefined,
  median: number
): { pct: number; label: string } | null {
  if (value == null || median <= 0) return null;
  if (value === 0) return { pct: 0, label: "(0)" };
  const pct = Math.round(((value - median) / median) * 100);
  const sign = pct > 0 ? "+" : "";
  return { pct, label: `(${sign}${pct}% vs median)` };
}
