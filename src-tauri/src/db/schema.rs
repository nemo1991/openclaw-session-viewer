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
    // v0.8.4: 给已存在 v0.8.x DB 加列 (item 2)
    crate::db::migrations::ensure_columns(conn)?;
    // v0.8.5 B: 给老 DB 创建 tool_global_stats / tool_session 表 + 索引 (CREATE IF NOT EXISTS 幂等)
    crate::db::migrations::ensure_tables(conn)?;
    // v0.9.0: 给老 v0.8.x DB 的 session_meta.source CHECK 加 'kimi' (rebuild dance)
    crate::db::migrations::ensure_kimi_in_source_check(conn)?;
    Ok(())
}

/// Schema 文本 — 单独抽出来便于 PR review
const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS session_meta (
  session_id        TEXT PRIMARY KEY,
  project_key       TEXT NOT NULL,
  workspace_guess   TEXT,
  source            TEXT NOT NULL CHECK(source IN ('claude','openclaw','kimi')),
  agent_id          TEXT,
  jsonl_path        TEXT NOT NULL UNIQUE,
  size_bytes        INTEGER NOT NULL,
  mtime_ms          INTEGER NOT NULL,
  line_count        INTEGER NOT NULL,
  first_timestamp   TEXT,
  last_timestamp    TEXT,
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
  synced_at         INTEGER NOT NULL,
  -- v0.8.4: 派生指标 (由 build_meta_full 二阶段填充)
  error_count                INTEGER NOT NULL DEFAULT 0,
  user_message_count         INTEGER NOT NULL DEFAULT 0,
  assistant_message_count    INTEGER NOT NULL DEFAULT 0,
  duration_seconds           INTEGER,
  first_response_latency_ms  INTEGER,
  agent_name                 TEXT,
  invoked_skills_count       INTEGER NOT NULL DEFAULT 0,
  plan_file_ref_count        INTEGER NOT NULL DEFAULT 0,
  compact_file_ref_count     INTEGER NOT NULL DEFAULT 0,
  queued_command_count       INTEGER NOT NULL DEFAULT 0,
  attached_file_count        INTEGER NOT NULL DEFAULT 0,
  -- v0.8.4 item 2': SessionSummaryStrip 全固化
  text_message_count          INTEGER NOT NULL DEFAULT 0,
  tool_usage_json             TEXT,
  phase_hint                  TEXT,
  phase_detail                TEXT,
  repeat_run_count            INTEGER NOT NULL DEFAULT 0,
  repeat_run_max_tool         TEXT,
  repeat_run_max_count        INTEGER,
  idle_gap_count              INTEGER NOT NULL DEFAULT 0,
  idle_gap_max_ms             INTEGER,
  -- v0.8.4 item 2'': ContentFilterPanel Model chip 也走 DB
  available_models_json       TEXT,
  -- v0.8.8: first_prompt 列 — 给 GraphView 节点首条 user prompt 显示用
  first_prompt                TEXT,
  -- v0.8.5 A: per-tool 失败计数 — [["Bash", 3], ["WebFetch", 1]] 按 count desc
  -- 跟 error_count (message 级) 正交, 互补
  tool_error_json             TEXT,
  -- v0.8.7 A: 该 session 出现过的全部 parent_uuid(去重), 新行分隔字符串
  -- 给 GraphView 派生 ParentUuid edges 用 (跨 session 关联可视化)
  parent_uuids_text           TEXT,
  -- v0.9.8: Kimi 专属聚合列 — 详情页折叠面板 + chip 数据来源
  todo_summary_json           TEXT,
  kimi_token_usage_json       TEXT,
  meta_banner_json            TEXT
);

