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
 *   availableTools 从 meta.toolUsage 派生(从 DB 读)。
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
  // v0.8.4 item 2'': availableTools 从 meta.toolUsage 读, 不再调 summarizeSession。
  // 函数本体保留(给未来 TrajectoryRoute / AnalyzeRoute 复用), 这里不再 import。
  findRepeatRuns,
  findIdleGaps,
  findRunForEntry,
  formatIdleGap,
} from "../components/sessionInsights";
import type { SessionMeta } from "@ocsv/shared";
import "./TranscriptView.css";

export function TranscriptView({ meta }: { meta?: SessionMeta }) {
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

  const { parentRef, virtualizer } = useTranscriptScroll({ sortedEntries, currentHit });

  // ===== 聚合提示(去噪)— 跟 SessionDetailRoute header 用同一组函数 =====
  // 注意:这里只对"原 entries"(未排序、未过滤)算 repeat runs,因为排序会破坏
  // "连续"语义。idle gap 用 sortedEntries 算(过滤后用户看到的间隔)。
  //
  // 这两个不能从 DB 派生 — DB 只存了 count 聚合 (repeat_run_count / idle_gap_count),
  // 没存每个 run 的 startIndex / endIndex (依赖当前过滤窗口)。所以 entry-级 marker
  // 必须在虚拟列表渲染层现场算。
  //
  // v0.8.4 item 2''+: 大 session (3000+ entry) 倒序时必卡 — 每次 render O(n) 重跑
  // 全量 scan。useMemo 锁住 deps, 只有 entries / sortedEntries reference 变化才重算。
  // meta prop 变化(例如 override toggle) 不会触发重算。
  const repeatRuns = useMemo(
    () => (entries.length === 0 ? [] : findRepeatRuns(entries, 3)),
    [entries]
  );
  const idleGaps = useMemo(
    () => (sortedEntries.length === 0 ? [] : findIdleGaps(sortedEntries, 5 * 60_000)),
    [sortedEntries]
  );
  /** entry.index → gap 之后的 idle gap(用于在 entry 之前显示) */
  const idleGapByAfterIndex = useMemo(() => {
    const m = new Map<number, number>();
    for (const g of idleGaps) {
      m.set(g.afterIndex, g.durationMs);
    }
    return m;
  }, [idleGaps]);

  // ===== v0.8.4 item 2'': ContentFilterPanel 用的 availableTools 走 DB =====
  // 之前从 summarizeSession(entries) 派生, 现在直接读 meta.toolUsage
  // (sync 二阶段 enrich 写到 session_meta.tool_usage_json)。
  // fallback: meta 还没拿到 / enrich 没跑完时 entries 派生, 避免空 tool chip。
  //
  // v0.8.5 D: 返回 `[tool_name, count]` tuple, chip 渲染 `${tool} × ${count}`,
  // 不再丢 count。按 count desc 排序(DB 已排好, fallback 也按 count 排)。
  const availableTools = useMemo<Array<[string, number]>>(() => {
    if (meta?.toolUsage && meta.toolUsage.length > 0) {
      return meta.toolUsage; // DB 已经是 count desc 紧凑数组
    }
    // fallback: enrich 还没跑完时 entries 派生
    const counts = new Map<string, number>();
    for (const e of entries) {
      for (const b of e.normalized.blocks ?? []) {
        if (b && (b as any).kind === "tool_use") {
          const name = String((b as any).name ?? "?");
          counts.set(name, (counts.get(name) ?? 0) + 1);
        }
      }
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [meta?.toolUsage, entries]);
  const availableModels = useMemo(() => {
    // v0.8.4 item 2'': 优先 meta.availableModels (DB 派生); fallback entries 派生
    if (meta?.availableModels && meta.availableModels.length > 0) {
      return meta.availableModels;
    }
    const set = new Set<string>();
    for (const e of entries) {
      const m = e.normalized.model;
      if (m) set.add(m);
    }
    return Array.from(set).sort();
  }, [meta?.availableModels, entries]);

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
        errorMode={filter.errorMode}
        onToggleTool={(t) => useTranscriptFilterStore.getState().toggleTool(t)}
        onSetRole={(r) => useTranscriptFilterStore.getState().setRole(r)}
        onToggleHas={(a) => useTranscriptFilterStore.getState().toggleHas(a)}
        onToggleModel={(m) => useTranscriptFilterStore.getState().toggleModel(m)}
        onSetSidechainMode={(m) => useTranscriptFilterStore.getState().setSidechainMode(m)}
        onSetErrorMode={(m) => useTranscriptFilterStore.getState().setErrorMode(m)}
        onClearContent={() =>
          useTranscriptFilterStore.setState({
            tools: [],
            role: undefined,
            has: [],
            models: [],
            sidechainMode: "all",
            errorMode: "all",
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

        {/* v0.7.0 第二轮:回归虚拟化(性能回归后修)。
         * 上一轮放弃 virtualizer 改 flex column,f51fc6c 合并后 1000+ entry session
         * 加载顿、筛选卡。恢复 useVirtualizer,但 3 个根因 bug 都修了:
         * - wrapper padding: 12px 0(被 measureElement 测到)
         * - getItemKey 用 entry.normalized.id(cache by id,不是 by index)
         * - React key 用 entry.normalized.id(DOM 复用,不 unmount/remount)
         * 见 useTranscriptScroll.ts 顶部注释。 */}
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
                key={entry.normalized.id || virtualRow.key}
                data-index={virtualRow.index}
                data-entry-index={entry.index}
                ref={virtualizer.measureElement}
                className={[
                  "transcript-row",
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
