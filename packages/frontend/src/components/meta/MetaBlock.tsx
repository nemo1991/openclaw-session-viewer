/**
 * 共享的 meta 块渲染器 (v0.6.x)
 *
 * 同一份样式服务两个入口:
 * 1. BlockRenderer 里 `kind` 已经是 agent_listing / skill_listing 等具体类型
 *    (后端把字段直接平铺到 NormalizedBlock.data)
 * 2. meta 分支里 `kind="meta"`(来自 Claude parser 的 attachment 类型,
 *    `label = attachment.type`,`payload = 整个 attachment 对象`)
 *
 * v0.6.x 变更 (用户报 '已展开, 不需要折叠按钮'):
 * - 移除了所有 <details> 折叠 — 默认全显示
 * - 长列表 (skill, file paths) 不再折叠 — meta-list-scrollable 加 max-height 滚动
 * - plan_mode reveal 失败不再静默 — 改用 revealAndNotify 拿错误, 内联红字显示
 * - task_reminder 关联字段渲染: description, activeForm, blocks, blockedBy,
 *   task id (跨 reminder 串联进度的 key)
 *
 * 支持的 label / kind:
 * - agent_listing / agent_listing_delta
 * - skill_listing (>6 滚动)
 * - plan_mode(带 reveal 入口 + 失败提示)
 * - file_snapshot / file-history-snapshot(列出路径 + 可点击 reveal + 失败提示)
 * - pr_link / pr-link
 * - agent_name / agent-name
 * - task_reminder (id / description / activeForm / blocks / blockedBy 关联)
 */

