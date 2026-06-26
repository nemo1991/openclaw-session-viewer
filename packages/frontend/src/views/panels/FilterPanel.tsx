/**
 * FilterPanel — Presentational 时间筛选面板
 *
 * 设计:Container/Presentational 拆分 — 父组件只传 props,本组件不直接
 * 接触 transcriptFilterStore。受控 datetime-local 输入(local state),
 * 不再用 document.getElementById 绕过 React(原 TranscriptView FilterBar)。
 *
 * 数据流:
 * - from/to/preset 由父组件传入(从 store 取)
 * - onPresetChange:preset 切换 → 父组件调 setPreset
 * - onApply(from?, to?):Apply 按钮提交受控输入值
 * - onClear:清空
 *
 * tz 由父组件通过 useFormatOpts 取得,负责本地 ↔ ISO 字符串转换(本组件
 * 只暴露原始字符串,转换细节留在父组件 — 让本组件 100% presentational,
 * 便于测试)。
 */

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

import type { FilterPreset } from "../../state/transcriptFilterStore";

export interface FilterPanelProps {
  preset: FilterPreset;
  /** ISO 8601 string,空表示无下界 */
  from?: string;
  /** ISO 8601 string,空表示无上界 */
  to?: string;
  /** 当前时区,显示给用户看 */
  tz: string;
  /**
   * 把本地 datetime-local 字符串 + 当前 TZ 转成 ISO 的回调
   * (由父组件用 lib/format.formatLocalInputToIsoInTz 注入)
   */
  localInputToIso: (input: string) => string | undefined;
  /**
   * 把 ISO 转成本地 datetime-local 字符串的回调(同上,反向)
   */
  isoToLocalInput: (iso: string | undefined) => string;
  onPresetChange: (p: FilterPreset) => void;
  /** Apply 提交:两个值都来自受控输入 */
  onApply: (from?: string, to?: string) => void;
  onClear: () => void;
}

const PRESETS: Array<{ value: Exclude<FilterPreset, "custom">; key: string }> = [
  { value: "all", key: "detail.filter.all" },
  { value: "1h", key: "detail.filter.last1h" },
  { value: "24h", key: "detail.filter.last24h" },
  { value: "7d", key: "detail.filter.last7d" },
];

export function FilterPanel({
  preset,
  from,
  to,
  tz,
  localInputToIso,
  isoToLocalInput,
  onPresetChange,
  onApply,
  onClear,
}: FilterPanelProps) {
  const { t } = useTranslation();
  const isCustom = preset === "custom";

  // 受控输入:本地 state 维护输入框原始字符串,
  // Apply 时通过 props.onApply(localInputToIso(...)) 转 ISO 上交
  const [fromInput, setFromInput] = useState(() => isoToLocalInput(from));
  const [toInput, setToInput] = useState(() => isoToLocalInput(to));

  // store 的 from/to 变化时(preset 切换、URL sync 等)同步本地输入
  useEffect(() => {
    setFromInput(isoToLocalInput(from));
  }, [from, isoToLocalInput]);
  useEffect(() => {
    setToInput(isoToLocalInput(to));
  }, [to, isoToLocalInput]);

  const handleApply = () => {
    onApply(
      fromInput ? localInputToIso(fromInput) : undefined,
      toInput ? localInputToIso(toInput) : undefined
    );
  };

  return (
    <div className="transcript-filter-bar">
      {PRESETS.map((p) => (
        <button
          key={p.value}
          data-testid={`filter-preset-${p.value}`}
          className={`filter-btn ${preset === p.value ? "filter-btn-active" : ""}`}
          onClick={() => onPresetChange(p.value)}
        >
          {t(p.key)}
        </button>
      ))}
      <button
        data-testid="filter-preset-custom"
        className={`filter-btn ${isCustom ? "filter-btn-active" : ""}`}
        onClick={() => onPresetChange("custom")}
      >
        {t("detail.filter.custom")}
      </button>
      {isCustom && (
        <div className="filter-custom">
          <input
            id="filter-from"
            data-testid="filter-from-input"
            type="datetime-local"
            value={fromInput}
            onChange={(e) => setFromInput(e.target.value)}
            placeholder={t("detail.filter.from")}
          />
          <span>~</span>
          <input
            id="filter-to"
            data-testid="filter-to-input"
            type="datetime-local"
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
            placeholder={t("detail.filter.to")}
          />
          <span className="filter-tz-label">
            ({tz === "auto" ? Intl.DateTimeFormat().resolvedOptions().timeZone : tz})
          </span>
          <button className="filter-apply-btn" data-testid="filter-apply-btn" onClick={handleApply}>
            {t("detail.filter.apply")}
          </button>
          <button className="filter-clear-btn" data-testid="filter-clear-btn" onClick={onClear}>
            {t("detail.filter.clear")}
          </button>
        </div>
      )}
    </div>
  );
}
