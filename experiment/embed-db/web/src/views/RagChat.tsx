/**
 * RagChat — S3 M1 PoC
 *
 * 工作流:
 * 1. 加载 sessions.ndjson
 * 2. 把每个 session 的 `first_prompt + assistant_text_snippets[]` 拼成 corpus
 * 3. embed corpus (hash embedding, 32-dim)
 * 4. 用户输入 query → topK cosine → 显示 top 5 sessions (高亮 matched tokens)
 *
 * 不用 LLM,只做"召回"。每张召回卡片:
 * - session_id (短)
 * - workspace
 * - first_prompt (摘要)
 * - 命中片段 (HTML 高亮 query tokens)
 * - cosine 分数
 *
 * 提供「预设 query」按钮快速探索
 */

import { useEffect, useMemo, useState } from "react";
import type { GraphEntry, SessionNode } from "../types";
import { loadNdjson } from "../loader";
import { formatNum } from "../analytics";
import { indexCorpus, topK, highlightHtml, type IndexedItem, type RetrievalHit } from "../rag";
import { useTitles } from "../titleStore";
import "./RagChat.css";

const NDJSON_URL = "/sessions.ndjson";

const PRESETS = [
  { label: "失败 / retry", q: "失败 错误 retry 不能" },
  { label: "explore 探索", q: "Explore 探索 调查" },
  { label: "openclaw session", q: "openclaw session" },
  { label: "SQLite / api", q: "SQLite API CRUD" },
  { label: "axios / curl", q: "fetch axios curl http" },
  { label: "rust / cargo", q: "cargo tauri Rust" },
];

function corpusText(n: SessionNode): string {
  // 把 first_prompt + assistant snippets 拼起来 — RAG 检索源
  const parts: string[] = [];
  if (n.workspace) parts.push(n.workspace);
  if (n.first_prompt) parts.push(n.first_prompt);
  if (n.assistant_text_snippets) parts.push(...n.assistant_text_snippets);
  return parts.join("\n");
}

export function RagChat() {
  const [entries, setEntries] = useState<GraphEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RetrievalHit<SessionNode>[] | null>(null);
  const [engineMs, setEngineMs] = useState<number | null>(null);
  const [topN, setTopN] = useState(8);
  const titles = useTitles();
  /** localStorage 自定义标题计数 — 跨视图共享,G1 改完这里立刻显示 */
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
    // 自定义事件 — 详情面板 set/clear 时主动触发,让当前 view 也重渲染
    window.addEventListener("openclaw:titlesChanged", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("openclaw:titlesChanged", sync);
    };
  }, [titles]);

  useEffect(() => {
    loadNdjson(NDJSON_URL)
      .then(setEntries)
      .catch((e) => setError(String(e)));
  }, []);

  // 索引 corpus (一次);计算与计时分离:setState 不允许在 useMemo 里跑
  const index: IndexedItem<SessionNode>[] = useMemo(() => {
    if (!entries) return [];
    const nodes = entries
      .map((e) => e?.node)
      .filter((n): n is SessionNode => Boolean(n && n.node_id));
    return indexCorpus(nodes, corpusText);
  }, [entries]);

  const lastIndexedCount = useMemo(() => (entries ? entries.length : 0), [entries]);

  // 仅 entries 数变时才重测索引构建耗时
  useEffect(() => {
    if (!entries) return;
    const nodes = entries
      .map((e) => e?.node)
      .filter((n): n is SessionNode => Boolean(n && n.node_id));
    const t0 = performance.now();
    indexCorpus(nodes, corpusText);
    const t1 = performance.now();
    setEngineMs(t1 - t0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastIndexedCount]);

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

  if (error) return <div className="error">❌ {error}</div>;
  if (!entries) return <div className="loading">加载 sessions.ndjson ...</div>;

  return (
    <div className="rag-chat">
      <header className="rag-header">
        <h2>G3 RAG (lite) — 跨 session 召回</h2>
        <p className="hint">
          hash-embedding + cosine top-{topN} · 索引 {index.length} sessions · 32-dim 词袋 · 0 deps
          {overrideCount > 0 && ` · ✏️ ${overrideCount} 个自定义名已应用到 G1/G2/G3`}
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

      {hits && hits.length === 0 && <div className="empty">没有匹配 session</div>}

      <div className="hits">
        {hits?.map((h, i) => (
          <HitCard key={h.item.node_id} hit={h} rank={i + 1} query={query} />
        ))}
      </div>
    </div>
  );
}

function HitCard({ hit, rank }: { hit: RetrievalHit<SessionNode>; rank: number; query: string }) {
  const n = hit.item;
  const matched = hit.matched_tokens;
  const titles = useTitles();
  const title = titles.get(n.node_id, titles.auto(n));
  return (
    <div className="hit-card">
      <div className="hit-rank">{rank}</div>
      <div className="hit-body">
        <div className="hit-header">
          <span className="hit-session" title={n.session_id}>
            {title}
          </span>
          <span className="hit-source">{n.source}</span>
          {n.workspace && <span className="hit-workspace">{n.workspace}</span>}
          <span className="hit-score">cosine: {hit.score.toFixed(3)}</span>
        </div>
        {n.first_prompt && (
          <div className="hit-prompt" title={n.first_prompt}>
            <b>首问:</b>{" "}
            <span
              dangerouslySetInnerHTML={{
                __html: highlightHtml(n.first_prompt.slice(0, 220), matched),
              }}
            />
          </div>
        )}
        {n.assistant_text_snippets && n.assistant_text_snippets.length > 0 && (
          <div className="hit-snippets">
            {n.assistant_text_snippets.map((s: string, i: number) => (
              <div key={i} className="hit-snippet">
                <b>片段 {i + 1}:</b>{" "}
                <span
                  dangerouslySetInnerHTML={{
                    __html: highlightHtml(s, matched),
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