CREATE INDEX IF NOT EXISTS idx_sm_mtime    ON session_meta(mtime_ms DESC);
CREATE INDEX IF NOT EXISTS idx_sm_lastts   ON session_meta(last_timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_sm_project  ON session_meta(project_key);
CREATE INDEX IF NOT EXISTS idx_sm_agent    ON session_meta(agent_id);

-- v0.8.5 B: 全局 tool 聚合 — 跨 session 工具排行/失败/时间线
CREATE TABLE IF NOT EXISTS tool_global_stats (
    tool_name       TEXT PRIMARY KEY,
    total_calls     INTEGER NOT NULL DEFAULT 0,
    session_count   INTEGER NOT NULL DEFAULT 0,
    error_count     INTEGER NOT NULL DEFAULT 0,
    first_seen_ms   INTEGER,
    last_seen_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_global_calls    ON tool_global_stats(total_calls DESC);
CREATE INDEX IF NOT EXISTS idx_tool_global_errors   ON tool_global_stats(error_count DESC);
CREATE INDEX IF NOT EXISTS idx_tool_global_sessions ON tool_global_stats(session_count DESC);

-- v0.8.5 B: 反范式 (session_id, tool_name) → call_count + error_count, 给"哪些 session 用过 X tool"查询
CREATE TABLE IF NOT EXISTS tool_session (
    session_id  TEXT NOT NULL,
    tool_name   TEXT NOT NULL,
    call_count  INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    last_ts_ms  INTEGER,
    PRIMARY KEY (session_id, tool_name),
    FOREIGN KEY (session_id) REFERENCES session_meta(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tool_session_tool    ON tool_session(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_session_session ON tool_session(session_id);

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
#[serde(rename_all = "camelCase")]
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
          first_timestamp, last_timestamp, message_count,
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
          first_timestamp = excluded.first_timestamp,
          last_timestamp  = excluded.last_timestamp,
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
  m.jsonl_path, m.size_bytes, m.first_timestamp, m.last_timestamp, m.message_count,
  m.thinking_count, m.tool_use_count, m.top_tools_json, m.total_tokens_json,
  m.primary_model, m.has_trajectory, m.trajectory_size,
  m.subagent_count, m.subagent_ids_json,
  MAX(m.mtime_ms) AS mtime_ms,
  o.display_title, o.hidden, o.pinned, o.archived, o.notes,
  GROUP_CONCAT(t.name, ',') AS tag_names,
  -- v0.8.4: 派生指标 (item 2)
  m.error_count, m.user_message_count, m.assistant_message_count,
  m.duration_seconds, m.first_response_latency_ms, m.agent_name,
  m.invoked_skills_count, m.plan_file_ref_count, m.compact_file_ref_count,
  m.queued_command_count, m.attached_file_count,
  -- v0.8.4 item 2': SessionSummaryStrip 全固化
  m.text_message_count, m.tool_usage_json,
  m.phase_hint, m.phase_detail,
  m.repeat_run_count, m.repeat_run_max_tool, m.repeat_run_max_count,
  m.idle_gap_count, m.idle_gap_max_ms,
  -- v0.8.4 item 2'': ContentFilterPanel Model chip
  m.available_models_json,
  -- v0.8.5 A: per-tool 失败计数
  m.tool_error_json,
  -- v0.8.7 A: parent_uuids (GraphView ParentUuid edges)
  m.parent_uuids_text,
  -- v0.9.8: kimi 专属聚合列 (TodoWrite + token + MetaBanner)
  m.todo_summary_json,
  m.kimi_token_usage_json,
  m.meta_banner_json
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
        // v0.8.4 item 2: 派生指标从 JOIN 直接读
        // 注意: 这些列在 JOIN_SELECT_BASE 里都是 m.* 直接拉, NOT NULL DEFAULT 0
        // (duration_seconds / first_response_latency_ms / agent_name 可空)
        error_count: Some(row.get::<_, i64>(26)? as u32),
        user_message_count: Some(row.get::<_, i64>(27)? as u32),
        assistant_message_count: Some(row.get::<_, i64>(28)? as u32),
        duration_seconds: row.get::<_, Option<i64>>(29)?.map(|v| v as u64),
        first_response_latency_ms: row.get::<_, Option<i64>>(30)?.map(|v| v as u64),
        agent_name: row.get(31)?,
        invoked_skills_count: Some(row.get::<_, i64>(32)? as u32),
        plan_file_ref_count: Some(row.get::<_, i64>(33)? as u32),
        compact_file_ref_count: Some(row.get::<_, i64>(34)? as u32),
        queued_command_count: Some(row.get::<_, i64>(35)? as u32),
        attached_file_count: Some(row.get::<_, i64>(36)? as u32),
        // v0.8.4 item 2': SessionSummaryStrip 全固化
        // 紧凑 JSON 格式 [["Bash", 286], ...] 解析回 Vec<(String, u32)>
        text_message_count: Some(row.get::<_, i64>(37)? as u32),
        tool_usage: row
            .get::<_, Option<String>>(38)?
            .and_then(|s| serde_json::from_str::<Vec<(String, u32)>>(&s).ok()),
        phase_hint: row.get(39)?,
        phase_detail: row.get(40)?,
        repeat_run_count: Some(row.get::<_, i64>(41)? as u32),
        repeat_run_max_tool: row.get(42)?,
        repeat_run_max_count: row.get::<_, Option<i64>>(43)?.map(|v| v as u32),
        idle_gap_count: Some(row.get::<_, i64>(44)? as u32),
        idle_gap_max_ms: row.get::<_, Option<i64>>(45)?.map(|v| v as u64),
        // v0.8.4 item 2'': ContentFilterPanel Model chip 走 DB
        available_models: row
            .get::<_, Option<String>>(46)?
            .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok()),
        // v0.8.5 A: per-tool 失败计数 (跟 tool_usage 同 JSON 紧凑格式)
        tool_error: row
            .get::<_, Option<String>>(47)?
            .and_then(|s| serde_json::from_str::<Vec<(String, u32)>>(&s).ok()),
        // v0.8.7 A: parent_uuids (newline-separated text)
        parent_uuids_text: row.get::<_, Option<String>>(48)?,
        // v0.9.8: kimi 专属聚合 (TodoWrite + token + MetaBanner)
        todo_summary: row
            .get::<_, Option<String>>(49)?
            .and_then(|s| serde_json::from_str(&s).ok()),
        kimi_token_usage: row
            .get::<_, Option<String>>(50)?
            .and_then(|s| serde_json::from_str(&s).ok()),
        meta_banner: row
            .get::<_, Option<String>>(51)?
            .and_then(|s| serde_json::from_str(&s).ok()),
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

/// v0.8.4 item 2: 由 build_meta_full 提取的派生指标, 单独 UPDATE 到 session_meta
///
/// 跟 upsert_session_meta 解耦: 第一次 sync 走 quick path 50 行, 派生列默认 0;
/// 第二个 loop iteration 跑 build_meta_full(全量扫描), 拿到 extras 后调这个。
///
/// v0.8.4 item 2' 扩展: 8 个新参数对应 SessionSummaryStrip 全固化
/// (textMessageCount / toolUsage / phaseHint / phaseDetail /
///  repeatRunCount / repeatRunMaxTool / repeatRunMaxCount /
///  idleGapCount / idleGapMaxMs — 共 9 个, 但 toolUsage 是 1 个 JSON)。
#[allow(clippy::too_many_arguments)]
pub fn enrich_session_meta(
    conn: &Connection,
    session_id: &str,
    error_count: u32,
    user_message_count: u32,
    assistant_message_count: u32,
    duration_seconds: Option<u64>,
    first_response_latency_ms: Option<u64>,
    agent_name: Option<&str>,
    invoked_skills_count: u32,
    plan_file_ref_count: u32,
    compact_file_ref_count: u32,
    queued_command_count: u32,
    attached_file_count: u32,
    // --- v0.8.4 item 2' ---
    text_message_count: u32,
    tool_usage_json: Option<&str>,
    phase_hint: Option<&str>,
    phase_detail: Option<&str>,
    repeat_run_count: u32,
    repeat_run_max_tool: Option<&str>,
    repeat_run_max_count: Option<u32>,
    idle_gap_count: u32,
    idle_gap_max_ms: Option<u64>,
    // --- v0.8.4 item 2'': ContentFilterPanel Model chip ---
    available_models_json: Option<&str>,
    // --- v0.8.5 A: per-tool 失败计数 ---
    tool_error_json: Option<&str>,
    // --- v0.8.7 A: parent_uuids_text (newline-separated) — GraphView ParentUuid edges 用 ---
    parent_uuids_text: Option<&str>,
    // --- v0.9.5: thinking_count (kimi wire event content.part.part.type=="think" 计数,
    //     claude/openclaw 路径暂填 0)
    thinking_count: u32,
    // --- v0.9.8: kimi 专属聚合 (TodoWrite + token + MetaBanner) ---
    todo_summary_json: Option<&str>,
    kimi_token_usage_json: Option<&str>,
    meta_banner_json: Option<&str>,
) -> AppResult<()> {
    conn.execute(
        r#"
        UPDATE session_meta SET
          error_count               = ?2,
          user_message_count        = ?3,
          assistant_message_count   = ?4,
          duration_seconds          = ?5,
          first_response_latency_ms = ?6,
          agent_name                = ?7,
          invoked_skills_count      = ?8,
          plan_file_ref_count       = ?9,
          compact_file_ref_count    = ?10,
          queued_command_count      = ?11,
          attached_file_count       = ?12,
          -- v0.8.4 item 2': SessionSummaryStrip 全固化
          text_message_count        = ?13,
          tool_usage_json           = ?14,
          phase_hint                = ?15,
          phase_detail              = ?16,
          repeat_run_count          = ?17,
          repeat_run_max_tool       = ?18,
          repeat_run_max_count      = ?19,
          idle_gap_count            = ?20,
          idle_gap_max_ms           = ?21,
          -- v0.8.4 item 2'': ContentFilterPanel Model chip
          available_models_json     = ?22,
          -- v0.8.5 A: per-tool 失败计数
          tool_error_json           = ?23,
          -- v0.8.7 A: parent_uuids (newline-separated) GraphView ParentUuid edges
          parent_uuids_text         = ?24,
          -- v0.9.5: thinking_count (kimi content.part.part.type=="think" 计数)
          thinking_count            = ?25,
          -- v0.9.8: kimi 专属聚合 (TodoWrite + token + MetaBanner)
          todo_summary_json         = ?26,
          kimi_token_usage_json     = ?27,
          meta_banner_json          = ?28
        WHERE session_id = ?1
        "#,
        params![
            session_id,
            error_count as i64,
            user_message_count as i64,
            assistant_message_count as i64,
            duration_seconds.map(|v| v as i64),
            first_response_latency_ms.map(|v| v as i64),
            agent_name,
            invoked_skills_count as i64,
            plan_file_ref_count as i64,
            compact_file_ref_count as i64,
            queued_command_count as i64,
            attached_file_count as i64,
            // v0.8.4 item 2'
            text_message_count as i64,
            tool_usage_json,
            phase_hint,
            phase_detail,
            repeat_run_count as i64,
            repeat_run_max_tool,
            repeat_run_max_count.map(|v| v as i64),
            idle_gap_count as i64,
            idle_gap_max_ms.map(|v| v as i64),
            // v0.8.4 item 2''
            available_models_json,
            // v0.8.5 A
            tool_error_json,
            // v0.8.7 A
            parent_uuids_text,
            // v0.9.5: thinking_count
            thinking_count as i64,
            // v0.9.8: kimi 专属聚合 (JSON)
            todo_summary_json,
            kimi_token_usage_json,
            meta_banner_json,
        ],
    )?;
    Ok(())
}

// ===== v0.8.5 B: 跨 session 工具聚合 (事务内 TRUNCATE + 全量重算) =====

/// v0.8.5 B: 在事务里清空 tool_session / tool_global_stats, 然后从 session_meta 的
/// tool_usage_json + tool_error_json 重新聚合.
///
/// 选 TRUNCATE + 重算 (而非 diff/增量) 的理由:
/// - session 数 <10K 时, 几条 SQL 跑完, 性能可接受
/// - 事务 atomic, 用户永远看不到中间状态 (空表或部分聚合)
/// - 避免 tool_session_history 这种 diff 表, 减小 schema 复杂度
/// - 重复累加 bug 不会发生
pub fn rebuild_tool_global_stats(conn: &Connection) -> AppResult<()> {
    let tx = conn.unchecked_transaction()?;

    // 1) 清空两张表
    tx.execute("DELETE FROM tool_session", [])?;
    tx.execute("DELETE FROM tool_global_stats", [])?;

    // 2) 全量聚合 — 从 session_meta 读 tool_usage_json + tool_error_json
    //    对每个 session:
    //      - 解析 tool_usage_json [(name, count)...]
    //      - 解析 tool_error_json [(name, count)...]
    //      - INSERT INTO tool_session (session_id, tool_name, call_count, error_count)
    //      - 累加到 tool_global_stats
    //
    //    用 Rust 解析 JSON 后逐行 INSERT (无 GROUP BY 跨 session, 因为 SQL 里没有好的
    //    "展开 JSON array 内每行" 语法, 在 SQLite 没有 json_each function)

    let mut stmt = tx.prepare(
        "SELECT session_id, tool_usage_json, tool_error_json, last_timestamp FROM session_meta
         WHERE tool_usage_json IS NOT NULL OR tool_error_json IS NOT NULL",
    )?;
    #[allow(clippy::type_complexity)]
    let rows: Vec<(String, Option<String>, Option<String>, Option<String>)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?,
            ))
        })?
        .collect::<Result<_, _>>()?;
    drop(stmt);

    use std::collections::HashMap;
    // global: tool_name → (total_calls, session_count, error_count, first_seen_ms, last_seen_ms)
    let mut global: HashMap<String, (i64, i64, i64, i64, i64)> = HashMap::new();

    for (sid, usage_json, error_json, last_ts) in rows {
        let last_ts_ms = last_ts
            .as_deref()
            .and_then(parse_rfc3339_to_ms)
            .unwrap_or(0);

        // 解析 tool_usage_json: [(tool, count)]
        let mut per_session: HashMap<String, (i64, i64)> = HashMap::new(); // tool → (calls, errors)
        if let Some(json) = usage_json {
            if let Ok(usage) = serde_json::from_str::<Vec<(String, u32)>>(&json) {
                for (tool, count) in usage {
                    per_session.entry(tool).or_insert((0, 0)).0 += count as i64;
                }
            }
        }
        if let Some(json) = error_json {
            if let Ok(errors) = serde_json::from_str::<Vec<(String, u32)>>(&json) {
                for (tool, count) in errors {
                    per_session.entry(tool).or_insert((0, 0)).1 += count as i64;
                }
            }
        }

        // 写 tool_session + 累加 global
        for (tool, (calls, errors)) in &per_session {
            tx.execute(
                "INSERT INTO tool_session (session_id, tool_name, call_count, error_count, last_ts_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![sid, tool, *calls, *errors, last_ts_ms],
            )?;
            let entry = global
                .entry(tool.clone())
                .or_insert((0, 0, 0, last_ts_ms, last_ts_ms));
            entry.0 += calls;
            entry.1 += 1; // session_count
            entry.2 += errors;
            if last_ts_ms > 0 {
                entry.3 = entry.3.min(last_ts_ms);
                entry.4 = entry.4.max(last_ts_ms);
            }
        }
    }

    // 3) 写 tool_global_stats
    let mut ins = tx.prepare(
        "INSERT INTO tool_global_stats (tool_name, total_calls, session_count, error_count,
                                         first_seen_ms, last_seen_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )?;
    for (tool, (calls, sessions, errors, first_ms, last_ms)) in &global {
        ins.execute(params![
            tool,
            *calls,
            *sessions,
            *errors,
            if *first_ms > 0 { Some(*first_ms) } else { None },
            if *last_ms > 0 { Some(*last_ms) } else { None },
        ])?;
    }
    drop(ins);

    tx.commit()?;
    Ok(())
}

