/**
 * MessageHeader — message bubble 的 header 子组件
 *
 * 设计:把 useFormatOpts / useTranslation 隔离在这个 memo 包裹的子组件里,
 * 这样 TZ / lang 切换时不会让每个 transcript entry 重新渲染,只有 header 自身
 * 重渲染一次。
 *
 * Props:role / model / timestamp / tokenUsage — 全都是 normalized message
 * 顶层字段,不在 block 派发链路里。
 */

import { memo } from "react";
import { useTranslation } from "react-i18next";
import { Bot, User, Wrench, Settings, FileText } from "lucide-react";

import { formatTimeExact } from "../lib/format";
import { useFormatOpts } from "../hooks/useFormatOpts";

export interface MessageHeaderProps {
  role: string;
  model?: string;
  timestamp?: string;
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function MessageHeaderInner({ role, model, timestamp, tokenUsage }: MessageHeaderProps) {
  const { t } = useTranslation();
  const fmtOpts = useFormatOpts();
  const roleLabel = getRoleLabel(role, t);
  const RoleIcon = getRoleIcon(role);

  return (
    <div className="msg-header">
      <div className="msg-avatar">
        <RoleIcon size={14} />
      </div>
      <div className="msg-header-text">
        <span className="msg-role">{roleLabel}</span>
        {model && <span className="msg-model">{model}</span>}
        {timestamp && (
          <span className="msg-time" title={formatTimeExact(timestamp, fmtOpts)}>
            {formatTimeExact(timestamp, fmtOpts)}
          </span>
        )}
      </div>
      {tokenUsage && (
        <div className="msg-tokens">
          {fmtTokens(tokenUsage.input)}/{fmtTokens(tokenUsage.output)}
          {tokenUsage.cacheRead > 0 && (
            <span className="msg-cache"> ⚡{fmtTokens(tokenUsage.cacheRead)}</span>
          )}
        </div>
      )}
    </div>
  );
}

export const MessageHeader = memo(MessageHeaderInner);

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
