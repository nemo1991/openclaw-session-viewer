/**
 * TextBlock — block kind === "text" 的 Presentational 包装
 *
 * 从 MessageBubble BlockRenderer (text arm) 抽出。
 *
 * 去噪(parseMessageText 来自 components/sessionInsights.ts):
 * - `<command-message>X</command-message><command-name>/Y</command-name>` → "/Y"
 * - `<local-command-caveat>...</local-command-caveat>` → 占位(local command 无首问)
 * - `<system-reminder>X</system-reminder>` 整段折叠,N 个合并成 "(N 个 system reminder 已折叠)"
 */

import { Markdown } from "../Markdown";
import type { NormalizedBlockFE } from "../../lib/api";
import { parseMessageText } from "../sessionInsights";

export interface TextBlockProps {
  block: NormalizedBlockFE;
}

export function TextBlock({ block }: TextBlockProps) {
  const raw = String(block.text ?? "");
  const parsed = parseMessageText(raw);

  // local command:整段是机器噪音 → 显示占位
  if (parsed.isLocalCommand) {
    return (
      <div className="block-text block-text-muted" data-testid="text-local-command">
        <em>local command 触发,无文本内容</em>
      </div>
    );
  }

  // 原始就是空白
  if (!parsed.clean) return null;

  return (
    <div className="block-text" data-testid="text-block">
      <Markdown text={parsed.clean} />
      {parsed.hasSystemReminder && (
        <div className="block-text-sr-note" title="<system-reminder> 已折叠">
          {parsed.systemReminderCount} 个 system reminder 已折叠
        </div>
      )}
    </div>
  );
}
