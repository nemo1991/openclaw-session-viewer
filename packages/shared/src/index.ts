/**
 * @ocsv/shared 入口
 * 同时被前端 (import from "@ocsv/shared") 和 Rust 端 (通过 ts-rs 生成) 引用
 */

export * from "./paths.js";
export * from "./claude-types.js";
export * from "./openclaw-types.js";
export * from "./kimi-types.js"; // v0.9.0: Kimi Code wire.jsonl 类型
export * from "./normalize.js";
// v0.10 (Epic 1 / FR-T1): 由 Rust 经 ts-rs 生成的归一化 schema 产物。
// 警告: 此文件由 `pnpm codegen:types` 自动生成, 不要手工编辑。
export * from "./generated/normalize-types.js";
// v0.10 验收收口 (A4): 让生成类型被真实消费的编译期结构断言。
// Rust 结构体改字段而 shared 手写类型未同步时, `pnpm typecheck` 会失败。
export * from "./schema-assert.js";
export * from "./ipc.js";
export * from "./analysis-prompts.js";
