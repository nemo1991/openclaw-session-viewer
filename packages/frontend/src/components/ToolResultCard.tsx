import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Check, X, ChevronDown, ChevronRight, FileText } from "lucide-react";
import { useFileReveal } from "../hooks/useFileReveal";
import "./ToolResultCard.css";

interface Props {
  toolUseId: string;
  content: unknown;
  isError?: boolean;
  filePath?: string;
}

const SHIKI_LANGS_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  py: "python",
  rs: "rust",
  go: "go",
  json: "json",
  md: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  html: "html",
  css: "css",
  scss: "scss",
  sql: "sql",
};

const PREVIEW_CHARS = 500;

export function ToolResultCard({ toolUseId, content, isError, filePath }: Props) {
  // v0.4.2: 默认展开
  const [open, setOpen] = useState(true);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  // v0.4.2: 异步 shiki 高亮
  useEffect(() => {
    if (!open || !filePath) {
      setHighlightedHtml(null);
      return;
    }
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const lang = SHIKI_LANGS_BY_EXT[ext];
    if (!lang) {
      setHighlightedHtml(null);
      return;
    }
    const text = stringifyContent(content);
    const preview = text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + "…" : text;
    let cancelled = false;
    (async () => {
      try {
        // v0.4.2: lazy import shiki 不打 startup bundle
        const { getHighlighter } = await import("shiki");
        const hl = await getHighlighter({ themes: ["github-light", "github-dark"], langs: [lang] });
        if (cancelled) return;
        const out = hl.codeToHtml(preview, { lang, theme: "github-light" });
        setHighlightedHtml(out);
      } catch {
        if (!cancelled) setHighlightedHtml(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, filePath, content]);

  const text = stringifyContent(content);
  const truncated = text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + "…" : text;
  const { revealAndNotify } = useFileReveal();

  // v0.6.0: 文件路径变可点击 → reveal in Finder
  // 默认 lock-down 模式: 路径必须在 workspace 内, 越界返回 PathSecurity 错误
  const handleFilePathClick = async (e: ReactMouseEvent) => {
    e.stopPropagation(); // 不触发 card 折叠切换
    e.preventDefault();
    if (!filePath) return;
    const result = await revealAndNotify(filePath);
    if (!result.ok) {
      // 简单 console.warn, 后续接 toast 系统
      console.warn("reveal 失败:", result.error);
    }
  };

  return (
    <div className={`tool-result-card ${isError ? "err" : ""}`}>
      <button className="tool-result-header" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {isError ? <X size={12} /> : <Check size={12} />}
        <span>{isError ? "工具结果 (失败)" : "工具结果"}</span>
        {filePath && (
          <span
            className="tool-result-file file-path-clickable"
            data-testid="file-path-reveal"
            onClick={handleFilePathClick}
            title={`${filePath} (点击 reveal in Finder)`}
          >
            <FileText size={10} /> {filePath.split("/").slice(-2).join("/")}
          </span>
        )}
        <span className="tool-result-id">{toolUseId.slice(0, 8)}</span>
      </button>
      {open && (
        <div className="tool-result-body">
          {highlightedHtml ? (
            <div
              className="tool-result-shiki"
              // shiki 返回的 HTML 是 sanitized 的(只生成 span + class)
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          ) : (
            <pre className="tool-result-content">{truncated}</pre>
          )}
          {text.length > PREVIEW_CHARS && (
            <div className="tool-result-more">共 {text.length} 字符,点击折叠查看完整</div>
          )}
        </div>
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
