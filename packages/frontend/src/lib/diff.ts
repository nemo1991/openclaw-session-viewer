/**
 * v0.4.2: Edit 工具 diff 视图的薄包装
 *
 * 基于 jsdiff 的 diffLines,把 Change[] 转成 {kind: "eq" | "add" | "del", text}[]
 * 方便 React 渲染和单测。
 *
 * 输入超 5000 行时抛 Error(让调用方走 fallback JSON dump)。
 */

import { diffLines } from "diff";

export type DiffKind = "eq" | "add" | "del";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

const MAX_LINES = 5000;

export class DiffTooLargeError extends Error {
  constructor(public readonly lineCount: number) {
    super(`Diff input too large: ${lineCount} lines (max ${MAX_LINES})`);
    this.name = "DiffTooLargeError";
  }
}

/**
 * 计算 old/new 之间的行级 diff。
 *  返回按 old/new 出现顺序排列的行数组(eq/del 来自分块 old,eq/add 来自分块 new)。
 */
export function computeLineDiff(oldStr: string, newStr: string): DiffLine[] {
  // 估算总行数(粗算 split '\n' 长度)。两边任一超 MAX 抛错。
  const lineCount = Math.max(oldStr.split("\n").length, newStr.split("\n").length);
  if (lineCount > MAX_LINES) {
    throw new DiffTooLargeError(lineCount);
  }

  const changes = diffLines(oldStr, newStr);
  const out: DiffLine[] = [];
  for (const c of changes) {
    const kind: DiffKind = c.added ? "add" : c.removed ? "del" : "eq";
    // c.value 末尾会有 '\n',直接 trimEnd 让渲染不带尾空行
    const lines = c.value.replace(/\n$/, "").split("\n");
    for (const line of lines) {
      out.push({ kind, text: line });
    }
  }
  return out;
}

/**
 * 统计 diff 的变化量,用于 header summary
 *  - added: 新增行数
 *  - removed: 删除行数
 *  - unchanged: 未变行数
 */
export function diffStats(lines: DiffLine[]): {
  added: number;
  removed: number;
  unchanged: number;
} {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const l of lines) {
    if (l.kind === "add") added++;
    else if (l.kind === "del") removed++;
    else unchanged++;
  }
  return { added, removed, unchanged };
}
