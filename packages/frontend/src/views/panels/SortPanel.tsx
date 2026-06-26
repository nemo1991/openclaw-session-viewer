/**
 * SortPanel — 正序 / 倒序切换(Presentational)
 */

import { useTranslation } from "react-i18next";

export interface SortPanelProps {
  sortAsc: boolean;
  onChange: (asc: boolean) => void;
}

export function SortPanel({ sortAsc, onChange }: SortPanelProps) {
  const { t } = useTranslation();
  return (
    <div className="transcript-sort-bar">
      <button
        data-testid="sort-asc"
        className={`sort-btn ${sortAsc ? "sort-btn-active" : ""}`}
        onClick={() => onChange(true)}
        title={t("detail.sortAsc")}
      >
        ↑ 正序
      </button>
      <button
        data-testid="sort-desc"
        className={`sort-btn ${!sortAsc ? "sort-btn-active" : ""}`}
        onClick={() => onChange(false)}
        title={t("detail.sortDesc")}
      >
        ↓ 倒序
      </button>
    </div>
  );
}
