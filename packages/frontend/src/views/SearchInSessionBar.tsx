import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, X, ChevronUp, ChevronDown } from "lucide-react";

import { useSearchInSessionStore } from "../state/searchInSessionStore";
import { useTranscriptStore } from "../state/transcriptStore";
import { useTranscriptFilterStore, isFilterActive } from "../state/transcriptFilterStore";
import { useKey } from "../lib/keymap";
import { formatTimeShort } from "../lib/format";
import { useFormatOpts } from "../hooks/useFormatOpts";
import "./SearchInSessionBar.css";

interface Props {
  /** 外部控制:跳到指定 entry 的回调 */
  onJump?: (entryIndex: number) => void;
}

/** v0.4.3: dropdown 最多渲染多少行(避免 500+ 命中时卡) */
const MAX_VISIBLE_HITS = 100;

export function SearchInSessionBar({ onJump }: Props) {
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

  const entries = useTranscriptStore((s) => s.entries);
  const filter = useTranscriptFilterStore();
  const filterActive = isFilterActive(filter);

  // 搜索只在筛选后的范围跑,这样 search hit 不会指向被过滤掉的 entry
  const searchableEntries = filterActive
    ? entries.filter((e) => {
        const ts = e.normalized.timestamp;
        if (!ts) return true;
        const ms = new Date(ts).getTime();
        const fromMs = filter.from ? new Date(filter.from).getTime() : -Infinity;
        const toMs = filter.to ? new Date(filter.to).getTime() : Infinity;
        return isNaN(ms) || (ms >= fromMs && ms <= toMs);
      })
    : entries;

  const inputRef = useRef<HTMLInputElement>(null);
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  // 防抖:输入 200ms 后才搜索
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  // 仅在 query 或 entries 变化时搜索,open 关闭时不搜索
  useEffect(() => {
    if (!open) return;
    search(searchableEntries);
    // search 函数本身引用稳定(zustand action),不放入 deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, debouncedQuery, searchableEntries]);

  // 当前命中变化时跳转
  const currentHit =
    currentHitIndex >= 0 && currentHitIndex < hits.length ? hits[currentHitIndex] : null;
  useEffect(() => {
    if (currentHit && onJump) {
      onJump(currentHit.entryIndex);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentHitIndex]);

  // v0.4.3: 键位 — n/p/Enter/Shift+Enter/↑/↓
  // 已有 n/p 缺失补上;↑/↓ 在有 query 时 intercept(空 query 让出原生光标行为)
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
  const visibleHits = hits.slice(0, MAX_VISIBLE_HITS);
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
            const entry = entries.find((e) => e.index === hit.entryIndex);
            const role = entry?.normalized.role ?? "unknown";
            const ts = entry?.normalized.timestamp;
            return (
              <button
                key={`${hit.entryIndex}-${hit.charOffset}-${i}`}
                className={`search-result-row ${i === currentHitIndex ? "is-active" : ""}`}
                onClick={() => {
                  setCurrentHitIndex(i);
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
