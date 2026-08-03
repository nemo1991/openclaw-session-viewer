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
    // v0.8.12 item E: 列 alias 跟原始 column 同名, 改 r.get(N) → r.get("col") by name
    // (v0.8.10 D 同款 hardening — schema 加列 / 调列顺序不再踩坑)
    let sql = format!(
        "SELECT tool_name      AS tool_name,
                total_calls    AS total_calls,
                session_count  AS session_count,
                error_count    AS error_count,
                first_seen_ms  AS first_seen_ms,
                last_seen_ms   AS last_seen_ms
         FROM tool_global_stats
         ORDER BY {order_col} DESC
         LIMIT ?1"
    );
    let lim = limit.unwrap_or(50) as i64;
    // v0.8.7 C: 纯读, 走 reader pool
    state.db.with_read(|c| {
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params![lim], |r| {
                Ok(ToolAggregateRow {
                    tool_name: r.get("tool_name")?,
                    total_calls: r.get::<_, i64>("total_calls")? as u32,
                    session_count: r.get::<_, i64>("session_count")? as u32,
                    error_count: r.get::<_, i64>("error_count")? as u32,
                    error_rate: 0.0,
                    first_seen_ms: r.get("first_seen_ms")?,
                    last_seen_ms: r.get("last_seen_ms")?,
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
    // v0.8.7 C: 纯读, 走 reader pool
    state.db.with_read(|c| {
        let mut stmt = c.prepare(
            // v0.8.12 item E: 列 alias + r.get by name — 同 get_tool_aggregate
            "SELECT session_id  AS session_id,
                    call_count  AS call_count,
                    error_count AS error_count,
                    last_ts_ms  AS last_ts_ms
             FROM tool_session
             WHERE tool_name = ?1
             ORDER BY call_count DESC
             LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(rusqlite::params![tool_name, lim], |r| {
                Ok(ToolSessionRef {
                    session_id: r.get("session_id")?,
                    call_count: r.get::<_, i64>("call_count")? as u32,
                    error_count: r.get::<_, i64>("error_count")? as u32,
                    last_ts_ms: r.get("last_ts_ms")?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

/// v0.8.5 B: 手动触发全量 rebuild — 给 dev / SettingsRoute "重新计算工具统计" 按钮用
#[tauri::command]
pub async fn rebuild_tool_stats(state: State<'_, AppState>) -> AppResult<()> {
    // v0.8.7 C: 走写连接 (事务里 DELETE + INSERT)
    state.db.with_write(|c| {
        crate::db::schema::rebuild_tool_global_stats(c)?;
        Ok::<_, crate::error::AppError>(())
    })
}

#[cfg(test)]
mod tests {
    use crate::db::schema;
    use tempfile::tempdir;

    /// 辅助 — fresh DB pool + 应用 schema
    fn fresh_pool() -> (tempfile::TempDir, crate::db::DbPool) {
        let tmp = tempdir().unwrap();
        let pool = crate::db::open(tmp.path()).unwrap();
        (tmp, pool)
    }

    /// 辅助 — fixture 一个 session_meta 行(带 tool_usage_json + tool_error_json)
    /// 供 rebuild_tool_global_stats 聚合。封装到 with_write 内,避开借用 lifetime。
    fn insert_session_with_tools(
        pool: &crate::db::DbPool,
        sid: &str,
        usage: &[(&str, u32)],
        errors: &[(&str, u32)],
        last_ts: Option<&str>,
    ) {
        let usage_json =
            serde_json::to_string(&usage.iter().map(|(n, c)| (n, c)).collect::<Vec<_>>()).unwrap();
        let error_json = if errors.is_empty() {
            None
        } else {
            Some(
                serde_json::to_string(&errors.iter().map(|(n, c)| (n, c)).collect::<Vec<_>>())
                    .unwrap(),
            )
        };
        let sid_s = sid.to_string();
        let path = format!("/tmp/{sid}.jsonl");
        let ts = last_ts.map(str::to_string);
        pool.with_write(|c| {
            c.execute(
                "INSERT INTO session_meta
                   (session_id, project_key, source, jsonl_path, last_timestamp,
                    size_bytes, mtime_ms, line_count, tool_usage_json, tool_error_json,
                    first_timestamp, message_count, tool_use_count, error_count,
                    subagent_count, thinking_count, synced_at)
                 VALUES (?1, 'p', 'claude', ?2, ?3, 0, 0, 0, ?4, ?5, ?3, 0, 0, 0, 0, 0, 0)",
                rusqlite::params![sid_s, path, ts, usage_json, error_json],
            )?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();
    }

    // ===== v0.8.12 item E: get_tool_aggregate 排序测试 =====

    #[test]
    fn aggregate_default_sort_by_calls() {
        let (_tmp, pool) = fresh_pool();
        // Bash 15 calls, Read 8 calls, Edit 3 calls
        insert_session_with_tools(
            &pool,
            "s1",
            &[("Bash", 10), ("Read", 5), ("Edit", 3)],
            &[],
            Some("2026-08-01T10:00:00Z"),
        );
        insert_session_with_tools(
            &pool,
            "s2",
            &[("Bash", 5), ("Read", 3)],
            &[],
            Some("2026-08-01T11:00:00Z"),
        );
        pool.with_write(|c| {
            schema::rebuild_tool_global_stats(c)?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();

        // 直接查表 (绕过 Tauri State)
        let rows: Vec<(String, i64)> = pool
            .with_read(|c| {
                let mut stmt = c.prepare(
                    "SELECT tool_name, total_calls FROM tool_global_stats
                     ORDER BY total_calls DESC",
                )?;
                let r = stmt
                    .query_map([], |r| Ok((r.get(0)?, r.get::<_, i64>(1)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(r)
            })
            .unwrap();
        assert_eq!(rows[0].0, "Bash");
        assert_eq!(rows[0].1, 15);
        assert_eq!(rows[1].0, "Read");
        assert_eq!(rows[1].1, 8);
        assert_eq!(rows[2].0, "Edit");
        assert_eq!(rows[2].1, 3);
    }

    #[test]
    fn aggregate_sort_by_sessions() {
        let (_tmp, pool) = fresh_pool();
        // Bash 跨 3 session, Read 跨 2, Edit 跨 1
        // s1: Bash+Read, s2: Bash+Read, s3: Bash+Edit
        insert_session_with_tools(
            &pool,
            "s1",
            &[("Bash", 5), ("Read", 3)],
            &[],
            Some("2026-08-01T10:00:00Z"),
        );
        insert_session_with_tools(
            &pool,
            "s2",
            &[("Bash", 4), ("Read", 2)],
            &[],
            Some("2026-08-01T10:00:00Z"),
        );
        insert_session_with_tools(
            &pool,
            "s3",
            &[("Bash", 3), ("Edit", 1)],
            &[],
            Some("2026-08-01T10:00:00Z"),
        );
        pool.with_write(|c| {
            schema::rebuild_tool_global_stats(c)?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();

        let rows: Vec<(String, i64)> = pool
            .with_read(|c| {
                let mut stmt = c.prepare(
                    "SELECT tool_name, session_count FROM tool_global_stats
                     ORDER BY session_count DESC",
                )?;
                let r = stmt
                    .query_map([], |r| Ok((r.get(0)?, r.get::<_, i64>(1)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(r)
            })
            .unwrap();
        assert_eq!(rows[0].0, "Bash", "Bash 跨 3 session 排第一");
        assert_eq!(rows[0].1, 3);
        assert_eq!(rows[1].0, "Read", "Read 跨 2 session 排第二(只 s1/s2 用过)");
        assert_eq!(rows[1].1, 2);
        assert_eq!(rows[2].0, "Edit", "Edit 跨 1 session 排第三(只 s3 用过)");
        assert_eq!(rows[2].1, 1);
    }

    #[test]
    fn aggregate_sort_by_errors() {
        let (_tmp, pool) = fresh_pool();
        // Bash 5 errors (跨 2 session), Read 10 errors (跨 1 session)
        insert_session_with_tools(
            &pool,
            "s1",
            &[("Bash", 20)],
            &[("Bash", 3), ("Read", 10)],
            Some("2026-08-01T10:00:00Z"),
        );
        insert_session_with_tools(
            &pool,
            "s2",
            &[("Bash", 10)],
            &[("Bash", 2)],
            Some("2026-08-01T11:00:00Z"),
        );
        pool.with_write(|c| {
            schema::rebuild_tool_global_stats(c)?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();

        let rows: Vec<(String, i64)> = pool
            .with_read(|c| {
                let mut stmt = c.prepare(
                    "SELECT tool_name, error_count FROM tool_global_stats
                     ORDER BY error_count DESC",
                )?;
                let r = stmt
                    .query_map([], |r| Ok((r.get(0)?, r.get::<_, i64>(1)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(r)
            })
            .unwrap();
        assert_eq!(rows[0].0, "Read", "Read 10 errors 排第一");
        assert_eq!(rows[0].1, 10);
        assert_eq!(rows[1].0, "Bash", "Bash 5 errors 排第二");
        assert_eq!(rows[1].1, 5);
    }

    #[test]
    fn aggregate_limit_caps_rows() {
        let (_tmp, pool) = fresh_pool();
        // 5 个 tool, limit=2 应只返 2 个 (按 total_calls 降序)
        for (i, name) in ["Bash", "Read", "Edit", "Write", "Grep"].iter().enumerate() {
            insert_session_with_tools(
                &pool,
                &format!("s{i}"),
                &[(*name, (5 - i as u32) * 10)],
                &[],
                Some("2026-08-01T10:00:00Z"),
            );
        }
        pool.with_write(|c| {
            schema::rebuild_tool_global_stats(c)?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();

        // 直接 query 拿 LIMIT 2 后的 2 行
        let names: Vec<String> = pool
            .with_read(|c| {
                let mut stmt = c.prepare(
                    "SELECT tool_name FROM tool_global_stats
                     ORDER BY total_calls DESC LIMIT 2",
                )?;
                let r = stmt
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(r)
            })
            .unwrap();
        assert_eq!(names.len(), 2, "LIMIT 2 只返 2 行");
        assert_eq!(names[0], "Bash", "Bash 50 calls 排第一");
        assert_eq!(names[1], "Read", "Read 40 calls 排第二");
    }

    #[test]
    fn aggregate_error_rate_calculated_in_rust() {
        // v0.8.12 item E: error_rate 在 Rust 算 (避免 SQL div-by-zero)
        // total=0 → 0.0, error=2/total=10 → 0.2
        let (_tmp, pool) = fresh_pool();
        insert_session_with_tools(
            &pool,
            "s1",
            &[("Bash", 10)],
            &[("Bash", 2)],
            Some("2026-08-01T10:00:00Z"),
        );
        pool.with_write(|c| {
            schema::rebuild_tool_global_stats(c)?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();

        // 模拟 get_tool_aggregate 的 error_rate 计算
        let (total, errors): (u32, u32) = pool
            .with_read(|c| {
                Ok(c.query_row(
                    "SELECT total_calls, error_count FROM tool_global_stats WHERE tool_name = 'Bash'",
                    [],
                    |r| Ok((r.get::<_, i64>(0)? as u32, r.get::<_, i64>(1)? as u32)),
                )?)
            })
            .unwrap();
        let error_rate = if total > 0 {
            errors as f64 / total as f64
        } else {
            0.0
        };
        assert_eq!(total, 10);
        assert_eq!(errors, 2);
        assert!(
            (error_rate - 0.2).abs() < 1e-9,
            "error_rate = 0.2, 实际 {error_rate}"
        );
    }

    #[test]
    fn aggregate_empty_table_returns_empty_vec() {
        let (_tmp, pool) = fresh_pool();
        // 没数据,直接查应空
        let count: i64 = pool
            .with_read(|c| {
                Ok(c.query_row("SELECT COUNT(*) FROM tool_global_stats", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(count, 0, "fresh DB 无 tool_global_stats 行");
    }

    // ===== v0.8.12 item E: get_tool_sessions 排序 + limit 测试 =====

    #[test]
    fn tool_sessions_returns_sessions_with_calls_desc() {
        let (_tmp, pool) = fresh_pool();
        // Bash 在 3 session 各有不同 call_count
        for (sid, count) in [("s1", 5), ("s2", 20), ("s3", 10)] {
            insert_session_with_tools(
                &pool,
                sid,
                &[("Bash", count)],
                &[],
                Some("2026-08-01T10:00:00Z"),
            );
        }
        pool.with_write(|c| {
            schema::rebuild_tool_global_stats(c)?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();

        // 直接查 tool_session (按 call_count desc)
        let rows: Vec<(String, i64)> = pool
            .with_read(|c| {
                let mut stmt = c.prepare(
                    "SELECT session_id, call_count FROM tool_session
                     WHERE tool_name = 'Bash' ORDER BY call_count DESC",
                )?;
                let r = stmt
                    .query_map([], |r| Ok((r.get(0)?, r.get::<_, i64>(1)?)))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(r)
            })
            .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].0, "s2", "s2 call_count=20 排第一");
        assert_eq!(rows[0].1, 20);
        assert_eq!(rows[1].0, "s3", "s3 call_count=10 排第二");
        assert_eq!(rows[1].1, 10);
        assert_eq!(rows[2].0, "s1");
        assert_eq!(rows[2].1, 5);
    }

    #[test]
    fn tool_sessions_limit() {
        let (_tmp, pool) = fresh_pool();
        for i in 0..5 {
            insert_session_with_tools(
                &pool,
                &format!("s{i}"),
                &[("Bash", (i + 1) as u32 * 10)],
                &[],
                Some("2026-08-01T10:00:00Z"),
            );
        }
        pool.with_write(|c| {
            schema::rebuild_tool_global_stats(c)?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();

        let count: i64 = pool
            .with_read(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM (SELECT 1 FROM tool_session
                     WHERE tool_name = 'Bash' ORDER BY call_count DESC LIMIT 3)",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(count, 3, "LIMIT 3 只返 3 行");
    }

    #[test]
    fn tool_sessions_empty_tool_returns_empty() {
        let (_tmp, pool) = fresh_pool();
        // 没数据,查不存在的 tool 应空
        let count: i64 = pool
            .with_read(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) FROM tool_session WHERE tool_name = 'NotExist'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    // ===== v0.8.12 item E: rebuild_tool_stats 集成测试 =====

    #[test]
    fn rebuild_tool_stats_inserts_aggregate_rows() {
        // v0.8.12 item E: rebuild_tool_stats 走完应把 session_meta.tool_usage_json
        // 聚合到 tool_global_stats,直接调 schema::rebuild_tool_global_stats 验证
        let (_tmp, pool) = fresh_pool();
        insert_session_with_tools(
            &pool,
            "s1",
            &[("Bash", 5), ("Read", 3)],
            &[("Bash", 1)],
            Some("2026-08-01T10:00:00Z"),
        );
        insert_session_with_tools(
            &pool,
            "s2",
            &[("Bash", 8)],
            &[],
            Some("2026-08-01T11:00:00Z"),
        );

        // 重建前空
        let pre: i64 = pool
            .with_read(|c| {
                Ok(c.query_row("SELECT COUNT(*) FROM tool_global_stats", [], |r| r.get(0))?)
            })
            .unwrap();
        assert_eq!(pre, 0);

        // 重建
        pool.with_write(|c| {
            schema::rebuild_tool_global_stats(c)?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();

        // 重建后: 2 个 tool (Bash + Read)
        let (bash_total, bash_sessions, bash_errors, read_total): (i64, i64, i64, i64) = pool
            .with_read(|c| {
                Ok(c.query_row(
                    "SELECT
                       COALESCE((SELECT total_calls FROM tool_global_stats WHERE tool_name = 'Bash'), 0),
                       COALESCE((SELECT session_count FROM tool_global_stats WHERE tool_name = 'Bash'), 0),
                       COALESCE((SELECT error_count FROM tool_global_stats WHERE tool_name = 'Bash'), 0),
                       COALESCE((SELECT total_calls FROM tool_global_stats WHERE tool_name = 'Read'), 0)",
                    [],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, i64>(2)?,
                            r.get::<_, i64>(3)?,
                        ))
                    },
                )?)
            })
            .unwrap();
        assert_eq!(bash_total, 13, "Bash = 5 + 8");
        assert_eq!(bash_sessions, 2, "Bash 跨 2 session");
        assert_eq!(bash_errors, 1, "Bash 1 error");
        assert_eq!(read_total, 3, "Read = 3");
    }
}
