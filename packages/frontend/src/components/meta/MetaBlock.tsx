/**
 * 共享的 meta 块渲染器 (v0.6.0 增强版)
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
 * - plan_mode(带 reveal 入口)
 * - file_snapshot / file-history-snapshot(列出路径 + 可点击 reveal)
 * - pr_link / pr-link
 * - agent_name / agent-name
 * - task_reminder
 *
 * v0.6.0 增强:
 * - file_snapshot: 列出所有 trackedFileBackups 路径 + 可点击 reveal
 * - skill_listing: >6 个默认折叠,带计数
 * - plan_mode: 路径加 reveal 按钮 + reminderType 配色 (full/none)
 * - agent_listing: 显示 totalDelta 详细列表
 */

import { useFileReveal } from "../../hooks/useFileReveal";
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
      const totalLabel = isInitial
        ? `初始化 ${added.length} 个 agent`
        : added.length > 0 && removed.length > 0
          ? `+${added.length} / -${removed.length}`
          : added.length > 0
            ? `+${added.length} agent`
            : removed.length > 0
              ? `-${removed.length} agent`
              : "无变化";
      return (
        <div className="block-meta-info">
          <span className="meta-kind-badge">🤖 agent</span>
          <span className="meta-primary-text">{totalLabel}</span>
          {(added.length > 0 || removed.length > 0) && (
            <details className="meta-details">
              <summary>查看 agent 列表</summary>
              {added.length > 0 && (
                <div className="meta-section">
                  <strong className="meta-section-title">新增 ({added.length}):</strong>
                  <div className="meta-list">
                    {added.map((a) => (
                      <span key={a} className="meta-tag meta-tag-add">
                        + {a}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {removed.length > 0 && (
                <div className="meta-section">
                  <strong className="meta-section-title">移除 ({removed.length}):</strong>
                  <div className="meta-list">
                    {removed.map((a) => (
                      <span key={a} className="meta-tag meta-tag-remove">
                        − {a}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </details>
          )}
        </div>
      );
    }
    case "skill_listing": {
      const names = (get("names") as string[]) ?? [];
      const count = Number(get("skillCount") ?? names.length);
      // 大于 6 个 skill 默认折叠, 长列表不堆主时间线
      const longList = names.length > 6;
      return (
        <div className="block-meta-info">
          <span className="meta-kind-badge">🛠 skill</span>
          <span className="meta-primary-text">{count} 个 skill</span>
          {longList ? (
            <details className="meta-details">
              <summary>查看全部 {count} 个</summary>
              <div className="meta-list">
                {names.map((s: string) => (
                  <span key={s} className="meta-tag">
                    {s}
                  </span>
                ))}
              </div>
            </details>
          ) : (
            <div className="meta-list meta-list-inline">
              {names.map((s: string) => (
                <span key={s} className="meta-tag">
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    }
    case "plan_mode": {
      const planFile = String(get("planFilePath") ?? "");
      const hasPlan = Boolean(get("planExists"));
      const reminder = String(get("reminderType") ?? "");
      const isFull = reminder === "full";
      return (
        <div className="block-meta-info">
          <span className="meta-kind-badge">📋 plan_mode</span>
          <span className="meta-primary-text">{hasPlan ? "活动计划已存在" : "无活动计划"}</span>
          {reminder && (
            <span
              className={`meta-reminder-pill meta-reminder-${isFull ? "full" : reminder || "none"}`}
              title={isFull ? "完整计划提醒 (full)" : `提醒类型: ${reminder}`}
            >
              reminder: {reminder}
            </span>
          )}
          {planFile && <PlanFilePath path={planFile} />}
        </div>
      );
    }
    case "file_snapshot":
    case "file-history-snapshot": {
      // snapshot.trackedFileBackups 才是真正的文件数组
      const backups = (get("trackedFileBackups") as Record<string, unknown>) ?? {};
      const paths = Object.keys(backups);
      const fileCount = paths.length;
      const mid = String(get("messageId") ?? "");
      return (
        <div className="block-meta-info">
          <span className="meta-kind-badge">📁 file_snapshot</span>
          <span className="meta-primary-text">
            {fileCount > 0 ? `${fileCount} 个跟踪文件` : "空 snapshot (无文件)"}
          </span>
          {mid && <span className="meta-sub">msg: {mid.slice(0, 8)}…</span>}
          {fileCount > 0 && (
            <details className="meta-details">
              <summary>查看路径 ({fileCount})</summary>
              <ul className="meta-file-list">
                {paths.map((p) => (
                  <li key={p} className="meta-file-item">
                    <FilePathClickable path={p} />
                  </li>
                ))}
              </ul>
            </details>
          )}
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
          <span className="meta-primary-text">{name || "(未命名)"}</span>
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
          <span className="meta-primary-text">
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

/* v0.6.0: 内部子组件 — 路径点击 reveal, 复用 useFileReveal hook */
function FilePathClickable({ path }: { path: string }) {
  const { reveal } = useFileReveal();
  return (
    <span
      className="meta-path-clickable"
      data-testid="meta-file-path"
      onClick={() => reveal(path)}
      title={`在 Finder/Explorer 打开: ${path} (settings 安全沙箱)`}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          reveal(path);
        }
      }}
    >
      {path}
    </span>
  );
}

function PlanFilePath({ path }: { path: string }) {
  const { reveal } = useFileReveal();
  const fileName = path.split("/").pop() ?? path;
  return (
    <details className="meta-details meta-details-plan">
      <summary>📄 {fileName}</summary>
      <div className="meta-plan-path-row">
        <code className="meta-path">{path}</code>
        <button
          type="button"
          className="meta-reveal-btn"
          data-testid="plan-mode-reveal"
          onClick={() => reveal(path)}
          title={`在 Finder/Explorer 打开: ${path}`}
        >
          reveal
        </button>
      </div>
    </details>
  );
}
