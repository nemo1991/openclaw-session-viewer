/**
 * TranscriptToolbar — FilterPanel + SortPanel 组合
 *
 * 简单组合组件,放在 transcript 视图顶部。原 TranscriptView 直接渲染这两个,
 * 抽出来便于单测 toolbar 整体(同时验证子组件 mount)。
 */

import { FilterPanel, type FilterPanelProps } from "./FilterPanel";
import { SortPanel, type SortPanelProps } from "./SortPanel";

export interface TranscriptToolbarProps extends FilterPanelProps, Omit<SortPanelProps, "onChange"> {
  onSortChange: SortPanelProps["onChange"];
}

export function TranscriptToolbar(props: TranscriptToolbarProps) {
  const { onSortChange, sortAsc, ...filterProps } = props;
  return (
    <div className="transcript-toolbar">
      <div className="transcript-sort-bar-wrapper">
        <SortPanel sortAsc={sortAsc} onChange={onSortChange} />
      </div>
      <FilterPanel {...filterProps} />
    </div>
  );
}
