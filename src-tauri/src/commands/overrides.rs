//! v0.8.0 用户 override + tag + link + sync utilities Tauri commands
//!
//! 设计要点:
//! - 写操作都用 UPSERT/REPLACE INTO,保证幂等
//! - 每个写操作完后 `app.emit("overrides-changed", ())`,前端 listen 后 refresh
//! - list_overrides 返回扁平 Snapshot(renames/hidden/pinned/archived/notes/tags/links)
//!   便于前端 overridesStore 单次拉全量,避免多次 invoke

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::db::schema::SyncStateRow;
use crate::error::{AppError, AppResult};
use crate::AppState;

// ===== 单字段 setter commands =====

#[tauri::command]
pub async fn rename_session(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    sid: String,
    new_title: String,
) -> AppResult<()> {
    let trimmed = new_title.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("重命名不能为空".into()));
    }
    if trimmed.chars().count() > 200 {
        return Err(AppError::Invalid("重命名最长 200 字符".into()));
    }
    let now = now_ms();
    state.db.with(|c| {
        upsert_override_field(
            c,
            &sid,
            Some("display_title = excluded.display_title"),
            Some(trimmed.to_string()),
            now,
        )
    })?;
    let _ = app.emit("overrides-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn hide_session(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    sid: String,
    hidden: bool,
) -> AppResult<()> {
    let now = now_ms();
    state.db.with(|c| {
        upsert_override_field(
            c,
            &sid,
            Some("hidden = excluded.hidden"),
            Some(if hidden { "1" } else { "0" }.to_string()),
            now,
        )
    })?;
    let _ = app.emit("overrides-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn set_pinned(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    sid: String,
    pinned: bool,
) -> AppResult<()> {
    let now = now_ms();
    state.db.with(|c| {
        upsert_override_field(
            c,
            &sid,
            Some("pinned = excluded.pinned"),
            Some(if pinned { "1" } else { "0" }.to_string()),
            now,
        )
    })?;
    let _ = app.emit("overrides-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn set_archived(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    sid: String,
    archived: bool,
) -> AppResult<()> {
    let now = now_ms();
    state.db.with(|c| {
        upsert_override_field(
            c,
            &sid,
            Some("archived = excluded.archived"),
            Some(if archived { "1" } else { "0" }.to_string()),
            now,
        )
    })?;
    let _ = app.emit("overrides-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn set_notes(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    sid: String,
    notes: String,
) -> AppResult<()> {
    let trimmed = notes.trim();
    if trimmed.chars().count() > 50_000 {
        return Err(AppError::Invalid("笔记最长 50000 字符".into()));
    }
    let now = now_ms();
    let value = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    };
    state
        .db
        .with(|c| upsert_override_field(c, &sid, Some("notes = excluded.notes"), value, now))?;
    let _ = app.emit("overrides-changed", ());
    Ok(())
}

/// v0.8.1: 撤销 display_title — 把 session_override.display_title 置 NULL,
/// 保留 row(其它字段如 pinned/notes 仍生效)。供 GraphDetailPanel 的
/// "自动名"按钮走,而不是只清 legacy localStorage。
#[tauri::command]
pub async fn remove_rename(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    sid: String,
) -> AppResult<()> {
    let now = now_ms();
    state.db.with(|c| {
        c.execute(
            "INSERT INTO session_override (session_id, updated_at) VALUES (?1, ?2)
             ON CONFLICT(session_id) DO UPDATE SET display_title = NULL, updated_at = excluded.updated_at",
            params![sid, now],
        )?;
        Ok::<_, AppError>(())
    })?;
    let _ = app.emit("overrides-changed", ());
    Ok(())
}

/// 通用 UPSERT helper:`INSERT ... ON CONFLICT DO UPDATE SET <set_clause>`
fn upsert_override_field(
    c: &Connection,
    sid: &str,
    set_clause: Option<&str>,
    value: Option<String>,
    now: i64,
) -> AppResult<()> {
    upsert_override_field_inner(AnyTx::Conn(c), sid, set_clause, value, now)
}

/// v0.8.1: tx 版本 — 沿用同一逻辑,但走 Transaction 的 execute(继承外层 tx)
fn upsert_override_field_in_tx(
    tx: &rusqlite::Transaction<'_>,
    sid: &str,
    set_clause: Option<&str>,
    value: Option<String>,
    now: i64,
) -> AppResult<()> {
    upsert_override_field_inner(AnyTx::Tx(tx), sid, set_clause, value, now)
}

/// Conn | Tx 区分标签 —— 用 monomorphization 避免 trait object dyn 不兼容
enum AnyTx<'a, 'b> {
    Conn(&'a Connection),
    Tx(&'a rusqlite::Transaction<'b>),
}

fn upsert_override_field_inner<'a, 'b>(
    any: AnyTx<'a, 'b>,
    sid: &str,
    set_clause: Option<&str>,
    value: Option<String>,
    now: i64,
) -> AppResult<()> {
    // 检查 session 是否存在
    let exists: bool = match any {
        AnyTx::Conn(c) => c
            .query_row(
                "SELECT 1 FROM session_meta WHERE session_id = ?1",
                params![sid],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false),
        AnyTx::Tx(tx) => tx
            .query_row(
                "SELECT 1 FROM session_meta WHERE session_id = ?1",
                params![sid],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false),
    };

    if !exists {
        // 占位 row(防止 FK 失败)
        let placeholder_sql = "INSERT OR IGNORE INTO session_meta
               (session_id, project_key, source, jsonl_path, size_bytes, mtime_ms, line_count, synced_at)
             VALUES (?1, '(unknown)', 'claude', '(unknown)', 0, 0, 0, ?2)";
        match any {
            AnyTx::Conn(c) => c.execute(placeholder_sql, params![sid, now])?,
            AnyTx::Tx(tx) => tx.execute(placeholder_sql, params![sid, now])?,
        };
    }

    // 对每个字段分支做对应 UPSERT
    match (set_clause, value) {
        (Some(clause), Some(v)) => {
            let col = match clause {
                "display_title = excluded.display_title" => "display_title",
                "hidden = excluded.hidden" => "hidden",
                "pinned = excluded.pinned" => "pinned",
                "archived = excluded.archived" => "archived",
                "notes = excluded.notes" => "notes",
                _ => return Err(AppError::Other("未支持的字段".into())),
            };
            let sql = format!(
                "INSERT INTO session_override (session_id, {}, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id) DO UPDATE SET {}, updated_at = excluded.updated_at",
                col, clause
            );
            let is_int = matches!(
                clause,
                "hidden = excluded.hidden"
                    | "pinned = excluded.pinned"
                    | "archived = excluded.archived"
            );
            if is_int {
                let n: i64 = v.parse().unwrap_or(0);
                match any {
                    AnyTx::Conn(c) => c.execute(&sql, params![sid, n.to_string(), now])?,
                    AnyTx::Tx(tx) => tx.execute(&sql, params![sid, n.to_string(), now])?,
                };
            } else {
                match any {
                    AnyTx::Conn(c) => c.execute(&sql, params![sid, v, now])?,
                    AnyTx::Tx(tx) => tx.execute(&sql, params![sid, v, now])?,
                };
            }
        }
        (Some(clause), None) => {
            let sql = format!(
                "INSERT INTO session_override (session_id, updated_at) VALUES (?1, ?2)
                 ON CONFLICT(session_id) DO UPDATE SET {}, updated_at = excluded.updated_at",
                clause
            );
            match any {
                AnyTx::Conn(c) => c.execute(&sql, params![sid, now])?,
                AnyTx::Tx(tx) => tx.execute(&sql, params![sid, now])?,
            };
        }
        _ => {
            let sql =
                "INSERT OR IGNORE INTO session_override (session_id, updated_at) VALUES (?1, ?2)";
            match any {
                AnyTx::Conn(c) => c.execute(sql, params![sid, now])?,
                AnyTx::Tx(tx) => tx.execute(sql, params![sid, now])?,
            };
        }
    }
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ===== OverrideSnapshot (list_overrides 命令返回) =====

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideSnapshot {
    pub renames: HashMap<String, String>,
    pub hidden: HashSet<String>,
    pub pinned: HashSet<String>,
    pub archived: HashSet<String>,
    pub notes: HashMap<String, String>,
    pub tags: HashMap<String, Vec<Tag>>,
    pub tags_all: Vec<Tag>,
    pub links_to: HashMap<String, Vec<Link>>,
    pub links_from: HashMap<String, Vec<Link>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub from_session: String,
    pub to_session: String,
    pub note: Option<String>,
    pub created_at: i64,
}

#[tauri::command]
pub async fn list_overrides(state: State<'_, Arc<AppState>>) -> AppResult<OverrideSnapshot> {
    state.db.with(|c| {
        let mut snap = OverrideSnapshot {
            renames: HashMap::new(),
            hidden: HashSet::new(),
            pinned: HashSet::new(),
            archived: HashSet::new(),
            notes: HashMap::new(),
            tags: HashMap::new(),
            tags_all: Vec::new(),
            links_to: HashMap::new(),
            links_from: HashMap::new(),
        };

        // 1) override 基础字段
        let mut stmt = c.prepare(
            "SELECT session_id, display_title, hidden, pinned, archived, notes
             FROM session_override",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)? != 0,
                r.get::<_, i64>(3)? != 0,
                r.get::<_, i64>(4)? != 0,
                r.get::<_, Option<String>>(5)?,
            ))
        })?;
        for row in rows {
            let (sid, dt, hidden, pinned, archived, notes) = row?;
            if let Some(t) = dt {
                snap.renames.insert(sid.clone(), t);
            }
            if hidden {
                snap.hidden.insert(sid.clone());
            }
            if pinned {
                snap.pinned.insert(sid.clone());
            }
            if archived {
                snap.archived.insert(sid.clone());
            }
            if let Some(n) = notes {
                snap.notes.insert(sid, n);
            }
        }
        drop(stmt);

        // 2) tags: 全局 + session_tag
        let mut stmt = c.prepare("SELECT id, name, color FROM tag ORDER BY name")?;
        let tag_rows = stmt.query_map([], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
            })
        })?;
        for t in tag_rows {
            snap.tags_all.push(t?);
        }
        drop(stmt);

        let mut stmt = c.prepare(
            "SELECT st.session_id, t.id, t.name, t.color
             FROM session_tag st JOIN tag t ON st.tag_id = t.id
             ORDER BY t.name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Tag {
                    id: r.get(1)?,
                    name: r.get(2)?,
                    color: r.get(3)?,
                },
            ))
        })?;
        for row in rows {
            let (sid, tag) = row?;
            snap.tags.entry(sid).or_default().push(tag);
        }
        drop(stmt);

        // 3) links: from → to + note
        let mut stmt =
            c.prepare("SELECT from_session, to_session, note, created_at FROM session_link")?;
        let rows = stmt.query_map([], |r| {
            Ok(Link {
                from_session: r.get(0)?,
                to_session: r.get(1)?,
                note: r.get(2)?,
                created_at: r.get(3)?,
            })
        })?;
        for row in rows {
            let link = row?;
            snap.links_to
                .entry(link.from_session.clone())
                .or_default()
                .push(link.clone());
            snap.links_from
                .entry(link.to_session.clone())
                .or_default()
                .push(link);
        }

        Ok::<_, AppError>(snap)
    })
}

