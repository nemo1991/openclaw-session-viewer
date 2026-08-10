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
import { useNavigate } from "react-router-dom";
import { useFileReveal } from "../../hooks/useFileReveal";
import { useSettingsStore } from "../../state/settingsStore";
import type { NormalizedBlockFE } from "../../lib/api";
import { UnknownBlockCard } from "../UnknownBlockCard";
import { UsageChartSvg } from "./UsageChart";
import { RequestChartSvg } from "./RequestChart";

export interface MetaBlockProps {
  block: NormalizedBlockFE;
  label: string;
  /** v0.6.x: 透传 parentJsonlPath, 让 useFileReveal (file_snapshot / plan_mode reveal) 推 workspaceRoot */
  parentJsonlPath?: string;
}

export function MetaBlock({ block, label, parentJsonlPath }: MetaBlockProps) {
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
                  <span key={a} className="meta-tag meta-tag-add" title={a}>
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
                  <span key={a} className="meta-tag meta-tag-remove" title={a}>
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
          {planFile && <PlanFilePath path={planFile} parentJsonlPath={parentJsonlPath} />}
        </div>
      );
    }
    case "file_snapshot":
    case "file-history-snapshot": {
      // v0.8.4: 抽出子组件以便用 useState 控制折叠 (item 3)
      const backups = (get("trackedFileBackups") as Record<string, unknown>) ?? {};
      const mid = String(get("messageId") ?? "");
      return (
        <FileSnapshotBlock
          paths={Object.keys(backups)}
          messageId={mid}
          parentJsonlPath={parentJsonlPath}
        />
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
    // v0.8.4 item 4: 新增 6 个 meta block 渲染
    case "invoked_skills": {
      const skills = (get("skills") as Array<{ name?: string; path?: string }>) ?? [];
      return (
        <div className="block-meta-info meta-block-flat">
          <span className="meta-kind-badge">⚙ invoked_skills</span>
          <span className="meta-primary-text">{skills.length} 个 skill</span>
          <div className="meta-list">
            {skills.map((s, i) => (
              <span key={i} className="meta-tag" title={s.path ?? ""}>
                {s.name ?? "?"}
              </span>
            ))}
          </div>
        </div>
      );
    }
    case "plan_file_reference": {
      const path = String(get("planFilePath") ?? "");
      const preview = String(get("planContentPreview") ?? "");
      const fileName = path.split("/").pop() ?? path;
      return (
        <div className="block-meta-info meta-block-flat">
          <span className="meta-kind-badge">📋 plan_file_reference</span>
          <div className="meta-plan-block">
            <div className="meta-plan-path-row">
              <span className="meta-plan-filename" title={path}>
                📄 {fileName}
              </span>
              {path && <FilePathClickable path={path} parentJsonlPath={parentJsonlPath} />}
            </div>
            {preview && <code className="meta-path">{preview}…</code>}
          </div>
        </div>
      );
    }
    case "compact_file_reference": {
      const filename = String(get("filename") ?? "");
      const displayPath = String(get("displayPath") ?? "");
      return (
        <div className="block-meta-info meta-block-flat">
          <span className="meta-kind-badge">📦 compact_file_reference</span>
          {filename && (
            <div className="meta-plan-block">
              <div className="meta-plan-path-row">
                <span className="meta-plan-filename" title={filename}>
                  📄 {displayPath || filename}
                </span>
                <FilePathClickable path={filename} parentJsonlPath={parentJsonlPath} />
              </div>
            </div>
          )}
        </div>
      );
    }
    case "attached_file": {
      const filename = String(get("filename") ?? "");
      const displayPath = String(get("displayPath") ?? "");
      const contentType = String(get("contentType") ?? "unknown");
      return (
        <div className="block-meta-info meta-block-flat">
          <span className="meta-kind-badge">🗂 attached_file</span>
          <span className="meta-sub">type: {contentType}</span>
          {filename && (
            <div className="meta-plan-block">
              <div className="meta-plan-path-row">
                <span className="meta-plan-filename" title={filename}>
                  📄 {displayPath || filename}
                </span>
                <FilePathClickable path={filename} parentJsonlPath={parentJsonlPath} />
              </div>
            </div>
          )}
        </div>
      );
    }
    case "queued_command": {
      const preview = String(get("promptPreview") ?? "");
      const mode = String(get("commandMode") ?? "");
      return (
        <div className="block-meta-info meta-block-flat">
          <span className="meta-kind-badge">📤 queued_command</span>
          {mode && (
            <span className="meta-reminder-pill meta-reminder-full" title={`commandMode: ${mode}`}>
              mode: {mode}
            </span>
          )}
          {preview && (
            <code className="meta-path" title={preview}>
              {preview}
              {preview.length >= 100 ? "…" : ""}
            </code>
          )}
        </div>
      );
    }
    case "queue_operation": {
      const op = String(get("operation") ?? "");
      const ts = String(get("timestamp") ?? "");
      const isEnqueue = op === "enqueue";
      return (
        <div className="block-meta-info meta-block-flat">
          <span
            className={`meta-reminder-pill ${isEnqueue ? "meta-reminder-full" : "meta-reminder-none"}`}
            title={ts}
          >
            {isEnqueue ? "📥 enqueue" : "🗑 remove"}
          </span>
          {ts && <span className="meta-sub">{ts}</span>}
        </div>
      );
    }
    // v0.9.12: context.apply_compaction — LLM 交接笔记 + 压缩统计
    case "context.apply_compaction":
      return <CompactionMetaBlock block={block} />;
    // v0.9.13: llm.tools_snapshot — session 启动时 dump 的 24 tool schema + hash
    case "llm.tools_snapshot":
      return <ToolsSnapshotMetaBlock block={block} />;
    // v0.9.14: usage.chart — 645 个 usage.record 聚合 1 个 chart meta
    case "usage.chart":
      return <UsageChartMetaBlock block={block} />;
    // v0.9.15: request.chart — 648 个 llm.request 聚合 1 个 context headroom + drift chart
    case "request.chart":
      return <RequestChartMetaBlock block={block} />;
    default:
      return <UnknownBlockCard block={block} />;
  }
}

