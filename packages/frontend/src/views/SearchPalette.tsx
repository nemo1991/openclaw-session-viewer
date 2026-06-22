import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Search, X } from "lucide-react";

import { useSearchStore } from "../state/searchStore";
import { useKey } from "../lib/keymap";
import "./SearchPalette.css";

export function SearchPalette() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { query, hits, searching, setQuery, search, hide } = useSearchStore();
  const [debouncedQuery, setDebouncedQuery] = useState(query);
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
              <div className="search-hit-snippet">
                {h.hit.snippet}
              </div>
              <div className="search-hit-meta">
                第 {h.hit.index} 条
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
