/**
 * 子代理会话专属元数据块折叠组件
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
 * v0.6.0:
 * - last-prompt 字段错配 (字段是 lastPrompt, 不是 prompt)
 * - leafUuid 跳到 user message
 * - mode / permission 值进 chip,配色区分 plan/bypass/normal/...
 */

import { useCallback, useState } from "react";
import { Bot, FileText, ExternalLink, Copy, Check } from "lucide-react";
import type { NormalizedBlockFE } from "../lib/api";
import { useTranscriptStore } from "../state/transcriptStore";

interface Props {
  block: NormalizedBlockFE;
}

type BadgeKind = "mode" | "permission" | "title" | "last-prompt";

interface Parsed {
  icon: typeof Bot;
  badge: BadgeKind;
  /** 折叠 summary 上显示的主文本(比如 "mode: normal") */
  summary: string;
  /** 展开后显示的内容,string 直接展示,object 走 JSON.stringify */
  detail: string;
  /** v0.6.0: 修饰 — mode/permission 单独渲染成彩色 chip,而不是整个 summary */
  modeValue?: string;
  /** v0.6.0: 可选 leafUuid — last-prompt 跳到对应 user message */
  leafUuid?: string;
  /** v0.6.0: prompt 长度,long 时给提示 */
  detailLength?: number;
}

/**
 * mode/permission 值配色:plan → 蓝,bypass → 红, accept-edits/normal → 灰
 * 实测 ~/.claude/projects/.../*.jsonl 大多数是 normal,plan/bypass 是少数"危险" 状态需要眼睛看到
 */
function chipTone(value: string): "danger" | "plan" | "neutral" {
  const v = value.toLowerCase();
  if (v.includes("bypass")) return "danger";
  if (v === "plan" || v.includes("plan")) return "plan";
  return "neutral";
}

function parse(block: NormalizedBlockFE): Parsed | null {
  const label = String(block.label ?? "");
  const payload = block.payload;

  // mode / permission 标签形如 "mode: normal" / "permission: plan"
  // parser 没有 payload,完整 label 已足够 ("mode: <value>")
  if (label.startsWith("mode:") || label.startsWith("permission:")) {
    const isMode = label.startsWith("mode:");
    const kind: BadgeKind = isMode ? "mode" : "permission";
    const value = label.slice(label.indexOf(":") + 1).trim() || "(空)";
    return {
      icon: isMode ? Bot : Bot,
      badge: kind,
      summary: isMode ? `mode` : `permission`,
      modeValue: value,
      detail: value,
    };
  }

  // title 来自 ai-title / custom-title,label="title",payload 是 title 字符串
  if (label === "title") {
    const titleText = typeof payload === "string" ? payload : "";
    return {
      icon: FileText,
      badge: "title",
      summary: titleText || "(空标题)",
      detail: titleText,
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
    const hasPrompt = promptText.length > 0;
    return {
      icon: FileText,
      badge: "last-prompt",
      // summary 上带 "[长 N]" 标识,提示用户展开看全文
      summary: hasPrompt
        ? promptText.length > 60
          ? `${promptText.slice(0, 60)}… (+${promptText.length - 60})`
          : promptText
        : "(无内容)",
      detail: promptText || "(无内容)",
      leafUuid: typeof leafUuid === "string" ? leafUuid : undefined,
      detailLength: promptText.length,
    };
  }

  return null;
}

/** mode/permission 的 value chip,带配色 (plan/bypass/normal 不同色) */
function ModeChip({ value }: { value: string }) {
  const tone = chipTone(value);
  return (
    <span
      className={`subagent-meta-value subagent-meta-value-${tone}`}
      data-tone={tone}
      title={`值: ${value}`}
    >
      {value}
    </span>
  );
}

/** title 拷贝按钮:点了之后显示 ✓ 2s,便于用户拿长 title */
function CopyableText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.warn("copy 失败:", e);
    }
  }, [text]);
  return (
    <button
      type="button"
      className="subagent-meta-copy-btn"
      data-testid="subagent-meta-copy"
      onClick={onCopy}
      title="复制 title"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? "已复制" : "复制"}
    </button>
  );
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
        {parsed.modeValue ? (
          <>
            <span className="subagent-meta-text">:</span>
            <ModeChip value={parsed.modeValue} />
          </>
        ) : (
          <span className="subagent-meta-text">{parsed.summary}</span>
        )}
        {/* last-prompt 长度标识:展开前就知道 prompt 多长 */}
        {parsed.detailLength !== undefined && parsed.detailLength > 100 && (
          <span
            className="subagent-meta-tag subagent-meta-tag-length"
            title={`prompt 全文 ${parsed.detailLength} 字`}
          >
            长 {parsed.detailLength}
          </span>
        )}
        {/* 跳按钮直接放 summary 上 — 不用展开 details 也能跳 */}
        {parsed.leafUuid && <SummaryJumpProbe leafUuid={parsed.leafUuid} />}
        <span className="subagent-meta-chevron">▸</span>
      </summary>
      <pre className="subagent-meta-detail">{parsed.detail}</pre>
      {parsed.badge === "title" && parsed.detail && <CopyableText text={parsed.detail} />}
      {parsed.leafUuid && <LeafJumpButton leafUuid={parsed.leafUuid} />}
    </details>
  );
}

/**
 * v0.6.0: 在 summary 上显示一个小 "→" 提示, 提示用户 "这里有跳按钮 (看下边)"
 * 真按钮在 details 内, 这里只显示图标态的 quick-jump button (matched 直接跳, 也允许
 * 用户不展开 details 就跳 — 用户报 "last-prompt 显示不全" 说想直接能用)
 */
function SummaryJumpProbe({ leafUuid }: { leafUuid: string }) {
  const entries = useTranscriptStore((s) => s.entries);
  const jumpTo = useTranscriptStore((s) => s.jumpTo);
  const matched = entries.find((e) => e.normalized?.id === leafUuid);
  const matchedIdx = matched?.index ?? -1;
  const shortId = leafUuid.slice(0, 8);

  const handleClick = useCallback(
    (ev: React.MouseEvent) => {
      // 阻止触发 details 的 toggle
      ev.preventDefault();
      ev.stopPropagation();
      if (matchedIdx < 0) {
        console.warn(`[last-prompt] leafUuid ${shortId}... 不在 transcript 范围`, { leafUuid });
        return;
      }
      jumpTo(matchedIdx);
    },
    [matchedIdx, shortId, leafUuid, jumpTo]
  );

  return (
    <button
      type="button"
      className={`subagent-meta-summary-jump${matchedIdx < 0 ? " subagent-meta-summary-jump-disabled" : ""}`}
      data-testid="last-prompt-summary-jump"
      data-state={matchedIdx >= 0 ? "ready" : "disabled"}
      onClick={handleClick}
      title={
        matchedIdx >= 0
          ? `跳到 uuid=${shortId}... (entry #${matchedIdx})`
          : `uuid=${shortId}... 不在当前 transcript 范围`
      }
    >
      <ExternalLink size={10} />
    </button>
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
