import { useEffect, useRef, useState, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";

import { useTranscriptStore } from "../state/transcriptStore";
import { useSearchInSessionStore } from "../state/searchInSessionStore";
import {
  useTranscriptFilterStore,
  isFilterActive,
  type FilterPreset,
} from "../state/transcriptFilterStore";
import { MessageBubble } from "../components/MessageBubble";
import { isoToLocalInputInTz, formatLocalInputToIsoInTz } from "../lib/format";
import { useFormatOpts } from "../hooks/useFormatOpts";
import "./TranscriptView.css";

export function TranscriptView() {
  const { t } = useTranslation();
  const { entries, loading, totalCount, loadedCount } = useTranscriptStore();
  const currentHit = useSearchInSessionStore((s) =>
    s.currentHitIndex >= 0 ? s.hits[s.currentHitIndex] : null
  );
  const filter = useTranscriptFilterStore();
  const filterActive = isFilterActive(filter);
  const parentRef = useRef<HTMLDivElement>(null);
  const [sortAsc, setSortAsc] = useState(true); // true=正序(旧→新), false=倒序(新→旧)

  // 时间筛选 + 排序
  const filteredEntries = useMemo(() => {
    if (!filterActive) return entries;
    const fromMs = filter.from ? new Date(filter.from).getTime() : -Infinity;
    const toMs = filter.to ? new Date(filter.to).getTime() : Infinity;
    return entries.filter((e) => {
      const t = e.normalized.timestamp;
      if (!t) return true; // meta 条目保留
      const ms = new Date(t).getTime();
      if (isNaN(ms)) return true; // 解析失败保留
      return ms >= fromMs && ms <= toMs;
    });
  }, [entries, filter.from, filter.to, filterActive]);

  const sortedEntries = useMemo(() => {
    if (sortAsc) return filteredEntries;
    return [...filteredEntries].reverse();
  }, [filteredEntries, sortAsc]);

  const virtualizer = useVirtualizer({
    count: sortedEntries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 10,
  });

  useEffect(() => {
    // 自动滚到底部:仅在正序、无搜索、加载完成、无筛选时
    if (currentHit) return;
    if (!sortAsc) return;
    if (filterActive) return;
    const last = virtualizer.getVirtualItems().at(-1);
    if (last && parentRef.current) {
      const items = virtualizer.getVirtualItems();
      const lastIdx = items[items.length - 1]?.index ?? 0;
      if (lastIdx >= sortedEntries.length - 5) {
        parentRef.current.scrollTop = parentRef.current.scrollHeight;
      }
    }
  }, [entries.length, virtualizer, currentHit, sortAsc, filterActive, sortedEntries.length]);

  return (
    <div className="transcript-view">
      <div className="transcript-toolbar">
        <div className="transcript-sort-bar">
          <button
            className={`sort-btn ${sortAsc ? "sort-btn-active" : ""}`}
            onClick={() => setSortAsc(true)}
            title="从旧到新"
          >
            ↑ 正序
          </button>
          <button
            className={`sort-btn ${!sortAsc ? "sort-btn-active" : ""}`}
            onClick={() => setSortAsc(false)}
            title="从新到旧"
          >
            ↓ 倒序
          </button>
        </div>
        <FilterBar />
      </div>
      <div className="transcript-scroll" ref={parentRef}>
        {sortedEntries.length === 0 && loading && (
          <div className="transcript-loading">{t("detail.loading")}</div>
        )}
        {sortedEntries.length === 0 && !loading && (
          <div className="transcript-empty">
            {filterActive ? t("detail.filter.noMatch") : t("detail.empty")}
          </div>
        )}

        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const entry = sortedEntries[virtualRow.index];
            if (!entry) return null;
            const isCurrentHit = currentHit?.entryIndex === entry.index;
            return (
              <div
                key={entry.normalized.id || virtualRow.index}
                data-index={virtualRow.index}
                data-entry-index={entry.index}
                ref={virtualizer.measureElement}
                className={isCurrentHit ? "search-hit-current" : undefined}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <MessageBubble entry={entry} />
              </div>
            );
          })}
        </div>
      </div>

      <footer className="transcript-footer">
        {loading
          ? `流式加载中… ${loadedCount}/${totalCount}`
          : filterActive
            ? t("detail.filter.showingFiltered", {
                shown: sortedEntries.length,
                total: entries.length,
              }) + ` · ${sortAsc ? "正序" : "倒序"}`
            : `已加载 ${entries.length} 条 · ${sortAsc ? "正序" : "倒序"}`}
      </footer>
    </div>
  );
}

/**
 * 时间筛选 bar — 4 个 preset + 自定义范围
 */
function FilterBar() {
  const { t } = useTranslation();
  const { tz } = useFormatOpts();
  const preset = useTranscriptFilterStore((s) => s.preset);
  const from = useTranscriptFilterStore((s) => s.from);
  const to = useTranscriptFilterStore((s) => s.to);
  const setPreset = useTranscriptFilterStore((s) => s.setPreset);
  const setRange = useTranscriptFilterStore((s) => s.setRange);
  const clear = useTranscriptFilterStore((s) => s.clear);

  const presets: Array<{ value: FilterPreset; label: string }> = [
    { value: "all", label: t("detail.filter.all") },
    { value: "1h", label: t("detail.filter.last1h") },
    { value: "24h", label: t("detail.filter.last24h") },
    { value: "7d", label: t("detail.filter.last7d") },
  ];

  // v0.4.2: naive datetime-local 字符串按选定 TZ 解析,不再依赖浏览器 OS TZ
  const handleApply = () => {
    const fromVal = (document.getElementById("filter-from") as HTMLInputElement)?.value;
    const toVal = (document.getElementById("filter-to") as HTMLInputElement)?.value;
    setRange(
      fromVal ? formatLocalInputToIsoInTz(fromVal, tz) : undefined,
      toVal ? formatLocalInputToIsoInTz(toVal, tz) : undefined
    );
  };

  return (
    <div className="transcript-filter-bar">
      {presets.map((p) => (
        <button
          key={p.value}
          className={`filter-btn ${preset === p.value ? "filter-btn-active" : ""}`}
          onClick={() => setPreset(p.value)}
        >
          {p.label}
        </button>
      ))}
      <button
        className={`filter-btn ${preset === "custom" ? "filter-btn-active" : ""}`}
        onClick={() => setPreset("custom")}
      >
        {t("detail.filter.custom")}
      </button>
      {preset === "custom" && (
        <div className="filter-custom">
          <input
            id="filter-from"
            type="datetime-local"
            defaultValue={from ? isoToLocalInputInTz(from, tz) : ""}
            placeholder={t("detail.filter.from")}
            key={`from-${tz}-${from ?? ""}`}
          />
          <span>~</span>
          <input
            id="filter-to"
            type="datetime-local"
            defaultValue={to ? isoToLocalInputInTz(to, tz) : ""}
            placeholder={t("detail.filter.to")}
            key={`to-${tz}-${to ?? ""}`}
          />
          <span className="filter-tz-label">
            ({tz === "auto" ? Intl.DateTimeFormat().resolvedOptions().timeZone : tz})
          </span>
          <button className="filter-apply-btn" onClick={handleApply}>
            {t("detail.filter.apply")}
          </button>
          <button className="filter-clear-btn" onClick={clear}>
            {t("detail.filter.clear")}
          </button>
        </div>
      )}
    </div>
  );
}
