//! JSONL 解析 + 记录归一化

pub mod blocks;
pub mod claude;
#[cfg(test)]
pub mod codegen; // v0.10 (Epic 1): 受控 ts-rs 代码生成测试
pub mod contract; // v0.10 (Epic 1 / FR-T4): Rust↔TS 归一化契约快照生成
pub mod dsh; // v0.9.28: DeepSeek Harness (dsh) wire format
pub mod jsonl;
pub mod jsonl_zst; // v0.9.28: transparent .jsonl.zstd reader (DeepSeek Harness)
pub mod kimi; // v0.9.0: Kimi Code wire.jsonl
pub mod meta_aggregator; // v0.8.4 item 2 → v0.9.27 (M10): Pass 1 aggregator
pub mod openclaw;
pub mod openclaw_index; // v0.8.10: 共享 OpenClaw sessions.json index schema (Item C hardening)
pub mod trajectory;
