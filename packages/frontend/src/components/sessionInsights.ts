/**
 * sessionInsights — session 详情聚合 + 去噪工具
 *
 * 4 个纯函数,从 TranscriptEntryOut[] 派生:
 *
 * 1. summarizeSession(entries)
 *    → 工具使用分布(降序)、错误计数、thinking 数、turn 数、阶段提示
 *
 * 2. findRepeatRuns(entries, minCount=3)
 *    → 连续 N 次同 tool_use 的 run 列表
 *    用于"286 个连续 Bash"折叠成 "Bash × 286"
 *
 * 3. findIdleGaps(entries, thresholdMs)
 *    → 相邻 entry 之间 > 阈值的间隔
 *    用于"<IdleGap minutes=5>"标注
 *
 * 4. parseMessageText(text)
 *    → 解析 <command-message>X / <local-command-caveat> / <system-reminder>X
 *      跟 formatPrompt.parseFirstPrompt 一致的思路,扩展到任意 message text
 *
 * 设计目标:
 * - 纯函数,无 React 依赖,易测
 * - 复杂度 O(n) 单遍扫,跟 entries 数量线性(几百到几千 ok)
 * - 不改原 entries,只读派生
 */

import type { TranscriptEntryOut } from "../lib/api";

// ===== 1. summarizeSession =====

export interface SessionSummary {
  /** 工具使用分布,降序 */
  toolUsage: Array<{ tool: string; count: number }>;
  /** 错误数(从 stopReason === "error" 或 isMeta 推断) */
  errorCount: number;
  /** thinking 块数 */
  thinkingCount: number;
  /** 文本消息数(assistant + user + tool) */
  textMessageCount: number;
  /** subagent 调用次数(Spawned-style tool_use 简化为计数) */
  subagentCount: number;
  /** 粗略阶段提示:explore / implement / mixed / short */
  phaseHint: "explore" | "implement" | "mixed" | "short";
  /** 阶段详情(给 chip 显示用) */
  phaseDetail: string;
}

export function summarizeSession(entries: TranscriptEntryOut[]): SessionSummary {
  const toolCounts = new Map<string, number>();
  let errorCount = 0;
  let thinkingCount = 0;
  let textMessageCount = 0;
  let subagentCount = 0;

  for (const e of entries) {
    const msg = e.normalized;
    // 统计 message 角色
    if (msg.role === "user" || msg.role === "assistant" || msg.role === "tool") {
      textMessageCount += 1;
    }
    if (msg.stopReason === "error" || (msg as any).is_error) {
      errorCount += 1;
    }
    // 遍历 blocks
    for (const b of msg.blocks ?? []) {
      const k = b.kind;
      if (k === "thinking") {
        thinkingCount += 1;
      } else if (k === "tool_use") {
        const toolName = String((b as any).name ?? "?");
        toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
        // 简易 subagent 探测:工具名是 Agent / Task
        if (toolName === "Agent" || toolName === "Task") subagentCount += 1;
      }
    }
  }

  const toolUsage = Array.from(toolCounts.entries())
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);

  // 阶段提示:Read-heavy → explore;Edit-heavy → implement
  const readCount = toolCounts.get("Read") ?? 0;
  const writeCount = (toolCounts.get("Write") ?? 0) + (toolCounts.get("Edit") ?? 0);
  const totalFile = readCount + writeCount;
  let phaseHint: SessionSummary["phaseHint"] = "mixed";
  let phaseDetail = "";
  if (textMessageCount < 5) {
    phaseHint = "short";
    phaseDetail = "短 session";
  } else if (totalFile === 0) {
    phaseHint = "mixed";
    phaseDetail = "无文件操作";
  } else if (writeCount / totalFile >= 0.5) {
    phaseHint = "implement";
    phaseDetail = `${Math.round((writeCount / totalFile) * 100)}% 写操作`;
  } else if (readCount / totalFile >= 0.7) {
    phaseHint = "explore";
    phaseDetail = `${Math.round((readCount / totalFile) * 100)}% 读操作`;
  } else {
    phaseHint = "mixed";
    phaseDetail = `${Math.round((readCount / totalFile) * 100)}% 读 / ${Math.round((writeCount / totalFile) * 100)}% 写`;
  }

  return {
    toolUsage,
    errorCount,
    thinkingCount,
    textMessageCount,
    subagentCount,
    phaseHint,
    phaseDetail,
  };
}

// ===== 2. findRepeatRuns =====

export interface RepeatRun {
  tool: string;
  count: number;
  /** 起始 entry 在原 entries 里的 index(virtualizer 用) */
  startIndex: number;
  /** 结束 entry index(包含) */
  endIndex: number;
}

/**
 * 检测连续 N+ 个相同 tool_use 的 run
 *
 * 注意:这里只看相邻的 tool_use 块,允许中间穿插 user message(常见模式:user "继续" + bash + bash + bash)
 * 严格"完全相邻"太严,实际看到的是 user → tool → user → tool → tool → tool 这种也算"重复"
 */
