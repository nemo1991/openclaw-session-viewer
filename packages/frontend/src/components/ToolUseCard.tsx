import { useState } from "react";
import { Wrench, ChevronDown, ChevronRight, FileText, Terminal, Edit3, Globe, ListChecks } from "lucide-react";
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
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[name] ?? Wrench;
  const summary = summarize(name, input);

  return (
    <div className="tool-use-card">
      <button className="tool-use-header" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Icon size={12} />
        <span className="tool-name">{name}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        <span className="tool-id">{id.slice(0, 8)}</span>
      </button>
      {open && (
        <div className="tool-use-body">
          <pre>{JSON.stringify(input, null, 2)}</pre>
        </div>
      )}
    </div>
  );
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
      return String(input.command ?? input.description ?? "");
    case "Glob":
      return String(input.pattern ?? "");
    case "Grep":
      return String(input.pattern ?? input.path ?? "");
    case "WebFetch":
    case "WebSearch":
      return String(input.url ?? input.query ?? "");
    case "Task":
      return String(input.description ?? input.prompt ?? "").slice(0, 80);
    default:
      return "";
  }
}
