import { useState } from "react";
import {
  Wrench,
  ChevronDown,
  ChevronRight,
  FileText,
  Terminal,
  Edit3,
  Globe,
  ListChecks,
} from "lucide-react";
import { computeLineDiff, diffStats, DiffTooLargeError, type DiffLine } from "../lib/diff";
import "./ToolUseCard.css";

interface Props {
  id: string;
  name: string;
  input: Record<string, unknown>;
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
};

export function ToolUseCard({ id, name, input }: Props) {
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
        <span className="tool-id">{id.slice(0, 8)}</span>
      </button>
      {open && <div className="tool-use-body">{renderBody(name, input)}</div>}
    </div>
  );
}

/** v0.4.2: 按 tool name dispatch 到专属 body 渲染器 */
function renderBody(name: string, input: Record<string, unknown>) {
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
      return <TaskToolBody input={input} />;
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
  let tooLarge = false;
  try {
    diff = computeLineDiff(oldStr, newStr);
  } catch (e) {
    if (e instanceof DiffTooLargeError) {
      tooLarge = true;
    }
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
  void tooLarge; // unused fallback marker, kept for future use

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
 */
function TaskToolBody({ input }: { input: Record<string, unknown> }) {
  const isUpdate = input.taskId != null;
  const description = String(input.description ?? "");
  const subagentType = String(input.subagent_type ?? "");
  const prompt = String(input.prompt ?? "");
  const status = String(input.status ?? "");
  const content = input.content ? String(input.content) : "";
  const taskId = String(input.taskId ?? "");

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

  return (
    <div className="tool-body-task">
      {description && <div className="tool-task-headline">{description}</div>}
      {subagentType && <span className="tool-badge tool-badge-info">{subagentType}</span>}
      {prompt && (
        <pre className="tool-task-prompt">
          {prompt.length > 200 ? prompt.slice(0, 200) + "…" : prompt}
        </pre>
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
