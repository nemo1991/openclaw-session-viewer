//! 共享 graph schema (S0 阶段)
//!
//! 三个 PoC 共有这些数据结构。Sprint 1/2/3 各自加 PoC-specific 字段时
//! 不修改这些核心类型。
//!
//! **设计原则**:
//! - SessionNode 是 1 个 JSONL 文件的视图
//! - Edge 类型枚举所有跨 session / 跨 message 的关联
//! - 字段尽量跟 main `SessionMeta` / `NormalizedMessage` 对齐,便于 cross-validate
//! - timestamp_ms 统一 i64 epoch millis,跨平台 OK

use serde::{Deserialize, Serialize};

/// 数据源类型
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum Source {
    Claude,
    OpenClaw,
}

impl Source {
    pub fn from_path(path: &std::path::Path) -> Option<Self> {
        // 简单启发:路径含 `.claude` → Claude,含 `.openclaw` → OpenClaw
        let s = path.to_string_lossy();
        if s.contains(".claude") {
            Some(Source::Claude)
        } else if s.contains(".openclaw") {
            Some(Source::OpenClaw)
        } else {
            None
        }
    }
}

/// 单个 session JSONL 文件的物化视图
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionNode {
    /// 唯一 ID(用 file path 的稳定 hash,避免外部 sessionId 冲突)
    pub node_id: String,
    pub source: Source,
    /// 从 envelope 提取的 sessionId(如果有);否则用 file stem
    pub session_id: String,
    /// 项目路径(Claude 的 workspaceGuess / OpenClaw 的 session cwd)
    pub workspace: Option<String>,
    /// JSONL 文件绝对路径
    pub jsonl_path: String,
    /// 文件大小 (bytes)
    pub size_bytes: u64,
    /// 文件 mtime (epoch millis)
    pub mtime_ms: i64,
    /// 第一个 user prompt(前 200 字符)
    pub first_prompt: Option<String>,
    /// 会话开始时间(从 first record 提取)
    pub first_timestamp_ms: Option<i64>,
    /// 会话最后活跃时间(从 last record 提取)
    pub last_timestamp_ms: Option<i64>,
    /// 累计 token 用量(input + output)
    pub token_total: u64,
    /// subagent 数量(Claude `subagents/` 子目录下 agent-*.jsonl)
    pub subagent_count: u32,
    /// subagent_ids (e.g. `agent-a1d92`)
    pub subagent_ids: Vec<String>,
    /// 当前 node 是否是 subagent 的 root(从 `isSidechain=true` 在 head 记录判断)
    pub is_subagent_root: bool,
    /// OpenClaw sessions.json 里指向的 parent_session_id (来自 OpenClaw session_info.parent)
    pub parent_session_id: Option<String>,
    /// JSONL 行数
    pub message_count: u64,
}

/// 所有 cross-node / cross-message 的关联边
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Edge {
    /// main session → subagent (主→子 派出关系)
    Spawned {
        from_session: String, // SessionNode.node_id
        to_subagent_id: String, // e.g. "agent-a1d92"
        to_subagent_path: String,
    },
    /// 单 session 内 message-parent 链
    ParentUuid {
        session: String,
        from_uuid: String,
        to_uuid: String,
    },
    /// session 用了什么 tool + 几次 (来自 message.content[].tool_use.name 计数)
    UsedTool {
        session: String,
        tool_name: String,
        count: u64,
    },
    /// session 内出现 is_error=true 的 tool_result 多少次
    AttemptedFix {
        session: String,
        error_count: u64,
    },
    /// Cross-session — OpenClaw `sessions.json` parent 字段
    CrossSession {
        parent: String,
        child: String,
    },
}

/// 一个 session 的完整物化输出(node + 该 session 的所有 edge)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionGraph {
    pub node: SessionNode,
    pub edges: Vec<Edge>,
}
