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
 */

import { Bot, FileText } from "lucide-react";
import type { NormalizedBlockFE } from "../lib/api";

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

  // last-prompt:label="last-prompt",payload 是 string(用户上一条 prompt 全文)
  if (label === "last-prompt") {
    return {
      icon: FileText,
      badge: "last-prompt",
      summary:
        typeof payload === "string"
          ? payload.length > 60
            ? payload.slice(0, 60) + "…"
            : payload
          : "(无内容)",
      detail: typeof payload === "string" ? payload : JSON.stringify(payload ?? "", null, 2),
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
    </details>
  );
}
