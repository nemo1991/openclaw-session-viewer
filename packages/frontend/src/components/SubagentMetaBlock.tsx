/**
 * 子代理会话专属元数据块 (v0.6.x)
 *
 * Claude sub-agent 会话专属字段:
 * - mode / permission-mode (chip 配色:plan/bypass/normal)
 * - ai-title / custom-title (label="title", payload=string,加拷贝按钮)
 * - last-prompt (label="last-prompt",payload={prompt, leafUuid?},上下结构:prompt 全文 + 跳按钮)
 *
 * v0.6.x 变更:
 * - 不再使用 <details> 折叠 — 用户报'已展开, 不需要折叠按钮'
 * - last-prompt 改上下结构:prompt 在上, 跳按钮在下 (合并成一个)
 * - 跳按钮保留 ready/disabled 视觉态 (未命中时灰)
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
  /** 主文本 (比如 "mode: normal" — 只 mode/permission 用) */
  summary: string;
  /** 主体内容 */
  detail: string;
  /** v0.6.0: mode/permission 单独渲染成彩色 chip */
  modeValue?: string;
  /** v0.6.0: 可选 leafUuid — last-prompt 跳到对应 user message */
  leafUuid?: string;
}

/**
 * mode/permission 值配色:plan → 蓝,bypass → 红, accept-edits/normal → 灰
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
  if (label.startsWith("mode:") || label.startsWith("permission:")) {
    const isMode = label.startsWith("mode:");
    const kind: BadgeKind = isMode ? "mode" : "permission";
    const value = label.slice(label.indexOf(":") + 1).trim() || "(空)";
    return {
      icon: Bot,
      badge: kind,
      summary: isMode ? `mode` : `permission`,
      modeValue: value,
      detail: value,
    };
  }

  if (label === "title") {
    const titleText = typeof payload === "string" ? payload : "";
    return {
      icon: FileText,
      badge: "title",
      summary: titleText || "(空标题)",
      detail: titleText,
    };
  }

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
      summary: "(无内容)",
      detail: promptText || "(无内容)",
      leafUuid: typeof leafUuid === "string" ? leafUuid : undefined,
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

/** title 拷贝按钮:点了之后显示 ✓ 2s */
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

/**
 * 单一跳按钮 (用户报: '只保留一个跳转按钮')
 * - 命中 → 蓝色 ready,可点
 * - 不命中 → 灰 disabled (保留 title 提示)
 * - 显示 leafUuid 前 8 字符 + entry index 让用户知道跳到哪
 */
function LeafJumpButton({ leafUuid }: { leafUuid: string }) {
  const entries = useTranscriptStore((s) => s.entries);
  const jumpTo = useTranscriptStore((s) => s.jumpTo);
  const matched = entries.find((e) => e.normalized?.id === leafUuid);
  const matchedIdx = matched?.index ?? -1;
  const shortId = leafUuid.slice(0, 8);

  const handleClick = useCallback(() => {
    if (matchedIdx < 0) {
      console.warn(`[last-prompt] leafUuid ${shortId}... 不在 transcript 范围`, { leafUuid });
      return;
    }
    jumpTo(matchedIdx);
  }, [matchedIdx, shortId, leafUuid, jumpTo]);

  const ready = matchedIdx >= 0;
  return (
    <button
      type="button"
      className={`subagent-meta-jump-btn${ready ? "" : " subagent-meta-jump-btn-disabled"}`}
      data-testid="last-prompt-jump"
      data-state={ready ? "ready" : "disabled"}
      onClick={handleClick}
      title={
        ready
          ? `跳到 uuid=${shortId}... 的消息 (entry #${matchedIdx})`
          : `uuid=${shortId}... 不在当前 transcript 范围`
      }
    >
      <ExternalLink size={11} />
      {ready ? `跳到 user message (${shortId}…)` : `目标不在范围 (${shortId}…)`}
    </button>
  );
}

export function SubagentMetaBlock({ block }: Props) {
  const parsed = parse(block);
  if (!parsed) {
    return (
      <div className="block-meta-info">
        <span className="meta-kind-badge">· meta</span>
        <span>{String(block.label ?? "")}</span>
      </div>
    );
  }

  const Icon = parsed.icon;

  // last-prompt 用上下结构 (user 报: 'last-prompt 改为上下结构')
  if (parsed.badge === "last-prompt") {
    return (
      <div className="block-meta-info subagent-meta-block subagent-meta-block-flat">
        <div className="subagent-meta-summary">
          <span className="meta-kind-badge subagent-meta-badge">
            <Icon size={11} /> {parsed.badge}
          </span>
          {/* summary 不显示文本,全部内容放下面 */}
          <span className="subagent-meta-tag" title="提示全文长度">
            {parsed.detail.length} 字
          </span>
        </div>
        <pre className="subagent-meta-detail">{parsed.detail}</pre>
        {parsed.leafUuid && (
          <div className="subagent-meta-action-row">
            <LeafJumpButton leafUuid={parsed.leafUuid} />
          </div>
        )}
      </div>
    );
  }

  // mode / permission: badge + chip, 单行
  if (parsed.modeValue !== undefined) {
    return (
      <div className="block-meta-info subagent-meta-block subagent-meta-block-flat">
        <div className="subagent-meta-summary">
          <span className="meta-kind-badge subagent-meta-badge">
            <Icon size={11} /> {parsed.badge}
          </span>
          <ModeChip value={parsed.modeValue} />
        </div>
      </div>
    );
  }

  // title: badge + 标题 + copy 按钮, 单行 + 拷贝按钮
  if (parsed.badge === "title") {
    return (
      <div className="block-meta-info subagent-meta-block subagent-meta-block-flat">
        <div className="subagent-meta-summary">
          <span className="meta-kind-badge subagent-meta-badge">
            <Icon size={11} /> {parsed.badge}
          </span>
          <span className="subagent-meta-text subagent-meta-text-title">{parsed.detail}</span>
          {parsed.detail && <CopyableText text={parsed.detail} />}
        </div>
      </div>
    );
  }

  // 兜底: 旧 schema (本不应该走到这)
  return (
    <div className="block-meta-info subagent-meta-block subagent-meta-block-flat">
      <div className="subagent-meta-summary">
        <span className="meta-kind-badge subagent-meta-badge">
          <Icon size={11} /> {parsed.badge}
        </span>
        <span className="subagent-meta-text">{parsed.summary}</span>
      </div>
    </div>
  );
}
