/**
 * SearchInSessionBar — 会话内搜索栏(Container, slim)
 *
 * 重构后(v0.4.5):
 * - searchableEntries 抽出到 useSearchableEntries hook
 *   (复用 lib/filterEntries.applyTimeFilter,跟 TranscriptView pipeline 共享)
 * - 不再直接订阅 useTranscriptFilterStore() 全量
 * - 滚动职责移到 TranscriptView(通过 useTranscriptScroll),本组件
 *   只在 row 点击时 setCurrentHitIndex,不重复 scrollIntoView(v0.4.3 fix)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, X, ChevronUp, ChevronDown } from "lucide-react";

import { useSearchInSessionStore } from "../state/searchInSessionStore";
import { useSearchableEntries } from "../hooks/useSearchableEntries";
import { useKey } from "../lib/keymap";
import { formatTimeShort } from "../lib/format";
import { useFormatOpts } from "../hooks/useFormatOpts";
import "./SearchInSessionBar.css";

interface Props {
  /** 外部控制:跳到指定 entry 的回调(由 useTranscriptScroll 提供) */
  onJump?: (entryIndex: number) => void;
}

/** v0.4.3: dropdown 最多渲染多少行(避免 500+ 命中时卡) */
const MAX_VISIBLE_HITS = 100;
const SEARCH_DEBOUNCE_MS = 200;

export function SearchInSessionBar({ onJump: _onJump }: Props) {
  const { t } = useTranslation();
  const fmtOpts = useFormatOpts();
  // 分别订阅各个状态,避免返回整个 store 导致引用频繁变化
  const open = useSearchInSessionStore((s) => s.open);
  const query = useSearchInSessionStore((s) => s.query);
  const hits = useSearchInSessionStore((s) => s.hits);
  const currentHitIndex = useSearchInSessionStore((s) => s.currentHitIndex);
  const setQuery = useSearchInSessionStore((s) => s.setQuery);
  const search = useSearchInSessionStore((s) => s.search);
  const next = useSearchInSessionStore((s) => s.next);
  const prev = useSearchInSessionStore((s) => s.prev);
  const setCurrentHitIndex = useSearchInSessionStore((s) => s.setCurrentHitIndex);
  const hide = useSearchInSessionStore((s) => s.hide);

  // 搜索范围 = filter 后的 entries(与 TranscriptView 渲染管线一致)
  const searchableEntries = useSearchableEntries();

  const inputRef = useRef<HTMLInputElement>(null);
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  // 防抖:输入 200ms 后才搜索
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // 仅在 query 或 entries 变化时搜索,open 关闭时不搜索
  useEffect(() => {
    if (!open) return;
    search(searchableEntries);
    // search 函数本身引用稳定(zustand action),不放入 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, debouncedQuery, searchableEntries]);

  // 当前命中 — 仅派生,不重复 scroll
  const currentHit =
    currentHitIndex >= 0 && currentHitIndex < hits.length ? hits[currentHitIndex] : null;

  // v0.4.3: 键位 — n/p/Enter/Shift+Enter/↑/↓
  useKey("escape", () => hide(), [open]);
  useKey("enter", () => next(), [open]);
  useKey("shift+enter", () => prev(), [open]);
  useKey("n", () => next(), [open]);
  useKey("p", () => prev(), [open]);
  useKey(
    "arrowdown",
    () => {
      if (query.length > 0) next();
    },
    [open, query]
  );
  useKey(
    "arrowup",
    () => {
      if (query.length > 0) prev();
    },
    [open, query]
  );

  if (!open) return null;

  const showDropdown = query.length > 0;
  const visibleHits = useMemo(() => hits.slice(0, MAX_VISIBLE_HITS), [hits]);
  const moreCount = hits.length - visibleHits.length;

  return (
    <div className="search-in-session-bar-wrapper">
      <div className="search-in-session-bar">
        <Search size={14} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("search.inSession")}
        />
        <span className="search-counter">
          {hits.length > 0 ? `${currentHitIndex + 1} / ${hits.length}` : query ? "0 / 0" : ""}
        </span>
        <button onClick={prev} disabled={hits.length === 0} title={t("search.prev")}>
          <ChevronUp size={14} />
        </button>
        <button onClick={next} disabled={hits.length === 0} title={t("search.next")}>
          <ChevronDown size={14} />
        </button>
        <button onClick={hide} title="关闭">
          <X size={14} />
        </button>
      </div>
      {showDropdown && (
        <div className="search-results-dropdown">
          {hits.length === 0 && (
            <div className="search-results-empty">{t("searchInSession.noResults")}</div>
          )}
          {visibleHits.map((hit, i) => {
            const entry = searchableEntries.find((e) => e.index === hit.entryIndex);
            const role = entry?.normalized.role ?? "unknown";
            const ts = entry?.normalized.timestamp;
            return (
              <button
                key={`${hit.entryIndex}-${hit.charOffset}-${i}`}
                className={`search-result-row ${i === currentHitIndex ? "is-active" : ""}`}
                onClick={() => {
                  setCurrentHitIndex(i);
                  // v0.4.3 fix: 点击后清空 query, dropdown 自动折叠
                  setQuery("");
                  inputRef.current?.focus();
                }}
                onMouseEnter={() => setCurrentHitIndex(i)}
              >
                <div className="search-result-meta">
                  <span>#{hit.entryIndex}</span>
                  <span>·</span>
                  <span>{role}</span>
                  {ts && (
                    <>
                      <span>·</span>
                      <span>{formatTimeShort(ts, fmtOpts)}</span>
                    </>
                  )}
                </div>
                <div className="search-result-snippet">{hit.snippet}</div>
              </button>
            );
          })}
          {moreCount > 0 && (
            <div className="search-results-more">
              {t("searchInSession.more", { count: moreCount })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
