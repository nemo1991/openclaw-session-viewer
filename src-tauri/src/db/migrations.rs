//! v0.8.4: 轻量 schema 迁移 — 给已存在 v0.8.x DB 加新列
//!
//! 设计取舍 (与 plan §B.2 一致):
//! - 不引入 `migration` 表 / `PRAGMA user_version`
//! - 用 `PRAGMA table_info(session_meta)` 拿到已有列名
//! - 对每个 NEW_COLUMN,只在 DB 没有时才 `ALTER TABLE ... ADD COLUMN`
//! - 幂等: 跑两遍不会有副作用
//!
//! 何时升级到完整 migration 系统:
//! - 需要 DROP / RENAME 列
//! - 需要按 schema 版本号 disable 旧功能
//!
//! 此次新增的 11 列都是 additive NOT NULL DEFAULT 0 / NULL, 走 ALTER 就够。

use std::collections::HashSet;

use rusqlite::{params, Connection};

use crate::error::AppResult;

/// (列名, ALTER ADD COLUMN 用的类型+默认值声明)
/// 列声明必须跟 SCHEMA_SQL 里 CREATE TABLE 完全一致。
const NEW_COLUMNS: &[(&str, &str)] = &[
    ("error_count", "INTEGER NOT NULL DEFAULT 0"),
    ("user_message_count", "INTEGER NOT NULL DEFAULT 0"),
    ("assistant_message_count", "INTEGER NOT NULL DEFAULT 0"),
    ("duration_seconds", "INTEGER"),
    ("first_response_latency_ms", "INTEGER"),
    ("agent_name", "TEXT"),
    ("invoked_skills_count", "INTEGER NOT NULL DEFAULT 0"),
    ("plan_file_ref_count", "INTEGER NOT NULL DEFAULT 0"),
    ("compact_file_ref_count", "INTEGER NOT NULL DEFAULT 0"),
    ("queued_command_count", "INTEGER NOT NULL DEFAULT 0"),
    ("attached_file_count", "INTEGER NOT NULL DEFAULT 0"),
    // --- v0.8.4 item 2': SessionSummaryStrip 全固化 ---
    ("text_message_count", "INTEGER NOT NULL DEFAULT 0"),
    ("tool_usage_json", "TEXT"),
    ("phase_hint", "TEXT"),
    ("phase_detail", "TEXT"),
    ("repeat_run_count", "INTEGER NOT NULL DEFAULT 0"),
    ("repeat_run_max_tool", "TEXT"),
    ("repeat_run_max_count", "INTEGER"),
    ("idle_gap_count", "INTEGER NOT NULL DEFAULT 0"),
    ("idle_gap_max_ms", "INTEGER"),
    // --- v0.8.4 item 2'': ContentFilterPanel Model chip ---
    ("available_models_json", "TEXT"),
    // --- v0.8.5 A: per-tool 失败计数 ---
    ("tool_error_json", "TEXT"),
    // --- v0.8.7 A: parent_uuids 列 (newline-separated UUIDs, 给 GraphView ParentUuid edges) ---
    ("parent_uuids_text", "TEXT"),
];

/// v0.8.5 B: 全量 CREATE TABLE 声明, 给老 DB 创建缺失的 2 张新表 (tool_global_stats / tool_session)
/// CREATE TABLE IF NOT EXISTS 本身幂等, 跑两遍无副作用
const NEW_TABLES: &[&str] = &[
    r#"CREATE TABLE IF NOT EXISTS tool_global_stats (
        tool_name       TEXT PRIMARY KEY,
        total_calls     INTEGER NOT NULL DEFAULT 0,
        session_count   INTEGER NOT NULL DEFAULT 0,
        error_count     INTEGER NOT NULL DEFAULT 0,
        first_seen_ms   INTEGER,
        last_seen_ms    INTEGER
    )"#,
    r#"CREATE INDEX IF NOT EXISTS idx_tool_global_calls    ON tool_global_stats(total_calls DESC)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_tool_global_errors   ON tool_global_stats(error_count DESC)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_tool_global_sessions ON tool_global_stats(session_count DESC)"#,
    r#"CREATE TABLE IF NOT EXISTS tool_session (
        session_id  TEXT NOT NULL,
        tool_name   TEXT NOT NULL,
        call_count  INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        last_ts_ms  INTEGER,
        PRIMARY KEY (session_id, tool_name),
        FOREIGN KEY (session_id) REFERENCES session_meta(session_id) ON DELETE CASCADE
    )"#,
    r#"CREATE INDEX IF NOT EXISTS idx_tool_session_tool    ON tool_session(tool_name)"#,
    r#"CREATE INDEX IF NOT EXISTS idx_tool_session_session ON tool_session(session_id)"#,
];