/// v0.8.5 B: 解析 RFC-3339 时间戳到毫秒 (从 meta_extras.rs 复制的轻量版)
fn parse_rfc3339_to_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

#[cfg(test)]
mod sync_helpers_tests {
    use super::*;
    use rusqlite::Connection;

    fn fresh_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA_SQL).unwrap();
        c
    }

    // v0.8.6 B: 增量判断 — 文件 (size, mtime, line_count) 三元组跟 DB 一致 → 跳过重 sync
    #[test]
    fn get_size_mtime_returns_none_for_missing_path() {
        let conn = fresh_conn();
        let r = get_size_mtime_by_path(&conn, "/no/such/path").unwrap();
        assert!(r.is_none());
    }

    #[test]
    fn get_size_mtime_returns_row_for_existing_path() {
        let conn = fresh_conn();
        conn.execute(
            "INSERT INTO session_meta (session_id, project_key, source, jsonl_path,
                                       size_bytes, mtime_ms, line_count, synced_at)
             VALUES ('s1', 'p', 'claude', '/tmp/foo.jsonl', 1234, 5678, 100, 0)",
            [],
        )
        .unwrap();
        let r = get_size_mtime_by_path(&conn, "/tmp/foo.jsonl")
            .unwrap()
            .unwrap();
        assert_eq!(r.size_bytes, 1234);
        assert_eq!(r.mtime_ms, 5678);
        assert_eq!(r.line_count, 100);
    }
}