// ===== Tag commands =====

#[tauri::command]
pub async fn list_tags(state: State<'_, Arc<AppState>>) -> AppResult<Vec<Tag>> {
    state.db.with(|c| {
        let mut stmt = c.prepare("SELECT id, name, color FROM tag ORDER BY name")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Tag {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    color: r.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

#[tauri::command]
pub async fn create_tag(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    name: String,
    color: Option<String>,
) -> AppResult<Tag> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Invalid("tag 名不能为空".into()));
    }
    if trimmed.chars().count() > 32 {
        return Err(AppError::Invalid("tag 名最长 32 字符".into()));
    }
    let tag = state.db.with(|c| {
        c.execute(
            "INSERT OR IGNORE INTO tag (name, color) VALUES (?1, ?2)",
            params![trimmed, color],
        )?;
        let row = c.query_row(
            "SELECT id, name, color FROM tag WHERE name = ?1",
            params![trimmed],
            |r| {
                Ok(Tag {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    color: r.get(2)?,
                })
            },
        )?;
        Ok::<_, AppError>(row)
    })?;
    let _ = app.emit("overrides-changed", ());
    Ok(tag)
}

#[tauri::command]
pub async fn delete_tag(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    tag_id: i64,
) -> AppResult<()> {
    state.db.with(|c| {
        c.execute("DELETE FROM tag WHERE id = ?1", params![tag_id])?;
        Ok::<_, AppError>(())
    })?;
    let _ = app.emit("overrides-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn set_session_tags(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    sid: String,
    tag_ids: Vec<i64>,
) -> AppResult<()> {
    let now = now_ms();
    state.db.with(|c| {
        // v0.8.1: 整个 DELETE + INSERT 序列包到一个事务里 — 之前 N 个
        // INSERT 各 auto-commit,中间被 list_overrides 看到会闪烁成"无 tag"。
        let tx = c.transaction()?;
        // 占位 row(防止 FK 失败)
        upsert_override_field_in_tx(&tx, &sid, None, None, now)?;
        tx.execute(
            "DELETE FROM session_tag WHERE session_id = ?1",
            params![sid],
        )?;
        for tid in &tag_ids {
            tx.execute(
                "INSERT OR IGNORE INTO session_tag (session_id, tag_id) VALUES (?1, ?2)",
                params![sid, tid],
            )?;
        }
        tx.commit()?;
        Ok::<_, AppError>(())
    })?;
    let _ = app.emit("overrides-changed", ());
    Ok(())
}

// ===== Link commands =====

#[tauri::command]
pub async fn add_session_link(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    from: String,
    to: String,
    note: Option<String>,
) -> AppResult<()> {
    if from == to {
        return Err(AppError::Invalid("不能链接到自己".into()));
    }
    let now = now_ms();
    state.db.with(|c| {
        c.execute(
            "INSERT OR REPLACE INTO session_link (from_session, to_session, note, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![from, to, note, now],
        )?;
        Ok::<_, AppError>(())
    })?;
    let _ = app.emit("overrides-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn remove_session_link(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    from: String,
    to: String,
) -> AppResult<()> {
    state.db.with(|c| {
        c.execute(
            "DELETE FROM session_link WHERE from_session = ?1 AND to_session = ?2",
            params![from, to],
        )?;
        Ok::<_, AppError>(())
    })?;
    let _ = app.emit("overrides-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn list_session_links(
    state: State<'_, Arc<AppState>>,
    sid: String,
) -> AppResult<Vec<Link>> {
    state.db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT from_session, to_session, note, created_at FROM session_link
             WHERE from_session = ?1 OR to_session = ?1
             ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map(params![sid], |r| {
                Ok(Link {
                    from_session: r.get(0)?,
                    to_session: r.get(1)?,
                    note: r.get(2)?,
                    created_at: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

// ===== Sync utilities =====

#[tauri::command]
pub async fn get_sync_status(state: State<'_, Arc<AppState>>) -> AppResult<SyncStateRow> {
    crate::db::sync::read_sync_state(&state)
}

#[tauri::command]
pub async fn rebuild_db(state: State<'_, Arc<AppState>>, app: AppHandle) -> AppResult<()> {
    crate::db::sync::rebuild_db(&state, &app).await
}

// ===== Export / Import overrides =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverrideExport {
    pub version: u32,
    pub exported_at: i64,
    pub renames: HashMap<String, String>,
    pub hidden: Vec<String>,
    pub pinned: Vec<String>,
    pub archived: Vec<String>,
    pub notes: HashMap<String, String>,
    pub tags: Vec<Tag>,
    /// map session_id → tag name 列表(导出时转 name,导入时按 name 找 id)
    pub session_tags: HashMap<String, Vec<String>>,
    pub links: Vec<Link>,
}

const EXPORT_VERSION: u32 = 1;

#[tauri::command]
pub async fn export_overrides(state: State<'_, Arc<AppState>>, path: String) -> AppResult<usize> {
    let snap = list_overrides_inner(&state)?;
    let exp = OverrideExport {
        version: EXPORT_VERSION,
        exported_at: now_ms(),
        renames: snap.renames,
        hidden: snap.hidden.into_iter().collect(),
        pinned: snap.pinned.into_iter().collect(),
        archived: snap.archived.into_iter().collect(),
        notes: snap.notes,
        tags: snap.tags_all,
        session_tags: snap
            .tags
            .into_iter()
            .map(|(sid, ts)| (sid, ts.into_iter().map(|t| t.name).collect()))
            .collect(),
        links: snap
            .links_to
            .values()
            .flat_map(|v| v.iter().cloned())
            .collect(),
    };
    let json = serde_json::to_string_pretty(&exp)?;
    std::fs::write(&path, json).map_err(AppError::Io)?;
    Ok(exp.renames.len() + exp.notes.len() + exp.tags.len())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ImportMode {
    /// 跳过已存在的(renames 用 sid+title 已存在 → 跳过)
    Keepboth,
    /// 覆盖本地的(用导入的)
    Overwrite,
    /// 合并:都保留,导入的覆盖本地的(sid 同名时)
    Merge,
}

#[tauri::command]
pub async fn import_overrides(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    path: String,
    mode: ImportMode,
) -> AppResult<usize> {
    let text = std::fs::read_to_string(&path).map_err(AppError::Io)?;
    let exp: OverrideExport = serde_json::from_str(&text)
        .map_err(|e| AppError::Other(format!("解析 overrides.json 失败: {e}")))?;
    if exp.version != EXPORT_VERSION {
        return Err(AppError::Other(format!(
            "overrides.json 版本不匹配: 期望 {EXPORT_VERSION},实得 {}",
            exp.version
        )));
    }
    let mut count = 0usize;
    state.db.with(|c| {
        // v0.8.1: 整段 import 包到一个事务里 — 之前 N 个 INSERT/UPDATE
        // 分别 auto-commit,中途中断会留半截。
        let tx = c.transaction()?;
        // tags 先建(name → id 映射)
        let mut tag_id_by_name: HashMap<String, i64> = HashMap::new();
        for t in &exp.tags {
            tx.execute(
                "INSERT OR IGNORE INTO tag (name, color) VALUES (?1, ?2)",
                params![t.name, t.color],
            )?;
            let id: i64 =
                tx.query_row("SELECT id FROM tag WHERE name = ?1", params![t.name], |r| {
                    r.get(0)
                })?;
            tag_id_by_name.insert(t.name.clone(), id);
        }

        // renames
        for (sid, title) in &exp.renames {
            apply_rename(&tx, sid, title, &mode)?;
            count += 1;
        }
        // hidden / pinned / archived
        for sid in &exp.hidden {
            apply_bool(&tx, sid, "hidden", true, &mode)?;
            count += 1;
        }
        for sid in &exp.pinned {
            apply_bool(&tx, sid, "pinned", true, &mode)?;
            count += 1;
        }
        for sid in &exp.archived {
            apply_bool(&tx, sid, "archived", true, &mode)?;
            count += 1;
        }
        // notes
        for (sid, note) in &exp.notes {
            apply_notes(&tx, sid, note, &mode)?;
            count += 1;
        }
        // session_tags
        for (sid, names) in &exp.session_tags {
            // 占位 override row
            upsert_override_field_in_tx(&tx, sid, None, None, now_ms())?;
            tx.execute(
                "DELETE FROM session_tag WHERE session_id = ?1",
                params![sid],
            )?;
            for name in names {
                if let Some(&tid) = tag_id_by_name.get(name) {
                    tx.execute(
                        "INSERT OR IGNORE INTO session_tag (session_id, tag_id) VALUES (?1, ?2)",
                        params![sid, tid],
                    )?;
                }
            }
            count += 1;
        }
        // links
        for link in &exp.links {
            tx.execute(
                "INSERT OR REPLACE INTO session_link (from_session, to_session, note, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    link.from_session,
                    link.to_session,
                    link.note,
                    link.created_at
                ],
            )?;
            count += 1;
        }
        tx.commit()?;
        Ok::<_, AppError>(())
    })?;
    let _ = app.emit("overrides-changed", ());
    Ok(count)
}

fn apply_rename(c: &Connection, sid: &str, title: &str, mode: &ImportMode) -> AppResult<()> {
    let now = now_ms();
    upsert_override_field(c, sid, None, None, now)?;
    match mode {
        ImportMode::Keepboth => {
            // 仅当本地无 display_title 时写入
            let exists: bool = c
                .query_row(
                    "SELECT display_title IS NOT NULL FROM session_override WHERE session_id = ?1",
                    params![sid],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(false);
            if !exists {
                c.execute(
                    "UPDATE session_override SET display_title = ?2, updated_at = ?3 WHERE session_id = ?1",
                    params![sid, title, now],
                )?;
            }
        }
        ImportMode::Overwrite | ImportMode::Merge => {
            c.execute(
                "UPDATE session_override SET display_title = ?2, updated_at = ?3 WHERE session_id = ?1",
                params![sid, title, now],
            )?;
        }
    }
    Ok(())
}

fn apply_bool(
    c: &Connection,
    sid: &str,
    field: &str,
    val: bool,
    mode: &ImportMode,
) -> AppResult<()> {
    let now = now_ms();
    upsert_override_field(c, sid, None, None, now)?;
    let n: i64 = if val { 1 } else { 0 };
    // v0.8.1: 此前 _mode 被无视,Keepboth 也会覆盖 hidden/pinned/archived。
    // Keepboth 语义:"本地无显式 override 时采纳导入值"; 显式定义为本行 NULL
    // (未在该字段上 write 过)。
    let sql = match mode {
        ImportMode::Keepboth => format!(
            "UPDATE session_override SET {} = ?2, updated_at = ?3
             WHERE session_id = ?1 AND {} IS NULL",
            field, field
        ),
        ImportMode::Overwrite | ImportMode::Merge => format!(
            "UPDATE session_override SET {} = ?2, updated_at = ?3 WHERE session_id = ?1",
            field
        ),
    };
    c.execute(&sql, params![sid, n, now])?;
    Ok(())
}

fn apply_notes(c: &Connection, sid: &str, notes: &str, mode: &ImportMode) -> AppResult<()> {
    let now = now_ms();
    upsert_override_field(c, sid, None, None, now)?;
    match mode {
        ImportMode::Keepboth => {
            let exists: bool = c
                .query_row(
                    "SELECT notes IS NOT NULL FROM session_override WHERE session_id = ?1",
                    params![sid],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(false);
            if !exists {
                c.execute(
                    "UPDATE session_override SET notes = ?2, updated_at = ?3 WHERE session_id = ?1",
                    params![sid, notes, now],
                )?;
            }
        }
        ImportMode::Overwrite | ImportMode::Merge => {
            c.execute(
                "UPDATE session_override SET notes = ?2, updated_at = ?3 WHERE session_id = ?1",
                params![sid, notes, now],
            )?;
        }
    }
    Ok(())
}

fn list_overrides_inner(state: &AppState) -> AppResult<OverrideSnapshot> {
    state.db.with(|c| {
        let mut snap = OverrideSnapshot {
            renames: HashMap::new(),
            hidden: HashSet::new(),
            pinned: HashSet::new(),
            archived: HashSet::new(),
            notes: HashMap::new(),
            tags: HashMap::new(),
            tags_all: Vec::new(),
            links_to: HashMap::new(),
            links_from: HashMap::new(),
        };
        let mut stmt = c.prepare(
            "SELECT session_id, display_title, hidden, pinned, archived, notes FROM session_override",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)? != 0,
                r.get::<_, i64>(3)? != 0,
                r.get::<_, i64>(4)? != 0,
                r.get::<_, Option<String>>(5)?,
            ))
        })?;
        for row in rows {
            let (sid, dt, hidden, pinned, archived, notes) = row?;
            if let Some(t) = dt {
                snap.renames.insert(sid.clone(), t);
            }
            if hidden {
                snap.hidden.insert(sid.clone());
            }
            if pinned {
                snap.pinned.insert(sid.clone());
            }
            if archived {
                snap.archived.insert(sid.clone());
            }
            if let Some(n) = notes {
                snap.notes.insert(sid, n);
            }
        }
        drop(stmt);

        let mut stmt = c.prepare("SELECT id, name, color FROM tag ORDER BY name")?;
        let tag_rows = stmt.query_map([], |r| {
            Ok(Tag {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
            })
        })?;
        for t in tag_rows {
            snap.tags_all.push(t?);
        }
        drop(stmt);

        let mut stmt = c.prepare(
            "SELECT st.session_id, t.id, t.name, t.color
             FROM session_tag st JOIN tag t ON st.tag_id = t.id
             ORDER BY t.name",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Tag {
                    id: r.get(1)?,
                    name: r.get(2)?,
                    color: r.get(3)?,
                },
            ))
        })?;
        for row in rows {
            let (sid, tag) = row?;
            snap.tags.entry(sid).or_default().push(tag);
        }
        drop(stmt);

        let mut stmt = c.prepare(
            "SELECT from_session, to_session, note, created_at FROM session_link",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Link {
                from_session: r.get(0)?,
                to_session: r.get(1)?,
                note: r.get(2)?,
                created_at: r.get(3)?,
            })
        })?;
        for row in rows {
            let link = row?;
            snap.links_to
                .entry(link.from_session.clone())
                .or_default()
                .push(link.clone());
            snap.links_from.entry(link.to_session.clone()).or_default().push(link);
        }
        Ok::<_, AppError>(snap)
    })
}

