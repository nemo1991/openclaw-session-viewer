import { useEffect, useRef, useState, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";

import { useTranscriptStore } from "../state/transcriptStore";
import { useSearchInSessionStore } from "../state/searchInSessionStore";
import { MessageBubble } from "../components/MessageBubble";
import "./TranscriptView.css";

export function TranscriptView() {
  const { t } = useTranslation();
  const { entries, loading, totalCount, loadedCount } = useTranscriptStore();
  const currentHit = useSearchInSessionStore((s) =>
    s.currentHitIndex >= 0 ? s.hits[s.currentHitIndex] : null
  );
  const parentRef = useRef<HTMLDivElement>(null);
  const [sortAsc, setSortAsc] = useState(true); // true=正序(旧→新), false=倒序(新→旧)

  // 根据 sortAsc 排序 entries
  const sortedEntries = useMemo(() => {
    if (sortAsc) return entries;
    return [...entries].reverse();
  }, [entries, sortAsc]);

  const virtualizer = useVirtualizer({
    count: sortedEntries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 120,
    overscan: 10,
  });

  useEffect(() => {
    // 自动滚到底部 (新增时,且当前不在搜索结果中)
    if (currentHit) return;
    if (!sortAsc) return; // 倒序时不上滚
    const last = virtualizer.getVirtualItems().at(-1);
    if (last && parentRef.current) {
      const items = virtualizer.getVirtualItems();
      const lastIdx = items[items.length - 1]?.index ?? 0;
      if (lastIdx >= sortedEntries.length - 5) {
        parentRef.current.scrollTop = parentRef.current.scrollHeight;
      }
    }
  }, [entries.length, virtualizer, currentHit, sortAsc, sortedEntries.length]);

  return (
    <div className="transcript-view">
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
      <div className="transcript-scroll" ref={parentRef}>
        {sortedEntries.length === 0 && loading && (
          <div className="transcript-loading">{t("detail.loading")}</div>
        )}
        {sortedEntries.length === 0 && !loading && <div className="transcript-empty">无消息</div>}

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
          : `已加载 ${entries.length} 条 · ${sortAsc ? "正序" : "倒序"}`}
      </footer>
    </div>
  );
}
