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

use rusqlite::{params, Connection, OptionalExtension};

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
    // --- v0.8.8: GraphView first_prompt 列 (list_graph SELECT 引用, 之前 schema 漏) ---
    ("first_prompt", "TEXT"),
];

/// v0.8.8: 列重命名 — 老 v0.8.x DB 用 `first_ts`/`last_ts`, list_graph SELECT 现在引用
/// `first_timestamp`/`last_timestamp` (跟 GraphNodeFE 字段名一致)。SQLite 3.25+ 支持
/// ALTER TABLE RENAME COLUMN, 幂等 (have 检查)。
const COLUMN_RENAMES: &[(&str, &str)] = &[
    ("first_ts", "first_timestamp"),
    ("last_ts", "last_timestamp"),
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
    // v0.8.8: 重命名老 v0.8.x 列名 (first_ts/last_ts → first_timestamp/last_timestamp)
    // SQLite 3.25+ 支持 ALTER TABLE RENAME COLUMN, 老 DB 升级路径
    for (old, new) in COLUMN_RENAMES {
        if have.contains(*old) && !have.contains(*new) {
            let sql = format!("ALTER TABLE session_meta RENAME COLUMN {old} TO {new}");
            conn.execute(&sql, params![])?;
            log::info!("v0.8.8 migration: renamed session_meta.{old} → {new}");
        }
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

/// v0.9.0: 给老 v0.8.x DB 的 `session_meta.source` CHECK 约束加 'kimi'
///
/// SQLite 不支持 ALTER TABLE 修改 CHECK 约束。走标准 12-step rebuild dance:
/// 1. CREATE TABLE session_meta_new (跟原 schema 完全一致,新 CHECK)
/// 2. INSERT INTO session_meta_new SELECT * FROM session_meta
/// 3. DROP TABLE session_meta
/// 4. ALTER TABLE session_meta_new RENAME TO session_meta
/// 5. 重建所有索引
///
/// 幂等: 跑两遍(CHECK 已含 'kimi')→ bail,不重建。
pub fn ensure_kimi_in_source_check(conn: &Connection) -> AppResult<()> {
    // 1) 看 CHECK 现状 — 含 'kimi' 则跳过
    let has_kimi_check: bool = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_meta'",
            [],
            |r| {
                let sql: String = r.get(0)?;
                Ok(sql.contains("'kimi'"))
            },
        )
        .optional()
        .unwrap_or(Some(false))
        .unwrap_or(false);
    if has_kimi_check {
        return Ok(());
    }

    log::info!("v0.9.0 migration: rebuilding session_meta to add 'kimi' to source CHECK");

    // 2) 取当前 session_meta 的全列定义(PRAGMA table_info)
    let mut col_defs: Vec<String> = Vec::new();
    {
        let mut stmt = conn.prepare("PRAGMA table_info(session_meta)")?;
        let rows = stmt.query_map([], |r| {
            let name: String = r.get(1)?;
            let ty: String = r.get(2)?;
            let notnull: i64 = r.get(3)?;
            let default_val: Option<String> = r.get(4)?;
            let pk: i64 = r.get(5)?;
            let mut s = format!("{} {}", name, ty);
            if pk > 0 {
                s.push_str(" PRIMARY KEY");
            }
            if notnull != 0 && pk == 0 {
                s.push_str(" NOT NULL");
            }
            if let Some(d) = default_val {
                s.push_str(&format!(" DEFAULT {}", d));
            }
            Ok(s)
        })?;
        for row in rows {
            col_defs.push(row?);
        }
    }

    // 3) 拿当前所有索引的 SQL,rebuild 后逐条重建
    let indexes: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='session_meta' AND sql IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |r| {
            let sql: String = r.get(0)?;
            Ok(sql)
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // 4) 开启事务(rebuild 必须 atomic,失败回滚)
    conn.execute_batch("BEGIN")?;

    // 5) 建新表 — 保留 source 列原位置,只改 CHECK 约束(替换原 CREATE TABLE 文本)
    //    从 sqlite_master 拿原 CREATE TABLE SQL,正则替换 CHECK 部分
    let original_create_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_meta'",
            [],
            |r| r.get(0),
        )
        .ok()
        .unwrap_or_default();
    // 替换 CHECK 约束: 'claude','openclaw' → 'claude','openclaw','kimi'
    let new_table_sql = original_create_sql
        .replace(
            "CHECK(source IN ('claude','openclaw'))",
            "CHECK(source IN ('claude','openclaw','kimi'))",
        )
        .replace("session_meta", "session_meta_new");

    conn.execute_batch(&new_table_sql)?;

    // 6) 数据迁移
    conn.execute_batch("INSERT INTO session_meta_new SELECT * FROM session_meta")?;

    // 7) 删旧表
    conn.execute_batch("DROP TABLE session_meta")?;

    // 8) 改名
    conn.execute_batch("ALTER TABLE session_meta_new RENAME TO session_meta")?;

    // 9) 重建索引
    for idx_sql in &indexes {
        conn.execute_batch(idx_sql)?;
    }

    // 10) 提交
    conn.execute_batch("COMMIT")?;

    log::info!("v0.9.0 migration: session_meta rebuilt with 'kimi' source");
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

    // ===== v0.9.0: ensure_kimi_in_source_check =====

    /// 建一个老 v0.8.x DB:source 列 CHECK 只含 claude/openclaw
    fn fresh_v8_db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            r#"CREATE TABLE session_meta (
                session_id TEXT PRIMARY KEY,
                project_key TEXT NOT NULL,
                source TEXT NOT NULL CHECK(source IN ('claude','openclaw')),
                jsonl_path TEXT NOT NULL,
                size_bytes INTEGER NOT NULL DEFAULT 0,
                mtime_ms INTEGER NOT NULL DEFAULT 0,
                line_count INTEGER NOT NULL DEFAULT 0,
                first_timestamp TEXT,
                last_timestamp TEXT,
                message_count INTEGER NOT NULL DEFAULT 0,
                synced_at INTEGER NOT NULL DEFAULT 0
            );"#,
        )
        .unwrap();
        // 插入一条 claude 行 — 验证 rebuild 后数据不丢
        c.execute(
            "INSERT INTO session_meta (session_id, project_key, source, jsonl_path) VALUES (?, ?, ?, ?)",
            rusqlite::params!["s1", "k1", "claude", "/p1"],
        ).unwrap();
        c
    }

    #[test]
    fn ensure_kimi_in_source_check_rebuilds_table() {
        let conn = fresh_v8_db();
        ensure_kimi_in_source_check(&conn).unwrap();
        // 现在 source CHECK 应含 'kimi'
        let has_kimi: bool = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_meta'",
                [],
                |r| Ok(r.get::<_, String>(0)?.contains("'kimi'")),
            )
            .unwrap();
        assert!(has_kimi, "after migration, CHECK should include 'kimi'");
        // 旧数据保留
        let sid: String = conn
            .query_row(
                "SELECT session_id FROM session_meta WHERE session_id='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sid, "s1");
        // kimi INSERT 现在成功
        conn.execute(
            "INSERT INTO session_meta (session_id, project_key, source, jsonl_path) VALUES ('s2', 'k2', 'kimi', '/p2')",
            [],
        ).unwrap();
    }

    #[test]
    fn ensure_kimi_in_source_check_idempotent() {
        let conn = fresh_v8_db();
        ensure_kimi_in_source_check(&conn).unwrap();
        // 再跑一次不应该破坏(sid 还在,索引都在)
        ensure_kimi_in_source_check(&conn).unwrap();
        let sid: String = conn
            .query_row(
                "SELECT session_id FROM session_meta WHERE session_id='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sid, "s1");
        // kimi 还能插入
        conn.execute(
            "INSERT INTO session_meta (session_id, project_key, source, jsonl_path) VALUES ('s3', 'k3', 'kimi', '/p3')",
            [],
        ).unwrap();
    }
}