/* v0.9.12: context.apply_compaction 专属渲染
 *
 * dcwin11 bpm-large (5834 行) 含 22 个 apply_compaction 事件,每个都带 LLM 生成
 * 的中文交接笔记 (`summary`,可达数 KB 字符)。之前这些事件走 UnknownBlockCard
 * 默认折叠 — 用户必须手动展开才能看到 summary 文本,但展开后又被埋在 6 个
 * payload 字段表里,体验差。
 *
 * 现在后端 parser 把 summary + tokens_before / tokens_after / compacted_count /
 * kept_user_message_count / compression_ratio 提到 block 顶层 (block.data),本组件
 * 直接读这些顶层字段渲染: 头部 stats pill + summary 大段文本 (可滚动)。
 *
 * fallback: 如果顶层字段缺失 (老 wire 数据 / 老 DB 缓存),仍走 UnknownBlockCard。
 */
function CompactionMetaBlock({ block }: { block: NormalizedBlockFE }) {
  // 字段可能在 payload (旧 wire / 老 DB 缓存) 也可能在 block 顶层 (新 builder)。
  // 后端字段是 snake_case (`tokens_before`),前端 type camelCase (`tokensBefore`)
  // — 都要兼容。统一 lookup: 顶层 → payload → camelCase fallback。
  const blk = block as Record<string, unknown>;
  const pl = (block.payload ?? {}) as Record<string, unknown>;
  const get = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (blk[k] !== undefined && blk[k] !== null) return blk[k];
      if (pl[k] !== undefined && pl[k] !== null) return pl[k];
    }
    return undefined;
  };

  const summary = typeof get("summary") === "string" ? (get("summary") as string) : null;
  const contextSummary =
    typeof get("contextSummary") === "string" ? (get("contextSummary") as string) : null;
  const tokensBefore = num(get("tokens_before", "tokensBefore"));
  const tokensAfter = num(get("tokens_after", "tokensAfter"));
  const compactedCount = num(get("compacted_count", "compactedCount"));
  const keptUserCount = num(get("kept_user_message_count", "keptUserMessageCount"));

  // 缺 summary 也缺 stats — fallback 到 UnknownBlockCard,让老数据仍能看
  if (!summary && tokensBefore === null && tokensAfter === null) {
    return <UnknownBlockCard block={block} />;
  }

  return (
    <div className="block-meta-info meta-block-flat compaction-meta">
      <span className="meta-kind-badge">🗜️ compaction</span>
      {tokensBefore !== null && tokensAfter !== null && tokensAfter > 0 && (
        <span className="meta-primary-text" title={`tokensBefore / tokensAfter`}>
          {formatTokens(tokensBefore)} → {formatTokens(tokensAfter)}
          {(() => {
            const ratio = tokensBefore / tokensAfter;
            return ` · ${ratio.toFixed(1)}× 压缩`;
          })()}
        </span>
      )}
      {compactedCount !== null && (
        <span className="meta-sub" title="被压缩的消息数 (LLM 折叠掉)">
          {compactedCount} msgs compacted
        </span>
      )}
      {keptUserCount !== null && (
        <span className="meta-sub" title="保留的用户消息数">
          {keptUserCount} kept
        </span>
      )}
      {summary && (
        <div className="compaction-summary" data-testid="compaction-summary">
          <div className="compaction-summary-title">LLM 交接笔记</div>
          <pre className="compaction-summary-text">{summary}</pre>
        </div>
      )}
      {!summary && contextSummary && (
        <div className="compaction-summary">
          <div className="compaction-summary-title">context 系统提示</div>
          <pre className="compaction-summary-text">{contextSummary}</pre>
        </div>
      )}
    </div>
  );
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/* v0.9.13: llm.tools_snapshot 专属渲染
 *
 * dcwin11 bpm-large (6040 行) 1 条 llm.tools_snapshot, 24 个 tool (Agent /
 * AgentSwarm / Bash / Read / Edit / CronCreate / TodoList / ...),每个带
 * 300-500 字符 description,SHA256 hash 作 LLM 缓存键。之前 protocol-layer
 * skip 完全不可见。
 *
 * 渲染策略:
 * - 头部: hash + tool count pill + 时间戳
 * - 中部: tool names 列表 (类似 skill_listing 的 chip,但加 dropdown 展开每个
 *   tool 的 truncated description 60 字符预览)— 24 个 tool 全展开太长,默认
 *   折叠
 * - rawType 保留 (wire "llm.tools_snapshot") — 后续如想区分 kimi 版本有依据
 *
 * fallback: 完全缺顶层字段 (老 wire / 老 DB 缓存) → UnknownBlockCard。
 */
