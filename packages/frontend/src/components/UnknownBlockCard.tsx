/**
 * v0.3.0 PR5: 未知 block type 展开卡片
 *
 * 默认折叠,展开后显示:
 * - hint pills (前端启发式推断可能的类型)
 * - 字段表 (key → value)
 * - 复制 JSON 按钮
 * - 报告 GitHub issue 链接
 */

import { useState } from "react";
import type { NormalizedBlockFE } from "../lib/api";
import "./UnknownBlockCard.css";

interface Props {
  block: NormalizedBlockFE;
}

export function UnknownBlockCard({ block }: Props) {
  const [open, setOpen] = useState(false);
  const kind = block.kind ?? "?";
  const label = (block.label as string) ?? kind;
  const payload = block.payload as Record<string, unknown> | undefined;

  // 没有 payload 时退化为简单 pill
  if (!payload || Object.keys(payload).length === 0) {
    return (
      <div className="unknown-pill">
        <span className="unknown-kind-badge">? {kind}</span>
        <span className="unknown-label">{label}</span>
      </div>
    );
  }

  const hints = inferHints(payload);
  const fields = Object.entries(payload).filter(([k]) => k !== "label" && k !== "payload");

  const handleCopy = () => {
    try {
      navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    } catch {
      // fallback for environments without clipboard API
    }
  };

  const reportUrl = `https://github.com/nemo1991/openclaw-session-viewer/issues/new?title=${encodeURIComponent(`未知 block type: ${kind}`)}&body=${encodeURIComponent(`block type: ${kind}\nlabel: ${label}\npayload:\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``)}`;

  return (
    <details
      className="unknown-block-card"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="unknown-summary">
        <span className="unknown-kind-badge">? {kind}</span>
        <span className="unknown-label">{label}</span>
        <span className="unknown-field-count">{fields.length} 字段</span>
        <span className="unknown-chevron">{open ? "▾" : "▸"}</span>
      </summary>
      <div className="unknown-body">
        {hints.length > 0 && (
          <div className="unknown-hints">
            {hints.map((h, i) => (
              <span key={i} className="hint-pill" title={`置信度: ${h.confidence}%`}>
                {h.type} · {h.confidence}%
              </span>
            ))}
          </div>
        )}
        <table className="unknown-fields">
          <thead>
            <tr>
              <th>字段</th>
              <th>值</th>
            </tr>
          </thead>
          <tbody>
            {fields.map(([key, value]) => (
              <tr key={key}>
                <td className="field-name">{key}</td>
                <td className="field-value">
                  <FieldValue value={value} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="unknown-actions">
          <button className="unknown-btn" onClick={handleCopy} title="复制 JSON 到剪贴板">
            📋 复制
          </button>
          <a
            className="unknown-btn"
            href={reportUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="在 GitHub 上报告这个未知 block type"
          >
            🐛 报告
          </a>
        </div>
      </div>
    </details>
  );
}

/** 渲染一个字段的值（字符串截断,对象折叠） */
function FieldValue({ value }: { value: unknown }) {
  if (value === null) return <code className="field-null">null</code>;
  if (value === undefined) return <code className="field-null">undefined</code>;
  if (typeof value === "string") {
    const MAX = 200;
    if (value.length <= MAX) return <span>{value}</span>;
    return (
      <details className="field-truncated">
        <summary>字符串 ({value.length} 字符)</summary>
        <pre className="field-pre">{value}</pre>
      </details>
    );
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <code className="field-scalar">{String(value)}</code>;
  }
  // object / array
  const json = JSON.stringify(value, null, 2);
  if (json.length <= 160) return <pre className="field-pre">{json}</pre>;
  return (
    <details className="field-truncated">
      <summary>
        {Array.isArray(value)
          ? `数组 (${value.length} 项)`
          : `对象 (${Object.keys(value as Record<string, unknown>).length} 键)`}
      </summary>
      <pre className="field-pre">{json}</pre>
    </details>
  );
}

/**
 * 前端启发式:根据 payload 字段推断可能的 block type。
 * 纯前端逻辑,不依赖 Rust handler 语义。
 */
function inferHints(payload: Record<string, unknown>): Array<{ type: string; confidence: number }> {
  const hints: Array<{ type: string; confidence: number }> = [];

  if (
    typeof payload.id === "string" &&
    typeof payload.name === "string" &&
    ("arguments" in payload || "input" in payload)
  ) {
    hints.push({ type: "tool_use", confidence: 90 });
  }

  if (typeof payload.text === "string" && Array.isArray(payload.citations)) {
    hints.push({ type: "citation", confidence: 75 });
  }

  if (typeof payload.thinking === "string") {
    hints.push({ type: "thinking", confidence: 80 });
  }

  if (typeof payload.tool_use_id === "string" || typeof payload.toolCallId === "string") {
    hints.push({ type: "tool_result", confidence: 85 });
  }

  if (typeof payload.mediaType === "string" || typeof payload.media_type === "string") {
    hints.push({ type: "image", confidence: 80 });
  }

  if (typeof payload.label === "string" && typeof payload.payload === "object") {
    hints.push({ type: "meta", confidence: 70 });
  }

  // dedup by type, keep highest confidence
  const seen = new Set<string>();
  return hints.filter((h) => {
    if (seen.has(h.type)) return false;
    seen.add(h.type);
    return true;
  });
}
