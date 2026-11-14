/**
 * @ocsv/shared 入口
 * 同时被前端 (import from "@ocsv/shared") 和 Rust 端 (通过 ts-rs 生成) 引用
 */

export * from "./paths.js";
export * from "./claude-types.js";
export * from "./openclaw-types.js";
export * from "./kimi-types.js"; // v0.9.0: Kimi Code wire.jsonl 类型
export * from "./normalize.js";
// v0.10 (Epic 1 / FR-T1): 由 Rust 经 ts-rs 生成的归一化 schema 单一事实源产物。
// 警告: 此文件由 `cargo test parser::codegen` 自动生成, 不要手工编辑。
export * from "./generated/normalize-types.js";
export * from "./ipc.js";
export * from "./analysis-prompts.js";
