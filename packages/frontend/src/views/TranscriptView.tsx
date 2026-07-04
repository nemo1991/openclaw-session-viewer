/**
 * TranscriptView — Container 角色(slim)
 *
 * 重构后(v0.4.5):
 * - filter + sort 委托 useTranscriptPipeline hook
 * - virtualizer + 自动跟随 + 跳到命中 委托 useTranscriptScroll hook
 * - FilterPanel / SortPanel 用受控组件,不再用 document.getElementById
 * - URL 同步委托 useSessionUrlSync(由 SessionDetailRoute 调用)
 *
 * View 本体只负责:
 * - 拿 hook 输出渲染 toolbar + 虚拟列表 + footer
 * - 渲染空 / loading 文案
 */

import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";

import { useTranscriptStore } from "../state/transcriptStore";
import { useSearchInSessionStore } from "../state/searchInSessionStore";
import { useTranscriptFilterStore, isFilterActive } from "../state/transcriptFilterStore";
import { useTranscriptPipeline } from "../hooks/useTranscriptPipeline";
import { useTranscriptScroll } from "../hooks/useTranscriptScroll";
import { useFormatOpts } from "../hooks/useFormatOpts";
import { isoToLocalInputInTz, formatLocalInputToIsoInTz } from "../lib/format";
import { MessageBubble } from "../components/MessageBubble";
import { TranscriptToolbar } from "./panels/TranscriptToolbar";
import {
  findRepeatRuns,
  findIdleGaps,
  findRunForEntry,
  formatIdleGap,
} from "../components/sessionInsights";
import "./TranscriptView.css";

export function TranscriptView() {
  const { t } = useTranslation();
  const path = useTranscriptStore((s) => s.path); // v0.5.0:透传给 MessageBubble
  const { loading, totalCount, loadedCount } = useTranscriptStore();
  const currentHit = useSearchInSessionStore(
    (s) => (s.currentHitIndex >= 0 ? s.hits[s.currentHitIndex] : null) ?? null
  );

  const { entries, sortedEntries, sortAsc, setSortAsc } = useTranscriptPipeline();
  const filter = useTranscriptFilterStore();
  const filterActive = isFilterActive(filter);
  const fmtOpts = useFormatOpts();
  const { tz } = fmtOpts;
  const parentSessionId = useParams()?.sessionId; // v0.5.0:从 URL 拿 sessionId 透传给子代理按钮

  const { parentRef, virtualizer } = useTranscriptScroll({ sortedEntries, currentHit });

  // ===== 聚合提示(去噪)— 跟 SessionDetailRoute header 用同一组函数 =====
  // 注意:这里只对"原 entries"(未排序、未过滤)算 repeat runs,因为排序会破坏
  // "连续"语义。idle gap 用 sortedEntries 算(过滤后用户看到的间隔)。
  const repeatRuns = findRepeatRuns(entries, 3);
  const idleGaps = findIdleGaps(sortedEntries, 5 * 60_000);
  /** entry.index → gap 之后的 idle gap(用于在 entry 之前显示) */
  const idleGapByAfterIndex = new Map<number, number>();
  for (const g of idleGaps) {
    idleGapByAfterIndex.set(g.afterIndex, g.durationMs);
  }

  return (
    <div className="transcript-view">
      <TranscriptToolbar
        preset={filter.preset}
        from={filter.from}
        to={filter.to}
        tz={tz}
        sortAsc={sortAsc}
        localInputToIso={(input) => formatLocalInputToIsoInTz(input, tz)}
        isoToLocalInput={(iso) => isoToLocalInputInTz(iso, tz)}
        onPresetChange={(p) => useTranscriptFilterStore.getState().setPreset(p)}
        onApply={(from, to) => useTranscriptFilterStore.getState().setRange(from, to)}
        onClear={() => useTranscriptFilterStore.getState().clear()}
        onSortChange={setSortAsc}
      />
      <div className="transcript-scroll" ref={parentRef} data-testid="transcript-scroll">
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
            const idleBefore = idleGapByAfterIndex.get(virtualRow.index - 1);
            const repeatRun = findRunForEntry(repeatRuns, entry.index);
            const isRepeatStart = repeatRun !== null && repeatRun.startIndex === entry.index;
            const isRepeatContinuation =
              repeatRun !== null &&
              entry.index > repeatRun.startIndex &&
              entry.index < repeatRun.endIndex;
            const isRepeatEnd =
              repeatRun !== null && entry.index === repeatRun.endIndex && repeatRun.count >= 2;
            return (
              <div
                key={entry.normalized.id || virtualRow.index}
                data-index={virtualRow.index}
                data-entry-index={entry.index}
                ref={virtualizer.measureElement}
                className={[
                  isCurrentHit ? "search-hit-current" : undefined,
                  isRepeatStart ? "msg-repeat-start" : undefined,
                  isRepeatContinuation ? "msg-repeat-cont" : undefined,
                  isRepeatEnd ? "msg-repeat-end" : undefined,
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {idleBefore !== undefined && (
                  <div className="transcript-idle-gap" data-testid="transcript-idle-gap">
                    <span className="transcript-idle-line" />
                    <span className="transcript-idle-label">间隔 {formatIdleGap(idleBefore)}</span>
                    <span className="transcript-idle-line" />
                  </div>
                )}
                {isRepeatStart && repeatRun && repeatRun.count >= 2 && (
                  <div
                    className="transcript-repeat-run"
                    data-testid="transcript-repeat-run"
                    title={`${repeatRun.tool} 连续 ${repeatRun.count} 次`}
                  >
                    <span className="transcript-repeat-label">
                      {repeatRun.tool} 连续 {repeatRun.count} 次
                    </span>
                  </div>
                )}
                <MessageBubble
                  entry={entry}
                  parentJsonlPath={path ?? undefined}
                  parentSessionId={parentSessionId}
                />
              </div>
            );
          })}
        </div>
      </div>

      <footer className="transcript-footer" data-testid="transcript-footer">
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
