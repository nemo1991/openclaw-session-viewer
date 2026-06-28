import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Wrench,
  ChevronDown,
  ChevronRight,
  FileText,
  Terminal,
  Edit3,
  Globe,
  ListChecks,
  ExternalLink,
} from "lucide-react";
import { computeLineDiff, diffStats, DiffTooLargeError, type DiffLine } from "../lib/diff";
import { apiListSubagentsByMeta } from "../lib/api";
import { useSessionsStore } from "../state/sessionsStore";
import { useTranslation } from "react-i18next";
import "./ToolUseCard.css";

interface Props {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  /** 主 session 的 jsonl 路径(用于查找对应子 agent) */
  parentJsonlPath?: string;
  /** 主 session 的 sessionId(用于 navigate 时 state 传父) */
  parentSessionId?: string;
}

const TOOL_ICONS: Record<string, typeof Wrench> = {
  Read: FileText,
  Write: Edit3,
  Edit: Edit3,
  NotebookEdit: Edit3,
  Bash: Terminal,
  Glob: ListChecks,
  Grep: ListChecks,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: Wrench,
  Agent: Wrench,
};

export function ToolUseCard({ id, name, input, parentJsonlPath, parentSessionId }: Props) {
  // v0.4.2: 默认展开
  const [open, setOpen] = useState(true);
  const Icon = TOOL_ICONS[name] ?? Wrench;
  const summary = summarize(name, input);
  const replaceAll = name === "Edit" && input?.replace_all === true;

  return (
    <div className="tool-use-card">
      <button className="tool-use-header" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Icon size={12} />
        <span className="tool-name">{name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        {replaceAll && <span className="tool-badge tool-badge-warn">替换全部</span>}
        <span className="tool-id">{id?.slice(0, 8) ?? ""}</span>
      </button>
      {open && (
        <div className="tool-use-body">
          {renderBody(name, input, id, parentJsonlPath, parentSessionId)}
        </div>
      )}
    </div>
  );
}

/** v0.4.2: 按 tool name dispatch 到专属 body 渲染器 */
function renderBody(
  name: string,
  input: Record<string, unknown>,
  toolUseId?: string,
  parentJsonlPath?: string,
  parentSessionId?: string
) {
  switch (name) {
    case "Edit":
      return <EditToolBody input={input} />;
    case "Bash":
      return <BashToolBody input={input} />;
    case "Read":
    case "Write":
    case "NotebookEdit":
      return <ReadToolBody input={input} />;
    case "Task":
    case "Agent":
      // v0.5.0:Claude Code 用 name="Agent" 派生子代理,input schema
      // 跟 Task 完全一样(description / subagent_type / prompt / taskId)
      // 共用 TaskToolBody
      return (
        <TaskToolBody
          input={input}
          toolUseId={toolUseId}
          parentJsonlPath={parentJsonlPath}
          parentSessionId={parentSessionId}
        />
      );
    default:
      return <pre className="tool-body-json">{JSON.stringify(input, null, 2)}</pre>;
  }
}

function summarize(name: string, input: Record<string, unknown>): string {
  if (!input) return "";
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return String(input.file_path ?? input.notebook_path ?? input.path ?? "");
    case "Bash":
      return String(input.command ?? input.description ?? "").slice(0, 80);
    case "Glob":
      return String(input.pattern ?? "");
    case "Grep":
      return String(input.pattern ?? input.path ?? "");
    case "WebFetch":
    case "WebSearch":
      return String(input.url ?? input.query ?? "");
    case "Task":
      // v0.4.2: 区分 TaskCreate/TaskUpdate
      if (input.taskId) {
        return `[更新] ${String(input.status ?? "…")}`;
      }
      return String(input.description ?? input.prompt ?? "").slice(0, 80);
    default:
      return "";
  }
}

/* ============ 专属 body 渲染器 ============ */

/**
 * v0.4.2: Edit 工具 — line-level diff 视图
 * old_string / new_string 缺失时 fallback 到 JSON dump;超大输入走 fallback + 警告。
 */
