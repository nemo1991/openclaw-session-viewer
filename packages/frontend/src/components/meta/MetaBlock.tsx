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
 * - agent_name / agent-name
 * - task_reminder
 *
 * 从 MessageBubble.tsx 抽出后,该组件被两个调用点共用:
 * - MessageBubble 里 meta 分支直接渲染
 * - blocks/ 目录下的 MetaBlockBlock(若需要)走 BlockRenderer 入口
 *
 * 因此 `payload = block.payload ?? block` 这条 fallback 必须保留。
 */

import type { NormalizedBlockFE } from "../../lib/api";
import { UnknownBlockCard } from "../UnknownBlockCard";

export interface MetaBlockProps {
  block: NormalizedBlockFE;
  label: string;
}

export function MetaBlock({ block, label }: MetaBlockProps) {
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
    case "agent_name":
    case "agent-name": {
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
