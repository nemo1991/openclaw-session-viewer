/**
 * ContentFilterPanel — 内容维度筛选面板(Presentational)
 *
 * 5 个独立维度(维内 OR、跨维 AND):
 * 1. tool 多选 — 从 props.tools 动态生成 chip,反映实际 entries 里出现的 tool
 * 2. role 单选 — 3 选项:全部 / User / Assistant
 * 3. has-attribute 多选 — 4 个 toggle:thinking / tool_use / error / subagent
 * 4. v0.7.0: model 多选 — 从 props.models 动态生成 chip(haiku/sonnet/opus/...)
 * 5. v0.7.0: sidechain 3 选项 — 全部 / 主链 / 子链(过滤 system noise)
 *
 * 数据流:
 * - 父组件(SessionDetailRoute / TranscriptView)从 summarizeSession(entries) 派生 availableTools
 * - 父组件用 zustand selector 读 selectedTools / role / has / selectedModels / sidechainMode
 * - 任何 toggle 触发 onXxx callback → 父组件调 store action
 *
 * 受控组件:本组件不接触 store,纯粹 props → callbacks。
 *
 * 边界:
 * - availableTools / availableModels 为空数组时不渲染对应行(没数据可筛)
 * - sidechainMode 永远渲染(常有用,即便 session 没有子链)
 * - 全部 filter 为空时,清除按钮隐藏
 */

import { useTranslation } from "react-i18next";

import type { HasAttribute } from "../../lib/filterEntries";

export type SidechainMode = "all" | "main" | "sidechain";

export interface ContentFilterPanelProps {
  /** 当前 session 中出现的 tool name(从 summarizeSession 派生) */
  availableTools: string[];
  /** 已选 tool name(多选) */
  selectedTools: string[];
  /** 当前 role(undefined = 全部) */
  role: string | undefined;
  /** 已选 has-attribute(多选) */
  has: HasAttribute[];
  /** v0.7.0: 当前 session 中出现的 model id(从 entries 派生) */
  availableModels: string[];
  /** v0.7.0: 已选 model(多选) */
  selectedModels: string[];
  /** v0.7.0: sidechain 模式 */
  sidechainMode: SidechainMode;
  onToggleTool: (tool: string) => void;
  onSetRole: (role: string | undefined) => void;
  onToggleHas: (attr: HasAttribute) => void;
  onToggleModel: (model: string) => void;
  onSetSidechainMode: (mode: SidechainMode) => void;
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

const SIDECHAIN_OPTIONS: Array<{
  value: SidechainMode;
  label: string;
  testId: string;
  title: string;
}> = [
  {
    value: "all",
    label: "全部",
    testId: "filter-sidechain-all",
    title: "显示所有 entry(主链 + 子链)",
  },
  {
    value: "main",
    label: "主链",
    testId: "filter-sidechain-main",
    title: "只看主链 entry,隐藏子代理 / sidechain",
  },
  {
    value: "sidechain",
    label: "子链",
    testId: "filter-sidechain-sidechain",
    title: "只看子链 entry(Agent/Task spawn 的子代理轨迹)",
  },
];

/** model chip 短显示:claude-opus-4-7 → opus,claude-sonnet-4-5 → sonnet 等 */
function modelShortLabel(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes("opus")) return "opus";
  if (lower.includes("sonnet")) return "sonnet";
  if (lower.includes("haiku")) return "haiku";
  // 其它原样截前 12 字符
  return model.length > 12 ? model.slice(0, 12) + "…" : model;
}

export function ContentFilterPanel({
  availableTools,
  selectedTools,
  role,
  has,
  availableModels,
  selectedModels,
  sidechainMode,
  onToggleTool,
  onSetRole,
  onToggleHas,
  onToggleModel,
  onSetSidechainMode,
  onClearContent,
}: ContentFilterPanelProps) {
  const { t } = useTranslation();

  // 任何维度非空 → 显示清除按钮(替代"无操作时不显示"的复杂度)
  const anyActive =
    selectedTools.length > 0 ||
    Boolean(role) ||
    has.length > 0 ||
    selectedModels.length > 0 ||
    sidechainMode !== "all";

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

      {/* v0.7.0: Model 多选 chips */}
      {availableModels.length > 0 && (
        <div className="content-filter-group" data-testid="content-filter-models">
          <span className="content-filter-label">Model</span>
          {availableModels.map((model) => {
            const active = selectedModels.includes(model);
            return (
              <button
                key={model}
                data-testid={`content-filter-model-${model}`}
                data-active={active}
                className={`content-chip ${active ? "content-chip-active" : ""}`}
                onClick={() => onToggleModel(model)}
                title={active ? `点击移除 ${model}` : `点击只保留 ${model}`}
              >
                {modelShortLabel(model)}
                {active && selectedModels.length > 1 && (
                  <span className="content-chip-x" aria-hidden>
                    ×
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* v0.7.0: Sidechain 单选 3 选项 */}
      <div className="content-filter-group" data-testid="content-filter-sidechains">
        <span className="content-filter-label">链</span>
        {SIDECHAIN_OPTIONS.map((opt) => {
          const active = sidechainMode === opt.value;
          return (
            <button
              key={opt.testId}
              data-testid={opt.testId}
              data-active={active}
              className={`content-chip ${active ? "content-chip-active" : ""}`}
              onClick={() => onSetSidechainMode(opt.value)}
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