#[cfg(test)]
mod round_trip_tests {
    use super::*;
    use rusqlite::Connection;

    fn fresh_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA_SQL).unwrap();
        c
    }

    // v0.8.5 E: tool_usage_json 写 → 读 回 Vec<(String, u32)>
    #[test]
    fn tool_usage_json_round_trip() {
        let conn = fresh_conn();
        // 插入 1 行 (含 top_tools_json / tool_usage_json)
        conn.execute(
            "INSERT INTO session_meta (session_id, project_key, source, jsonl_path, size_bytes,
                                       mtime_ms, line_count, synced_at, top_tools_json, tool_usage_json)
             VALUES ('s1', 'p', 'claude', '/x', 0, 0, 0, 0, '[\"Bash\",\"Read\"]',
                     '[[\"Bash\",286],[\"Read\",50]]')",
            [],
        )
        .unwrap();
        // 读回
        let json: String = conn
            .query_row(
                "SELECT tool_usage_json FROM session_meta WHERE session_id='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let parsed: Vec<(String, u32)> = serde_json::from_str(&json).unwrap();
        assert_eq!(
            parsed,
            vec![("Bash".to_string(), 286), ("Read".to_string(), 50)]
        );
    }

    // v0.8.5 E: tool_error_json 写 → 读
    #[test]
    fn tool_error_json_round_trip() {
        let conn = fresh_conn();
        conn.execute(
            "INSERT INTO session_meta (session_id, project_key, source, jsonl_path, size_bytes,
                                       mtime_ms, line_count, synced_at, tool_error_json)
             VALUES ('s1', 'p', 'claude', '/x', 0, 0, 0, 0,
                     '[[\"Bash\",3],[\"WebFetch\",1]]')",
            [],
        )
        .unwrap();
        let json: String = conn
            .query_row(
                "SELECT tool_error_json FROM session_meta WHERE session_id='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let parsed: Vec<(String, u32)> = serde_json::from_str(&json).unwrap();
        assert_eq!(
            parsed,
            vec![("Bash".to_string(), 3), ("WebFetch".to_string(), 1)]
        );
    }

    // v0.8.5 E: enrich_session_meta 各列更新正确
    #[test]
    fn enrich_session_meta_writes_all_columns() {
        let conn = fresh_conn();
        // 先 INSERT 一行
        conn.execute(
            "INSERT INTO session_meta (session_id, project_key, source, jsonl_path, size_bytes,
                                       mtime_ms, line_count, synced_at)
             VALUES ('s1', 'p', 'claude', '/x', 0, 0, 0, 0)",
            [],
        )
        .unwrap();
        // 调 enrich
        enrich_session_meta(
            &conn,
            "s1",
            5,  // error_count
            10, // user_message_count
            8,  // assistant_message_count
            Some(3600),
            Some(5000),
            Some("agent-x"),
            2,
            1,
            1,
            0,
            0,  // invoked/plans/compacts/queued/attached
            18, // text_message_count
            Some("[[\"Bash\",286]]"),
            Some("implement"),
            Some("47% 写操作"),
            3, // repeat_run_count
            Some("Bash"),
            Some(5),
            2, // idle_gap_count
            Some(420_000),
            Some("[\"opus\",\"sonnet\"]"),
            Some("[[\"Bash\",3]]"), // tool_error
            Some("uuid-a\nuuid-b"), // v0.8.7 A: parent_uuids
            7,                      // v0.9.5: thinking_count
            None,                   // v0.9.8: todo_summary_json
            None,                   // v0.9.8: kimi_token_usage_json
            None,                   // v0.9.8: meta_banner_json
        )
        .unwrap();
        // 读回验证
        let (err, txt, repeat, idle, tool_err, tool_use, agent): (
            i64,
            i64,
            i64,
            i64,
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT error_count, text_message_count, repeat_run_count, idle_gap_count,
                        tool_error_json, tool_usage_json, agent_name
                 FROM session_meta WHERE session_id='s1'",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(err, 5);
        assert_eq!(txt, 18);
        assert_eq!(repeat, 3);
        assert_eq!(idle, 2);
        assert!(tool_err.contains("Bash"));
        assert!(tool_use.contains("Bash"));
        assert_eq!(agent, "agent-x");
    }

    // v0.8.5 E: enrich_session_meta 接受 None 字段 (不覆盖已有值)
    #[test]
    fn enrich_session_meta_handles_none_fields() {
        let conn = fresh_conn();
        conn.execute(
            "INSERT INTO session_meta (session_id, project_key, source, jsonl_path, size_bytes,
                                       mtime_ms, line_count, synced_at)
             VALUES ('s1', 'p', 'claude', '/x', 0, 0, 0, 0)",
            [],
        )
        .unwrap();
        enrich_session_meta(
            &conn, "s1", 0, 0, 0, None, None, None, 0, 0, 0, 0, 0, 0, None, None, None, 0, None,
            None, 0, None, None, None, None, 0, // v0.9.5: thinking_count = 0
            None, None,
            None, // v0.9.8: todo_summary_json / kimi_token_usage_json / meta_banner_json
        )
        .unwrap();
        // 写完后所有列应为 default 0 / None
        let (agent, dur, err): (Option<String>, Option<i64>, i64) = conn
            .query_row(
                "SELECT agent_name, duration_seconds, error_count FROM session_meta WHERE session_id='s1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert!(agent.is_none());
        assert!(dur.is_none());
        assert_eq!(err, 0);
    }
}

