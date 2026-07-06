/**
 * RagChat — G3 RAG (搬自 experiment/embed-db/web)
 *
 * 工作流:
 * 1. 从 useGraphStore 拿 entries (跟 GraphView/AnalyticsView 共享)
 * 2. 把每个 session 的 `first_prompt + assistant_text_snippets[]` 拼成 corpus
 * 3. embed corpus (hash embedding, 32-dim)
 * 4. 用户输入 query → topK cosine → 显示 top 5 sessions (高亮 matched tokens)
 *
 * 跨 tab prefill:从 ?q= URL 读 initialQuery,自动跑 topK 后消费掉
 * 跟 G1 详情面板 "G3 RAG" 按钮接的 URL /graph?view=rag&q=<query> 配对
 *
 * 改进(本轮优化):
 * - hit card 加 "打开会话" 按钮 → /session/:id
 * - 加 source / workspace 过滤(空选项时 dropdown 自动隐藏)
 * - 命中提示 "top{N} 共 {index}/{entries} 索引"
 * - first_prompt 解析去 <command-message> 噪音
 * - 完整 first_prompt 展开/收起
 * - 去 emoji (✏️ → 普通字符)
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GraphEntry, SessionNode } from "./types";
import { formatNum } from "./analytics";
import { indexCorpus, topK, highlightQueryHtml, type IndexedItem, type RetrievalHit } from "./rag";
import { useTitleStore } from "./titleStore";
import { useGraphStore } from "./graphStore";
import { parseFirstPrompt } from "./formatPrompt";
import "./RagChat.css";

const PRESETS = [
  { label: "失败 / retry", q: "失败 错误 retry 不能" },
  { label: "explore 探索", q: "Explore 探索 调查" },
  { label: "openclaw session", q: "openclaw session" },
  { label: "SQLite / api", q: "SQLite API CRUD" },
  { label: "axios / curl", q: "fetch axios curl http" },
  { label: "rust / cargo", q: "cargo tauri Rust" },
];

function corpusText(n: SessionNode): string {
  // 把 first_prompt (解析后) + assistant snippets 拼起来 — RAG 检索源
  const parts: string[] = [];
  if (n.workspace) parts.push(n.workspace);
  const parsed = parseFirstPrompt(n.first_prompt);
  if (parsed.clean) parts.push(parsed.clean);
  if (n.assistant_text_snippets) parts.push(...n.assistant_text_snippets);
  return parts.join("\n");
}

export function RagChat({
  initialQuery = null,
  onConsumed = () => {},
}: {
  initialQuery?: string | null;
  onConsumed?: () => void;
} = {}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RetrievalHit<SessionNode>[] | null>(null);
  const [engineMs, setEngineMs] = useState<number | null>(null);
  const [topN, setTopN] = useState(8);
  /** workspace 过滤(空 = all) */
  const [workspaceFilter, setWorkspaceFilter] = useState<string>("");
  /** source 过滤(空 = all) */
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const titles = useTitleStore();
  const navigate = useNavigate();

  // 数据源:跟 GraphView/AnalyticsView 共享 graphStore.entries
  const entries = useGraphStore((s) => s.entries);
  const error = useGraphStore((s) => s.error);
  const graphLoad = useGraphStore((s) => s.load);

  useEffect(() => {
    if (!entries) void graphLoad();
  }, [entries, graphLoad]);

  /** 自定义标题数 — 跨视图共享 (G1 改完这里立刻显示) */
  const [overrideCount, setOverrideCount] = useState(0);
  useEffect(() => {
    const sync = () => {
      try {
        const raw = localStorage.getItem("openclaw.titleOverrides.v1");
        const m = raw ? (JSON.parse(raw)?.m ?? {}) : {};
        setOverrideCount(Object.keys(m).length);
      } catch {
        setOverrideCount(0);
      }
    };
    sync();
    window.addEventListener("storage", sync);
    window.addEventListener("openclaw:titlesChanged", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("openclaw:titlesChanged", sync);
    };
  }, []);

  /** workspace / source 选项(去重)— 给过滤 dropdown 用(>1 个时才显示) */
  const workspaceOptions = useMemo(() => {
    if (!entries) return [] as string[];
    const set = new Set<string>();
    for (const e of entries) if (e.node.workspace) set.add(e.node.workspace);
    return Array.from(set).sort();
  }, [entries]);
  const sourceOptions = useMemo(() => {
    if (!entries) return [] as string[];
    const set = new Set<string>();
    for (const e of entries) set.add(e.node.source);
    return Array.from(set).sort();
  }, [entries]);

  // 索引 corpus (一次);应用 workspace/source 过滤
  const index: IndexedItem<SessionNode>[] = useMemo(() => {
    if (!entries) return [];
    let nodes = entries
      .map((e) => e?.node)
      .filter((n): n is SessionNode => Boolean(n && n.node_id));
    if (workspaceFilter) nodes = nodes.filter((n) => n.workspace === workspaceFilter);
    if (sourceFilter) nodes = nodes.filter((n) => n.source === sourceFilter);
    return indexCorpus(nodes, corpusText);
  }, [entries, workspaceFilter, sourceFilter]);

  // G1 详情面板跳转过来时,接收 prefill query 并自动跑 topK
  // (index 准备好后才能跑,这里同时等 entries / index 都 ready)
  // 注意:runQuery 定义必须先于本 effect — const 声明不 hoist,会被 TDZ 拦截
  const [prefillArmed, setPrefillArmed] = useState<string | null>(null);

  const lastIndexedCount = useMemo(() => index.length, [index.length]);

  const runQuery = (q: string, n: number = topN) => {
    if (!q.trim()) {
      setHits(null);
      return;
    }
    const t0 = performance.now();
    const result = topK(q, index, n);
    const t1 = performance.now();
    setHits(result);
    setEngineMs(t1 - t0);
  };

  /** 过滤变化时,如果有 query,自动重跑 — 否则命中数会跟当前 index 不一致 */
  useEffect(() => {
    if (query.trim() && index.length > 0) {
      runQuery(query);
    } else if (query.trim() && index.length === 0) {
      setHits(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceFilter, sourceFilter, index.length]);

  useEffect(() => {
    if (initialQuery && initialQuery !== prefillArmed && index.length > 0) {
      setQuery(initialQuery);
      runQuery(initialQuery);
      setPrefillArmed(initialQuery);
      onConsumed();
    }
    // runQuery 引用每次 render 都变,这里不依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery, prefillArmed, index.length, onConsumed]);

  // 仅 entries 数变时才重测索引构建耗时
  useEffect(() => {
    if (!entries) return;
    const t0 = performance.now();
    indexCorpus(
      entries.map((e) => e.node).filter((n): n is SessionNode => Boolean(n && n.node_id)),
      corpusText
    );
    const t1 = performance.now();
    setEngineMs(t1 - t0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastIndexedCount]);

  if (error) return <div className="error">Error: {error}</div>;
  if (!entries) return <div className="loading">加载 sessions.ndjson ...</div>;

  return (
    <div className="rag-chat">
      <header className="rag-header">
        <h2>G3 RAG (lite) — 跨 session 召回</h2>
        <p className="hint">
          hash-embedding + cosine top-{topN} · 索引 {index.length}/{entries.length} sessions ·
          32-dim 词袋 · 0 deps
          {overrideCount > 0 && ` · ${overrideCount} 个自定义名已应用到 G1/G2/G3`}
        </p>
      </header>

      <div className="rag-search">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") runQuery(query);
          }}
          placeholder="问点什么... e.g. retry, explore, sqlite, cargo"
          data-testid="rag-input"
        />
        <button onClick={() => runQuery(query)} disabled={!query.trim()} className="primary">
          检索
        </button>
        <span className="topn-control">
          top
          <input
            type="number"
            min={1}
            max={20}
            value={topN}
            onChange={(e) => setTopN(parseInt(e.target.value) || 8)}
            style={{ width: 44 }}
          />
        </span>
        {workspaceOptions.length > 1 && (
          <select
            className="rag-filter"
            value={workspaceFilter}
            onChange={(e) => setWorkspaceFilter(e.target.value)}
            aria-label="按 workspace 过滤"
            title="按 workspace 过滤"
          >
            <option value="">全部 workspace ({workspaceOptions.length})</option>
            {workspaceOptions.map((w) => (
              <option key={w} value={w}>
                {w.split("/").slice(-2).join("/")}
              </option>
            ))}
          </select>
        )}
        {sourceOptions.length > 1 && (
          <select
            className="rag-filter"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            aria-label="按 source 过滤"
            title="按 source 过滤"
          >
            <option value="">全部 source</option>
            {sourceOptions.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="presets">
        <span className="presets-label">预设 query:</span>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => {
              setQuery(p.q);
              runQuery(p.q);
            }}
          >
            {p.label}
          </button>
        ))}
      </div>

      {engineMs !== null && (
        <p className="engine-timing">
          {hits ? `${hits.length} 条命中` : ""}
          {hits ? " · " : ""}耗时 {engineMs.toFixed(2)}ms (embed 索引 {index.length} 个 session
          一次性算完)
          {" · "}卡片标题 = display_title(在 G1 详情面板可重命名)
        </p>
      )}

      {hits && hits.length === 0 && (
        <div className="empty">
          没有匹配 session{workspaceFilter || sourceFilter ? " (已应用过滤)" : ""}
        </div>
      )}

      <div className="hits">
        {hits?.map((h, i) => (
          <HitCard
            key={h.item.node_id}
            hit={h}
            rank={i + 1}
            query={query}
            onOpenSession={(id, path) =>
              navigate(
                `/session/${encodeURIComponent(id)}${path ? `?path=${encodeURIComponent(path)}` : ""}`
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

function HitCard({
  hit,
  rank,
  query,
  onOpenSession,
}: {
  hit: RetrievalHit<SessionNode>;
  rank: number;
  query: string;
  onOpenSession: (sessionId: string, jsonlPath: string) => void;
}) {
  const n = hit.item;
  const titles = useTitleStore();
  const title = titles.get(n.node_id, titles.auto(n));
  const parsed = parseFirstPrompt(n.first_prompt);
  const promptText = parsed.clean;
  const [expanded, setExpanded] = useState(false);
  const hasOverflow = promptText.length > 220;
  return (
    <div className="hit-card">
      <div className="hit-rank">{rank}</div>
      <div className="hit-body">
        <div className="hit-header">
          <span className="hit-session" title={n.session_id}>
            {title}
          </span>
          <span className="hit-source">{n.source}</span>
          {n.workspace && (
            <span className="hit-workspace" title={n.workspace}>
              {n.workspace}
            </span>
          )}
          <span className="hit-score">cosine: {hit.score.toFixed(3)}</span>
          <button
            className="hit-open"
            onClick={() => onOpenSession(n.session_id, n.jsonl_path)}
            title="跳到主项目 /session/:id (带 ?path= 走 SessionDetailRoute)"
          >
            打开会话
          </button>
        </div>
        {parsed.isLocalCommand && (
          <div className="hit-prompt">
            <b>首问:</b> <span className="hit-muted">local command 触发,无文本首问</span>
          </div>
        )}
        {promptText && (
          <div className="hit-prompt" title={n.first_prompt ?? ""}>
            <b>首问:</b>{" "}
            <span
              dangerouslySetInnerHTML={{
                __html: highlightQueryHtml(
                  hasOverflow && !expanded ? promptText.slice(0, 220) + "…" : promptText,
                  query
                ),
              }}
            />
            {hasOverflow && (
              <button
                className="hit-expand"
                onClick={() => setExpanded((v) => !v)}
                title={expanded ? "收起" : "展开完整内容"}
              >
                {expanded ? "收起" : "展开"}
              </button>
            )}
          </div>
        )}
        {n.assistant_text_snippets && n.assistant_text_snippets.length > 0 && (
          <div className="hit-snippets">
            {n.assistant_text_snippets.map((s: string, i) => (
              <div key={i} className="hit-snippet">
                <b>片段 {i + 1}:</b>{" "}
                <span
                  dangerouslySetInnerHTML={{
                    __html: highlightQueryHtml(s, query),
                  }}
                />
              </div>
            ))}
          </div>
        )}
        <div className="hit-meta">
          <span>tokens: {formatNum(n.token_total)}</span>
          <span>thinking: {n.thinking_count}</span>
          <span>errors: {n.error_count}</span>
          <span>subagents: {n.subagent_count}</span>
          <span>model: {n.primary_model ?? "?"}</span>
        </div>
      </div>
    </div>
  );
}
