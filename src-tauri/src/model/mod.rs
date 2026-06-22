//! 跨模块共享的数据模型
//!
//! 注:此处定义的 SessionMeta 对应前端 packages/shared/src/normalize.ts 中同名类型

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub session_id: String,
    pub project_key: String,
    pub workspace_guess: Option<String>,
    /// "claude" | "openclaw"
    pub source: String,
    pub jsonl_path: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
    pub message_count: u32,
    pub title: Option<String>,
    pub live_pid: Option<u32>,
    pub subagent_dir: Option<String>,
    pub total_tokens: Option<TokenUsage>,
    pub primary_model: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePidMeta {
    pub pid: u32,
    pub session_id: String,
    pub cwd: String,
    pub status: String,
    pub started_at: u64,
    pub version: Option<String>,
    pub waiting_for: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentMeta {
    pub agent_id: String,
    pub jsonl_path: String,
    pub meta_path: String,
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpilloverFile {
    pub path: String,
    pub size_bytes: u64,
    pub content: String,
}
