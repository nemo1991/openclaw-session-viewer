/**
 * TranscriptToolbar — FilterPanel + SortPanel + ContentFilterPanel 组合
 *
 * 简单组合组件,放在 transcript 视图顶部。原 TranscriptView 直接渲染这三个,
 * 抽出来便于单测 toolbar 整体(同时验证子组件 mount)。
 *
 * v0.7.0: 加 ContentFilterPanel — 内容维度(tool / role / has-attribute / model)filter。
 */

import { FilterPanel, type FilterPanelProps } from "./FilterPanel";
import { SortPanel, type SortPanelProps } from "./SortPanel";
import { ContentFilterPanel, type ContentFilterPanelProps } from "./ContentFilterPanel";

export interface TranscriptToolbarProps
  extends
    FilterPanelProps,
    Omit<SortPanelProps, "onChange">,
    Omit<ContentFilterPanelProps, "onClearContent"> {
  onSortChange: SortPanelProps["onChange"];
  /** 清空 content 维度(不影响 time)— 独立于 onClear(time 清空) */
  onClearContent: ContentFilterPanelProps["onClearContent"];
}

export function TranscriptToolbar(props: TranscriptToolbarProps) {
  const { onSortChange, sortAsc, onClearContent, ...rest } = props;
  const filterProps: FilterPanelProps = {
    preset: rest.preset,
    from: rest.from,
    to: rest.to,
    tz: rest.tz,
    localInputToIso: rest.localInputToIso,
    isoToLocalInput: rest.isoToLocalInput,
    onPresetChange: rest.onPresetChange,
    onApply: rest.onApply,
    onClear: rest.onClear,
  };
  const contentProps: ContentFilterPanelProps = {
    availableTools: rest.availableTools,
    selectedTools: rest.selectedTools,
    role: rest.role,
    has: rest.has,
    availableModels: rest.availableModels,
    selectedModels: rest.selectedModels,
    sidechainMode: rest.sidechainMode,
    errorMode: rest.errorMode,
    onToggleTool: rest.onToggleTool,
    onSetRole: rest.onSetRole,
    onToggleHas: rest.onToggleHas,
    onToggleModel: rest.onToggleModel,
    onSetSidechainMode: rest.onSetSidechainMode,
    onSetErrorMode: rest.onSetErrorMode,
    onClearContent,
  };
  return (
    <div className="transcript-toolbar">
      <div className="transcript-sort-bar-wrapper">
        <SortPanel sortAsc={sortAsc} onChange={onSortChange} />
      </div>
      <FilterPanel {...filterProps} />
      <ContentFilterPanel {...contentProps} />
    </div>
  );
}