// ===== Search history =====

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHistoryEntry {
    pub id: i64,
    pub query: String,
    pub hit_count: u32,
    pub ts: i64,
}

#[tauri::command]
pub async fn record_search(
    state: State<'_, Arc<AppState>>,
    query: String,
    hit_count: u32,
) -> AppResult<()> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    state.db.with(|c| {
        c.execute(
            "INSERT INTO search_history (query, hit_count, ts) VALUES (?1, ?2, ?3)",
            params![trimmed, hit_count as i64, now_ms()],
        )?;
        // 只保留最近 100 条
        c.execute(
            "DELETE FROM search_history WHERE id NOT IN
               (SELECT id FROM search_history ORDER BY ts DESC LIMIT 100)",
            [],
        )?;
        Ok::<_, AppError>(())
    })
}

#[tauri::command]
pub async fn list_search_history(
    state: State<'_, Arc<AppState>>,
    limit: Option<u32>,
) -> AppResult<Vec<SearchHistoryEntry>> {
    let n = limit.unwrap_or(20) as i64;
    state.db.with(|c| {
        let mut stmt = c.prepare(
            "SELECT id, query, hit_count, ts FROM search_history ORDER BY ts DESC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map(params![n], |r| {
                Ok(SearchHistoryEntry {
                    id: r.get(0)?,
                    query: r.get(1)?,
                    hit_count: r.get::<_, i64>(2)? as u32,
                    ts: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

// ===== 测试 =====

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn fresh_db() -> (tempfile::TempDir, crate::db::DbPool) {
        let tmp = tempdir().unwrap();
        let conn = rusqlite::Connection::open(tmp.path().join("test.db")).unwrap();
        crate::db::schema::apply(&conn).unwrap();
        let pool = crate::db::DbPool {
            inner: std::sync::Arc::new(parking_lot::Mutex::new(conn)),
            path: tmp.path().join("test.db"),
        };
        (tmp, pool)
    }

    fn placeholder_session(c: &rusqlite::Connection, sid: &str) {
        c.execute(
            "INSERT INTO session_meta
               (session_id, project_key, source, jsonl_path, size_bytes, mtime_ms, line_count, synced_at)
             VALUES (?1, 'p', 'claude', 'j', 0, 0, 0, 0)",
            rusqlite::params![sid],
        )
        .unwrap();
    }

    #[test]
    fn rename_creates_override_and_can_be_read_back() {
        let (_tmp, pool) = fresh_db();
        pool.with(|c| {
            placeholder_session(c, "sess-1");
            Ok::<_, AppError>(())
        })
        .unwrap();
        pool.with(|c| {
            upsert_override_field(
                c,
                "sess-1",
                Some("display_title = excluded.display_title"),
                Some("My Renamed Session".into()),
                now_ms(),
            )
        })
        .unwrap();
        let v: Option<String> = pool
            .with(|c| {
                Ok(c.query_row(
                    "SELECT display_title FROM session_override WHERE session_id = 'sess-1'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(v.as_deref(), Some("My Renamed Session"));
    }

    #[test]
    fn set_pinned_persists() {
        let (_tmp, pool) = fresh_db();
        pool.with(|c| {
            placeholder_session(c, "sess-2");
            Ok::<_, AppError>(())
        })
        .unwrap();
        pool.with(|c| {
            upsert_override_field(
                c,
                "sess-2",
                Some("pinned = excluded.pinned"),
                Some("1".into()),
                now_ms(),
            )
        })
        .unwrap();
        let pinned: bool = pool
            .with(|c| {
                Ok(c.query_row(
                    "SELECT pinned FROM session_override WHERE session_id = 'sess-2'",
                    [],
                    |r| r.get::<_, i64>(0),
                )? != 0)
            })
            .unwrap();
        assert!(pinned);
    }

    #[test]
    fn empty_session_creates_placeholder_meta() {
        let (_tmp, pool) = fresh_db();
        pool.with(|c| {
            // 没建 session_meta,直接 upsert override → 应自动占位
            upsert_override_field(
                c,
                "ghost-sid",
                Some("hidden = excluded.hidden"),
                Some("1".into()),
                now_ms(),
            )
        })
        .unwrap();
        let exists: bool = pool
            .with(|c| {
                let n: i64 = c.query_row(
                    "SELECT COUNT(*) FROM session_meta WHERE session_id = 'ghost-sid'",
                    [],
                    |r| r.get(0),
                )?;
                Ok(n > 0)
            })
            .unwrap();
        assert!(exists);
    }
}
