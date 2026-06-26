/**
 * useSearchableEntries — 搜索范围 = filter 后 entries
 *
 * 从 SearchInSessionBar 抽出,被 SearchInSessionBar 自己消费,
 * 也可被 transcript 范围内的任何搜索相关组件复用。
 *
 * 设计要点:
 * - selector 分别订阅 4 个字段,避免 useTranscriptFilterStore() 全量解构
 *   (后者每次返回新对象,会让 useMemo deps "变化" 而误触发搜索)
 * - filter 步骤复用 lib/filterEntries.applyTimeFilter(消除原本两处 ~12 行重复)
 */

import { useMemo } from "react";

import { applyTimeFilter } from "../lib/filterEntries";
import type { TranscriptEntryOut } from "../lib/api";
import { useTranscriptStore } from "../state/transcriptStore";
import { isFilterActive, useTranscriptFilterStore } from "../state/transcriptFilterStore";

export function useSearchableEntries(): TranscriptEntryOut[] {
  const entries = useTranscriptStore((s) => s.entries);
  const filterActive = useTranscriptFilterStore(isFilterActive);
  const filterFrom = useTranscriptFilterStore((s) => s.from);
  const filterTo = useTranscriptFilterStore((s) => s.to);

  return useMemo(
    () => (filterActive ? applyTimeFilter(entries, { from: filterFrom, to: filterTo }) : entries),
    [entries, filterActive, filterFrom, filterTo]
  );
}
