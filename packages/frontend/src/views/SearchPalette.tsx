import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Search, X, History } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import { useSearchStore } from "../state/searchStore";
import { useKey } from "../lib/keymap";
import { apiRecordSearch, apiListSearchHistory } from "../lib/overridesApi";
import "./SearchPalette.css";

interface SearchHistoryItem {
  id: number;
  query: string;
  hitCount: number;
  ts: number;
}

export function SearchPalette() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { query, hits, searching, setQuery, search, hide } = useSearchStore();
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [history, setHistory] = useState<SearchHistoryItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    void search(debouncedQuery);
  }, [debouncedQuery, search]);

  // v0.8.0: 加载搜索历史(只在打开时拉一次)
  useEffect(() => {
    void apiListSearchHistory(10)
      .then(setHistory)
      .catch(() => {});
  }, []);

  // v0.8.14 item E: 移除自动 record-search effect — 之前 deps [debouncedQuery,
  // hits.length, searching] 每次 search 完成都重置 500ms timer,typing "claude code"
  // 多次 search 完成 → 多次 setTimeout(虽然 cleanup 会 cancel 旧的,实际上仍可能 fire
  // 多次)。改成只在 Enter 提交时 record 一次。
  //
  // 副作用:用户 typing 但没 Enter 不再写历史 — 接受,因为这是 user-initiated 行为。
  // 历史只记 "user 真正提交过的搜索",更有意义。
  //
  // 注意: useKey 默认 deps=[] 闭包捕获首渲染的 hits/debouncedQuery,
  // 必须传 [hits, debouncedQuery] 让 handler 每次都拿到最新值,否则 Enter
  // 永远看到 hits=[] / debouncedQuery="" — record + navigate 都不会触发。

  useKey("escape", () => hide());
  useKey(
    "enter",
    () => {
      if (hits.length > 0) {
        const h = hits[0]!;
        const queryToRecord = debouncedQuery.trim();
        const hitsCount = hits.length;
        // v0.8.14 item E: 提交时立刻 record(也是 fire-and-forget,
        // 不 await 让 navigation 不被 IPC 阻塞)
        if (queryToRecord) {
          void apiRecordSearch(queryToRecord, hitsCount)
            .then(() => {
              void apiListSearchHistory(10)
                .then(setHistory)
                .catch(() => {});
            })
            .catch(() => {});
        }
        navigate(`/session/${encodeURIComponent(h.sessionId)}`, {
          state: { session: { sessionId: h.sessionId, jsonlPath: h.sessionPath } },
        });
        hide();
      }
    },
    [hits, debouncedQuery]
  );

  return (
    <div className="search-palette-overlay" onClick={hide}>
      <div className="search-palette" onClick={(e) => e.stopPropagation()}>
        <div className="search-palette-header">
          <Search size={16} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("search.title")}
          />
          <button onClick={hide}>
            <X size={14} />
          </button>
        </div>
        <div className="search-palette-body">
          {searching && <div className="search-status">{t("search.searching")}</div>}
          {!searching && hits.length === 0 && query && (
            <div className="search-status">{t("search.noResults")}</div>
          )}
          {!query && history.length > 0 && (
            <div className="search-history" data-testid="search-history">
              <h4>
                <History size={12} /> 最近搜索
              </h4>
              {history.map((h) => (
                <div
                  key={h.id}
                  className="search-history-item"
                  onClick={() => setQuery(h.query)}
                  title={`${h.hitCount} 个命中 · ${new Date(h.ts).toLocaleString()}`}
                >
                  <span className="history-query">{h.query}</span>
                  <span className="history-meta">{h.hitCount} 个</span>
                </div>
              ))}
            </div>
          )}
          {hits.map((h, i) => (
            <div
              key={`${h.sessionPath}-${h.hit.index}-${i}`}
              className="search-hit"
              onClick={() => {
                const hit = h;
                navigate(`/session/${encodeURIComponent(hit.sessionId)}`, {
                  state: { session: { sessionId: hit.sessionId, jsonlPath: hit.sessionPath } },
                });
                hide();
              }}
            >
              <div className="search-hit-title">
                {h.title || h.sessionId.slice(0, 8)}
                <span className="source-badge source-claude">{h.source}</span>
              </div>
              <div className="search-hit-snippet">{h.hit.snippet}</div>
              <div className="search-hit-meta">第 {h.hit.index} 条</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
