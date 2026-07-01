/**
 * GraphDetailPanel — 右侧详情面板,点击 G1 graph 节点打开。
 *
 * 数据流:
 * 1. GraphView 把点击的 GNode 传过来 (selectedNode: GNode | null)
 * 2. 我们拉 entry = entries.find(e => e.node.node_id === selectedNode.id)
 * 3. 显示:
 *    - 标题 (display_title via useTitles)
 *    - first_prompt (完整)
 *    - metadata grid (token / thinking / errors / subagents / model / workspace)
 *    - subagents list (main 才有)— 颜色按 role
 *    - session_id + jsonl_path 链接(实验分支 web 没有 file:// 跳转,只显示)
 * 4. 操作:
 *    - ✏️ Edit title — 切换到 inline <input>
 *    - ↩️ Reset to auto — 清掉 override
 *    - 🔍 Enter drill-down — 只对 main 暴露,设 focusedNodeId
 *    - ✕ Close
 */

import { useEffect, useState } from "react";
import type { GNode, SubagentRole } from "../graph-types";
import type { GraphEntry, SessionNode } from "../types";
import { classifyRole } from "../loader";
import { useTitles } from "../titleStore";
import { formatNum } from "../analytics";
import "./GraphDetailPanel.css";

interface Props {
  node: GNode;
  entries: GraphEntry[];
  onClose: () => void;
  onDrillDown?: (nodeId: string) => void;
  isDrilledIntoThis?: boolean;
}

const ROLE_COLORS: Record<SubagentRole, string> = {
  Explore: "#10b981",
  Design: "#6366f1",
  Validate: "#f59e0b",
  Implement: "#ef4444",
  Other: "#94a3b8",
};

const ROLE_LABELS: Record<SubagentRole, string> = {
  Explore: "探索",
  Design: "设计",
  Validate: "验证",
  Implement: "实施",
  Other: "其他",
};

export function GraphDetailPanel({
  node,
  entries,
  onClose,
  onDrillDown,
  isDrilledIntoThis,
}: Props) {
  const titles = useTitles();
  const entry = entries.find((e) => e.node.node_id === node.id);
  const session: SessionNode | null = entry?.node ?? null;

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const currentTitle = titles.get(node.id, session ? titles.auto(session) : node.label);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (isEditing) setIsEditing(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isEditing, onClose]);

  const startEdit = () => {
    setDraft(currentTitle);
    setIsEditing(true);
  };

  const commitEdit = () => {
    const v = draft.trim();
    if (v && v !== titles.auto(session ?? ({} as SessionNode))) {
      titles.set(node.id, v);
    } else {
      titles.clear(node.id);
    }
    setIsEditing(false);
  };

  return (
    <aside className="graph-detail" aria-label="节点详情">
      <header className="detail-header">
        <div className="detail-title-row">
          {isEditing ? (
            <input
              autoFocus
              className="detail-title-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit();
                if (e.key === "Escape") setIsEditing(false);
              }}
              onBlur={commitEdit}
              maxLength={80}
            />
          ) : (
            <h3 className="detail-title" title={node.id}>
              {currentTitle}
            </h3>
          )}
          <button className="icon-btn" onClick={onClose} title="Esc 关闭">
            ✕
          </button>
        </div>
        <div className="detail-title-actions">
          {!isEditing && (
            <>
              <button className="icon-btn" onClick={startEdit} title="编辑显示名">
                ✏️ 编辑
              </button>
              {titles.hasOverride(node.id) && (
                <button
                  className="icon-btn"
                  onClick={() => titles.clear(node.id)}
                  title="撤销自定义,回到自动命名"
                >
                  ↺ Auto
                </button>
              )}
              {node.type === "main" && onDrillDown && (
                <button
                  className="icon-btn primary"
                  onClick={() => onDrillDown(node.id)}
                  disabled={isDrilledIntoThis}
                  title={isDrilledIntoThis ? "当前已聚焦这个 session" : "进入该 session 钻取视图"}
                >
                  🔍 {isDrilledIntoThis ? "已聚焦" : "独立显示"}
                </button>
              )}
            </>
          )}
        </div>
      </header>

      <div className="detail-body">
        <div className="detail-meta-grid">
          {node.type === "main" ? (
            <span className="meta-tag tag-main">main session</span>
          ) : (
            <span
              className="meta-tag"
              style={{
                background: ROLE_COLORS[node.role ?? "Other"] + "33",
                color: ROLE_COLORS[node.role ?? "Other"],
                borderColor: ROLE_COLORS[node.role ?? "Other"],
              }}
            >
              subagent · {ROLE_LABELS[node.role ?? "Other"]}
            </span>
          )}
          {node.workspace && (
            <span className="meta-tag tag-workspace" title={node.workspace}>
              📁 {node.workspace.length > 22 ? node.workspace.slice(-22) : node.workspace}
            </span>
          )}
          {node.primary_model && (
            <span className="meta-tag tag-model">model · {node.primary_model}</span>
          )}
        </div>

        {session?.first_prompt && (
          <section className="detail-section">
            <div className="detail-section-label">首问</div>
            <p className="detail-prompt">{session.first_prompt}</p>
          </section>
        )}

        {node.description && (
          <section className="detail-section">
            <div className="detail-section-label">描述</div>
            <p className="detail-description">{node.description}</p>
          </section>
        )}

        <section className="detail-section">
          <div className="detail-section-label">指标</div>
          <dl className="detail-stats">
            <Stat label="tokens" value={formatNum(node.token_total ?? 0)} />
            <Stat label="thinking" value={formatNum(node.thinking_count ?? 0)} />
            <Stat
              label="errors"
              value={formatNum(node.error_count ?? 0)}
              warn={(node.error_count ?? 0) > 0}
            />
            <Stat label="subagents" value={formatNum(node.subagent_count ?? 0)} />
            <Stat
              label="first_ts"
              value={
                session?.first_timestamp_ms
                  ? new Date(session.first_timestamp_ms).toLocaleString()
                  : "—"
              }
            />
            <Stat
              label="last_ts"
              value={
                session?.last_timestamp_ms
                  ? new Date(session.last_timestamp_ms).toLocaleString()
                  : "—"
              }
            />
          </dl>
        </section>

        {node.type === "main" && session && session.subagent_ids.length > 0 && (
          <section className="detail-section">
            <div className="detail-section-label">Subagents ({session.subagent_ids.length})</div>
            <ul className="detail-subagent-list">
              {session.subagent_ids.map((saId) => {
                // 拉 subagent description 从 Spawned edge
                let desc: string | null = null;
                for (const e of entry!.edges) {
                  if (e.type === "Spawned" && e.to_subagent_id === saId) {
                    desc = e.description ?? null;
                    break;
                  }
                }
                const role = classifyRole(desc);
                return (
                  <li key={saId} className="detail-subagent">
                    <span
                      className="subagent-role-dot"
                      style={{ background: ROLE_COLORS[role] }}
                      title={ROLE_LABELS[role]}
                    />
                    <span className="subagent-desc">{desc ?? saId.slice(0, 12)}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}

        <section className="detail-section detail-section-muted">
          <div className="detail-section-label">session_id</div>
          <code className="detail-id">{node.id}</code>
        </section>
      </div>
    </aside>
  );
}

function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className={`stat ${warn ? "stat-warn" : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
