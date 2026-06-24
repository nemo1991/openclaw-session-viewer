import { useTranslation } from "react-i18next";
import { Bot, User, Wrench, Settings, FileText } from "lucide-react";

import { ThinkingBlock } from "./ThinkingBlock";
import { ToolUseCard } from "./ToolUseCard";
import { ToolResultCard } from "./ToolResultCard";
import { UnknownBlockCard } from "./UnknownBlockCard";
import { Markdown } from "./Markdown";
import type { TranscriptEntryOut, NormalizedBlockFE } from "../lib/api";
import { formatTimeExact } from "../lib/format";
import "./MessageBubble.css";

interface Props {
  entry: TranscriptEntryOut;
}

export function MessageBubble({ entry }: Props) {
  const { t } = useTranslation();
  const msg = entry.normalized;
  const role = msg.role;
  const roleLabel = getRoleLabel(role, t);
  const RoleIcon = getRoleIcon(role);

  // meta 类消息:不渲染大卡片,渲染小标签(或 UnknownBlockCard)
  if (role === "meta") {
    return (
      <div className="msg-meta-line">
        {msg.blocks.map((b, i) => {
          const labelValue = b.label ?? b.kind;
          // 有 payload 且字段丰富时使用完整 UnknownBlockCard
          if (
            b.payload &&
            typeof b.payload === "object" &&
            Object.keys(b.payload as Record<string, unknown>).length > 0
          ) {
            return <UnknownBlockCard key={i} block={b} />;
          }
          return (
            <span key={i} className="msg-meta-pill">
              <FileText size={11} />
              {String(labelValue)}
            </span>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`msg msg-${role}`}>
      <div className="msg-header">
        <div className="msg-avatar">
          <RoleIcon size={14} />
        </div>
        <div className="msg-header-text">
          <span className="msg-role">{roleLabel}</span>
          {msg.model && <span className="msg-model">{msg.model}</span>}
          {msg.timestamp && (
            <span className="msg-time" title={formatTimeExact(msg.timestamp)}>
              {formatTimeExact(msg.timestamp)}
            </span>
          )}
        </div>
        {msg.tokenUsage && (
          <div className="msg-tokens">
            {fmtTokens(msg.tokenUsage.input)}/{fmtTokens(msg.tokenUsage.output)}
            {msg.tokenUsage.cacheRead > 0 && (
              <span className="msg-cache"> ⚡{fmtTokens(msg.tokenUsage.cacheRead)}</span>
            )}
          </div>
        )}
      </div>

      <div className="msg-body">
        {msg.blocks.map((block, i) => (
          <BlockRenderer key={i} block={block} />
        ))}
      </div>
    </div>
  );
}

function BlockRenderer({ block }: { block: NormalizedBlockFE }) {
  const kind = block.kind as string;
  switch (kind) {
    case "text":
      return (
        <div className="block-text">
          <Markdown text={String(block.text ?? "")} />
        </div>
      );
    case "thinking":
      return <ThinkingBlock text={String(block.thinking ?? block.text ?? "")} />;
    case "tool_use":
      return (
        <ToolUseCard
          id={String(block.id ?? "")}
          name={String(block.name ?? "?")}
          input={(block.input as Record<string, unknown>) ?? {}}
        />
      );
    case "tool_result":
      return (
        <ToolResultCard
          toolUseId={String(block.tool_use_id ?? "")}
          content={block.content}
          isError={Boolean(block.is_error)}
          filePath={block.filePath as string | undefined}
        />
      );
    case "image":
      return (
        <div className="block-image">
          <em>
            📷 图片 (data:{String(block.mediaType ?? "image/png")},{" "}
            {String(block.dataBase64 ?? "").length} 字符)
          </em>
        </div>
      );
    default:
      // 未知 kind:使用 UnknownBlockCard
      return <UnknownBlockCard block={block} />;
  }
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function getRoleLabel(role: string, t: (k: string) => string): string {
  switch (role) {
    case "user":
      return t("blocks.text") === "文本" ? "用户" : t("blocks.text");
    case "assistant":
      return "助手";
    case "tool":
      return "工具";
    case "system":
      return "系统";
    default:
      return role;
  }
}

function getRoleIcon(role: string) {
  switch (role) {
    case "user":
      return User;
    case "assistant":
      return Bot;
    case "tool":
      return Wrench;
    case "system":
      return Settings;
    default:
      return FileText;
  }
}
