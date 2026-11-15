/**
 * v0.12 (C1 / FR-C1): 会话卡片 stat-chip 分层选择
 *
 * 抽成纯函数是为了让「默认可见 ≤3 / 高信号优先 / 展开显示全部」这条验收
 * 指标可被单测直接断言,而不依赖 DOM 渲染。
 *
 * 优先级由调用方给每个 chip 赋值,数字越小越优先露出。首页约定:
 *   error(0) > repeat(1) > duration(2) > thinking/tools/idle/todo/tokens/compaction > topTools
 */

export interface RankedChip<T> {
  key: string;
  /** 数字越小越优先露出 */
  priority: number;
  node: T;
}

export interface ChipSelection<T> {
  ordered: RankedChip<T>[];
  shown: RankedChip<T>[];
  /** 是否还有被折叠的 chip(决定要不要渲染「展开」按钮) */
  hasMore: boolean;
  /** 折叠态下被隐藏的数量,用于按钮文案 */
  hiddenCount: number;
}

export function selectStatChips<T>(
  chips: RankedChip<T>[],
  expanded: boolean,
  maxVisible = 3
): ChipSelection<T> {
  const list = Array.isArray(chips) ? chips : [];
  // 不修改入参(组件里 chips 是每次 render 新建的,但仍保持纯函数语义)
  const ordered = [...list].sort((a, b) => a.priority - b.priority);
  const max = Number.isFinite(maxVisible) ? Math.max(0, Math.floor(maxVisible)) : 3;
  const shown = expanded ? ordered : ordered.slice(0, max);
  return {
    ordered,
    shown,
    hasMore: ordered.length > max,
    hiddenCount: ordered.length - shown.length,
  };
}