function ToolsSnapshotMetaBlock({ block }: { block: NormalizedBlockFE }) {
  const blk = block as Record<string, unknown>;
  const pl = (block.payload ?? {}) as Record<string, unknown>;
  const get = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (blk[k] !== undefined && blk[k] !== null) return blk[k];
      if (pl[k] !== undefined && pl[k] !== null) return pl[k];
    }
    return undefined;
  };

  const hash =
    typeof get("snapshot_hash", "snapshotHash", "hash") === "string"
      ? (get("snapshot_hash", "snapshotHash", "hash") as string)
      : null;
  const toolNames = (get("tool_names", "toolNames") as string[]) ?? [];
  const toolDescs = (get("tool_descriptions", "toolDescriptions") as Record<string, string>) ?? {};
  const rawTools = (pl.tools as Array<{ name?: string }>) ?? [];

  // 缺关键字段 → fallback (老 wire / 老 DB 缓存)
  if (toolNames.length === 0 && rawTools.length === 0) {
    return <UnknownBlockCard block={block} />;
  }

  const [showAll, setShowAll] = useState(false);
  const visibleNames = showAll ? toolNames : toolNames.slice(0, 12);
  const overflow = toolNames.length - visibleNames.length;

  return (
    <div className="block-meta-info meta-block-flat tools-snapshot-meta">
      <span className="meta-kind-badge">🔧 tools snapshot</span>
      <span className="meta-primary-text" data-testid="tools-snapshot-count">
        {toolNames.length} 个 tool 配置
      </span>
      {hash && (
        <span
          className="meta-sub"
          title={`SHA256 hash (LLM cache key): ${hash}`}
          data-testid="tools-snapshot-hash"
        >
          {hash.slice(0, 8)}…
        </span>
      )}
      <div className="meta-list tools-snapshot-list" data-testid="tools-snapshot-list">
        {visibleNames.map((name) => {
          const desc = toolDescs[name];
          return (
            <span
              key={name}
              className="meta-tag tools-snapshot-tag"
              title={desc ? `${name}: ${desc}` : name}
            >
              {name}
            </span>
          );
        })}
      </div>
      {overflow > 0 && (
        <button
          type="button"
          className="meta-show-more"
          data-testid="tools-snapshot-toggle"
          onClick={() => setShowAll((v) => !v)}
          title={showAll ? "收起 tool 列表" : `展开剩余 ${overflow} 个 tool`}
        >
          {showAll ? "收起" : `展开剩余 ${overflow} 个 tool`}
        </button>
      )}
    </div>
  );
}

/* v0.9.14: usage.chart 专属渲染
 *
 * dcwin11 bpm-large (6040 行) 645 个 usage.record 事件 (623 turn + 22 session)。
 * v0.9.3 把 total 累加到 SessionMeta.total_tokens,但详情页看不到每 turn 趋势。
 * v0.9.14 后端 `build_usage_chart_meta` 把 645 events 折成 1 个聚合 meta:
 * - 顶层 stats: total_tokens / input_other / output / input_cache_read /
 *   cache_hit_ratio / turn_count / session_scope_count / duration_ms
 * - buckets[]: 60 个时间窗口,inline SVG stacked bar 渲染
 *   (inputCacheRead indigo-alpha + inputOther blue + output amber)
 * - session_scope_events[]: 22 个 compaction-aligned snapshot 单独 subsection
 * - payload.raw_events: 前 5 + 后 5 raw sample (drill-down)
 *
 * 渲染策略:
 * - 头部: total_tokens pill + cache hit ratio pill + turn_count / bucket_count
 * - 中部: UsageChartSvg (60 stacked bar, time-linear)
 * - 22 session_scope_events: 默认显示前 5 (跟 v0.9.13 tools_snapshot 限 12)
 * - 折叠 / 展开 645 raw events 切片 (`payload.raw_events`) — 跟 v0.9.13
 *   "展开剩余 tool" 同 pattern
 *
 * fallback: 缺 total_tokens 或 buckets → UnknownBlockCard
 */
