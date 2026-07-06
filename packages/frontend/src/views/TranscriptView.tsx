/**
 * TranscriptView — Container 角色(slim)
 *
 * 重构后(v0.4.5):
 * - filter + sort 委托 useTranscriptPipeline hook
 * - virtualizer + 自动跟随 + 跳到命中 委托 useTranscriptScroll hook
 * - FilterPanel / SortPanel 用受控组件,不再用 document.getElementById
 * - URL 同步委托 useSessionUrlSync(由 SessionDetailRoute 调用)
 *
 * v0.7.0: ContentFilterPanel 接入 — tool/role/has-attribute 3 维内容筛选,
 *   availableTools 从 summarizeSession(entries) 动态派生。
 *
 * View 本体只负责:
 * - 拿 hook 输出渲染 toolbar + 虚拟列表 + footer
 * - 渲染空 / loading 文案
 */

import { useMemo } from "react";
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
  summarizeSession,
} from "../components/sessionInsights";
import "./TranscriptView.css";

export function TranscriptView() {
  const { t } = useTranslation();
  const path = useTranscriptStore((s) => s.path); // v0.5.0:透传给 MessageBubble
  const entries = useTranscriptStore((s) => s.entries);
  const { loading, totalCount, loadedCount } = useTranscriptStore();
  const currentHit = useSearchInSessionStore(
    (s) => (s.currentHitIndex >= 0 ? s.hits[s.currentHitIndex] : null) ?? null
  );

  const { sortedEntries, sortAsc, setSortAsc } = useTranscriptPipeline();
  const filter = useTranscriptFilterStore();
  const filterActive = isFilterActive(filter);
  const fmtOpts = useFormatOpts();
  const { tz } = fmtOpts;
  const parentSessionId = useParams()?.sessionId; // v0.5.0:从 URL 拿 sessionId 透传给子代理按钮

  const { parentRef } = useTranscriptScroll({ sortedEntries, currentHit });

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

  // ===== v0.7.0:ContentFilterPanel 用的 availableTools / availableModels =====
  // 从 entries 动态派生,反映该 session 实际用到的 tool / model(不硬编码常见列表)。
  const availableTools = useMemo(
    () => summarizeSession(entries).toolUsage.map((t) => t.tool),
    [entries]
  );
  const availableModels = useMemo(() => {
    const set = new Set<string>();
    for (const e of entries) {
      const m = e.normalized.model;
      if (m) set.add(m);
    }
    return Array.from(set).sort();
  }, [entries]);

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
        // ===== Content filter props =====
        availableTools={availableTools}
        selectedTools={filter.tools}
        role={filter.role}
        has={filter.has}
        availableModels={availableModels}
        selectedModels={filter.models}
        sidechainMode={filter.sidechainMode}
        onToggleTool={(t) => useTranscriptFilterStore.getState().toggleTool(t)}
        onSetRole={(r) => useTranscriptFilterStore.getState().setRole(r)}
        onToggleHas={(a) => useTranscriptFilterStore.getState().toggleHas(a)}
        onToggleModel={(m) => useTranscriptFilterStore.getState().toggleModel(m)}
        onSetSidechainMode={(m) => useTranscriptFilterStore.getState().setSidechainMode(m)}
        onClearContent={() =>
          useTranscriptFilterStore.setState({
            tools: [],
            role: undefined,
            has: [],
            models: [],
            sidechainMode: "all",
          })
        }
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

        {/* v0.7.0 重构:放弃 @tanstack/react-virtual,改 flex column。
         * 浏览器原生 gap 处理间距,filter / sort 变化 = React 重渲染,自动重排。
         * 干掉 position:absolute + transform translateY + getBoundingClientRect 这套脆弱设计。 */}
        {sortedEntries.map((entry, idx) => {
          const isCurrentHit = currentHit?.entryIndex === entry.index;
          const idleBefore = idleGapByAfterIndex.get(idx - 1);
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
              key={entry.normalized.id || idx}
              data-index={idx}
              data-entry-index={entry.index}
              className={[
                "transcript-row",
                isCurrentHit ? "search-hit-current" : undefined,
                isRepeatStart ? "msg-repeat-start" : undefined,
                isRepeatContinuation ? "msg-repeat-cont" : undefined,
                isRepeatEnd ? "msg-repeat-end" : undefined,
              ]
                .filter(Boolean)
                .join(" ")}
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