#[cfg(test)]
mod tool_global_tests {
    use super::*;
    use rusqlite::Connection;

    fn fresh_conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        // 简化的 session_meta + 新表
        c.execute_batch(
            "CREATE TABLE session_meta (
                session_id TEXT PRIMARY KEY,
                last_timestamp TEXT,
                tool_usage_json TEXT,
                tool_error_json TEXT
             );
             CREATE TABLE tool_global_stats (
                tool_name TEXT PRIMARY KEY,
                total_calls INTEGER NOT NULL DEFAULT 0,
                session_count INTEGER NOT NULL DEFAULT 0,
                error_count INTEGER NOT NULL DEFAULT 0,
                first_seen_ms INTEGER,
                last_seen_ms INTEGER
             );
             CREATE TABLE tool_session (
                session_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                call_count INTEGER NOT NULL DEFAULT 0,
                error_count INTEGER NOT NULL DEFAULT 0,
                last_ts_ms INTEGER,
                PRIMARY KEY (session_id, tool_name)
             );",
        )
        .unwrap();
        c
    }

    #[test]
    fn rebuild_aggregates_basic() {
        let conn = fresh_conn();
        // 2 session 各有 Bash + Read, session 1 还有 Bash 失败
        conn.execute(
            "INSERT INTO session_meta (session_id, last_timestamp, tool_usage_json, tool_error_json) VALUES
             ('s1', '2026-07-08T10:00:00Z', '[[\"Bash\",10],[\"Read\",3]]', '[[\"Bash\",2]]'),
             ('s2', '2026-07-08T11:00:00Z', '[[\"Bash\",5],[\"Read\",7]]', NULL)",
            [],
        )
        .unwrap();
        rebuild_tool_global_stats(&conn).unwrap();
        // Bash: total=15, sessions=2, errors=2
        let (calls, sessions, errors): (i64, i64, i64) = conn
            .query_row(
                "SELECT total_calls, session_count, error_count FROM tool_global_stats WHERE tool_name='Bash'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(calls, 15);
        assert_eq!(sessions, 2);
        assert_eq!(errors, 2);
        // Read: total=10, sessions=2, errors=0
        let (calls, sessions, errors): (i64, i64, i64) = conn
            .query_row(
                "SELECT total_calls, session_count, error_count FROM tool_global_stats WHERE tool_name='Read'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(calls, 10);
        assert_eq!(sessions, 2);
        assert_eq!(errors, 0);
    }

    #[test]
    fn rebuild_clears_stale_data() {
        let conn = fresh_conn();
        // 先写一行 stale
        conn.execute(
            "INSERT INTO tool_global_stats (tool_name, total_calls) VALUES ('Stale', 999)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_meta (session_id, tool_usage_json) VALUES ('s1', '[[\"Bash\",1]]')",
            [],
        )
        .unwrap();
        rebuild_tool_global_stats(&conn).unwrap();
        // Stale 应该被清掉
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM tool_global_stats WHERE tool_name='Stale'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn rebuild_handles_empty_db() {
        let conn = fresh_conn();
        rebuild_tool_global_stats(&conn).unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM tool_global_stats", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    #[test]
    fn rebuild_writes_tool_session_rows() {
        let conn = fresh_conn();
        conn.execute(
            "INSERT INTO session_meta (session_id, tool_usage_json) VALUES ('s1', '[[\"Bash\",5]]')",
            [],
        )
        .unwrap();
        rebuild_tool_global_stats(&conn).unwrap();
        let (sid, calls): (String, i64) = conn
            .query_row(
                "SELECT session_id, call_count FROM tool_session WHERE tool_name='Bash'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(sid, "s1");
        assert_eq!(calls, 5);
    }
}
