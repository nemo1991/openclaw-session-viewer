import { useTranslation } from "react-i18next";
import { Bot, User, Wrench, Settings, FileText } from "lucide-react";

import { ThinkingBlock } from "./ThinkingBlock";
import { ToolUseCard } from "./ToolUseCard";
import { ToolResultCard } from "./ToolResultCard";
import { Markdown } from "./Markdown";
import type { TranscriptEntryOut } from "../lib/api";
import { formatTimeExact } from "../lib/format";
import "./MessageBubble.css";

interface Props {
  entry: TranscriptEntryOut;
}

// v0.2.6 调查:全局错误捕获 — 抓"页面崩但 console 啥都没有"的诡异情况
window.addEventListener("error", (e) => {
  console.error("[WINDOW:error]", { msg: e.message, filename: e.filename, lineno: e.lineno });
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("[WINDOW:unhandledrejection]", { reason: e.reason });
});
const origConsoleError = console.error;
console.error = (...args: unknown[]) => {
  origConsoleError("[console.error]", ...args);
};

export function MessageBubble({ entry }: Props) {
  const { t } = useTranslation();
  const msg = entry.normalized;
  const role = msg.role;
  // v0.2.6 调查:这个 entry 长啥样
  console.log("[MessageBubble:render]", {
    id: msg.id,
    role,
    rawType: msg.rawType,
    blockCount: msg.blocks.length,
    blockKinds: msg.blocks.map((b) => b.kind),
  });
  const roleLabel = getRoleLabel(role, t);
  const RoleIcon = getRoleIcon(role);

  // meta 类消息:不渲染大卡片,只渲染小标签
  if (role === "meta") {
    return (
      <div className="msg-meta-line">
        {msg.blocks.map((b, i) => (
          <span key={i} className="msg-meta-pill">
            <FileText size={11} />
            {/* v0.2.6 调查:label 是对象时 String() 会变 [object Object] */}
            {(() => {
              const labelValue = b.label ?? b.kind;
              if (typeof labelValue !== "string") {
                console.warn("[MessageBubble:meta-label-not-string]", {
                  b,
                  typeofLabel: typeof b.label,
                  kind: b.kind,
                });
              }
              return String(labelValue);
            })()}
          </span>
        ))}
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

function BlockRenderer({ block }: { block: Record<string, unknown> }) {
  const kind = block.kind as string;
  switch (kind) {
    case "text": {
      // v0.2.6 调查:Windows 上 liushuyou/91d1796e 报 [object Object],
      // 怀疑 block.text 在 IPC 后变成对象。先 console.log 拿真实数据再修。
      console.log("[BlockRenderer:text]", {
        block,
        typeofText: typeof block.text,
        value: block.text,
      });
      return (
        <div className="block-text">
          <Markdown text={String(block.text ?? "")} />
        </div>
      );
    }
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
    default: {
      // v0.2.6 调查:未知 kind 打 console.warn 收集证据
      console.warn("[BlockRenderer:unknown]", { kind, block });
      return <div className="block-unknown">[{kind}]</div>;
    }
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
      return t("blocks.text") === "文本" ? "用户" : t("blocks.text"); // fallback
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
