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
    // --- v0.2.4 多 agent 支持 ---
    /// OpenClaw agentId(如 "main" / "liushuyou");Claude 始终为 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// 来自 sessions.json 的友好标签,如 "forcetone (@forcetone) id:6030344417"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_label: Option<String>,
    /// 渠道,如 "telegram" / "feishu" / "main"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_channel: Option<String>,
    /// 渠道 target,如 "telegram:6030344417"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_target: Option<String>,
    // --- v0.4.0 列表增强 ---
    /// 首条 user 文本, ≤ 80 字符(独立于 title)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_prompt: Option<String>,
    /// 末条消息 ISO timestamp
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message_at: Option<String>,
    /// thinking 块数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_count: Option<u32>,
    /// tool_use 块数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_count: Option<u32>,
    /// top 3 工具名(按出现频次)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top_tools: Option<Vec<String>>,
    // --- v0.4.0 trajectory 支持 ---
    /// OpenClaw session 是否有关联 trajectory 文件
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_trajectory: Option<bool>,
    /// trajectory 文件大小(字节)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trajectory_size_bytes: Option<u64>,
    // --- v0.5.0 subagent 关联 ---
    /// 子 agent 文件数量(<sessionId>/subagents/agent-*.jsonl)
    /// OpenClaw 会话始终为 None(无 Claude 风格子代理机制)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_count: Option<u32>,
    /// 子 agent id 列表(去重,与 list_subagents 返回顺序一致)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_ids: Option<Vec<String>>,
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
    /// `.meta.json` 解析后的内容(原始 JSON 值),含 agentType / description / toolUseId / spawnDepth
    pub meta: Option<serde_json::Value>,
    // --- v0.5.0 详情字段(从 .meta.json + jsonl 头部 200 行解析) ---
    /// "Explore" / "Plan" / "general-purpose" 等(来自 .meta.json 的 agentType)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    /// 任务描述(来自 .meta.json 的 description)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 子 agent 自身消息数(jsonl 头部扫描估算)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u32>,
    /// 首条消息 ISO timestamp
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_timestamp: Option<String>,
    /// 末条消息 ISO timestamp
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpilloverFile {
    pub path: String,
    pub size_bytes: u64,
    pub content: String,
}
