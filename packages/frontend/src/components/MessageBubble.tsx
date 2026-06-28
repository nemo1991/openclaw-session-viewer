/**
 * MessageBubble — Container 角色
 *
 * 拆分历程(v0.4.5):
 * - role 派发(user / assistant / meta / 系统):本文件
 * - block 派发(text / thinking / tool_use / ...):delegate 到 blocks/*Block.tsx
 * - meta label 派发(7 种已知 label):delegate 到 meta/MetaBlock.tsx
 * - header(TZ/lang 依赖):delegate 到 MessageHeader.tsx(memo 包裹)
 *
 * 设计要点:
 * - 本组件用 React.memo 包裹,entries 数量变化但单个 entry 引用未变时跳过重渲染
 * - BLOCK_RENDERERS 用 useMemo 稳定 map 引用
 * - meta 分支直接走 MetaBlock,block 分支走 BlockRenderer
 */

import { memo } from "react";
import { FileText } from "lucide-react";

import type { NormalizedBlockFE, TranscriptEntryOut } from "../lib/api";
import { MessageHeader } from "./MessageHeader";
import { SubagentMetaBlock } from "./SubagentMetaBlock";
import { UnknownBlockCard } from "./UnknownBlockCard";
import { MetaBlock } from "./meta/MetaBlock";
import { TextBlock } from "./blocks/TextBlock";
import { ThinkingBlockWrap } from "./blocks/ThinkingBlockWrap";
import { ToolUseBlock } from "./blocks/ToolUseBlock";
import { ToolResultBlock } from "./blocks/ToolResultBlock";
import { ImageBlock } from "./blocks/ImageBlock";
import { UnknownBlock } from "./blocks/UnknownBlock";
import "./MessageBubble.css";

interface Props {
  entry: TranscriptEntryOut;
  /** v0.5.0:主 session 的 jsonl 路径(透传到 ToolUseBlock → ToolUseCard → Agent 卡片定位子代理) */
  parentJsonlPath?: string;
  /** v0.5.0:主 session 的 sessionId */
  parentSessionId?: string;
}

function MessageBubbleInner({ entry, parentJsonlPath, parentSessionId }: Props) {
  const msg = entry.normalized;

  // meta 类消息:不渲染大卡片,渲染小标签
  if (msg.role === "meta") {
    return (
      <div className="msg-meta-line">
        {msg.blocks.map((b, i) => {
          const labelValue = b.label ?? b.kind;
          const labelStr = String(labelValue);
          // 子代理专属字段
          if (isSubagentMetaLabel(labelStr)) {
            return <SubagentMetaBlock key={i} block={b} />;
          }
          // 已知 meta label → MetaBlock 专属样式
          if (isKnownMetaLabel(labelStr)) {
            return <MetaBlock key={i} block={b} label={labelStr} />;
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
              {labelStr}
            </span>
          );
        })}
      </div>
    );
  }

  return (
    <div className={`msg msg-${msg.role}`}>
      <MessageHeader
        role={msg.role}
        model={msg.model}
        timestamp={msg.timestamp}
        tokenUsage={msg.tokenUsage}
      />
      <div className="msg-body">
        {msg.blocks.map((block, i) => (
          <BlockRenderer
            key={i}
            block={block}
            parentJsonlPath={parentJsonlPath}
            parentSessionId={parentSessionId}
          />
        ))}
      </div>
    </div>
  );
}

export const MessageBubble = memo(MessageBubbleInner);

/**
 * BlockRenderer — 单 block 派发
 *
 * 1. meta 类的 7 个 kind(后端 kind="meta",label=具体类型)走 MetaBlock
 * 2. 已知 5 种 block kind 走 blocks/*Block
 * 3. 兜底 UnknownBlock(走 UnknownBlockCard)
 */
export function BlockRenderer({
  block,
  parentJsonlPath,
  parentSessionId,
}: {
  block: NormalizedBlockFE;
  parentJsonlPath?: string;
  parentSessionId?: string;
}) {
  const kind = block.kind as string;

  // meta 类 kind 统一走 MetaBlock
  if (isMetaKind(kind)) {
    return <MetaBlock block={block} label={String(block.label ?? kind)} />;
  }

  switch (kind) {
    case "text":
      return <TextBlock block={block} />;
    case "thinking":
      return <ThinkingBlockWrap block={block} />;
    case "tool_use":
      return (
        <ToolUseBlock
          block={block}
          parentJsonlPath={parentJsonlPath}
          parentSessionId={parentSessionId}
        />
      );
    case "tool_result":
      return <ToolResultBlock block={block} />;
    case "image":
      return <ImageBlock block={block} />;
    default:
      return <UnknownBlock block={block} />;
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

/** v0.4.1: meta 分支里已知有专属样式的 block label */
function isKnownMetaLabel(label: string): boolean {
  return (
    label === "file-history-snapshot" ||
    label === "agent_listing_delta" ||
    label === "skill_listing" ||
    label === "plan_mode" ||
    label === "task_reminder" ||
    label === "pr-link" ||
    label === "agent_name" ||
    label === "agent-name" ||
    label === "agent_listing" ||
    label === "file_snapshot"
  );
}

/** v0.4.1: BlockRenderer meta 入口要识别的 kind(顶层 kind 形式) */
function isMetaKind(kind: string): boolean {
  return (
    kind === "meta" ||
    kind === "agent_listing" ||
    kind === "skill_listing" ||
    kind === "plan_mode" ||
    kind === "file_snapshot" ||
    kind === "pr_link" ||
    kind === "agent_name" ||
    kind === "task_reminder"
  );
}
