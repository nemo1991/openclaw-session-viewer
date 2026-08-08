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

/// v0.9.8: Kimi TodoWrite 状态 — 来自 `tools.update_store{key:"todo"}` 末次 value
///
/// `current` 是 status=="in_progress" 的 title(若有);`done`/`total` 给 chip "📋 N/M 任务"
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodoSummary {
    pub total: u32,
    pub done: u32,
    pub current: Option<String>,
    pub updated_at_ms: Option<i64>,
}

/// v0.9.8: 顶部 Session Meta Banner 折叠面板 — 配置 + 权限 + 压缩快照
///
/// 设计:不存全文 systemPrompt(太大),存 hash + 长度 + 关键字段。详情页 banner
/// 折叠后显示完整 systemPrompt(从 wire.jsonl 重读)。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetaBanner {
    /// 协议版本 "1.4" / "1.5"
    pub protocol_version: Option<String>,
    /// profile 名("agent" / "plan" 等)
    pub profile_name: Option<String>,
    /// 当前 modelAlias
    pub model_alias: Option<String>,
    /// thinking effort
    pub thinking_effort: Option<String>,
    /// 当前 permission mode
    pub permission_mode: Option<String>,
    /// active tools 数
    pub active_tool_count: Option<u32>,
    /// config.update 次数(系统提示/profile/model 演化)
    pub config_change_count: u32,
    /// permission.record_approval_result 次数
    pub approval_count: u32,
    /// full_compaction 对数
    pub compaction_count: u32,
    /// 末次压缩的 duration_ms — 给 chip "🗜 22 压缩 / 末次 73s" 用
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_compaction_duration_ms: Option<u64>,
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
    // --- v0.8.0 DB 同步后填充 + 用户 override ---
    /// 用户重写的显示名(覆盖 `title` 优先级 1)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_title: Option<String>,
    /// 用户标记为隐藏(列表过滤时排除)
    #[serde(default)]
    pub hidden: bool,
    /// 用户标记为置顶(列表顶部独立分组)
    #[serde(default)]
    pub pinned: bool,
    /// 用户标记为归档(默认隐藏,详情页 banner 提示)
    #[serde(default)]
    pub archived: bool,
    /// 用户自由笔记(Markdown)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// tag 名列表(已 join session_tag)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    // --- v0.8.4: 固化到 DB 的派生指标(由 build_meta_full 在 sync 二阶段填充) ---
    /// assistant 消息中 stop_reason=="error" 或 is_error==true 的计数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_count: Option<u32>,
    /// 顶层 user 消息计数 (排除 sidechain)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_message_count: Option<u32>,
    /// 顶层 assistant 消息计数 (排除 sidechain)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant_message_count: Option<u32>,
    /// 会话跨度(秒) = last_ts - first_ts
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u64>,
    /// 首次响应延迟(毫秒) = first_assistant_ts - first_user_ts
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_response_latency_ms: Option<u64>,
    /// jsonl 里 agent-name envelope 的 agentName 值(本会话自己的别名)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
    /// invoked_skills 计数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invoked_skills_count: Option<u32>,
    /// plan_file_reference 计数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_file_ref_count: Option<u32>,
    /// compact_file_reference 计数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_file_ref_count: Option<u32>,
    /// queued_command 计数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_command_count: Option<u32>,
    /// attached_file 计数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attached_file_count: Option<u32>,
    // --- v0.8.4 item 2': SessionSummaryStrip 全固化 ---
    /// 文本消息数 (user + assistant + tool 角色) — 等价于 `summarizeSession.textMessageCount`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_message_count: Option<u32>,
    /// 全量 tool 分布,按 count 降序: `[("Bash", 286), ("Read", 50), ...]`
    /// 跟 `top_tools` 区别:top_tools 只存名字(前 5),`tool_usage` 带 count
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_usage: Option<Vec<(String, u32)>>,
    /// 阶段提示: "explore" | "implement" | "mixed" | "short"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase_hint: Option<String>,
    /// 阶段详情,例如 "47% 写操作" / "短 session" / "无文件操作"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase_detail: Option<String>,
    /// 相邻 assistant tool_use 同 tool ≥3 次的 run 段数(等价 `findRepeatRuns(entries, 3).length`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_run_count: Option<u32>,
    /// 占比最大 run 的 tool name(tooltip 用)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_run_max_tool: Option<String>,
    /// 占比最大 run 的次数(tooltip 用)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat_run_max_count: Option<u32>,
    /// 相邻 entry ts gap ≥ 5 分钟的次数(等价 `findIdleGaps(entries, 5*60_000).length`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_gap_count: Option<u32>,
    /// 最长间隔 ms(chip "最长 X 分钟" 用)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_gap_max_ms: Option<u64>,
    /// v0.8.4 item 2'': 该 session 用过的 model id(去重,字典序),ContentFilterPanel chip 源
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_models: Option<Vec<String>>,
    /// v0.8.5 A: per-tool 失败计数 — `[(tool_name, error_count)...]`,按 count 降序
    /// 跟 `error_count` (message 级) 正交: error_count 数整条 assistant 失败,
    /// tool_error 数单个 tool_result.is_error==true 的 tool 调用失败。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_error: Option<Vec<(String, u32)>>,
    /// v0.8.7 A: parent_uuids (newline-separated UUIDs), GraphView ParentUuid edges 用
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_uuids_text: Option<String>,
    // --- v0.9.8: kimi 专属聚合 (TodoWrite + token + MetaBanner) ---
    /// Kimi TodoWrite 末次状态 — 来自 `tools.update_store{key:"todo"}`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub todo_summary: Option<TodoSummary>,
    /// Kimi session 自身 token 聚合 — 来自 `usage.record{usageScope:"turn"}`
    /// 跟 `total_tokens` 互补:total_tokens 给前端通用 chip,kimi 兼容
    /// (chip 文案 "🪙 2.3M input · 716k output · 30.9M cache hit")
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kimi_token_usage: Option<TokenUsage>,
    /// Meta Banner 折叠快照 — protocol_version/profile/model/mode/tool_count
    /// + config_change/approval/compaction 计数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta_banner: Option<MetaBanner>,
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
    // --- v0.6.0: 递归子代理层级(来自 .meta.json 的 spawnDepth) ---
    /// 0 = 主 session 直接派出的子代理
    /// 1+ = 子代理内部又派出的子代理(递归),UI 截递归避免深度爆炸
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spawn_depth: Option<u32>,
}

/// v0.6.0: 单个子代理的摘要(轻量级,Agent 卡片内嵌展开用)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentSummary {
    pub agent_id: String,
    pub description: Option<String>,
    pub agent_type: Option<String>,
    pub message_count: Option<u32>,
    /// 工具使用分布,按 count 降序排列: `[(name, count), ...]`
    /// 例: `[("Bash", 8), ("Read", 5), ("Edit", 2)]`
    pub tool_distribution: Vec<(String, u32)>,
    pub first_timestamp: Option<String>,
    pub last_timestamp: Option<String>,
    /// 从 first 到 last 的秒数(None 当时间不可解析)
    pub duration_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpilloverFile {
    pub path: String,
    pub size_bytes: u64,
    pub content: String,
}