export function findRepeatRuns(entries: TranscriptEntryOut[], minCount: number = 3): RepeatRun[] {
  const runs: RepeatRun[] = [];
  let currentTool: string | null = null;
  let currentStart = -1;
  let currentCount = 0;
  let lastEntryIndex = -1;

  const flush = (endIndex: number) => {
    if (currentTool && currentCount >= minCount) {
      runs.push({
        tool: currentTool,
        count: currentCount,
        startIndex: currentStart,
        endIndex,
      });
    }
    currentTool = null;
    currentCount = 0;
    currentStart = -1;
  };

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    const msg = e.normalized;
    // 只看 assistant message 的 tool_use(user message 里的 tool_result 不算"调用")
    if (msg.role !== "assistant") {
      flush(i - 1);
      continue;
    }
    let firstToolInEntry: string | null = null;
    for (const b of msg.blocks ?? []) {
      if (!b) continue;
      if (b.kind === "tool_use") {
        firstToolInEntry = String((b as any).name ?? "?");
        break;
      }
    }
    if (firstToolInEntry === null) {
      // 这条 entry 不是 tool_use
      flush(i - 1);
      continue;
    }
    if (firstToolInEntry === currentTool) {
      currentCount += 1;
    } else {
      // 切到新 tool(可能紧接也可能跳)
      flush(i - 1);
      currentTool = firstToolInEntry;
      currentCount = 1;
      currentStart = i;
    }
    lastEntryIndex = i;
  }
  flush(lastEntryIndex);
  return runs;
}

/** 给定 entry index,返回它属于哪个 repeat run(若没有则 null) */
export function findRunForEntry(runs: RepeatRun[], entryIndex: number): RepeatRun | null {
  for (const r of runs) {
    if (entryIndex >= r.startIndex && entryIndex <= r.endIndex) return r;
  }
  return null;
}

// ===== 3. findIdleGaps =====

export interface IdleGap {
  /** 间隔之前的 entry index */
  afterIndex: number;
  /** 间隔毫秒数 */
  durationMs: number;
}

/**
 * 检测相邻 entry 之间超过阈值的间隔
 * 阈值默认 5 分钟
 */
export function findIdleGaps(
  entries: TranscriptEntryOut[],
  thresholdMs: number = 5 * 60_000
): IdleGap[] {
  const gaps: IdleGap[] = [];
  for (let i = 1; i < entries.length; i++) {
    const prevE = entries[i - 1];
    const currE = entries[i];
    if (!prevE || !currE) continue;
    const prev = prevE.normalized.timestamp;
    const curr = currE.normalized.timestamp;
    if (!prev || !curr) continue;
    const prevMs = Date.parse(prev);
    const currMs = Date.parse(curr);
    if (isNaN(prevMs) || isNaN(currMs)) continue;
    const delta = currMs - prevMs;
    if (delta >= thresholdMs) {
      gaps.push({ afterIndex: i - 1, durationMs: delta });
    }
  }
  return gaps;
}

/** 人类可读间隔:"5 分钟" / "2 小时 15 分" / "3 天" */
export function formatIdleGap(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return min % 60 > 0 ? `${hr} 小时 ${min % 60} 分` : `${hr} 小时`;
  }
  const day = Math.floor(hr / 24);
  return hr % 24 > 0 ? `${day} 天 ${hr % 24} 小时` : `${day} 天`;
}

// ===== 4. parseMessageText =====

const COMMAND_MESSAGE_RE =
  /<command-message>([\s\S]*?)<\/command-message>\s*<command-name>([\s\S]*?)<\/command-name>/;
const LOCAL_COMMAND_RE = /<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g;
const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

export interface ParsedText {
  clean: string;
  commandName: string | null;
  isLocalCommand: boolean;
  hasSystemReminder: boolean;
  /** 原始文本里 system-reminder 的次数(用于标注) */
  systemReminderCount: number;
}

/**
 * 清洗 message text,跟 formatPrompt.parseFirstPrompt 思路一致
 * - command-message → /cmdName
 * - local-command-caveat → 空(整段是机器噪音)
 * - system-reminder → 整段去掉,但在 parsed.hasSystemReminder 标记
 *   让 UI 可以加 "(N 个 system reminder 已折叠)" 提示
 */
export function parseMessageText(raw: string | null | undefined): ParsedText {
  if (!raw) return emptyParsed();
  const text = raw;

  // 1. local-command-caveat 整段是噪音
  if (LOCAL_COMMAND_RE.test(text) && !text.replace(LOCAL_COMMAND_RE, "").trim()) {
    return { ...emptyParsed(), isLocalCommand: true };
  }

  // 2. system-reminder 计数 + 移除
  const srMatches = text.match(SYSTEM_REMINDER_RE) ?? [];
  const systemReminderCount = srMatches.length;
  let cleaned = text.replace(SYSTEM_REMINDER_RE, "");

  // 3. command-message / command-name 配对
  const cm = COMMAND_MESSAGE_RE.exec(cleaned);
  let commandName: string | null = null;
  if (cm) {
    commandName = (cm[2] || "").trim();
    const normalized = commandName.startsWith("/") ? commandName : `/${commandName}`;
    // command-message 块替换成 normalized 字符串(去 system-reminder 后的)
    cleaned = cleaned.replace(COMMAND_MESSAGE_RE, normalized);
  }

  // 4. 折叠连续空白行
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim();

  return {
    clean: cleaned,
    commandName,
    isLocalCommand: false,
    hasSystemReminder: systemReminderCount > 0,
    systemReminderCount,
  };
}

function emptyParsed(): ParsedText {
  return {
    clean: "",
    commandName: null,
    isLocalCommand: false,
    hasSystemReminder: false,
    systemReminderCount: 0,
  };
}
