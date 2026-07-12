//! v0.8.10: 共享 OpenClaw sessions.json index entry schema
//!
//! 之前 `src-tauri/src/db/sync.rs::read_agent_info_from_index` 和
//! `src-tauri/src/commands/sessions.rs::SessionsIndexEntry` 各定义了一份完全
//! parallel 的 schema,字段 + 类型 + 序列化方式 (camelCase) 重复。sync.rs 那份
//! 因为没有 `#[serde(rename_all = "camelCase")]`,对真实 OpenClaw 数据永远
//! 静默返 `(None, None, None)` (Item A bug)。
//!
//! 现在抽到 `parser/openclaw_index.rs::SessionsIndexEntry` 共享,sync.rs +
//! sessions.rs 都用,加 rename 后两边自动一致。`SessionsIndexOrigin` 也共用。
//!
//! 字段集合跟 OpenClaw `~/.openclaw/agents/<agent>/sessions/sessions.json`
//! 的实际 shape 对齐 — `sessionId` / `origin.label` / `lastChannel` /
//! `lastTo` 4 个核心字段,其它 (`lastAccountId` / `lastInteractionAt` /
//! `chatType` / `abortedLastRun`) 由 `#[serde(default)]` 自动忽略。

use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsIndexEntry {
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub origin: SessionsIndexOrigin,
    #[serde(default)]
    pub last_channel: String,
    #[serde(default)]
    pub last_to: String,
}

#[derive(Debug, Default, Deserialize)]
pub struct SessionsIndexOrigin {
    #[serde(default)]
    pub label: String,
}
