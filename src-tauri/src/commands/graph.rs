//! v0.8.5 C: graph 数据源从 NDJSON 切到 session_meta DB
//!
//! 提供 `list_graph` command, 返回 `Vec<GraphEntry>` (从 session_meta JOIN 派生)。
//!
//! v0.8.5 范围:
//! - node 字段全部从 session_meta 派生 (含 firstPrompt, lastMessageAt 等)
//! - UsedTool edges 从 session_meta.tool_usage_json 派生 (item 2' 固化数据)
//!
//! v0.8.6+ 后续补完:
//! - Spawned / ParentUuid / AttemptedFix / CrossSession edges
//! - is_subagent_root / parent_session_id 派生 (需要 subagent 关联扫描)
//! - assistant_text_snippets (RAG 用的 top 3 文本块)

use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct GraphNodeFE {
    pub node_id: String,
    pub source: String, // "Claude" | "OpenClaw"
    pub session_id: String,
    pub workspace: Option<String>,
    pub jsonl_path: String,
    pub size_bytes: u64,
    pub mtime_ms: u64,
    pub first_prompt: Option<String>,
    pub first_timestamp_ms: Option<i64>,
    pub last_timestamp_ms: Option<i64>,
    pub token_total: u64,
    pub thinking_count: u32,
    pub primary_model: Option<String>,
    pub top_tools: Vec<String>,
    pub error_count: u32,
    pub subagent_count: u32,
    pub subagent_ids: Vec<String>,
    pub is_subagent_root: bool,
    pub parent_session_id: Option<String>,
    pub message_count: u32,
    pub agent_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EdgeFE {
    UsedTool {
        session: String,
        tool_name: String,
        count: u32,
    },
    /// v0.8.6 A: session.error_count > 0 → AttemptedFix edge
    AttemptedFix { session: String, error_count: u32 },
    /// v0.8.6 A: session.subagent_count > 0 → N 个 Spawned edges
    /// (from_session 派 subagent_id; to_subagent_path 暂时 None — subagent
    /// 文件路径需要 subagents/ 关联, 留 v0.8.7)
    Spawned {
        from_session: String,
        to_subagent_id: String,
        to_subagent_path: Option<String>,
        description: Option<String>,
    },
    // ParentUuid + CrossSession 暂时不派生, 需要 session_meta 加 parent_uuid
    // / parent_session_id 列 (v0.8.7+)
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphEntryFE {
    pub node: GraphNodeFE,
    pub edges: Vec<EdgeFE>,
}

#[derive(serde::Deserialize)]
struct TokenUsageFE {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
}

fn parse_iso_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

#[tauri::command]
pub async fn list_graph(state: State<'_, AppState>) -> AppResult<Vec<GraphEntryFE>> {
    state.db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT session_id, project_key, source, jsonl_path, size_bytes, mtime_ms,
                    first_timestamp, last_timestamp, message_count, thinking_count,
                    tool_use_count, top_tools_json, total_tokens_json, primary_model,
                    error_count, subagent_count, subagent_ids_json, first_prompt, agent_id,
                    tool_usage_json
             FROM session_meta
             ORDER BY mtime_ms DESC",
        )?;

        let rows: Vec<GraphEntryFE> = stmt
            .query_map([], |r| {
                let session_id: String = r.get(0)?;
                let source_raw: String = r.get(2)?;
                let source = if source_raw == "claude" {
                    "Claude"
                } else {
                    "OpenClaw"
                };

                let first_ts: Option<String> = r.get(6)?;
                let last_ts: Option<String> = r.get(7)?;
                let first_ts_ms = first_ts.as_deref().and_then(parse_iso_ms);
                let last_ts_ms = last_ts.as_deref().and_then(parse_iso_ms);

                let top_tools_json: Option<String> = r.get(11)?;
                let top_tools: Vec<String> = top_tools_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                    .unwrap_or_default();

                let total_tokens_json: Option<String> = r.get(12)?;
                let token_total: u64 = total_tokens_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<TokenUsageFE>(s).ok())
                    .map(|t| t.input + t.output + t.cache_read + t.cache_write)
                    .unwrap_or(0);

                let subagent_ids_json: Option<String> = r.get(17)?;
                let subagent_ids: Vec<String> = subagent_ids_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                    .unwrap_or_default();
                // v0.8.6 A: 提前读 error_count / subagent_count 给 edges 派生用
                let error_count: u32 = r.get::<_, i64>(14)? as u32;
                // 用完 subagent_count 立即释放 borrow
                let subagent_count: u32 = r.get::<_, i64>(15)? as u32;
                let _ = subagent_count; // 只在 node 用

                let node = GraphNodeFE {
                    node_id: session_id.clone(),
                    source: source.to_string(),
                    session_id: session_id.clone(),
                    workspace: r.get(1)?,
                    jsonl_path: r.get(3)?,
                    size_bytes: r.get::<_, i64>(4)? as u64,
                    mtime_ms: r.get::<_, i64>(5)? as u64,
                    first_prompt: r.get(18)?,
                    first_timestamp_ms: first_ts_ms,
                    last_timestamp_ms: last_ts_ms,
                    token_total,
                    thinking_count: r.get::<_, i64>(9)? as u32,
                    primary_model: r.get(13)?,
                    top_tools,
                    error_count,
                    subagent_count,
                    subagent_ids: subagent_ids.clone(), // v0.8.6 A: edges 派生也要用
                    is_subagent_root: false,            // v0.8.6+ 派生
                    parent_session_id: None,            // v0.8.6+ 派生
                    message_count: r.get::<_, i64>(8)? as u32,
                    agent_id: r.get(19)?,
                };

                // UsedTool edges 派生 from tool_usage_json: [["Bash", 286], ...]
                let tool_usage_json: Option<String> = r.get(20)?;
                let mut edges: Vec<EdgeFE> = Vec::new();
                if let Some(json) = tool_usage_json {
                    if let Ok(usage) = serde_json::from_str::<Vec<(String, u32)>>(&json) {
                        for (tool_name, count) in usage {
                            edges.push(EdgeFE::UsedTool {
                                session: session_id.clone(),
                                tool_name,
                                count,
                            });
                        }
                    }
                }

                // v0.8.6 A: AttemptedFix — error_count > 0 时派生
                if error_count > 0 {
                    edges.push(EdgeFE::AttemptedFix {
                        session: session_id.clone(),
                        error_count,
                    });
                }
                // v0.8.6 A: Spawned — 每个 subagent_id 派生一个 edge
                // (subagent_ids 来自 subagent_ids_json, SessionMeta 已经有)
                for sub_id in &subagent_ids {
                    edges.push(EdgeFE::Spawned {
                        from_session: session_id.clone(),
                        to_subagent_id: sub_id.clone(),
                        to_subagent_path: None, // v0.8.7+ 加 SessionSubagentMeta 表
                        description: None,
                    });
                }

                Ok(GraphEntryFE { node, edges })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok(rows)
    })
}
