//! v0.8.5 B: 全局 tool 聚合 — 跨 session 工具排行 / 失败 / 时间线
//!
//! 数据来源: `tool_global_stats` + `tool_session` (由 sync.rs 增量维护)
//! 见 `db::schema::rebuild_tool_global_stats`。

use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolAggregateRow {
    pub tool_name: String,
    pub total_calls: u32,
    pub session_count: u32,
    pub error_count: u32,
    pub error_rate: f64, // = error_count / total_calls (0 if no calls)
    pub first_seen_ms: Option<i64>,
    pub last_seen_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolSessionRef {
    pub session_id: String,
    pub call_count: u32,
    pub error_count: u32,
    pub last_ts_ms: Option<i64>,
}

/// v0.8.5 B: 全局工具排行 — sort_by 支持 "calls" / "sessions" / "errors"
#[tauri::command]
pub async fn get_tool_aggregate(
    state: State<'_, AppState>,
    sort_by: Option<String>,
    limit: Option<u32>,
) -> AppResult<Vec<ToolAggregateRow>> {
    let order_col = match sort_by.as_deref() {
        Some("sessions") => "session_count",
        Some("errors") => "error_count",
        _ => "total_calls",
    };
    let sql = format!(
        "SELECT tool_name, total_calls, session_count, error_count, first_seen_ms, last_seen_ms
         FROM tool_global_stats
         ORDER BY {order_col} DESC
         LIMIT ?1"
    );
    let lim = limit.unwrap_or(50) as i64;
    state.db.with(|c| {
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params![lim], |r| {
                Ok(ToolAggregateRow {
                    tool_name: r.get(0)?,
                    total_calls: r.get::<_, i64>(1)? as u32,
                    session_count: r.get::<_, i64>(2)? as u32,
                    error_count: r.get::<_, i64>(3)? as u32,
                    error_rate: 0.0,
                    first_seen_ms: r.get(4)?,
                    last_seen_ms: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        // error_rate 在 Rust 算 (避免 SQL div-by-zero)
        let out: Vec<ToolAggregateRow> = rows
            .into_iter()
            .map(|mut row| {
                row.error_rate = if row.total_calls > 0 {
                    row.error_count as f64 / row.total_calls as f64
                } else {
                    0.0
                };
                row
            })
            .collect();
        Ok(out)
    })
}

/// v0.8.5 B: 单 tool 跨 session — 哪些 session 用过此 tool, 按 call_count desc
#[tauri::command]
pub async fn get_tool_sessions(
    state: State<'_, AppState>,
    tool_name: String,
    limit: Option<u32>,
) -> AppResult<Vec<ToolSessionRef>> {
    let lim = limit.unwrap_or(20) as i64;
    state.db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT session_id, call_count, error_count, last_ts_ms
             FROM tool_session
             WHERE tool_name = ?1
             ORDER BY call_count DESC
             LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![tool_name, lim], |r| {
                Ok(ToolSessionRef {
                    session_id: r.get(0)?,
                    call_count: r.get::<_, i64>(1)? as u32,
                    error_count: r.get::<_, i64>(2)? as u32,
                    last_ts_ms: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// v0.8.5 B: 手动触发全量 rebuild — 给 dev / SettingsRoute "重新计算工具统计" 按钮用
#[tauri::command]
pub async fn rebuild_tool_stats(state: State<'_, AppState>) -> AppResult<()> {
    state.db.with(|c| {
        crate::db::schema::rebuild_tool_global_stats(c)?;
        Ok::<_, crate::error::AppError>(())
    })
}