/// 给 session_meta 加 v0.8.4 列 (仅缺失的列)。幂等。
pub fn ensure_columns(conn: &Connection) -> AppResult<()> {
    let have = read_existing_columns(conn)?;
    for (name, decl) in NEW_COLUMNS {
        if have.contains(*name) {
            continue;
        }
        // ALTER TABLE ... ADD COLUMN 不支持 IF NOT EXISTS (旧 SQLite), 走 PRAGMA 判断
        // SQLite 3.35+ 才支持, 但我们用 PRAGMA 兼容所有版本
        let sql = format!("ALTER TABLE session_meta ADD COLUMN {name} {decl}");
        conn.execute(&sql, params![])?;
        log::info!("v0.8.4 migration: added session_meta.{name}");
    }
    Ok(())
}

/// v0.8.5 B: 给老 DB 创建缺失的 tool_global_stats / tool_session 表 + 索引。幂等 (CREATE IF NOT EXISTS)。
pub fn ensure_tables(conn: &Connection) -> AppResult<()> {
    for stmt in NEW_TABLES {
        conn.execute_batch(stmt)?;
    }
    Ok(())
}

/// 读已有列名集合 (PRAGMA table_info 只返回列名在第 1 列)
fn read_existing_columns(conn: &Connection) -> AppResult<HashSet<String>> {
    let mut stmt = conn.prepare("PRAGMA table_info(session_meta)")?;
    let names: HashSet<String> = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn fresh_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE session_meta (
                session_id TEXT PRIMARY KEY,
                project_key TEXT NOT NULL
             );",
        )
        .unwrap();
        c
    }

    #[test]
    fn ensure_columns_adds_missing() {
        let conn = fresh_conn();
        ensure_columns(&conn).unwrap();
        // 全部 11 列都应该加进去
        let cols = read_existing_columns(&conn).unwrap();
        for (name, _) in NEW_COLUMNS {
            assert!(cols.contains(*name), "missing column {name}");
        }
    }

    #[test]
    fn ensure_columns_idempotent() {
        let conn = fresh_conn();
        ensure_columns(&conn).unwrap();
        // 再跑一次不应该报错
        ensure_columns(&conn).unwrap();
        let cols = read_existing_columns(&conn).unwrap();
        for (name, _) in NEW_COLUMNS {
            assert!(cols.contains(*name));
        }
        // session_id 还在
        assert!(cols.contains("session_id"));
    }

    #[test]
    fn ensure_columns_preserves_existing_rows() {
        let conn = fresh_conn();
        conn.execute(
            "INSERT INTO session_meta (session_id, project_key) VALUES ('abc', 'p')",
            [],
        )
        .unwrap();
        ensure_columns(&conn).unwrap();
        // 行还在
        let still: String = conn
            .query_row(
                "SELECT session_id FROM session_meta WHERE session_id='abc'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(still, "abc");
        // 新列默认值生效
        let err_count: i64 = conn
            .query_row(
                "SELECT error_count FROM session_meta WHERE session_id='abc'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(err_count, 0);
    }

    // ===== v0.8.5 B: ensure_tables 幂等 =====

    #[test]
    fn ensure_tables_creates_new_tables() {
        let conn = fresh_conn();
        ensure_tables(&conn).unwrap();
        // tool_global_stats 表存在
        let g: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tool_global_stats'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(g, 1);
        // tool_session 表存在
        let s: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tool_session'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(s, 1);
    }

    #[test]
    fn ensure_tables_idempotent() {
        let conn = fresh_conn();
        ensure_tables(&conn).unwrap();
        // 再跑一次不报错
        ensure_tables(&conn).unwrap();
        // 还是 2 张表 (没重复)
        let g: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tool_global_stats'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(g, 1);
    }
}
