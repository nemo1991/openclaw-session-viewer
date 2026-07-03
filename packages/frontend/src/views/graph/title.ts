/**
 * session 自动名生成 — 不调 LLM,启发式
 *
 * 优先 first_prompt 去前缀 + 截断,退化到 id 截断 + 关键指标。
 *
 * 设计:
 * - 8-30 字之间最舒服(< 6 太短看不出,> 36 截断)
 * - 优先 user 真正想问的事
 * - fallback 永远包含 token_total / subagent_count,用户即使第一眼也能识别规模
 */

import type { SessionNode } from "./types";
import { formatNum } from "./analytics";

const VERB_PREFIX =
  /^\s*(please|plz|帮我|帮我写|请|帮我做|help me|i need|let'?s|can you|could you|would you|hi|hello|hey)\s+/i;

const QUOTE_PREFIX = /^["'`]+|["'`]+$/g;

/** 自动生一个 8-30 字的简洁名 */
export function autoTitle(n: SessionNode): string {
  if (n.first_prompt) {
    let t = n.first_prompt.replace(QUOTE_PREFIX, "").trim();
    t = t.replace(VERB_PREFIX, "").trim();
    if (t.length >= 6) {
      if (t.length > 36) return t.slice(0, 34).trim() + "…";
      return t;
    }
  }
  // first_prompt 太短 / 缺失
  return `${n.session_id.slice(0, 6)} · ${n.subagent_count} sp · ${formatNum(n.token_total)} tok`;
}
