/**
 * v0.9.21 (M6): lib/meta.ts — meta block 共享 utility 集中
 *
 * 之前 meta 子组件各自写自己的 `get` / `num` / 字段读取逻辑 — 4 个
 * chart SVG 组件(UsageChart / RequestChart / TodoChart / AiTitleChart)
 * 各有 `num(v): number`(返回 0 on failure),chart 子组件又有 `num(v):
 * number | null`(返回 null on failure),还有 `readMetaField` 散在
 * `charts/chart-utils.ts`,AttachmentBlock 又有自己的内联 `get`。
 *
 * M6 集中:
 * - `getMetaField(block, ...keys)`: snake + camel + 顶层 + payload 双查
 *   (历史包袱:Rust 早期 emit snake_case 平铺 + 老 wire / DB 缓存)
 * - `unwrapPayload(block)`: 返回 `block.payload ?? block`,安全 fallback
 * - `numOrZero(v)`: 跟原 SVG 内联 `num` 同语义(失败返 0)— 防御式
 * - `numOrNull(v)`: 跟原 chart-utils `num` 同语义(失败返 null)— 用来
 *   区分"缺失"和"零"
 * - `formatPreviewValue(v, opts)`: 跟 EventMetaBlock 内联 `previewValue`
 *   同语义,集中后给 EventMetaBlock 用
 *
 * chart-utils.ts 和 chart SVG 组件不再自己定义这些,改 re-export/import。
 * AttachmentBlock 内联 `get` 改用 `getMetaField`。
 */

import type { NormalizedBlockFE } from "./api";

/**
 * snake_case + camelCase 双查 + 顶层字段 + payload 双源 fallback:
 * 1. 先查 `block[k]`(顶层 snake_case 平铺,新 wire)
 * 2. 再查 `block.payload[k]`(顶层没找到时,降级到 payload)
 * 3. 多 key 顺序:通常传 (snake, camel) 双 key,如
 *    `getMetaField(block, "tokens_before", "tokensBefore")`
 *
 * 返回第一个非 null/undefined 的值;都没找到返回 undefined。
 */
export function getMetaField(block: NormalizedBlockFE, ...keys: string[]): unknown {
  const blk = block as unknown as Record<string, unknown>;
  const pl = (block.payload ?? {}) as Record<string, unknown>;
  for (const k of keys) {
    if (blk[k] !== undefined && blk[k] !== null) return blk[k];
    if (pl[k] !== undefined && pl[k] !== null) return pl[k];
  }
  return undefined;
}

/**
 * 解包 meta 分支里的 payload: meta 分支字段都在 payload 里,
 * 顶层平铺的为 BlockRenderer 入口用。统一返回 `Record<string, unknown>`。
 */
export function unwrapPayload(block: NormalizedBlockFE): Record<string, unknown> {
  return (block.payload ?? block) as Record<string, unknown>;
}

/**
 * 简化版 field 读取 — 只读 payload(没有 snake/camel 双查需求时更清晰):
 * `unwrapPayload(block)[key] ?? block[key]`。
 */
export function getPayloadField(block: NormalizedBlockFE, key: string): unknown {
  const pl = (block.payload ?? {}) as Record<string, unknown>;
  return pl[key] ?? block[key];
}

/**
 * 把 unknown 转 number,失败返回 0(跟 chart SVG 内联 `num` 同语义,
 * 防御式解析,缺失值跟 0 等价)。返回 number 类型,调用方可以直接做
 * 算术运算不用 null-check。
 */
export function numOrZero(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/**
 * 把 unknown 转 number,失败返回 null(跟 chart-utils `num` 同语义,
 * 让调用方区分"字段缺失"和"值为 0" — chart sub-component 用此判断
 * fallback 到 UnknownBlockCard)。返回 number | null,调用方需要 null-check。
 */
export function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** v0.9.21 (M6): 把 block 顶层或 payload 字段值 preview 成可读字符串。
 *
 * 跟 EventMetaBlock 内联 `previewValue` 同语义,集中后给 EventMetaBlock
 * 用。返回字符串 preview(适合 inline 显示):
 * - null / undefined → "null" / "undefined"
 * - string → 240 字符截断 + "…"
 * - number / boolean → String(v)
 * - array → 前 8 项 + 溢出 "+N" 标记
 * - object → "{N 字段: key1, key2, ...}"
 */
export interface PreviewOpts {
  maxStringLen?: number;
  arrayHead?: number;
  objectKeyHead?: number;
}
const DEFAULT_PREVIEW: Required<PreviewOpts> = {
  maxStringLen: 240,
  arrayHead: 8,
  objectKeyHead: 6,
};

export function formatPreviewValue(v: unknown, opts: PreviewOpts = {}): string {
  const o = { ...DEFAULT_PREVIEW, ...opts };
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") {
    return v.length > o.maxStringLen ? `${v.slice(0, o.maxStringLen)}…` : v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const head = v
      .slice(0, o.arrayHead)
      .map((item) => formatPreviewValue(item))
      .join(", ");
    return v.length > o.arrayHead ? `[${head}, … (+${v.length - o.arrayHead})]` : `[${head}]`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>);
    return `{${keys.length} 字段: ${keys.slice(0, o.objectKeyHead).join(", ")}${keys.length > o.objectKeyHead ? ", …" : ""}}`;
  }
  return String(v);
}
