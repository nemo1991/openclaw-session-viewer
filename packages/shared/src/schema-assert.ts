/**
 * v0.10 验收收口 (FR-T1 / A4):Rust 生成 schema 的**编译期结构断言**。
 *
 * 背景:ts-rs 生成的 `RustNormalized*` 类型此前只被 `index.ts` re-export,
 * 没有任何真实消费方,因此「改 Rust 字段 → typecheck 暴露未适配点」并无代码
 * 支撑(见 `docs/QA_v0.10_Acceptance_Verification.md` 第五章偏差 #2/#4)。
 *
 * 本文件让生成类型被真实 import,并断言:
 *   1. 字段集合覆盖:Rust 新增/重命名字段而 shared 手写类型未同步 → tsc FAIL
 *   2. 闭合结构等价:TokenUsage / SubagentSummary / Block.kind 逐字段相等
 *   3. 关键字段相容:role 窄化安全、blocks 元素形状相容
 *
 * 诚实边界:`NormalizedMessage` 与 `RustNormalizedMessage` 的 nullability 不同
 * (Rust 全 required + `T | null`,TS 侧 optional + `T | undefined`),消息主体
 * 只做键集合覆盖、不做整体 Equal —— 这正是 FR-T1「部分实现 / 可检出漂移」
 * 而非「单一事实源」的原因,不要为了让断言变绿去伪造类型。
 *
 * 无运行时逻辑(除 `RUST_MESSAGE_KEYS`),由 `pnpm typecheck` 覆盖;
 * 取值一致性另由 `contract.test.ts` + Rust 契约快照门禁负责(FR-T4)。
 */

import type {
  RustNormalizedBlock,
  RustNormalizedMessage,
  RustSubagentSummary,
  RustTokenUsageOut,
} from "./generated/normalize-types.js";
import type { NormalizedBlock, NormalizedMessage, SubagentSummary } from "./normalize.js";

/** 只有 `true` 可以通过 —— 条件为 false 时 tsc 直接报错。 */
type Assert<T extends true> = T;

/** 严格类型相等(属性顺序无关,能识别 optional / readonly / union 差异)。 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Rust 侧的每个 key 都必须在手写类型里存在。 */
type RustKeysCovered<Rust, Hand> = Exclude<keyof Rust, keyof Hand> extends never ? true : false;

// ---- 1. 字段集合覆盖(Rust 改字段 → 这里 FAIL)----

export type AssertRustMessageKeysCovered = Assert<
  RustKeysCovered<RustNormalizedMessage, NormalizedMessage>
>;
export type AssertRustBlockKeysCovered = Assert<
  RustKeysCovered<RustNormalizedBlock, NormalizedBlock>
>;
export type AssertRustTokenUsageKeysCovered = Assert<
  RustKeysCovered<RustTokenUsageOut, NonNullable<NormalizedMessage["tokenUsage"]>>
>;
export type AssertRustSubagentKeysCovered = Assert<
  RustKeysCovered<RustSubagentSummary, SubagentSummary>
>;

// ---- 2. 闭合结构逐字段相等 ----

export type AssertTokenUsageEqual = Assert<
  Equal<RustTokenUsageOut, NonNullable<NormalizedMessage["tokenUsage"]>>
>;
export type AssertSubagentSummaryEqual = Assert<Equal<RustSubagentSummary, SubagentSummary>>;
export type AssertBlockKindEqual = Assert<
  Equal<RustNormalizedBlock["kind"], NormalizedBlock["kind"]>
>;

// ---- 3. 关键字段类型相容 ----

/** TS 侧把 role 收窄成字面量 union,是 Rust `string` 的安全子类型。 */
export type AssertRoleNarrowingSafe = Assert<
  NormalizedMessage["role"] extends RustNormalizedMessage["role"] ? true : false
>;
/** 生成的最小 block 形状必须能被渲染层 block 接受。 */
export type AssertBlockShapeCompatible = Assert<
  RustNormalizedBlock extends Pick<NormalizedBlock, "kind"> ? true : false
>;

/**
 * Rust 消息字段清单(运行时可读,便于测试与文档核对)。
 * `satisfies` 保证清单里不出现 Rust 结构体中不存在的 key;
 * 反向的「Rust 新增字段但清单未更新」由上面的键覆盖断言负责。
 */
export const RUST_MESSAGE_KEYS = [
  "id",
  "role",
  "timestamp",
  "blocks",
  "model",
  "stopReason",
  "tokenUsage",
  "isSidechain",
  "subagentId",
  "parentUuid",
  "rawType",
] as const satisfies readonly (keyof RustNormalizedMessage)[];