function EditToolBody({ input }: { input: Record<string, unknown> }) {
  const oldStr = String(input.old_string ?? "");
  const newStr = String(input.new_string ?? "");

  // 缺字段时 fallback
  if (!input.old_string || !input.new_string) {
    return <pre className="tool-body-json">{JSON.stringify(input, null, 2)}</pre>;
  }

  let diff: DiffLine[];
  try {
    diff = computeLineDiff(oldStr, newStr);
  } catch (e) {
    return (
      <div className="tool-body-edit">
        <div className="tool-body-warning">
          Diff 输入过大({e instanceof DiffTooLargeError ? e.lineCount : "?"} 行),已 fallback 到 JSON
          dump
        </div>
        <pre className="tool-body-json">{JSON.stringify(input, null, 2)}</pre>
      </div>
    );
  }

  const stats = diffStats(diff);
  const filePath = String(input.file_path ?? "");

  return (
    <div className="tool-body-edit">
      {filePath && <div className="tool-edit-file-path">{filePath}</div>}
      <div className="tool-diff-stats">
        <span className="tool-diff-stat-add">+{stats.added}</span>
        <span className="tool-diff-stat-del">-{stats.removed}</span>
        <span className="tool-diff-stat-eq">{stats.unchanged} 未变</span>
      </div>
      <div className="tool-diff-table">
        {diff.map((line, i) => (
          <div key={i} className={`tool-diff-row tool-diff-row-${line.kind}`}>
            <span className="tool-diff-marker">
              {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}
            </span>
            <span className="tool-diff-text">{line.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** v0.4.2: Bash — command 等宽块 + description caption + 后台 badge */
function BashToolBody({ input }: { input: Record<string, unknown> }) {
  const command = String(input.command ?? "");
  const description = input.description ? String(input.description) : null;
  const background = input.run_in_background === true;

  return (
    <div className="tool-body-bash">
      {description && <div className="tool-bash-description">说明: {description}</div>}
      {background && <span className="tool-badge tool-badge-info">后台运行</span>}
      <pre className="tool-bash-command">{command || "(空命令)"}</pre>
    </div>
  );
}

/** v0.4.2: Read / Write / NotebookEdit — file_path 粗体 + offset/limit 行号指示 */
function ReadToolBody({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
  const offset = typeof input.offset === "number" ? input.offset : null;
  const limit = typeof input.limit === "number" ? input.limit : null;

  let rangeBadge: string | null = null;
  if (offset != null && limit != null) {
    rangeBadge = `lines ${offset}–${offset + limit}`;
  } else if (offset != null) {
    rangeBadge = `从 line ${offset} 起`;
  } else if (limit != null) {
    rangeBadge = `前 ${limit} 行`;
  }

  return (
    <div className="tool-body-read">
      <div className="tool-read-file-path">{filePath || "(无文件路径)"}</div>
      {rangeBadge && <span className="tool-badge tool-read-range">{rangeBadge}</span>}
    </div>
  );
}

/**
 * v0.4.2: Task 工具 — TaskCreate vs TaskUpdate 区分
 *  - TaskCreate: description + subagent_type + prompt 预览
 *  - TaskUpdate: taskId + status 大 badge + content
 *
 * v0.5.0:Claude Code Agent(name="Agent")也走这个 body(input schema 完全一致)。
 *  末尾追加"打开子代理详情"按钮 — 按 toolUseId 在 list_subagents 中精确匹配
 *  对应的子代理,跳到 /session/<agentId> + state.subagentContext。
 */
function TaskToolBody({
  input,
  toolUseId,
  parentJsonlPath,
  parentSessionId,
}: {
  input: Record<string, unknown>;
  toolUseId?: string;
  parentJsonlPath?: string;
  parentSessionId?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isUpdate = input.taskId != null;
  const description = String(input.description ?? "");
  const subagentType = String(input.subagent_type ?? "");
  const prompt = String(input.prompt ?? "");
  const status = String(input.status ?? "");
  const content = input.content ? String(input.content) : "";
  const taskId = String(input.taskId ?? "");

  // v0.5.0:点击按钮 → 按 toolUseId 匹配子代理
  const [resolvedAgentId, setResolvedAgentId] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const handleOpenSubagent = async () => {
    if (!toolUseId || !parentSessionId) return;
    setResolving(true);
    try {
      const meta = useSessionsStore
        .getState()
        .sessions.find((s) => s.sessionId === parentSessionId);
      if (!meta?.subagentDir) return;
      const subs = await apiListSubagentsByMeta(meta);
      // 按 .meta.json toolUseId 字段精确匹配(实测 19/19)
      const matched = subs.find((s) => s.meta?.toolUseId === toolUseId);
      if (matched) {
        navigate(`/session/${encodeURIComponent(matched.agentId)}`, {
          state: {
            session: {
              sessionId: matched.agentId,
              jsonlPath: matched.jsonlPath,
              title: matched.description ?? matched.agentId,
              workspaceGuess: meta.workspaceGuess ?? meta.projectKey,
              projectKey: meta.projectKey,
              primaryModel: meta.primaryModel ?? null,
              messageCount: matched.messageCount ?? 0,
              sizeBytes: 0,
              firstTimestamp: matched.firstTimestamp ?? null,
              hasTrajectory: false,
              subagentDir: null,
              totalTokens: undefined,
              source: "claude",
            },
            subagentContext: {
              parentSessionId,
              agentId: matched.agentId,
              agentType: matched.agentType ?? null,
            },
          },
        });
        setResolvedAgentId(matched.agentId);
      }
    } finally {
      setResolving(false);
    }
  };

  if (isUpdate) {
    return (
      <div className="tool-body-task">
        <div className="tool-task-row">
          <span className="tool-task-label">任务 ID</span>
          <code className="tool-task-id">{taskId.slice(0, 12) || "(无)"}</code>
        </div>
        {status && (
          <div className={`tool-task-status tool-task-status-${status}`}>{statusLabel(status)}</div>
        )}
        {content && <pre className="tool-task-content">{content}</pre>}
      </div>
    );
  }

  // v0.5.0:只有 Claude Agent(非 TaskCreate/TaskUpdate)且有 toolUseId + parent 上下文时才显示
  const showSubagentButton = !isUpdate && !!toolUseId && !!parentSessionId && !!parentJsonlPath;

  return (
    <div className="tool-body-task">
      {description && <div className="tool-task-headline">{description}</div>}
      {subagentType && <span className="tool-badge tool-badge-info">{subagentType}</span>}
      {prompt && (
        <pre className="tool-task-prompt">
          {prompt.length > 200 ? prompt.slice(0, 200) + "…" : prompt}
        </pre>
      )}
      {showSubagentButton && (
        <div className="tool-task-actions">
          <button
            className="tool-task-action-btn"
            data-testid="open-subagent-detail"
            disabled={resolving || !!resolvedAgentId}
            onClick={handleOpenSubagent}
            title={t("detail.taskOpenDetail")}
          >
            <ExternalLink size={11} /> {t("detail.taskOpenDetail")}
          </button>
          {resolvedAgentId && (
            <span className="tool-task-resolved">→ agent-{resolvedAgentId.slice(0, 12)}</span>
          )}
        </div>
      )}
    </div>
  );
}

function statusLabel(s: string): string {
  switch (s) {
    case "pending":
      return "待办";
    case "in_progress":
      return "进行中";
    case "completed":
      return "已完成";
    default:
      return s;
  }
}