function UsageChartMetaBlock({ block }: { block: NormalizedBlockFE }) {
  const blk = block as Record<string, unknown>;
  const pl = (block.payload ?? {}) as Record<string, unknown>;
  const get = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (blk[k] !== undefined && blk[k] !== null) return blk[k];
      if (pl[k] !== undefined && pl[k] !== null) return pl[k];
    }
    return undefined;
  };

  const total = num(get("total_tokens", "totalTokens"));
  const inputOther = num(get("input_other", "inputOther")) ?? 0;
  const output = num(get("output")) ?? 0;
  const cacheRead = num(get("input_cache_read", "inputCacheRead")) ?? 0;
  const cacheCreation = num(get("input_cache_creation", "inputCacheCreation")) ?? 0;
  const cacheHitRatio = num(get("cache_hit_ratio", "cacheHitRatio"));
  const turnCount = num(get("turn_count", "turnCount")) ?? 0;
  const sessionScopeCount = num(get("session_scope_count", "sessionScopeCount")) ?? 0;
  const durationMs = num(get("duration_ms", "durationMs")) ?? 0;
  const model = String(get("model") ?? "");
  const buckets = (get("buckets") as Array<Record<string, unknown>>) ?? [];
  const sessionScopeEvents =
    (get("session_scope_events", "sessionScopeEvents") as Array<Record<string, unknown>>) ?? [];
  const rawEvents = (pl.raw_events as Array<Record<string, unknown>>) ?? [];
  const rawCount = (pl.raw_count as number) ?? rawEvents.length;

  // 缺关键字段 → fallback (老 wire / 老 DB 缓存)
  if (total === null || buckets.length === 0) {
    return <UnknownBlockCard block={block} />;
  }

  const [showRawEvents, setShowRawEvents] = useState(false);

  return (
    <div
      className="block-meta-info meta-block-flat usage-chart-meta"
      data-testid="usage-chart-meta"
    >
      <span className="meta-kind-badge">📊 usage chart</span>
      <span className="meta-primary-text" data-testid="usage-chart-total">
        {total.toLocaleString()} tokens
      </span>
      <span
        className="meta-sub"
        title={`cache hit ratio (cacheRead / input): ${cacheHitRatio !== null ? (cacheHitRatio * 100).toFixed(1) + "%" : "n/a"}`}
        data-testid="usage-chart-cache-ratio"
      >
        cache {cacheHitRatio !== null ? (cacheHitRatio * 100).toFixed(1) + "%" : "n/a"}
      </span>
      <span
        className="meta-sub"
        title={`turn_count: ${turnCount} 个 turn-scope events, session_scope_count: ${sessionScopeCount} session-scope events`}
        data-testid="usage-chart-turn-count"
      >
        {turnCount} turns · {buckets.length} buckets
      </span>
      {model && (
        <span className="meta-sub" title={`模型: ${model}`}>
          {model}
        </span>
      )}
      {durationMs > 0 && (
        <span className="meta-sub" title="session 实际跨度">
          {formatDurationMs(durationMs)}
        </span>
      )}
      <UsageChartSvg buckets={buckets} />
      <div className="usage-chart-legend" data-testid="usage-chart-legend">
        <span className="usage-chart-legend-item">
          <span
            className="usage-chart-legend-dot"
            style={{ background: "rgba(245, 158, 11, 0.9)" }}
          />
          output ({output.toLocaleString()})
        </span>
        <span className="usage-chart-legend-item">
          <span
            className="usage-chart-legend-dot"
            style={{ background: "rgba(59, 130, 246, 0.9)" }}
          />
          input ({inputOther.toLocaleString()})
        </span>
        <span className="usage-chart-legend-item">
          <span
            className="usage-chart-legend-dot"
            style={{ background: "rgba(99, 102, 241, 0.4)" }}
          />
          cache read ({cacheRead.toLocaleString()})
        </span>
        {cacheCreation > 0 && (
          <span className="usage-chart-legend-item">
            <span
              className="usage-chart-legend-dot"
              style={{ background: "rgba(16, 185, 129, 0.9)" }}
            />
            cache write ({cacheCreation.toLocaleString()})
          </span>
        )}
      </div>
      {sessionScopeEvents.length > 0 && (
        <div className="meta-section" data-testid="usage-chart-session-scope">
          <strong className="meta-section-title">
            {sessionScopeEvents.length} 个 compaction 时刻 session 累计:
          </strong>
          <div className="meta-list meta-list-scrollable">
            {sessionScopeEvents.slice(0, 5).map((e, i) => (
              <span
                key={i}
                className="meta-tag"
                title={`time=${e.time}, inputOther=${e.input_other}, output=${e.output}, cacheRead=${e.input_cache_read}`}
              >
                {formatTokenShort(num(e.input_other) ?? 0)} in +{" "}
                {formatTokenShort(num(e.output) ?? 0)} out
              </span>
            ))}
          </div>
        </div>
      )}
      {rawEvents.length > 0 && (
        <button
          type="button"
          className="meta-show-more"
          data-testid="usage-chart-raw-toggle"
          onClick={() => setShowRawEvents((v) => !v)}
          title={showRawEvents ? "收起 raw events" : `展开 ${rawCount} raw events`}
        >
          {showRawEvents ? "收起" : `展开 ${rawCount} raw events`}
        </button>
      )}
      {showRawEvents && (
        <div className="usage-chart-raw-events" data-testid="usage-chart-raw-events">
          {rawEvents.map((e, i) => (
            <div key={i} className="usage-chart-raw-row">
              <span className="meta-tag">{String(e.usageScope ?? "turn")}</span>
              <span className="meta-sub">
                {formatTokenShort(
                  ((e.usage as Record<string, unknown>)?.inputOther as number) ?? 0
                )}{" "}
                in
              </span>
              <span className="meta-sub">
                {formatTokenShort(((e.usage as Record<string, unknown>)?.output as number) ?? 0)}{" "}
                out
              </span>
              <span className="meta-sub">
                cache{" "}
                {formatTokenShort(
                  ((e.usage as Record<string, unknown>)?.inputCacheRead as number) ?? 0
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function formatDurationMs(ms: number): string {
  if (ms >= 3_600_000_000) return `${(ms / 3_600_000_000).toFixed(1)}M ms`;
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)} min`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)} s`;
  return `${ms} ms`;
}

/* v0.9.15: request.chart 专属渲染
 *
 * dcwin11 bpm-large (6040 行) 648 个 llm.request 事件 (625 loop + 23
 * compaction)。v0.9.14 把 token cost 折成 usage.chart。本版揭示
 * **context headroom** 趋势 + **config drift detection**:
 * - maxTokens 随 prompt 增长下降 → 用户能看到 "还剩多少上下文"
 * - toolsHash 跨 session 稳定性 → bpm-large 0 drift (跟 v0.9.13 snapshot hash 一致)
 * - system_prompt_hash 跨 session 独立数 → bpm-large 23 个独立 hash
 *   (compaction / manual edit 触发)
 * - kind 分流: loop (常规 turn) vs compaction (compaction LLM 调用)
 *
 * 渲染策略:
 * - 头部: maxTokens min/max/avg pill + kind 分流 pill (loop + compaction) +
 *   messageCount range + turnIndex range + model
 * - 中部: RequestChartSvg (3 条折线 avg/max/min + amber dots for compaction
 *   时刻)
 * - system_prompt_drift_events: 默认显示前 8 个 hash 切换时刻 (bpm-large 23 个,
 *   单 hash 单独成行,带 inline 标记)
 * - 折叠 / 展开 raw events (payload.raw_events) — 跟 v0.9.14 同 pattern
 *
 * fallback: 缺 request_count 或 buckets → UnknownBlockCard
 */
function RequestChartMetaBlock({ block }: { block: NormalizedBlockFE }) {
  const blk = block as Record<string, unknown>;
  const pl = (block.payload ?? {}) as Record<string, unknown>;
  const get = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (blk[k] !== undefined && blk[k] !== null) return blk[k];
      if (pl[k] !== undefined && pl[k] !== null) return pl[k];
    }
    return undefined;
  };

  const requestCount = num(get("request_count", "requestCount"));
  const kindLoop = num(get("kind_loop", "kindLoop")) ?? 0;
  const kindCompaction = num(get("kind_compaction", "kindCompaction")) ?? 0;
  const compactionPct = num(get("compaction_pct", "compactionPct"));
  const maxTokensMin = num(get("max_tokens_min", "maxTokensMin")) ?? 0;
  const maxTokensMax = num(get("max_tokens_max", "maxTokensMax")) ?? 0;
  const maxTokensAvg = num(get("max_tokens_avg", "maxTokensAvg")) ?? 0;
  const messageCountMin = num(get("message_count_min", "messageCountMin")) ?? 0;
  const messageCountMax = num(get("message_count_max", "messageCountMax")) ?? 0;
  const turnIndexMin = num(get("turn_index_min", "turnIndexMin")) ?? 0;
  const turnIndexMax = num(get("turn_index_max", "turnIndexMax")) ?? 0;
  const toolsHashBaseline = String(get("tools_hash_baseline", "toolsHashBaseline") ?? "");
  const toolsHashDriftCount = num(get("tools_hash_drift_count", "toolsHashDriftCount")) ?? 0;
  const systemPromptHashDistinct =
    num(get("system_prompt_hash_distinct", "systemPromptHashDistinct")) ?? 0;
  const model = String(get("model") ?? "");
  const provider = String(get("provider") ?? "");
  const durationMs = num(get("duration_ms", "durationMs")) ?? 0;
  const buckets = (get("buckets") as Array<Record<string, unknown>>) ?? [];
  const driftEvents =
    (get("system_prompt_drift_events", "systemPromptDriftEvents") as Array<
      Record<string, unknown>
    >) ?? [];
  const rawEvents = (pl.raw_events as Array<Record<string, unknown>>) ?? [];
  const rawCount = (pl.raw_count as number) ?? rawEvents.length;

  // 缺关键字段 → fallback
  if (requestCount === null || buckets.length === 0) {
    return <UnknownBlockCard block={block} />;
  }

  const [showRawEvents, setShowRawEvents] = useState(false);
  const [showAllDrift, setShowAllDrift] = useState(false);
  const DRIFT_VISIBLE = 8;
  const visibleDrift = showAllDrift ? driftEvents : driftEvents.slice(0, DRIFT_VISIBLE);
  const driftOverflow = driftEvents.length - DRIFT_VISIBLE;

  return (
    <div
      className="block-meta-info meta-block-flat request-chart-meta"
      data-testid="request-chart-meta"
    >
      <span className="meta-kind-badge">🧭 request chart</span>
      <span className="meta-primary-text" data-testid="request-chart-count">
        {requestCount.toLocaleString()} requests
      </span>
      <span
        className="meta-sub"
        title={`maxTokens min/max/avg (剩余上下文 token 预算): ${maxTokensMin} / ${maxTokensMax} / ${maxTokensAvg}`}
        data-testid="request-chart-headroom"
      >
        headroom {(maxTokensAvg / 1000).toFixed(1)}K avg
      </span>
      <span
        className="meta-sub"
        title={`loop: ${kindLoop} 次常规 turn LLM 调用, compaction: ${kindCompaction} 次 compaction LLM 调用 (${compactionPct !== null ? (compactionPct * 100).toFixed(1) + "%" : "n/a"})`}
        data-testid="request-chart-kinds"
      >
        {kindLoop} loop · {kindCompaction} compaction
      </span>
      <span
        className="meta-sub"
        title={`messageCount: ${messageCountMin} → ${messageCountMax}, turnIndex: ${turnIndexMin} → ${turnIndexMax}`}
        data-testid="request-chart-session-length"
      >
        msg {messageCountMin}→{messageCountMax} · turn {turnIndexMin}→{turnIndexMax}
      </span>
      {model && (
        <span className="meta-sub" title={`model: ${model}, provider: ${provider}`}>
          {model}
        </span>
      )}
      {durationMs > 0 && (
        <span className="meta-sub" title="session 实际跨度">
          {formatDurationMs(durationMs)}
        </span>
      )}
      <RequestChartSvg buckets={buckets} />
      <div className="request-chart-legend" data-testid="request-chart-legend">
        <span className="request-chart-legend-item">
          <span
            className="request-chart-legend-dot"
            style={{ background: "rgba(139, 92, 246, 0.95)" }}
          />
          avg maxTokens
        </span>
        <span className="request-chart-legend-item">
          <span
            className="request-chart-legend-dot"
            style={{ background: "rgba(139, 92, 246, 0.35)" }}
          />
          min/max range
        </span>
        <span className="request-chart-legend-item">
          <span
            className="request-chart-legend-dot"
            style={{ background: "rgba(245, 158, 11, 0.9)" }}
          />
          compaction 时刻
        </span>
      </div>
      {driftEvents.length > 0 && (
        <div className="meta-section" data-testid="request-chart-drift">
          <strong className="meta-section-title">
            system_prompt_hash drift ({driftEvents.length} 个独立 hash
            {toolsHashDriftCount > 0
              ? `, tools_hash drift ${toolsHashDriftCount}`
              : ", tools_hash 稳定"}
            ):
          </strong>
          <div className="meta-list meta-list-scrollable">
            {visibleDrift.map((e, i) => {
              const hash = String(e.hash ?? "?");
              const short = hash.length > 12 ? hash.slice(0, 12) + "…" : hash;
              const inline = e.system_prompt_inline === true;
              const idx = num(e.request_index) ?? i;
              return (
                <span
                  key={i}
                  className="meta-tag"
                  title={`request #${idx}, hash=${hash}, inline=${inline}, kind=${String(e.kind ?? "?")}`}
                >
                  #{idx} {short} {inline ? "📝" : ""}
                </span>
              );
            })}
          </div>
          {driftOverflow > 0 && !showAllDrift && (
            <button
              type="button"
              className="meta-show-more"
              onClick={() => setShowAllDrift(true)}
              data-testid="request-chart-drift-toggle"
            >
              展开剩余 {driftOverflow} 个 hash 切换
            </button>
          )}
          {toolsHashBaseline && (
            <span
              className="meta-sub"
              title={`toolsHash baseline (取最高频 hash): ${toolsHashBaseline}`}
              data-testid="request-chart-tools-hash"
            >
              tools_hash {toolsHashBaseline.slice(0, 12)}…
            </span>
          )}
        </div>
      )}
      {rawEvents.length > 0 && (
        <button
          type="button"
          className="meta-show-more"
          data-testid="request-chart-raw-toggle"
          onClick={() => setShowRawEvents((v) => !v)}
          title={showRawEvents ? "收起 raw events" : `展开 ${rawCount} raw events`}
        >
          {showRawEvents ? "收起" : `展开 ${rawCount} raw events`}
        </button>
      )}
      {showRawEvents && (
        <div className="request-chart-raw-events" data-testid="request-chart-raw-events">
          {rawEvents.map((e, i) => {
            const kind = String(e.kind ?? "loop");
            return (
              <div key={i} className="request-chart-raw-row">
                <span
                  className="meta-tag"
                  style={{
                    background:
                      kind === "compaction"
                        ? "rgba(245, 158, 11, 0.18)"
                        : "rgba(139, 92, 246, 0.18)",
                  }}
                >
                  {kind}
                </span>
                <span className="meta-sub">mt {((num(e.maxTokens) ?? 0) / 1000).toFixed(1)}K</span>
                <span className="meta-sub">msg {num(e.messageCount) ?? 0}</span>
                <span className="meta-sub">{String(e.turnStep ?? "?")}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function formatTokenShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/* v0.8.4: file_snapshot 折叠 (item 3)
 *
 * v0.6.x 把 <details> 折叠移除, 默认全展开 → 但单个 snapshot 可达 100+ 文件,
 * 全渲染进 DOM 太重。改为: 默认显示前 5 行, 下方放 "展开剩余 N 个文件" 按钮。
 * 用 useState 而非 <details>, 跟 v0.6.x 设计意图一致 (不用原生 fold widget)。
 */
const FILE_SNAPSHOT_VISIBLE_DEFAULT = 5;

function FileSnapshotBlock({
  paths,
  messageId,
  parentJsonlPath,
}: {
  paths: string[];
  messageId: string;
  parentJsonlPath?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const fileCount = paths.length;
  const mid = messageId;
  const visiblePaths = expanded ? paths : paths.slice(0, FILE_SNAPSHOT_VISIBLE_DEFAULT);
  const overflow = fileCount - FILE_SNAPSHOT_VISIBLE_DEFAULT;
  const showToggle = overflow > 0;
  return (
    <div className="block-meta-info meta-block-flat">
      <span className="meta-kind-badge">📁 file_snapshot</span>
      <span className="meta-primary-text">
        {fileCount > 0 ? `${fileCount} 个跟踪文件` : "空 snapshot (无文件)"}
      </span>
      {mid && <span className="meta-sub">msg: {mid.slice(0, 8)}…</span>}
      {fileCount > 0 && (
        <>
          <ul className="meta-file-list" data-count={visiblePaths.length}>
            {visiblePaths.map((p) => (
              <li key={p} className="meta-file-item">
                <FilePathClickable path={p} parentJsonlPath={parentJsonlPath} />
              </li>
            ))}
          </ul>
          {showToggle && (
            <button
              type="button"
              className="meta-show-more"
              data-testid="file-snapshot-toggle"
              onClick={() => setExpanded((v) => !v)}
              title={expanded ? "收起文件列表" : `展开剩余 ${overflow} 个文件`}
            >
              {expanded ? "收起" : `展开剩余 ${overflow} 个文件`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/* v0.6.x: 路径点击 reveal — 用 revealAndNotify 拿错误, 内联可操作错误 UI (用户报 'reveal 无效')
 *
 * UX 流程:
 * 1. 用户点路径 → 调 revealAndNotify
 * 2. 成功 → 清空错误, Finder 打开
 * 3. 失败 → 显示内联错误 bar:
 *    - ⚠ 人类能读的错误描述 (去掉 'PathSecurity:' 前缀)
 *    - [复制路径] 按钮 (用户至少能把路径手动复制)
 *    - [去设置] 按钮 (跳到 /settings, 用户能配置 workspaceRoot)
 *    - [一键开启允许越界] 按钮 (确认后 toggle settings.pathSecurity.allowRelaxed=true + 重试)
 */
function FilePathClickable({ path, parentJsonlPath }: { path: string; parentJsonlPath?: string }) {
  const { revealAndNotify } = useFileReveal(
    parentJsonlPath ? { sessionJsonlPath: parentJsonlPath } : undefined
  );
  const [error, setError] = useState<string | null>(null);
  const allowRelaxed = useSettingsStore((s) => s.settings.pathSecurity?.allowRelaxed ?? false);

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
        <RevealErrorActions
          path={path}
          error={error}
          allowRelaxed={allowRelaxed}
          parentJsonlPath={parentJsonlPath}
          onRetried={() => setError(null)}
        />
      )}
    </span>
  );
}

function PlanFilePath({ path, parentJsonlPath }: { path: string; parentJsonlPath?: string }) {
  const { revealAndNotify } = useFileReveal(
    parentJsonlPath ? { sessionJsonlPath: parentJsonlPath } : undefined
  );
  const [error, setError] = useState<string | null>(null);
  const allowRelaxed = useSettingsStore((s) => s.settings.pathSecurity?.allowRelaxed ?? false);

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
        <RevealErrorActions
          path={path}
          error={error}
          allowRelaxed={allowRelaxed}
          parentJsonlPath={parentJsonlPath}
          onRetried={() => setError(null)}
        />
      )}
    </div>
  );
}

/**
 * v0.6.x: reveal 失败时的可操作错误 UI
 * - 错误描述 (去掉 PathSecurity: 前缀)
 * - [复制路径] — 至少让用户能手动复制到 Finder
 * - [去设置] — 跳到 settings 页改默认 workspace 目录
 * - [一键开启允许越界] — 弹 confirm, 确认后 toggle allowRelaxed=true + 重试
 *
 * (PlanFilePath 和 FilePathClickable 复用, 区别只在前后 slot)
 */
function RevealErrorActions({
  path,
  error,
  allowRelaxed,
  parentJsonlPath,
  onRetried,
}: {
  path: string;
  error: string;
  allowRelaxed: boolean;
  parentJsonlPath?: string;
  onRetried: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const navigate = useNavigate();
  const updateSettings = useSettingsStore((s) => s.update);
  const saveSettings = useSettingsStore((s) => s.save);
  const { revealAndNotify } = useFileReveal(
    parentJsonlPath ? { sessionJsonlPath: parentJsonlPath } : undefined
  );

  // 把 PathSecurity 错转成人类语言
  const humanError = (() => {
    if (error.startsWith("PathSecurity: 需提供 workspace_root")) {
      return "请在「设置 → 数据源」中配置默认导出目录, 或开启「允许 reveal 越界」";
    }
    if (error.includes("不在 workspace") || error.includes("不在任一已知 root 下")) {
      return "路径不在允许范围内, 开启「允许 reveal 越界」或选择更宽的 root";
    }
    return error.replace(/^PathSecurity:\s*/, "");
  })();

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.warn("copy 失败:", e);
    }
  };

  const goSettings = () => navigate("/settings");

  const unlockAndRetry = async () => {
    // ⚠️ 安全确认 (用户已确认)
    const ok = window.confirm(
      "开启「允许 reveal 越界」会让任意已知 root 下的文件可被 reveal。\n\n" +
        "受 assert_within_any_root 兜底, 不会触碰 ~/.ssh 等敏感路径。\n\n确认开启?"
    );
    if (!ok) return;
    // v0.6.x fix: 同时把 defaultExportDir 也设上 (保证之后 lock-down 也能 reveal 计划文件)
    // 从 path 推断 ~/.claude: '/Users/foo/.claude/plans/x.md' → '/Users/foo/.claude'
    let inferredExportDir: string | undefined;
    const claudeMatch = path.match(/^(.*?\.claude)(\/|$)/);
    if (claudeMatch) inferredExportDir = claudeMatch[1];
    updateSettings({
      pathSecurity: { allowRelaxed: true },
      ...(inferredExportDir ? { defaultExportDir: inferredExportDir } : {}),
    });
    await saveSettings({
      ...useSettingsStore.getState().settings,
      pathSecurity: { allowRelaxed: true },
      ...(inferredExportDir ? { defaultExportDir: inferredExportDir } : {}),
    });
    // 重试 reveal
    const result = await revealAndNotify(path);
    if (result.ok) {
      onRetried();
    } else {
      console.warn("[unlock] 重试仍失败:", result.error);
    }
  };

  return (
    <div className="meta-reveal-error" data-testid="meta-reveal-error-block" title={error}>
      <span className="meta-reveal-error-msg">
        <span className="meta-reveal-error-icon">⚠</span>
        <span className="meta-reveal-error-text">{humanError}</span>
      </span>
      <span className="meta-reveal-error-actions">
        <button
          type="button"
          className="meta-reveal-error-btn"
          data-testid="meta-reveal-error-copy"
          onClick={copyPath}
          title="复制路径到剪贴板"
        >
          {copied ? "✓ 已复制" : "复制路径"}
        </button>
        <button
          type="button"
          className="meta-reveal-error-btn meta-reveal-error-btn-primary"
          data-testid="meta-reveal-error-settings"
          onClick={goSettings}
          title="跳到设置页"
        >
          去设置
        </button>
        {!allowRelaxed && (
          <button
            type="button"
            className="meta-reveal-error-btn meta-reveal-error-btn-warning"
            data-testid="meta-reveal-error-unlock"
            onClick={unlockAndRetry}
            title="一键开启 (弹确认) 后重试 reveal"
          >
            一键开启允许越界
          </button>
        )}
      </span>
    </div>
  );
}
