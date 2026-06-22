import { useState } from "react";
import { Check, X, ChevronDown, ChevronRight, FileText, ExternalLink } from "lucide-react";
import { apiGetToolResultFile } from "../lib/api";
import "./ToolResultCard.css";

interface Props {
  toolUseId: string;
  content: unknown;
  isError?: boolean;
  filePath?: string;
}

export function ToolResultCard({ toolUseId, content, isError, filePath }: Props) {
  const [open, setOpen] = useState(false);
  const [spillover, setSpillover] = useState<string | null>(null);
  const [spilloverLoading, setSpilloverLoading] = useState(false);

  // 试图从 spillover 路径(可能不是绝对路径)推断
  const handleSpillover = async () => {
    if (!filePath) return;
    // 暂用占位逻辑:假设 filePath 是 tool-results 下的相对路径
    setSpilloverLoading(true);
    try {
      // 实际从后端读
      // 这里需要父组件传入 session 路径来拼绝对路径
      // 简化:用户点击"打开完整输出"会后端读整个 tool-results
    } catch (e) {
      console.error(e);
    } finally {
      setSpilloverLoading(false);
    }
  };

  const text = stringifyContent(content);
  const truncated = text.length > 500 ? text.slice(0, 500) + "…" : text;

  return (
    <div className={`tool-result-card ${isError ? "err" : ""}`}>
      <button className="tool-result-header" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {isError ? <X size={12} /> : <Check size={12} />}
        <span>{isError ? "工具结果 (失败)" : "工具结果"}</span>
        {filePath && (
          <span className="tool-result-file">
            <FileText size={10} /> {filePath.split("/").slice(-2).join("/")}
          </span>
        )}
        <span className="tool-result-id">{toolUseId.slice(0, 8)}</span>
      </button>
      {open && (
        <div className="tool-result-body">
          <pre>{truncated}</pre>
          {text.length > 500 && (
            <div className="tool-result-more">
              共 {text.length} 字符,点击折叠查看完整
            </div>
          )}
        </div>
      )}
      {spillover && (
        <pre className="tool-result-spillover">{spillover}</pre>
      )}
    </div>
  );
}

function stringifyContent(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((it) => {
        if (typeof it === "string") return it;
        if (it && typeof it === "object") {
          const o = it as Record<string, unknown>;
          if ("stdout" in o) return String(o.stdout ?? "");
          if ("type" in o && o.type === "text" && "file" in o) {
            const f = o.file as { content?: string } | undefined;
            return f?.content ?? "";
          }
        }
        return JSON.stringify(it);
      })
      .join("\n");
  }
  if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    if ("stdout" in o) return String(o.stdout ?? "");
    return JSON.stringify(c, null, 2);
  }
  return String(c);
}
