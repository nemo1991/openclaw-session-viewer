/**
 * 会话详情筛选 store
 *
 * v0.7.0: 扩展到内容维度 — tool / role / has-attribute,与 time 正交。
 * 4 维共享同一个 clear(),但 setPreset/setRange 不影响内容字段(让用户能叠加)。
 *
 * 在已加载的 transcript entries 上做客户端筛选。
 * 不需要后端,前提是 entries 已经全量在内存 (loadedCount === totalCount)。
 *
 * Time 维度:
 * - `preset`: 快捷选择 (all / 1h / 24h / 7d / custom)
 * - `from` / `to`: ISO 8601 字符串,定义时间范围闭区间
 *
 * Content 维度:
 * - `tools`: 多选 tool name(Bash / Read / Edit ...)— 来自 summarizeSession 动态生成
 * - `role`: 单选 role(user / assistant / system)
 * - `has`: 多选 has-attribute(thinking / tool_use / error / subagent)
 *
 * URL 持久化: SessionDetailRoute 解析 ?from=ISO&to=ISO&tool=A,B&role=X&has=Y,Z 后调用 actions。
 */

import { create } from "zustand";

import type { HasAttribute } from "../lib/filterEntries";

export type FilterPreset = "all" | "1h" | "24h" | "7d" | "custom";

interface TranscriptFilterStore {
  // ===== Time =====
  preset: FilterPreset;
  /** ISO 8601 string, inclusive lower bound */
  from?: string;
  /** ISO 8601 string, inclusive upper bound */
  to?: string;

  // ===== Content =====
  /** 多选 tool name;空数组 = 不限 */
  tools: string[];
  /** 单选 role;undefined = 不限 */
  role?: string;
  /** 多选 has-attribute;空数组 = 不限 */
  has: HasAttribute[];
  /** v0.7.0: 多选 model (haiku/sonnet/opus/...);空数组 = 不限 */
  models: string[];
  /** v0.7.0: 单选 sidechain 模式;"all" = 不限(默认),"main" = 只看主链,"sidechain" = 只看子链 */
  sidechainMode: "all" | "main" | "sidechain";
  /** v0.8.5 A: 错误模式过滤 — "all" = 不限(默认),"errors" = 只看 tool_result.is_error 的 entries,
   * "no_errors" = 排除 tool_result.is_error 的 entries */
  errorMode: "all" | "errors" | "no_errors";

  // ===== Actions: time =====
  /** 切换 preset (1h/24h/7d/all 时同步设置 from) */
  setPreset: (p: FilterPreset) => void;
  /** 直接设置 from/to (自定义模式) */
  setRange: (from?: string, to?: string) => void;

  // ===== Actions: content =====
  /** 切换单个 tool(已选 → 移除,未选 → 追加);空操作若是已存在 */
  toggleTool: (tool: string) => void;
  /** 设 role(undefined = 清空) */
  setRole: (role: string | undefined) => void;
  /** 切换单个 has attribute */
  toggleHas: (attr: HasAttribute) => void;
  /** 切换单个 model(已选 → 移除,未选 → 追加) */
  toggleModel: (model: string) => void;
  /** 设置 sidechain 模式("all" / "main" / "sidechain") */
  setSidechainMode: (mode: "all" | "main" | "sidechain") => void;
  /** v0.8.5 A: 设置错误模式("all" / "errors" / "no_errors") */
  setErrorMode: (mode: "all" | "errors" | "no_errors") => void;

  // ===== Actions: 批量 =====
  /** 清空所有过滤(time + content) */
  clear: () => void;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function presetToRange(p: Exclude<FilterPreset, "all" | "custom">): {
  from: string;
} {
  const now = Date.now();
  let fromMs: number;
  switch (p) {
    case "1h":
      fromMs = now - HOUR_MS;
      break;
    case "24h":
      fromMs = now - DAY_MS;
      break;
    case "7d":
      fromMs = now - 7 * DAY_MS;
      break;
  }
  return { from: new Date(fromMs).toISOString() };
}

export const useTranscriptFilterStore = create<TranscriptFilterStore>((set, get) => ({
  preset: "all",
  from: undefined,
  to: undefined,
  tools: [],
  role: undefined,
  has: [],
  models: [],
  sidechainMode: "all",
  errorMode: "all",

  // ===== Time actions =====
  setPreset: (p) => {
    if (p === "all") {
      set({ preset: "all", from: undefined, to: undefined });
    } else if (p === "custom") {
      // 切换到自定义时保留现有 from/to,让用户编辑
      set({ preset: "custom" });
    } else {
      // 1h / 24h / 7d: 计算 from,to 留 undefined (= now)
      const { from } = presetToRange(p);
      set({ preset: p, from, to: undefined });
    }
  },

  setRange: (from, to) => {
    const hasRange = Boolean(from || to);
    set({
      preset: hasRange ? "custom" : "all",
      from,
      to,
    });
  },

  // ===== Content actions =====
  toggleTool: (tool) => {
    const current = get().tools;
    set({
      tools: current.includes(tool) ? current.filter((t) => t !== tool) : [...current, tool],
    });
  },

  setRole: (role) => {
    set({ role });
  },

  toggleHas: (attr) => {
    const current = get().has;
    set({
      has: current.includes(attr) ? current.filter((a) => a !== attr) : [...current, attr],
    });
  },

  toggleModel: (model) => {
    const current = get().models;
    set({
      models: current.includes(model) ? current.filter((m) => m !== model) : [...current, model],
    });
  },

  setSidechainMode: (mode) => {
    set({ sidechainMode: mode });
  },

  setErrorMode: (mode) => {
    set({ errorMode: mode });
  },

  // ===== Batch =====
  clear: () => {
    set({
      preset: "all",
      from: undefined,
      to: undefined,
      tools: [],
      role: undefined,
      has: [],
      models: [],
      sidechainMode: "all",
      errorMode: "all",
    });
  },
}));

/**
 * 当前 store 是否实际生效 — 任何维度非空都算 active
 *
 * 返回 boolean primitive,可直接作为 zustand selector 使用:
 *   useTranscriptFilterStore(isFilterActive)
 * 避免消费整个 store 对象导致无关字段变化也触发重渲染。
 */
export function isFilterActive(s: TranscriptFilterStore): boolean {
  return (
    s.preset !== "all" ||
    Boolean(s.from || s.to) ||
    s.tools.length > 0 ||
    Boolean(s.role) ||
    s.has.length > 0 ||
    s.models.length > 0 ||
    s.sidechainMode !== "all" ||
    s.errorMode !== "all"
  );
}

/**
 * Content 维度是否生效 — 仅看 tools/role/has/models/sidechain/errorMode
 * (time 单独由 s.preset 判断;Pipeline hook 用 isContentFilterActive 来
 *  在 contentFilter 步骤做短路)
 */
export function isContentFilterActive(s: TranscriptFilterStore): boolean {
  return (
    s.tools.length > 0 ||
    Boolean(s.role) ||
    s.has.length > 0 ||
    s.models.length > 0 ||
    s.sidechainMode !== "all" ||
    s.errorMode !== "all"
  );
}
