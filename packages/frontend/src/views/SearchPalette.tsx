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

  // 搜索完成后(有 query + 不在 searching + hits 稳定)记录一条
  useEffect(() => {
    if (!debouncedQuery.trim() || searching) return;
    // debounce 500ms 避免抖动
    const t = setTimeout(() => {
      void apiRecordSearch(debouncedQuery.trim(), hits.length)
        .then(() => {
          // 刷新历史
          void apiListSearchHistory(10)
            .then(setHistory)
            .catch(() => {});
        })
        .catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [debouncedQuery, hits.length, searching]);

  useKey("escape", () => hide());
  useKey("enter", () => {
    if (hits.length > 0) {
      const h = hits[0]!;
      navigate(`/session/${encodeURIComponent(h.sessionId)}`, {
        state: { session: { sessionId: h.sessionId, jsonlPath: h.sessionPath } },
      });
      hide();
    }
  });

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
