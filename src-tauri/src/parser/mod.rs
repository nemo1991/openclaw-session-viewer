//! JSONL 解析 + 记录归一化

pub mod blocks;
pub mod claude;
pub mod dsh; // v0.9.28: DeepSeek Harness (dsh) wire format
pub mod jsonl;
pub mod jsonl_zst; // v0.9.28: transparent .jsonl.zstd reader (DeepSeek Harness)
pub mod kimi; // v0.9.0: Kimi Code wire.jsonl
pub mod meta_aggregator; // v0.8.4 item 2 → v0.9.27 (M10): Pass 1 aggregator
pub mod openclaw;
pub mod openclaw_index; // v0.8.10: 共享 OpenClaw sessions.json index schema (Item C hardening)
pub mod trajectory;
