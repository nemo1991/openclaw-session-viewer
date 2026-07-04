/**
 * ContentFilterPanel — 内容维度筛选面板(Presentational)
 *
 * 3 个独立维度(维内 OR、跨维 AND):
 * 1. tool 多选 — 从 props.tools 动态生成 chip,反映实际 entries 里出现的 tool
 * 2. role 单选 — 3 选项:全部 / User / Assistant
 * 3. has-attribute 多选 — 4 个 toggle:thinking / tool_use / error / subagent
 *
 * 数据流:
 * - 父组件(SessionDetailRoute)从 summarizeSession(entries) 派生 availableTools
 * - 父组件用 zustand selector 读 selectedTools / role / has
 * - 任何 toggle 触发 onXxx callback → 父组件调 store action
 *
 * 受控组件:本组件不接触 store,纯粹 props → callbacks。
 *
 * 边界:
 * - availableTools 为空数组时不渲染 tool 行(没数据可筛)
 * - 全部 filter 为空时,整行隐藏 — 避免空 bar 抢视觉
 */

import { useTranslation } from "react-i18next";

import type { HasAttribute } from "../../lib/filterEntries";

export interface ContentFilterPanelProps {
  /** 当前 session 中出现的 tool name(从 summarizeSession 派生) */
  availableTools: string[];
  /** 已选 tool name(多选) */
  selectedTools: string[];
  /** 当前 role(undefined = 全部) */
  role: string | undefined;
  /** 已选 has-attribute(多选) */
  has: HasAttribute[];
  onToggleTool: (tool: string) => void;
  onSetRole: (role: string | undefined) => void;
  onToggleHas: (attr: HasAttribute) => void;
  /** 清除 content 维度筛选(不影响 time) */
  onClearContent: () => void;
}

const HAS_OPTIONS: Array<{ value: HasAttribute; label: string; title: string }> = [
  { value: "thinking", label: "thinking", title: "包含 thinking block 的 entry" },
  { value: "tool_use", label: "tool_use", title: "包含 tool_use block 的 entry" },
  { value: "error", label: "error", title: "stopReason=error 的 assistant entry" },
  { value: "subagent", label: "subagent", title: "子代理调用的 entry" },
];

const ROLE_OPTIONS: Array<{ value: string | undefined; label: string; testId: string }> = [
  { value: undefined, label: "全部", testId: "filter-role-all" },
  { value: "user", label: "user", testId: "filter-role-user" },
  { value: "assistant", label: "assistant", testId: "filter-role-assistant" },
];

export function ContentFilterPanel({
  availableTools,
  selectedTools,
  role,
  has,
  onToggleTool,
  onSetRole,
  onToggleHas,
  onClearContent,
}: ContentFilterPanelProps) {
  const { t } = useTranslation();

  // 任何维度非空 → 显示清除按钮(替代"无操作时不显示"的复杂度)
  const anyActive = selectedTools.length > 0 || Boolean(role) || has.length > 0;

  return (
    <div className="transcript-content-filter-bar" data-testid="content-filter-bar">
      {/* Tool 多选 chips */}
      {availableTools.length > 0 && (
        <div className="content-filter-group" data-testid="content-filter-tools">
          <span className="content-filter-label">Tool</span>
          {availableTools.map((tool) => {
            const active = selectedTools.includes(tool);
            return (
              <button
                key={tool}
                data-testid={`content-filter-tool-${tool}`}
                data-active={active}
                className={`content-chip ${active ? "content-chip-active" : ""}`}
                onClick={() => onToggleTool(tool)}
                title={active ? `点击移除 ${tool}` : `点击只保留 ${tool}`}
              >
                {tool}
                {active && selectedTools.length > 1 && (
                  <span className="content-chip-x" aria-hidden>
                    ×
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Role 单选 */}
      <div className="content-filter-group" data-testid="content-filter-roles">
        <span className="content-filter-label">Role</span>
        {ROLE_OPTIONS.map((opt) => {
          const active = (role ?? undefined) === opt.value;
          return (
            <button
              key={opt.testId}
              data-testid={opt.testId}
              data-active={active}
              className={`content-chip ${active ? "content-chip-active" : ""}`}
              onClick={() => onSetRole(opt.value)}
              title={`只看 ${opt.label}`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {/* Has-attribute 多选 */}
      <div className="content-filter-group" data-testid="content-filter-hases">
        <span className="content-filter-label">包含</span>
        {HAS_OPTIONS.map((opt) => {
          const active = has.includes(opt.value);
          return (
            <button
              key={opt.value}
              data-testid={`content-filter-has-${opt.value}`}
              data-active={active}
              className={`content-chip ${active ? "content-chip-active" : ""}`}
              onClick={() => onToggleHas(opt.value)}
              title={opt.title}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {anyActive && (
        <button
          className="filter-clear-btn"
          data-testid="content-filter-clear"
          onClick={onClearContent}
          title={t("detail.filter.clear")}
        >
          {t("detail.filter.clear")}
        </button>
      )}
    </div>
  );
}
