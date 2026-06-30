/**
 * v0.4.1: 子代理会话专属元数据块折叠组件
 *
 * Claude sub-agent 会话的 content 数组里会塞一些专属字段:
 * - mode (`mode: normal` / `plan` / `accept-edits` / `bypass-permissions`)
 * - permission-mode (`permission: plan` 等)
 * - ai-title / custom-title (`title`)
 * - last-prompt (`last-prompt`)
 *
 * 后端把它们归一化成 `kind: "meta"`,label 前缀分别为 "mode:" / "permission:" / "title" / "last-prompt"。
 *
 * 这里把它们识别出来,渲染成可折叠的"子代理元数据"块,默认折叠,点开看 value。
 *
 * v0.6.0: last-prompt 的 payload 结构从 `string` 改为 `{ prompt, leafUuid? }`
 *  - 真实数据字段是 `lastPrompt` (camelCase), 之前取 `record.prompt` 永远是 undefined
 *  - leafUuid 指向最后一条 user message (实测 5/5 命中), /resume 触发的恢复点
 *  - UI 显示 prompt 全文, 旁边 "跳到对话位置" 按钮用 leafUuid 跳
 */

import { Bot, FileText, ExternalLink } from "lucide-react";
import type { NormalizedBlockFE } from "../lib/api";
import { useTranscriptStore } from "../state/transcriptStore";

interface Props {
  block: NormalizedBlockFE;
}

interface Parsed {
  icon: typeof Bot;
  badge: string;
  /** 折叠 summary 上显示的主文本(比如 "mode: normal") */
  summary: string;
  /** 展开后显示的内容,string 直接展示,object 走 JSON.stringify */
  detail: string;
  /** v0.6.0: 可选 leafUuid — last-prompt 跳到对应 user message */
  leafUuid?: string;
}

function parse(block: NormalizedBlockFE): Parsed | null {
  const label = String(block.label ?? "");
  const payload = block.payload;

  // mode / permission 标签形如 "mode: normal" / "permission: plan"
  if (label.startsWith("mode:") || label.startsWith("permission:")) {
    return {
      icon: Bot,
      badge: (label.split(":")[0] ?? label).trim(),
      summary: label,
      detail:
        typeof payload === "string" && payload ? payload : JSON.stringify(payload ?? "", null, 2),
    };
  }

  // title 来自 ai-title / custom-title,label="title",payload 是 title 字符串
  if (label === "title") {
    return {
      icon: FileText,
      badge: "title",
      summary: typeof payload === "string" && payload ? payload : "(空标题)",
      detail: typeof payload === "string" ? payload : JSON.stringify(payload ?? "", null, 2),
    };
  }

  // v0.6.0: last-prompt 兼容新 schema { prompt, leafUuid? } + 旧 schema (裸 string)
  if (label === "last-prompt") {
    const promptText =
      typeof payload === "string"
        ? payload
        : typeof payload === "object" && payload !== null
          ? String((payload as { prompt?: unknown }).prompt ?? "")
          : "";
    const leafUuid =
      typeof payload === "object" && payload !== null
        ? (payload as { leafUuid?: unknown }).leafUuid
        : undefined;
    return {
      icon: FileText,
      badge: "last-prompt",
      summary: promptText
        ? promptText.length > 60
          ? promptText.slice(0, 60) + "…"
          : promptText
        : "(无内容)",
      detail: promptText || "(无内容)",
      leafUuid: typeof leafUuid === "string" ? leafUuid : undefined,
    };
  }

  return null;
}

export function SubagentMetaBlock({ block }: Props) {
  const parsed = parse(block);
  // 兜底:解析失败不应该走到这里,显示安全降级
  if (!parsed) {
    return (
      <div className="block-meta-info">
        <span className="meta-kind-badge">· meta</span>
        <span>{String(block.label ?? "")}</span>
      </div>
    );
  }

  const Icon = parsed.icon;

  return (
    <details className="block-meta-info subagent-meta-block">
      <summary className="subagent-meta-summary">
        <span className="meta-kind-badge subagent-meta-badge">
          <Icon size={11} /> {parsed.badge}
        </span>
        <span className="subagent-meta-text">{parsed.summary}</span>
        <span className="subagent-meta-chevron">▸</span>
      </summary>
      <pre className="subagent-meta-detail">{parsed.detail}</pre>
      {parsed.leafUuid && <LeafJumpButton leafUuid={parsed.leafUuid} />}
    </details>
  );
}

/**
 * v0.6.0: last-prompt 跳到对应 user message 按钮
 * - 在 entries 里找 uuid 匹配的 entry
 * - 找到 → virtualizer.scrollToIndex(localIdx, { align: "center" })
 * - 找不到 → 提示 "目标消息不在当前 transcript 范围"
 */
function LeafJumpButton({ leafUuid }: { leafUuid: string }) {
  const entries = useTranscriptStore((s) => s.entries);
  const jumpTo = useTranscriptStore((s) => s.jumpTo);

  const shortId = leafUuid.slice(0, 8);
  const matchedEntry = entries.find((e) => e.normalized?.id === leafUuid);
  const matchedIdx = matchedEntry?.index ?? -1;

  const handleClick = () => {
    if (matchedIdx < 0) {
      // 找不到时给出明确提示, 不静默失败
      console.warn(
        `[last-prompt] leafUuid ${shortId}... 不在当前 transcript 范围 (${entries.length} 条)`,
        { leafUuid }
      );
      return;
    }
    // 通过 store.jumpTo 触发, TranscriptView 内的 useTranscriptScroll 监听滚动
    jumpTo(matchedIdx);
  };

  const matched = matchedIdx >= 0;
  return (
    <button
      type="button"
      className={`subagent-meta-jump-btn${matched ? "" : " subagent-meta-jump-btn-disabled"}`}
      data-testid="last-prompt-jump"
      data-state={matched ? "ready" : "disabled"}
      onClick={handleClick}
      title={
        matched
          ? `跳到 uuid=${shortId}... 的消息 (entry #${matchedIdx})`
          : `uuid=${shortId}... 不在当前 transcript 范围`
      }
    >
      <ExternalLink size={10} />{" "}
      {matched ? `跳到 user message (${shortId}…)` : `目标不在范围 (${shortId}…)`}
    </button>
  );
}
