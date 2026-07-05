/**
 * GraphDetailPanel — G1 节点详情面板(右侧抽屉)
 *
 * 关键改动 (vs 实验 web 原版):
 * - 加 onJumpToSession:跳主项目原生 /session/:id 路由
 *   - main 节点:state.session = 真实 SessionMeta
 *   - subagent 节点:state.session = virtualMeta + state.subagentContext
 *   - 复用 SubagentPanel.tsx:79-110 模板
 * - onJumpToRag 改用 useNavigate 跳 /graph?view=rag&q=... (M2 完整实现, M1 已可用)
 * - useTitles() 改用 useTitleStore() (zustand)
 * - first_prompt 解析(去 <command-message> 噪音)— 用 formatPrompt.parseFirstPrompt
 * - 每个 Stat 加 vs-avg 对比 + 复制 session_id / jsonl_path 按钮
 * - 加 session 持续时间 (formatDuration) + "同 workspace 其它 session" 链接
 * - 去 emoji,error badge "1k+" → "≥1k"
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GNode, SubagentRole } from "./graph-types";
import type { GraphEntry, SessionNode } from "./types";
import { classifyRole } from "./loader";
import { useTitleStore } from "./titleStore";
import type { SessionMeta as MainSessionMeta } from "@ocsv/shared";
import { formatDuration, parseFirstPrompt, vsMedianPct } from "./formatPrompt";
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
  const navigate = useNavigate();
  const titles = useTitleStore();
  const entry = entries.find((e) => e.node.node_id === node.id);
  const session: SessionNode | null = entry?.node ?? null;

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const currentTitle = titles.get(node.id, session ? titles.auto(session) : node.label);

  // ===== 计算对比基线(用全图 sessions 的中位数)— 36 节点规模下稳定,代价可忽略 =====
  const baseline = useMemo<{ medTokens: number; medThinking: number; medErrors: number }>(() => {
    const tokensAll: number[] = entries
      .map((e) => e.node.token_total)
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => a - b);
    const medTokens = tokensAll.length ? (tokensAll[Math.floor(tokensAll.length / 2)] ?? 0) : 0;
    const thinkingAll: number[] = entries
      .map((e) => e.node.thinking_count)
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => a - b);
    const medThinking = thinkingAll.length
      ? (thinkingAll[Math.floor(thinkingAll.length / 2)] ?? 0)
      : 0;
    const errorsAll: number[] = entries
      .map((e) => e.node.error_count)
      .filter((n): n is number => typeof n === "number")
      .sort((a, b) => a - b);
    const medErrors = errorsAll.length ? (errorsAll[Math.floor(errorsAll.length / 2)] ?? 0) : 0;
    return { medTokens, medThinking, medErrors };
  }, [entries]);

  // ===== 解析 first_prompt — 去 <command-message>/<local-command-caveat> 噪音 =====
  const parsed = parseFirstPrompt(session?.first_prompt);

  // ===== 同 workspace 其它 main session(limit 5)— 给"探索上下文"入口 =====
  const sameWorkspace = useMemo(() => {
    if (!session?.workspace) return [];
    return entries
      .filter(
        (e) =>
          e.node.node_id !== node.id &&
          e.node.workspace === session.workspace &&
          !e.node.is_subagent_root
      )
      .sort((a, b) => (b.node.last_timestamp_ms ?? 0) - (a.node.last_timestamp_ms ?? 0))
      .slice(0, 5);
  }, [entries, session?.workspace, node.id]);

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

  const copyToClipboard = (text: string, label: string) => {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(text).then(() => {
        // 简单提示 — 不打扰用户
        setCopyHint(label);
        setTimeout(() => setCopyHint(null), 1500);
      });
    }
  };
  const [copyHint, setCopyHint] = useState<string | null>(null);

  // ===== 跳主项目会话详情 =====
  // main 节点 → /session/<sessionId> (state.session = 真实 SessionMeta)
  // subagent 节点 → /session/<agentId>?path=<jsonlPath> (state.session = virtual + subagentContext)
  // 完全复用 SubagentPanel.tsx:79-110 模板
  const handleJumpToSession = () => {
    if (!session) return;
    if (node.type === "main") {
      const mainMeta: Partial<MainSessionMeta> = {
        sessionId: session.session_id,
        jsonlPath: session.jsonl_path,
        title: session.first_prompt?.slice(0, 60) ?? session.session_id.slice(0, 8),
        workspaceGuess: session.workspace,
        projectKey: session.workspace ?? "",
        primaryModel: session.primary_model ?? undefined,
        messageCount: session.message_count ?? 0,
        sizeBytes: session.size_bytes ?? 0,
        firstTimestamp: session.first_timestamp_ms
          ? new Date(session.first_timestamp_ms).toISOString()
          : undefined,
        hasTrajectory: false,
        subagentDir: undefined,
        source: (session.source === "OpenClaw" ? "openclaw" : "claude") as any,
        subagentCount: session.subagent_count,
        topTools: session.top_tools,
        thinkingCount: session.thinking_count,
      };
      navigate(`/session/${encodeURIComponent(session.session_id)}`, {
        state: { session: mainMeta },
      });
    } else if (node.type === "subagent" && node.agent_id && entry) {
      // 找 Spawned edge 拿 jsonlPath
      const spawnedEdge = entry.edges.find(
        (e) => e.type === "Spawned" && e.to_subagent_id === node.agent_id
      );
      const jsonlPath =
        (spawnedEdge && spawnedEdge.type === "Spawned" && spawnedEdge.to_subagent_path) ||
        session.jsonl_path;
      const virtualMeta: Partial<MainSessionMeta> = {
        sessionId: node.agent_id,
        jsonlPath,
        title: node.description?.slice(0, 60) ?? node.agent_id,
        workspaceGuess: session.workspace,
        projectKey: session.workspace ?? "",
        primaryModel: undefined,
        messageCount: 0,
        sizeBytes: 0,
        firstTimestamp: session.first_timestamp_ms
          ? new Date(session.first_timestamp_ms).toISOString()
          : undefined,
        hasTrajectory: false,
        subagentDir: undefined,
        source: (session.source === "OpenClaw" ? "openclaw" : "claude") as any,
      };
      navigate(
        `/session/${encodeURIComponent(node.agent_id)}?path=${encodeURIComponent(jsonlPath)}`,
        {
          state: {
            session: virtualMeta,
            subagentContext: {
              parentSessionId: session.node_id,
              agentId: node.agent_id,
              agentType: null,
            },
          },
        }
      );
    }
  };

  // ===== 跳 G3 RAG(用 URL ?q= 深链,M2 完整支持)— 用解析后的 clean prompt 更准 =====
  const handleJumpToRag = () => {
    const q = (parsed.clean || session?.first_prompt || "")
      .slice(0, 80)
      .replace(/\s+/g, " ")
      .trim();
    if (!q) return;
    navigate(`/graph?view=rag&q=${encodeURIComponent(q)}`);
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
            ×
          </button>
        </div>
        <div className="detail-title-actions">
          {!isEditing && (
            <>
              <button className="icon-btn" onClick={startEdit} title="编辑显示名">
                重命名
              </button>
              {titles.hasOverride(node.id) && (
                <button
                  className="icon-btn"
                  onClick={() => titles.clear(node.id)}
                  title="撤销自定义,回到自动命名"
                >
                  自动名
                </button>
              )}
              {node.type === "main" && onDrillDown && (
                <button
                  className="icon-btn primary"
                  onClick={() => onDrillDown(node.id)}
                  disabled={isDrilledIntoThis}
                  title={isDrilledIntoThis ? "当前已聚焦这个 session" : "进入该 session 钻取视图"}
                >
                  {isDrilledIntoThis ? "已聚焦" : "钻取"}
                </button>
              )}
              {(parsed.clean || session?.first_prompt) && (
                <button
                  className="icon-btn"
                  onClick={handleJumpToRag}
                  title="跳 G3 RAG,以首问为 query 召回相关上下文"
                >
                  G3 RAG
                </button>
              )}
              {/* M1.4 新增:跳主项目原生会话详情(main + subagent 都有) */}
              {session && (
                <button
                  className="icon-btn primary"
                  onClick={handleJumpToSession}
                  title={
                    node.type === "subagent"
                      ? "跳到主项目 /session/<agentId>?path=... (含子会话 context)"
                      : "跳到主项目 /session/<sessionId> 原生 TranscriptView"
                  }
                >
                  会话详情
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
              {node.workspace.length > 22 ? `…${node.workspace.slice(-21)}` : node.workspace}
            </span>
          )}
          {node.primary_model && (
            <span className="meta-tag tag-model">model · {node.primary_model}</span>
          )}
          {parsed.isLocalCommand && (
            <span className="meta-tag tag-local" title="由 local command 触发的会话,无首问">
              local command
            </span>
          )}
        </div>

        {parsed.clean && (
          <section className="detail-section">
            <div className="detail-section-label">首问</div>
            <p className="detail-prompt">
              {parsed.commandName ? (
                <code className="detail-cmd">{parsed.clean}</code>
              ) : (
                parsed.clean
              )}
            </p>
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
            <Stat
              label="tokens"
              value={formatNum(node.token_total ?? 0)}
              compare={vsMedianPct(node.token_total, baseline.medTokens)}
            />
            <Stat
              label="thinking"
              value={formatNum(node.thinking_count ?? 0)}
              compare={vsMedianPct(node.thinking_count, baseline.medThinking)}
            />
            <Stat
              label="errors"
              value={formatNum(node.error_count ?? 0)}
              warn={(node.error_count ?? 0) > 0}
              compare={vsMedianPct(node.error_count, baseline.medErrors)}
            />
            <Stat label="subagents" value={formatNum(node.subagent_count ?? 0)} />
            <Stat
              label="持续"
              value={formatDuration(session?.first_timestamp_ms, session?.last_timestamp_ms)}
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
                let desc: string | null = null;
                for (const e2 of entry!.edges) {
                  if (e2.type === "Spawned" && e2.to_subagent_id === saId) {
                    desc = e2.description ?? null;
                    break;
                  }
                }
                const role = classifyRole(desc);
                return (
                  <li
                    key={saId}
                    className="detail-subagent"
                    style={{ cursor: "default" }}
                    title={desc ?? saId}
                  >
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

        {sameWorkspace.length > 0 && (
          <section className="detail-section">
            <div className="detail-section-label">同 workspace 其它 main</div>
            <ul className="detail-sibling-list">
              {sameWorkspace.map((sib) => (
                <li
                  key={sib.node.node_id}
                  className="detail-sibling"
                  onClick={() => {
                    const sibMeta: Partial<MainSessionMeta> = {
                      sessionId: sib.node.session_id,
                      jsonlPath: sib.node.jsonl_path,
                      title: titles.get(sib.node.node_id, titles.auto(sib.node)),
                      workspaceGuess: sib.node.workspace,
                      projectKey: sib.node.workspace ?? "",
                      primaryModel: sib.node.primary_model ?? undefined,
                      messageCount: sib.node.message_count ?? 0,
                      sizeBytes: sib.node.size_bytes ?? 0,
                      firstTimestamp: sib.node.first_timestamp_ms
                        ? new Date(sib.node.first_timestamp_ms).toISOString()
                        : undefined,
                      hasTrajectory: false,
                      subagentDir: undefined,
                      source: (sib.node.source === "OpenClaw" ? "openclaw" : "claude") as any,
                    };
                    navigate(`/session/${encodeURIComponent(sib.node.session_id)}`, {
                      state: { session: sibMeta },
                    });
                  }}
                  title="跳转到该 session 详情"
                >
                  <span className="sibling-title">
                    {titles.get(sib.node.node_id, titles.auto(sib.node))}
                  </span>
                  <span className="sibling-meta">
                    {formatNum(sib.node.token_total)} tok ·{" "}
                    {sib.node.last_timestamp_ms
                      ? new Date(sib.node.last_timestamp_ms).toISOString().slice(0, 10)
                      : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="detail-section detail-section-muted">
          <div className="detail-section-label">
            session_id
            <button
              className="copy-btn"
              onClick={() => copyToClipboard(node.id, "session_id")}
              title="复制 session_id"
            >
              {copyHint === "session_id" ? "已复制" : "复制"}
            </button>
            {session?.jsonl_path && (
              <button
                className="copy-btn"
                onClick={() => copyToClipboard(session.jsonl_path, "jsonl_path")}
                title="复制 jsonl_path(在 finder 中可 ⌘⇧G 跳转)"
              >
                {copyHint === "jsonl_path" ? "已复制" : "复制路径"}
              </button>
            )}
          </div>
          <code className="detail-id">{node.id}</code>
        </section>
      </div>
    </aside>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function Stat({
  label,
  value,
  warn,
  compare,
}: {
  label: string;
  value: string | number;
  warn?: boolean;
  compare?: { pct: number; label: string } | null;
}) {
  return (
    <div className={`stat ${warn ? "stat-warn" : ""}`}>
      <dt>{label}</dt>
      <dd>
        {value}
        {compare && compare.pct !== 0 && (
          <span
            className={`stat-compare ${compare.pct > 0 ? "stat-compare-up" : "stat-compare-down"}`}
          >
            {compare.label}
          </span>
        )}
      </dd>
    </div>
  );
}
