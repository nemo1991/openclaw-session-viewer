//! v0.8.0 DB schema — 一次性全表定义
//!
//! 表清单:
//! - `session_meta`     — jsonl 同步结果(单行 = 一个 session)
//! - `session_override` — 用户视角(display_title / hidden / pinned / archived / notes)
//! - `tag` + `session_tag` — 多对多标签
//! - `session_link`     — 跨 session backlink
//! - `search_history`   — 搜索 query 历史
//! - `sync_state`       — 单行同步状态
//!
//! 所有表用 `IF NOT EXISTS`,幂等可重入。

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::AppResult;
use crate::model::SessionMeta;

/// 应用全部 schema(只在打开 DB 时调一次)
pub fn apply(conn: &Connection) -> AppResult<()> {
    conn.execute_batch(SCHEMA_SQL)?;
    Ok(())
}

/// Schema 文本 — 单独抽出来便于 PR review
const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS session_meta (
  session_id        TEXT PRIMARY KEY,
  project_key       TEXT NOT NULL,
  workspace_guess   TEXT,
  source            TEXT NOT NULL CHECK(source IN ('claude','openclaw')),
  agent_id          TEXT,
  jsonl_path        TEXT NOT NULL UNIQUE,
  size_bytes        INTEGER NOT NULL,
  mtime_ms          INTEGER NOT NULL,
  line_count        INTEGER NOT NULL,
  first_ts          TEXT,
  last_ts           TEXT,
  message_count     INTEGER NOT NULL DEFAULT 0,
  thinking_count    INTEGER NOT NULL DEFAULT 0,
  tool_use_count    INTEGER NOT NULL DEFAULT 0,
  top_tools_json    TEXT,
  total_tokens_json TEXT,
  primary_model     TEXT,
  has_trajectory    INTEGER NOT NULL DEFAULT 0,
  trajectory_size   INTEGER,
  subagent_count    INTEGER NOT NULL DEFAULT 0,
  subagent_ids_json TEXT,
  synced_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sm_mtime    ON session_meta(mtime_ms DESC);
CREATE INDEX IF NOT EXISTS idx_sm_lastts   ON session_meta(last_ts DESC);
CREATE INDEX IF NOT EXISTS idx_sm_project  ON session_meta(project_key);
CREATE INDEX IF NOT EXISTS idx_sm_agent    ON session_meta(agent_id);

CREATE TABLE IF NOT EXISTS session_override (
  session_id    TEXT PRIMARY KEY,
  display_title TEXT,
  hidden        INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  updated_at    INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES session_meta(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_so_hidden   ON session_override(hidden)   WHERE hidden = 1;
CREATE INDEX IF NOT EXISTS idx_so_pinned   ON session_override(pinned)   WHERE pinned = 1;
CREATE INDEX IF NOT EXISTS idx_so_archived ON session_override(archived) WHERE archived = 1;

CREATE TABLE IF NOT EXISTS tag (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE IF NOT EXISTS session_tag (
  session_id TEXT NOT NULL,
  tag_id     INTEGER NOT NULL,
  PRIMARY KEY(session_id, tag_id),
  FOREIGN KEY(session_id) REFERENCES session_meta(session_id) ON DELETE CASCADE,
  FOREIGN KEY(tag_id)     REFERENCES tag(id)            ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_st_tag ON session_tag(tag_id);

CREATE TABLE IF NOT EXISTS session_link (
  from_session TEXT NOT NULL,
  to_session   TEXT NOT NULL,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY(from_session, to_session)
);

CREATE TABLE IF NOT EXISTS search_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  query     TEXT NOT NULL,
  hit_count INTEGER NOT NULL,
  ts        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sh_ts ON search_history(ts DESC);

CREATE TABLE IF NOT EXISTS sync_state (
  id           INTEGER PRIMARY KEY CHECK(id = 1),
  last_run_at  INTEGER,
  last_error   TEXT,
  files_seen   INTEGER NOT NULL DEFAULT 0,
  files_synced INTEGER NOT NULL DEFAULT 0,
  in_progress  INTEGER NOT NULL DEFAULT 0
);
"#;

// ===== 数据行 struct(内部使用) =====

/// session_meta 表的一行
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct SessionMetaRow {
    pub meta: SessionMeta,
    pub size_bytes: u64,
    pub mtime_ms: u64,
    pub line_count: u64,
}

/// session_override 的一行
#[allow(dead_code)]
#[derive(Debug, Default, Clone)]
pub struct OverrideRow {
    pub session_id: String,
    pub display_title: Option<String>,
    pub hidden: bool,
    pub pinned: bool,
    pub archived: bool,
    pub notes: Option<String>,
}

/// 同步状态(单行)
#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct SyncStateRow {
    pub last_run_at: Option<i64>,
    pub last_error: Option<String>,
    pub files_seen: u32,
    pub files_synced: u32,
    pub in_progress: bool,
}

/// DB 路径下的轻量元数据,供增量判断(只查 size/mtime/line_count)
#[derive(Debug, Clone)]
pub struct SizeMtimeRow {
    pub size_bytes: u64,
    pub mtime_ms: u64,
    pub line_count: u64,
}

/// 按 jsonl_path 查 (size_bytes, mtime_ms, line_count) — 增量判断
pub fn get_size_mtime_by_path(conn: &Connection, path: &str) -> AppResult<Option<SizeMtimeRow>> {
    let row = conn
        .query_row(
            "SELECT size_bytes, mtime_ms, line_count FROM session_meta WHERE jsonl_path = ?1",
            params![path],
            |r| {
                Ok(SizeMtimeRow {
                    size_bytes: r.get::<_, i64>(0)? as u64,
                    mtime_ms: r.get::<_, i64>(1)? as u64,
                    line_count: r.get::<_, i64>(2)? as u64,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// UPSERT 一行 session_meta
///
/// 设计:不传 `synced_at` 字段(由 DB 层自动写入 `unixepoch() * 1000`),
/// 这样写代码更干净。
pub fn upsert_session_meta(
    conn: &Connection,
    m: &SessionMeta,
    size_bytes: u64,
    mtime_ms: u64,
    line_count: u64,
) -> AppResult<()> {
    let top_tools_json = serde_json::to_string(&m.top_tools).unwrap_or_else(|_| "null".into());
    let total_tokens_json = m
        .total_tokens
        .as_ref()
        .and_then(|t| serde_json::to_string(t).ok());
    let subagent_ids_json = m
        .subagent_ids
        .as_ref()
        .and_then(|t| serde_json::to_string(t).ok());

    conn.execute(
        r#"
        INSERT INTO session_meta (
          session_id, project_key, workspace_guess, source, agent_id,
          jsonl_path, size_bytes, mtime_ms, line_count,
          first_ts, last_ts, message_count,
          thinking_count, tool_use_count,
          top_tools_json, total_tokens_json, primary_model,
          has_trajectory, trajectory_size,
          subagent_count, subagent_ids_json,
          synced_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5,
          ?6, ?7, ?8, ?9,
          ?10, ?11, ?12,
          ?13, ?14,
          ?15, ?16, ?17,
          ?18, ?19,
          ?20, ?21,
          (CAST(strftime('%s','now') AS INTEGER) * 1000)
        )
        ON CONFLICT(session_id) DO UPDATE SET
          project_key      = excluded.project_key,
          workspace_guess  = excluded.workspace_guess,
          source           = excluded.source,
          agent_id         = excluded.agent_id,
          jsonl_path       = excluded.jsonl_path,
          size_bytes       = excluded.size_bytes,
          mtime_ms         = excluded.mtime_ms,
          line_count       = excluded.line_count,
          first_ts         = excluded.first_ts,
          last_ts          = excluded.last_ts,
          message_count    = excluded.message_count,
          thinking_count   = excluded.thinking_count,
          tool_use_count   = excluded.tool_use_count,
          top_tools_json   = excluded.top_tools_json,
          total_tokens_json= excluded.total_tokens_json,
          primary_model    = excluded.primary_model,
          has_trajectory   = excluded.has_trajectory,
          trajectory_size  = excluded.trajectory_size,
          subagent_count   = excluded.subagent_count,
          subagent_ids_json= excluded.subagent_ids_json,
          synced_at        = excluded.synced_at
        "#,
        params![
            m.session_id,
            m.project_key,
            m.workspace_guess,
            m.source,
            m.agent_id,
            m.jsonl_path,
            size_bytes as i64,
            mtime_ms as i64,
            line_count as i64,
            m.first_timestamp,
            m.last_timestamp,
            m.message_count as i64,
            // v0.8.2: NOT NULL DEFAULT 0 列必须给 0 而非 NULL。
            // 之前 .map(|v| v as i64) 在 None 时传 NULL,触发 NOT NULL 失败,
            // sync_one 整体失败 → orphan sweep 把 session_meta 行误删(见 CHANGELOG [0.8.2])
            m.thinking_count.map(|v| v as i64).unwrap_or(0),
            m.tool_use_count.map(|v| v as i64).unwrap_or(0),
            top_tools_json,
            total_tokens_json,
            m.primary_model,
            m.has_trajectory.unwrap_or(false) as i32,
            m.trajectory_size_bytes.map(|v| v as i64),
            m.subagent_count.map(|v| v as i64).unwrap_or(0),
            subagent_ids_json,
        ],
    )?;
    Ok(())
}

/// 单行 JOIN 查询:session_meta + override + tags
#[allow(dead_code)]
pub fn fetch_session_meta_joined(
    conn: &Connection,
    session_id: &str,
) -> AppResult<Option<JoinedRow>> {
    let sql = format!(
        "{} WHERE m.session_id = ?1 GROUP BY m.session_id",
        JOIN_SELECT_BASE
    );
    let row = conn
        .query_row(&sql, params![session_id], joined_row_mapper)
        .optional()?;
    Ok(row)
}

/// 按 jsonl_path 查一条 joined 行(给 get_session_meta 命令用)
pub fn fetch_session_meta_by_path(conn: &Connection, path: &str) -> AppResult<Option<JoinedRow>> {
    let sql = format!(
        "{} WHERE m.jsonl_path = ?1 GROUP BY m.session_id",
        JOIN_SELECT_BASE
    );
    let row = conn
        .query_row(&sql, params![path], joined_row_mapper)
        .optional()?;
    Ok(row)
}

/// 全部 joined 行,按 mtime 倒序(给 list_sessions 用)
pub fn list_all_joined(conn: &Connection) -> AppResult<Vec<JoinedRow>> {
    let sql = format!(
        "{} GROUP BY m.session_id ORDER BY m.mtime_ms DESC",
        JOIN_SELECT_BASE
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], joined_row_mapper)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 一次 JOIN 拿全量字段。
///
/// v0.8.1: GROUP BY 时聚合 mtime_ms 用 MAX(避免 SQLite 在 GROUP BY 里对
/// 非聚合列取任意行导致 ORDER BY 0 全等 → 退化为 session_id 字典序)。
const JOIN_SELECT_BASE: &str = r#"
SELECT
  m.session_id, m.project_key, m.workspace_guess, m.source, m.agent_id,
  m.jsonl_path, m.size_bytes, m.first_ts, m.last_ts, m.message_count,
  m.thinking_count, m.tool_use_count, m.top_tools_json, m.total_tokens_json,
  m.primary_model, m.has_trajectory, m.trajectory_size,
  m.subagent_count, m.subagent_ids_json,
  MAX(m.mtime_ms) AS mtime_ms,
  o.display_title, o.hidden, o.pinned, o.archived, o.notes,
  GROUP_CONCAT(t.name, ',') AS tag_names
FROM session_meta m
LEFT JOIN session_override o ON m.session_id = o.session_id
LEFT JOIN session_tag st     ON m.session_id = st.session_id
LEFT JOIN tag t              ON st.tag_id = t.id
"#;

/// JOIN 结果(供前端 SessionMeta 直接序列化)
#[derive(Debug, Clone)]
pub struct JoinedRow {
    pub meta: SessionMeta,
    pub display_title: Option<String>,
    pub hidden: bool,
    pub pinned: bool,
    pub archived: bool,
    pub notes: Option<String>,
    pub tag_names: Vec<String>,
}

fn joined_row_mapper(row: &rusqlite::Row<'_>) -> rusqlite::Result<JoinedRow> {
    // 列序见 JOIN_SELECT_BASE。注意:m.mtime_ms 现在是聚合列,索引 19。
    let top_tools_json: Option<String> = row.get(12)?;
    let total_tokens_json: Option<String> = row.get(13)?;
    let subagent_ids_json: Option<String> = row.get(18)?;
    // index 19 = MAX(m.mtime_ms) (v0.8.1 修复:之前 mtime_ms 未拉,mapping 硬填 0)
    // 注:GROUP BY m.session_id 时 m.* 在 SQLite 是任意单值,但 mtime_ms 一致,
    // MAX 兜底多版本共存的兜底。
    let tag_names_csv: Option<String> = row.get(25)?;
    let tag_names: Vec<String> = tag_names_csv
        .map(|s| {
            s.split(',')
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();

    let meta = SessionMeta {
        session_id: row.get(0)?,
        project_key: row.get(1)?,
        workspace_guess: row.get(2)?,
        source: row.get(3)?,
        agent_id: row.get(4)?,
        jsonl_path: row.get(5)?,
        size_bytes: row.get::<_, i64>(6)? as u64,
        mtime_ms: row.get::<_, i64>(19)? as u64,
        first_timestamp: row.get(7)?,
        last_timestamp: row.get(8)?,
        message_count: row.get::<_, i64>(9)? as u32,
        thinking_count: Some(row.get::<_, i64>(10)? as u32),
        tool_use_count: Some(row.get::<_, i64>(11)? as u32),
        top_tools: top_tools_json.and_then(|s| serde_json::from_str(&s).ok()),
        total_tokens: total_tokens_json.and_then(|s| serde_json::from_str(&s).ok()),
        primary_model: row.get(14)?,
        has_trajectory: Some(row.get::<_, i64>(15)? != 0),
        trajectory_size_bytes: row.get::<_, Option<i64>>(16)?.map(|v| v as u64),
        subagent_count: Some(row.get::<_, i64>(17)? as u32),
        subagent_ids: subagent_ids_json.and_then(|s| serde_json::from_str(&s).ok()),
        live_pid: None,
        subagent_dir: None,
        title: None, // title 由前端从 display_title ?? ai/custom/first_prompt 计算
        last_message_at: row.get(8)?,
        agent_label: None,
        agent_channel: None,
        agent_target: None,
        first_prompt: None,
        display_title: None,
        hidden: false,
        pinned: false,
        archived: false,
        notes: None,
        tags: None,
    };

    Ok(JoinedRow {
        meta,
        display_title: row.get(20)?,
        // v0.8.3: LEFT JOIN 时没 session_override 行的 session,这些列都是 NULL。
        // 之前 `row.get::<_, i64>(...)` 在 NULL 上抛 `Invalid column type Null`,
        // 用户装 v0.8.2 后整张列表崩成"出错了"。改成 Option<i64> + unwrap_or(0) 兜底。
        hidden: row.get::<_, Option<i64>>(21)?.unwrap_or(0) != 0,
        pinned: row.get::<_, Option<i64>>(22)?.unwrap_or(0) != 0,
        archived: row.get::<_, Option<i64>>(23)?.unwrap_or(0) != 0,
        notes: row.get(24)?,
        tag_names,
    })
}