import { useState } from "react";
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
        <div className="block-meta-info meta-block-flat">
          <span className="meta-kind-badge">🤖 agent</span>
          <span className="meta-primary-text">{totalLabel}</span>
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
        </div>
      );
    }
    case "skill_listing": {
      const names = (get("names") as string[]) ?? [];
      const count = Number(get("skillCount") ?? names.length);
      return (
        <div className="block-meta-info meta-block-flat">
          <span className="meta-kind-badge">🛠 skill</span>
          <span className="meta-primary-text">{count} 个 skill</span>
          <div className="meta-list meta-list-scrollable" data-count={count}>
            {names.map((s: string) => (
              <span key={s} className="meta-tag" title={`skill: ${s}`}>
                {s}
              </span>
            ))}
          </div>
        </div>
      );
    }
    case "plan_mode": {
      const planFile = String(get("planFilePath") ?? "");
      const hasPlan = Boolean(get("planExists"));
      const reminder = String(get("reminderType") ?? "");
      const isFull = reminder === "full";
      return (
        <div className="block-meta-info meta-block-flat">
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
        <div className="block-meta-info meta-block-flat">
          <span className="meta-kind-badge">📁 file_snapshot</span>
          <span className="meta-primary-text">
            {fileCount > 0 ? `${fileCount} 个跟踪文件` : "空 snapshot (无文件)"}
          </span>
          {mid && <span className="meta-sub">msg: {mid.slice(0, 8)}…</span>}
          {fileCount > 0 && (
            <ul className="meta-file-list" data-count={fileCount}>
              {paths.map((p) => (
                <li key={p} className="meta-file-item">
                  <FilePathClickable path={p} />
                </li>
              ))}
            </ul>
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
        <div className="block-meta-info meta-block-flat">
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
        <div className="block-meta-info meta-block-flat">
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
        <div className="block-meta-info meta-block-flat">
          <span className="meta-kind-badge">📝 task_reminder</span>
          <span className="meta-primary-text">
            {pending} 待办 · {inProgress} 进行 · {completed} 完成 · 共 {itemCount} 个
          </span>
          {/* v0.6.x 关联字段研究 (用户报: 研究一下 task_reminder 的关联关系):
              - id (跨 reminder 串联同一 task 的进度轨迹, e.g. "4" 在多个 reminder 中
                    出现, status 从 pending → in_progress → completed)
              - description (TODO 详情, 之前 UI 完全不显示)
              - activeForm (Claude 当前正在做的动作)
              - blocks / blockedBy (跨 task DAG 依赖, 之前 UI 完全不显示)

              当前实现: 在每个 task 行下折叠显示 description + activeForm + blocks/blockedBy
              跨 reminder 索引(同 task id 进度轨迹聚合) 待 v0.7+ 引入 redb 时统一做 */}
          <div className="meta-task-list">
            {content.map((t, i) => {
              const status = String(t.status ?? "pending");
              const subj = String(t.subject ?? `Task ${i + 1}`);
              const id = String(t.id ?? "");
              const desc = String(t.description ?? "");
              const activeForm = String(t.activeForm ?? "");
              const blocks = (t.blocks as string[]) ?? [];
              const blockedBy = (t.blockedBy as string[]) ?? [];
              return (
                <div key={id || i} className={`meta-task-row meta-task-${status}`}>
                  <div className="meta-task-row-head">
                    {id && (
                      <span className="meta-task-id" title={`Task ID (跨 reminder 跟踪): ${id}`}>
                        #{id}
                      </span>
                    )}
                    <span className="meta-task-status">{status}</span>
                    <span className="meta-task-subject">{subj}</span>
                  </div>
                  {(desc || activeForm || blocks.length > 0 || blockedBy.length > 0) && (
                    <div className="meta-task-meta">
                      {activeForm && (
                        <div className="meta-task-activeform">
                          <span className="meta-task-activeform-label">正在做:</span>
                          {activeForm}
                        </div>
                      )}
                      {desc && (
                        <div className="meta-task-desc" title={desc}>
                          {desc.length > 120 ? `${desc.slice(0, 120)}…` : desc}
                        </div>
                      )}
                      {(blocks.length > 0 || blockedBy.length > 0) && (
                        <div className="meta-task-graph">
                          {blockedBy.length > 0 && (
                            <span className="meta-task-graph-row" title="被这些 task 阻塞">
                              <span className="meta-task-graph-label">等待:</span>
                              {blockedBy.map((b) => (
                                <span key={b} className="meta-task-ref">
                                  #{b}
                                </span>
                              ))}
                            </span>
                          )}
                          {blocks.length > 0 && (
                            <span className="meta-task-graph-row" title="阻塞这些 task">
                              <span className="meta-task-graph-label">阻塞:</span>
                              {blocks.map((b) => (
                                <span key={b} className="meta-task-ref">
                                  #{b}
                                </span>
                              ))}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    default:
      return <UnknownBlockCard block={block} />;
  }
}

/* v0.6.x: 路径点击 reveal — 用 revealAndNotify 拿错误, 内联红字提示 (用户报 'reveal 无效') */
function FilePathClickable({ path }: { path: string }) {
  const { revealAndNotify } = useFileReveal();
  const [error, setError] = useState<string | null>(null);
  const onClick = async () => {
    setError(null);
    const result = await revealAndNotify(path);
    if (!result.ok) setError(result.error);
  };
  return (
    <span className="meta-path-clickable-row">
      <span
        className="meta-path-clickable"
        data-testid="meta-file-path"
        onClick={onClick}
        title={`在 Finder/Explorer 打开: ${path}`}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
      >
        {path}
      </span>
      {error && (
        <span className="meta-reveal-error" data-testid="meta-file-path-error" title={error}>
          ⚠ {error}
        </span>
      )}
    </span>
  );
}

function PlanFilePath({ path }: { path: string }) {
  const { revealAndNotify } = useFileReveal();
  const [error, setError] = useState<string | null>(null);
  const onReveal = async () => {
    setError(null);
    const result = await revealAndNotify(path);
    if (!result.ok) setError(result.error);
  };
  const fileName = path.split("/").pop() ?? path;
  return (
    <div className="meta-plan-block">
      <div className="meta-plan-path-row">
        <span className="meta-plan-filename" title={path}>
          📄 {fileName}
        </span>
        <button
          type="button"
          className="meta-reveal-btn"
          data-testid="plan-mode-reveal"
          onClick={onReveal}
          title={`在 Finder/Explorer 打开: ${path}`}
        >
          reveal
        </button>
      </div>
      <code className="meta-path">{path}</code>
      {error && (
        <span className="meta-reveal-error" data-testid="plan-mode-reveal-error" title={error}>
          ⚠ reveal 失败: {error}
        </span>
      )}
    </div>
  );
}
