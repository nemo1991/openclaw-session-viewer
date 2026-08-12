/**
 * v0.9.18 → v0.9.21 (M2 → M6): chart meta block 共享 utility
 *
 * v0.9.18 <redacted>,6 个 chart sub-component 复用:
 * - num: 把 unknown 转 number / null
 * - formatTokens / formatTokenShort / formatDurationMs: 数字格式化
 * - readMetaField: 顶层字段 + payload fallback + snake/camel 双查
 *
 * v0.9.21 (M6): chart-utils.ts 不再自己定义,改 re-export 自 `lib/meta.ts`
 * 和 `lib/format.ts` — 集中 utility 让 chart SVG / chart sub-component /
 * AttachmentBlock / EventMetaBlock 共享一套。chart-utils.ts 保留作为
 * 兼容层,chart sub-component 仍然从 `./chart-utils` import,行为不变。
 */

export { numOrNull as num } from "../../../lib/meta";
export { formatTokens, formatTokenShort, formatDurationMs } from "../../../lib/format";
export { getMetaField as readMetaField } from "../../../lib/meta";
