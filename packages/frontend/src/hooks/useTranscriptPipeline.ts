/**
 * useTranscriptPipeline — 把 transcript 数据的 filter + sort 逻辑封到 hook
 *
 * 设计要点(Container / Hook / Strategy):
 * - selector 分别订阅 4 个独立 slice(entries / filterActive / from / to),
 *   避免 useTranscriptStore() / useTranscriptFilterStore() 全量解构导致
 *   任一字段变化都触发 pipeline 重算
 * - filter 步骤调用 lib/filterEntries.applyTimeFilter 纯函数,
 *   复用 SearchInSessionBar 的搜索范围筛选(原本两处 ~12 行重复)
 * - sort 用 useMemo + setSortAsc 暴露给 View(本组件 sortAsc=true 直通,
 *   false 时 reverse;reverse 创建新数组但 entry 引用复用 → memo 仍生效)
 */

import { useMemo, useState } from "react";

import { applyTimeFilter } from "../lib/filterEntries";
import type { TranscriptEntryOut } from "../lib/api";
import { useTranscriptStore } from "../state/transcriptStore";
import { isFilterActive, useTranscriptFilterStore } from "../state/transcriptFilterStore";

export interface PipelineResult {
  /** 原始 entries(从 store) */
  entries: TranscriptEntryOut[];
  /** 时间筛选后的 entries(filterActive 时是新数组,否则 === entries) */
  filteredEntries: TranscriptEntryOut[];
  /** 排序后的 entries(始终是新数组) */
  sortedEntries: TranscriptEntryOut[];
  /** 当前是否正序(true=旧→新) */
  sortAsc: boolean;
  /** 切换排序方向 */
  setSortAsc: (asc: boolean) => void;
}

export function useTranscriptPipeline(): PipelineResult {
  // 4 个独立 selector — 任一字段变化才触发对应重渲染
  const entries = useTranscriptStore((s) => s.entries);
  const filterActive = useTranscriptFilterStore(isFilterActive);
  const filterFrom = useTranscriptFilterStore((s) => s.from);
  const filterTo = useTranscriptFilterStore((s) => s.to);

  const [sortAsc, setSortAsc] = useState(true);

  const filteredEntries = useMemo(
    () => (filterActive ? applyTimeFilter(entries, { from: filterFrom, to: filterTo }) : entries),
    [entries, filterActive, filterFrom, filterTo]
  );

  const sortedEntries = useMemo(
    () => (sortAsc ? filteredEntries : [...filteredEntries].reverse()),
    [filteredEntries, sortAsc]
  );

  return { entries, filteredEntries, sortedEntries, sortAsc, setSortAsc };
}
