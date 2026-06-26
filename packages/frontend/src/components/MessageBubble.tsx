import { useTranslation } from "react-i18next";
import { Bot, User, Wrench, Settings, FileText } from "lucide-react";

import { ThinkingBlock } from "./ThinkingBlock";
import { ToolUseCard } from "./ToolUseCard";
import { ToolResultCard } from "./ToolResultCard";
import { UnknownBlockCard } from "./UnknownBlockCard";
import { SubagentMetaBlock } from "./SubagentMetaBlock";
import { Markdown } from "./Markdown";
import type { TranscriptEntryOut, NormalizedBlockFE } from "../lib/api";
import { formatTimeExact } from "../lib/format";
import { useFormatOpts } from "../hooks/useFormatOpts";
import "./MessageBubble.css";

interface Props {
  entry: TranscriptEntryOut;
}

export function MessageBubble({ entry }: Props) {
  const { t } = useTranslation();
  const fmtOpts = useFormatOpts();
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
          // v0.4.1: 子代理专属字段(mode / permission / title / last-prompt)
          // 走可折叠 SubagentMetaBlock,默认折叠,不挤主流程
          if (isSubagentMetaLabel(String(labelValue))) {
            return <SubagentMetaBlock key={i} block={b} />;
          }
          // v0.4.1: 已知 meta label (file-history-snapshot / agent_listing_delta /
          // skill_listing / plan_mode / task_reminder / pr-link / agent_name /
          // file_snapshot / agent_listing) 走 MetaBlockRenderer 拿到专属好看样式
          // 注意:这些 block 在 meta 分支里 kind="meta",label 才是具体类型
          if (isKnownMetaLabel(String(labelValue))) {
            return <MetaBlockRenderer key={i} block={b} label={String(labelValue)} />;
          }
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
            <span className="msg-time" title={formatTimeExact(msg.timestamp, fmtOpts)}>
              {formatTimeExact(msg.timestamp, fmtOpts)}
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

export function BlockRenderer({ block }: { block: NormalizedBlockFE }) {
  const kind = block.kind as string;
  // v0.4.1: meta 类的 7 个 kind(后端 kind="meta",label=具体类型)统一走 MetaBlockRenderer
  // 避免落到默认 UnknownBlockCard 兜底
  if (
    kind === "meta" ||
    kind === "agent_listing" ||
    kind === "skill_listing" ||
    kind === "plan_mode" ||
    kind === "file_snapshot" ||
    kind === "pr_link" ||
    kind === "agent_name" ||
    kind === "task_reminder"
  ) {
    return <MetaBlockRenderer block={block} label={String(block.label ?? kind)} />;
  }
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

/**
 * v0.4.1: 共享的 meta 块渲染器
 *
 * 同一份样式服务两个入口:
 * 1. BlockRenderer 里 `kind` 已经是 agent_listing / skill_listing 等具体类型
 *    (后端把字段直接平铺到 NormalizedBlock.data)
 * 2. meta 分支里 `kind="meta"`(来自 Claude parser 的 attachment 类型,
 *    `label = attachment.type`,`payload = 整个 attachment 对象`)
 *
 * 关键:meta 分支里数据是包在 payload 里的(`block.payload.names`),所以
 * 必须先从 payload 解包,再 fallback 到顶层平铺字段(给 BlockRenderer 入口用)。
 *
 * 支持的 label / kind:
 * - agent_listing / agent_listing_delta
 * - skill_listing
 * - plan_mode
 * - file_snapshot / file-history-snapshot
 * - pr_link / pr-link
 * - agent_name
 * - task_reminder
 */
export function MetaBlockRenderer({ block, label }: { block: NormalizedBlockFE; label: string }) {
  // 解包:meta 分支里字段都在 payload 里,顶层平铺的为 BlockRenderer 入口用
  const payload = (block.payload ?? block) as Record<string, unknown>;
  const get = (key: string): unknown => payload[key] ?? block[key];

  switch (label) {
    case "agent_listing":
    case "agent_listing_delta": {
      const added = (get("addedTypes") as string[]) ?? [];
      const removed = (get("removedTypes") as string[]) ?? [];
      const isInitial = Boolean(get("isInitial"));
      return (
        <div className="block-meta-info">
          <span className="meta-kind-badge">🤖 agent</span>
          {isInitial ? <span>初始化 {added.length} 个 agent</span> : null}
          {!isInitial && added.length > 0 && <span>+{added.length} agent</span>}
          {!isInitial && removed.length > 0 && <span>-{removed.length} agent</span>}
          <details className="meta-details">
            <summary>详情</summary>
            {added.length > 0 && (
              <div className="meta-list">
                <strong>新增:</strong> {added.join(", ")}
              </div>
            )}
            {removed.length > 0 && (
              <div className="meta-list">
                <strong>移除:</strong> {removed.join(", ")}
              </div>
            )}
          </details>
        </div>
      );
    }
    case "skill_listing": {
      const names = (get("names") as string[]) ?? [];
      const count = Number(get("skillCount") ?? names.length);
      return (
        <div className="block-meta-info">
          <span className="meta-kind-badge">🛠 skill</span>
          <span>{count} 个 skill</span>
          <details className="meta-details">
            <summary>查看列表</summary>
            <div className="meta-list">
              {names.map((s: string) => (
                <span key={s} className="meta-tag">
                  {s}
                </span>
              ))}
            </div>
          </details>
        </div>
      );
    }
    case "plan_mode": {
      const planFile = String(get("planFilePath") ?? "");
      const hasPlan = Boolean(get("planExists"));
      const reminder = String(get("reminderType") ?? "");
      return (
        <div className="block-meta-info">
          <span className="meta-kind-badge">📋 plan_mode</span>
          <span>{hasPlan ? "有活动计划" : "无计划"}</span>
          {reminder && <span>· {reminder}</span>}
          {planFile && (
            <details className="meta-details">
              <summary>路径</summary>
              <code className="meta-path">{planFile}</code>
            </details>
          )}
        </div>
      );
    }
    case "file_snapshot":
    case "file-history-snapshot": {
      // snapshot.trackedFileBackups 才是真正的文件数组
      const backups = (get("trackedFileBackups") as Record<string, unknown>) ?? {};
      const fileCount = Object.keys(backups).length;
      const mid = String(get("messageId") ?? "");
      return (
        <div className="block-meta-info">
          <span className="meta-kind-badge">📁 file_snapshot</span>
          <span>{fileCount} 个跟踪文件</span>
          {mid && <span className="meta-sub">msg: {mid.slice(0, 8)}…</span>}
        </div>
      );
    }
    case "pr_link":
    case "pr-link": {
      const prNum = Number(get("prNumber") ?? 0);
      const repo = String(get("prRepository") ?? "");
      const url = String(get("prUrl") ?? "");
      const text = repo ? `${repo}#${prNum}` : `PR #${prNum}`;
      return (
        <div className="block-meta-info">
          <span className="meta-kind-badge">🔗 pr_link</span>
          {url ? (
            <a className="meta-link" href={url} target="_blank" rel="noreferrer">
              {text}
            </a>
          ) : (
            <span>{text}</span>
          )}
        </div>
      );
    }
    case "agent_name": {
      const name = String(get("agentName") ?? "");
      return (
        <div className="block-meta-info">
          <span className="meta-kind-badge">🏷 agent_name</span>
          <span>{name || "(未命名)"}</span>
        </div>
      );
    }
    case "task_reminder": {
      const itemCount = Number(get("itemCount") ?? 0);
      const pending = Number(get("pendingCount") ?? 0);
      const inProgress = Number(get("inProgressCount") ?? 0);
      const completed = Number(get("completedCount") ?? 0);
      const content = (get("content") as Array<Record<string, unknown>>) ?? [];
      return (
        <div className="block-meta-info">
          <span className="meta-kind-badge">📝 task_reminder</span>
          <span>
            {pending} 待办 · {inProgress} 进行 · {completed} 完成
          </span>
          <details className="meta-details">
            <summary>{itemCount} 个 task</summary>
            <div className="meta-task-list">
              {content.map((t, i) => {
                const status = String(t.status ?? "pending");
                const subj = String(t.subject ?? `Task ${i + 1}`);
                const id = String(t.id ?? "");
                return (
                  <div key={id || i} className={`meta-task-row meta-task-${status}`}>
                    <span className="meta-task-status">{status}</span>
                    <span className="meta-task-subject">{subj}</span>
                  </div>
                );
              })}
            </div>
          </details>
        </div>
      );
    }
    default:
      return <UnknownBlockCard block={block} />;
  }
}

/** v0.4.1: 识别子代理专属元数据 label */
function isSubagentMetaLabel(label: string): boolean {
  return (
    label.startsWith("mode:") ||
    label.startsWith("permission:") ||
    label === "title" ||
    label === "last-prompt"
  );
}

/** v0.4.1: meta 分支里已知有专属样式的 block label(复用 BlockRenderer) */
function isKnownMetaLabel(label: string): boolean {
  return (
    label === "file-history-snapshot" ||
    label === "agent_listing_delta" ||
    label === "skill_listing" ||
    label === "plan_mode" ||
    label === "task_reminder" ||
    label === "pr-link" ||
    label === "agent_name" ||
    label === "agent_listing" ||
    label === "file_snapshot"
  );
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
