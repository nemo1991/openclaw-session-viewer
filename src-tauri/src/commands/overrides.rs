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
        // v0.8.12: 占位 row 用 `(unknown):{sid}` 编码路径,避开 session_meta.jsonl_path
        // UNIQUE 约束冲突(schema.rs:36) — 之前所有 placeholder 都写同一个 `(unknown)`,
        // 第二个未同步 sid 的 placeholder 被 INSERT OR IGNORE 静默吞,session_override FK 失败。
        // 真实 sync 走完后 upsert_session_meta ON CONFLICT(session_id) 会把占位行 upgrade 成
        // 真实 jsonl_path。orphan sweep (sync.rs:188) 的 NOT IN 子查询仍能识别
        // `(unknown):{sid}` — 永远不在磁盘 jsonl path 集合里,会被 sweep 清掉。
        let placeholder_path = format!("(unknown):{sid}");
        let placeholder_sql = "INSERT OR IGNORE INTO session_meta
               (session_id, project_key, source, jsonl_path, size_bytes, mtime_ms, line_count, synced_at)
             VALUES (?1, '(unknown)', 'claude', ?2, 0, 0, 0, ?3)";
        match any {
            AnyTx::Conn(c) => c.execute(placeholder_sql, params![sid, placeholder_path, now])?,
            AnyTx::Tx(tx) => tx.execute(placeholder_sql, params![sid, placeholder_path, now])?,
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
        // v0.8.9: INSERT OR REPLACE 每次重置 created_at。改为 ON CONFLICT DO UPDATE
        // 只更新 note,保留原 created_at (代表 link 什么时候建立)。
        c.execute(
            "INSERT INTO session_link (from_session, to_session, note, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(from_session, to_session) DO UPDATE SET note = excluded.note",
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

/// v0.8.4 item 1: HomeStatusBar 用 — DB 文件绝对路径
#[tauri::command]
pub async fn get_db_path(state: State<'_, Arc<AppState>>) -> AppResult<String> {
    Ok(state.db.path().to_string_lossy().to_string())
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

/// v0.8.6 D: 默认不导出 hidden/archived/notes — 这 3 个字段含用户隐私
/// (例如 "这个 session 标为隐藏因为它是个失败实验"), 跟 tags/links/renames
/// 公开性不同。include_private=true 可选导出全部 (debugging 用)。
#[tauri::command]
pub async fn export_overrides(
    state: State<'_, Arc<AppState>>,
    path: String,
    include_private: Option<bool>,
) -> AppResult<usize> {
    let snap = list_overrides_inner(&state)?;
    let include_private = include_private.unwrap_or(false);
    let exp = OverrideExport {
        version: EXPORT_VERSION,
        exported_at: now_ms(),
        renames: snap.renames,
        // v0.8.6 D 修复: 默认导出公开字段 (renames/tags/links/pinned),
        // 隐私字段 (hidden/archived/notes) 仅 include_private=true 时导出
        hidden: if include_private {
            snap.hidden.into_iter().collect()
        } else {
            Default::default()
        },
        pinned: snap.pinned.into_iter().collect(),
        archived: if include_private {
            snap.archived.into_iter().collect()
        } else {
            Default::default()
        },
        notes: if include_private {
            snap.notes.clone()
        } else {
            Default::default()
        },
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
        // v0.8.12 item D: 预计算 Keepboth "fresh sid" 集合 — 行不存在 = 本地无 override
        // (即"本 import 视为首次写入")。import_overrides 对同一 sid 调 3 次 apply_bool
        // (hidden/pinned/archived),如果用 apply_bool 内部 SELECT 判 fresh,1st call
        // INSERT 行后 2nd/3rd call 看见行已存在会跳过 — pinned/archived 永远导不进去。
        // 必须在 caller 层一次性判定 sid 是不是 fresh,3 次 apply_bool 共享这个判定。
        let fresh_bool_sids: HashSet<String> = if matches!(mode, ImportMode::Keepboth) {
            let all_sids: HashSet<String> = exp
                .hidden
                .iter()
                .chain(exp.pinned.iter())
                .chain(exp.archived.iter())
                .cloned()
                .collect();
            let mut fresh: HashSet<String> = HashSet::new();
            for sid in &all_sids {
                let exists: bool = tx
                    .query_row(
                        "SELECT 1 FROM session_override WHERE session_id = ?1",
                        params![sid],
                        |_| Ok(true),
                    )
                    .optional()?
                    .unwrap_or(false);
                if !exists {
                    fresh.insert(sid.clone());
                }
            }
            fresh
        } else {
            HashSet::new()
        };
        // hidden / pinned / archived
        for sid in &exp.hidden {
            apply_bool(&tx, sid, "hidden", true, &mode, &fresh_bool_sids)?;
            count += 1;
        }
        for sid in &exp.pinned {
            apply_bool(&tx, sid, "pinned", true, &mode, &fresh_bool_sids)?;
            count += 1;
        }
        for sid in &exp.archived {
            apply_bool(&tx, sid, "archived", true, &mode, &fresh_bool_sids)?;
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
            // v0.8.10: 跟 v0.8.9 add_session_link 同样的 ON CONFLICT 修复 —
            // 重导 (Overwrite / Merge 模式) 不重置 created_at (代表 link 何时建立)。
            tx.execute(
                "INSERT INTO session_link (from_session, to_session, note, created_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(from_session, to_session) DO UPDATE SET note = excluded.note",
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
    fresh_bool_sids: &HashSet<String>,
) -> AppResult<()> {
    let now = now_ms();
    let n: i64 = if val { 1 } else { 0 };
    // v0.8.12 item D: 修复 Keepboth bug。
    // 旧代码: Keepboth 用 `WHERE field IS NULL` 判定"未显式 override",但
    // schema `hidden/pinned/archived INTEGER NOT NULL DEFAULT 0` 让字段永不为 NULL,
    // 条件永远 false,Keepboth 模式实际不导 hidden/pinned/archived。
    // display_title/notes 没这问题因为那俩字段是 nullable (`apply_rename`/`apply_notes`
    // 用 `IS NOT NULL` 单独判断 OK)。
    //
    // 新语义: Keepboth 走"行 sentinel" — caller 预计算 sid 是否在 fresh 集合
    // (即"本 import 时本地无 override 行"),在集合里 → INSERT 占位行 + UPDATE 该字段;
    // 不在集合里 → 跳过(本地已有 override)。这样同一 sid 多次 apply_bool 调用
    // 都能正确处理(都基于 caller 的预判,不会被 1st call INSERT 的行骗到)。
    // Overwrite/Merge 仍走 `upsert_override_field` + UPDATE 全覆盖,不看 fresh。
    match mode {
        ImportMode::Keepboth => {
            if !fresh_bool_sids.contains(sid) {
                // 已有 override 行(任意字段写过都算)→ Keepboth 跳过
                return Ok(());
            }
            // 创 session_meta placeholder (FK 约束)
            upsert_override_field(c, sid, None, None, now)?;
            // 创 session_override 占位行 (INSERT OR IGNORE 防止 caller 误判
            // 导致的二次 INSERT — 防御性,理论上 caller 预判已保证行不存在)
            c.execute(
                "INSERT OR IGNORE INTO session_override (session_id, updated_at) VALUES (?1, ?2)",
                params![sid, now],
            )?;
            // UPDATE 该 bool 字段
            let sql = format!(
                "UPDATE session_override SET {} = ?2, updated_at = ?3 WHERE session_id = ?1",
                field
            );
            c.execute(&sql, params![sid, n, now])?;
        }
        ImportMode::Overwrite | ImportMode::Merge => {
            upsert_override_field(c, sid, None, None, now)?;
            let sql = format!(
                "UPDATE session_override SET {} = ?2, updated_at = ?3 WHERE session_id = ?1",
                field
            );
            c.execute(&sql, params![sid, n, now])?;
        }
    }
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
        // v0.8.7 C: 走 open() 而不是手搓 DbPool (避免 inner/readers/writer 三字段)
        let pool = crate::db::open(tmp.path()).unwrap();
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

    // ===== v0.8.12 item A: placeholder `(unknown):{sid}` 编码路径回归测试 =====
    //
    // Bug: 之前所有 placeholder 共享 `jsonl_path='(unknown)'`,session_meta.jsonl_path
    // UNIQUE 约束让第二个 placeholder 被 INSERT OR IGNORE 静默吞,FK 失败抛错。
    // Fix: placeholder 用 `(unknown):{sid}` 编码路径,每行 unique。

    #[test]
    fn multiple_unknown_sessions_create_distinct_placeholders() {
        let (_tmp, pool) = fresh_db();
        // 3 个 placeholder sid 各自 upsert override,不应有 UNIQUE 冲突
        let sids = ["ghost-1", "ghost-2", "ghost-3"];
        for sid in sids {
            pool.with(|c| {
                upsert_override_field(
                    c,
                    sid,
                    Some("display_title = excluded.display_title"),
                    Some(format!("Title for {sid}")),
                    now_ms(),
                )
            })
            .unwrap();
        }
        // 验证: 3 个 placeholder 行都在 session_meta,3 个 override 行都在 session_override
        let (meta_count, override_count, distinct_paths): (i64, i64, i64) = pool
            .with(|c| {
                let m: i64 = c.query_row(
                    "SELECT COUNT(*) FROM session_meta WHERE session_id IN ('ghost-1','ghost-2','ghost-3')",
                    [],
                    |r| r.get(0),
                )?;
                let o: i64 = c.query_row(
                    "SELECT COUNT(*) FROM session_override WHERE session_id IN ('ghost-1','ghost-2','ghost-3')",
                    [],
                    |r| r.get(0),
                )?;
                let p: i64 = c.query_row(
                    "SELECT COUNT(DISTINCT jsonl_path) FROM session_meta
                     WHERE session_id IN ('ghost-1','ghost-2','ghost-3')",
                    [],
                    |r| r.get(0),
                )?;
                Ok((m, o, p))
            })
            .unwrap();
        assert_eq!(meta_count, 3, "3 个 placeholder 行都应在 session_meta");
        assert_eq!(override_count, 3, "3 个 override 行 FK 都不应失败");
        assert_eq!(
            distinct_paths, 3,
            "3 个 placeholder jsonl_path 必须 distinct(否则 UNIQUE 冲突)"
        );
    }

    #[test]
    fn placeholder_uses_sid_encoded_jsonl_path() {
        let (_tmp, pool) = fresh_db();
        pool.with(|c| {
            upsert_override_field(
                c,
                "ghost-x",
                Some("hidden = excluded.hidden"),
                Some("1".into()),
                now_ms(),
            )
        })
        .unwrap();
        // 占位行 jsonl_path 必须是 `(unknown):{sid}` 编码路径,不是裸 `(unknown)`
        let path: String = pool
            .with(|c| {
                Ok(c.query_row(
                    "SELECT jsonl_path FROM session_meta WHERE session_id = 'ghost-x'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(
            path, "(unknown):ghost-x",
            "placeholder 必须用 sid 编码路径避开 UNIQUE"
        );
    }

    // ===== v0.8.9: add_session_link ON CONFLICT 回归测试 =====
    //
    // Bug: 之前用 INSERT OR REPLACE,重设 created_at。改成 ON CONFLICT DO UPDATE
    // 只更新 note,保留原 created_at (代表 link 什么时候建立)。这里直接复用 add_session_link
    // 的 SQL 模式测试,因为 Tauri State/AppHandle 难 mock — 验证 SQL 语义。
    #[test]
    fn add_session_link_preserves_created_at_on_re_add() {
        let (_tmp, pool) = fresh_db();
        let now_first = 1_700_000_000_000_i64;
        let now_second = 1_700_000_999_999_i64;

        // 第一次 insert
        pool.with(|c| {
            c.execute(
                "INSERT INTO session_link (from_session, to_session, note, created_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(from_session, to_session) DO UPDATE SET note = excluded.note",
                rusqlite::params!["sess-a", "sess-b", "first note", now_first],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        // 第二次 insert — 同样 (from, to),不同 note,不同时间
        pool.with(|c| {
            c.execute(
                "INSERT INTO session_link (from_session, to_session, note, created_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(from_session, to_session) DO UPDATE SET note = excluded.note",
                rusqlite::params!["sess-a", "sess-b", "second note", now_second],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        // 读回 — note 应该是 second (更新成功),但 created_at 必须是 first (保留)
        let (note, created_at): (Option<String>, i64) = pool
            .with(|c| {
                Ok(c.query_row(
                    "SELECT note, created_at FROM session_link
                     WHERE from_session = 'sess-a' AND to_session = 'sess-b'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            })
            .unwrap();

        assert_eq!(note.as_deref(), Some("second note"), "note 必须被更新");
        assert_eq!(
            created_at, now_first,
            "created_at 必须保留 first insert 的值 ({now_first}),不是 second ({now_second})"
        );
    }

    // ===== v0.8.10: import_overrides ON CONFLICT 回归测试 (item B) =====
    //
    // Bug: v0.8.9 修 add_session_link 时,import_overrides (L785) 同样 INSERT OR REPLACE
    // 漏修。Overwrite / Merge 模式重导时,所有 link created_at 被重置成 import 时刻。
    // 这里复用 import_overrides 实际使用的 SQL 模式测试 (跟 v0.8.9 add_session_link
    // 同样套路 — Tauri State/AppHandle 难 mock,直接验证 SQL 语义)。
    #[test]
    fn import_overrides_preserves_existing_link_created_at() {
        let (_tmp, pool) = fresh_db();
        let ts_first = 1_700_000_000_000_i64;
        let ts_second = 1_700_000_999_999_i64;

        // 1) 第一次 import — 模拟用户自己 add_session_link 后,导出 json 文件
        //    (这里直接 INSERT 用 sql pattern,跟 import_overrides 实际跑的 SQL 一致)
        pool.with(|c| {
            c.execute(
                "INSERT INTO session_link (from_session, to_session, note, created_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(from_session, to_session) DO UPDATE SET note = excluded.note",
                rusqlite::params!["sess-a", "sess-b", "first note", ts_first],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        // 2) 第二次 import — 同样 (from, to),不同 note,不同时间戳
        //    (这是 import_overrides 实际跑的 SQL — 跟 v0.8.9 修的 add_session_link
        //    用一模一样的 ON CONFLICT 模式)
        pool.with(|c| {
            c.execute(
                "INSERT INTO session_link (from_session, to_session, note, created_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(from_session, to_session) DO UPDATE SET note = excluded.note",
                rusqlite::params!["sess-a", "sess-b", "second note", ts_second],
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        // 3) 读回 — note 应该是 second (更新成功),但 created_at 必须是 first (保留)
        let (note, created_at): (Option<String>, i64) = pool
            .with(|c| {
                Ok(c.query_row(
                    "SELECT note, created_at FROM session_link
                     WHERE from_session = 'sess-a' AND to_session = 'sess-b'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?)
            })
            .unwrap();

        assert_eq!(note.as_deref(), Some("second note"), "note 必须被更新");
        assert_eq!(
            created_at, ts_first,
            "created_at 必须保留 first import 的值 ({ts_first}),不是 second ({ts_second}) — \
             这是 import_overrides ON CONFLICT 修复的契约"
        );
    }

    // ===== v0.8.12 item D: apply_bool Keepboth bool 字段修复回归测试 =====
    //
    // Bug: 旧 `apply_bool` Keepboth 模式用 `WHERE field IS NULL` 判定未显式 override,
    // 但 schema `hidden/pinned/archived INTEGER NOT NULL DEFAULT 0` 让字段永不为 NULL,
    // 条件永远 false,Keepboth 模式不导 bool 字段。
    // Fix: Keepboth 改 `INSERT ... DO NOTHING` (行存在 = 本地有 override = 跳过)。

    #[test]
    fn apply_bool_keepboth_imports_into_fresh_override() {
        // v0.8.12 item D: fresh DB + Keepboth — hidden/pinned/archived 应被导入
        let (_tmp, pool) = fresh_db();
        // v0.8.12: Keepboth 路径下 apply_bool 不调 upsert_override_field,
        // 所以不会自动占位 session_meta 行,这里要手动建 (FK 约束)
        pool.with(|c| {
            placeholder_session(c, "sess-fresh");
            Ok::<_, AppError>(())
        })
        .unwrap();
        pool.with(|c| {
            // v0.8.12 item D: caller 预计算 fresh_sids — fresh DB 无 override 行,
            // sess-fresh 算 fresh,3 次 apply_bool 都会写
            let fresh = HashSet::from(["sess-fresh".to_string()]);
            apply_bool(
                c,
                "sess-fresh",
                "hidden",
                true,
                &ImportMode::Keepboth,
                &fresh,
            )?;
            apply_bool(
                c,
                "sess-fresh",
                "pinned",
                true,
                &ImportMode::Keepboth,
                &fresh,
            )?;
            apply_bool(
                c,
                "sess-fresh",
                "archived",
                true,
                &ImportMode::Keepboth,
                &fresh,
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        // 3 个 bool 字段都应是 1 (导入成功)
        let (hidden, pinned, archived): (bool, bool, bool) = pool
            .with(|c| {
                Ok(c.query_row(
                    "SELECT hidden, pinned, archived FROM session_override WHERE session_id = 'sess-fresh'",
                    [],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)? != 0,
                            r.get::<_, i64>(1)? != 0,
                            r.get::<_, i64>(2)? != 0,
                        ))
                    },
                )?)
            })
            .unwrap();
        assert!(hidden, "Keepboth 必须导入 hidden=true 到 fresh DB");
        assert!(pinned, "Keepboth 必须导入 pinned=true 到 fresh DB");
        assert!(archived, "Keepboth 必须导入 archived=true 到 fresh DB");
    }

    #[test]
    fn apply_bool_keepboth_skips_existing_override() {
        // v0.8.12 item D: 已存在 override 行 + Keepboth — 本地 bool 必须保留
        let (_tmp, pool) = fresh_db();
        // 1) 占位 row (apply_rename 触发)
        pool.with(|c| {
            apply_rename(c, "sess-existing", "Local Title", &ImportMode::Overwrite)?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        // 2) 本地 hidden 已经是 true
        pool.with(|c| {
            apply_bool(
                c,
                "sess-existing",
                "hidden",
                true,
                &ImportMode::Overwrite,
                &HashSet::new(),
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        // 3) 导入 hidden=false (Keepboth) — 应被忽略,本地 hidden=true 保留
        //    sess-existing 已有 override 行,fresh 集合不含它 → 跳过
        pool.with(|c| {
            let fresh = HashSet::new(); // sess-existing 不在 fresh 里
            apply_bool(
                c,
                "sess-existing",
                "hidden",
                false,
                &ImportMode::Keepboth,
                &fresh,
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let (hidden, display_title): (bool, Option<String>) = pool
            .with(|c| {
                Ok(c.query_row(
                    "SELECT hidden, display_title FROM session_override WHERE session_id = 'sess-existing'",
                    [],
                    |r| Ok((r.get::<_, i64>(0)? != 0, r.get(1)?)),
                )?)
            })
            .unwrap();
        assert!(
            hidden,
            "Keepboth 必须跳过已存在 override 行,本地 hidden=true 保留 (实际={hidden})"
        );
        assert_eq!(
            display_title.as_deref(),
            Some("Local Title"),
            "display_title 也不应被 Keepboth 覆盖"
        );
    }

    #[test]
    fn apply_bool_overwrite_imports_all_three_bools() {
        // v0.8.12 item D: Overwrite 模式 — hidden/pinned/archived 全部 UPDATE,无 NULL 漏
        let (_tmp, pool) = fresh_db();
        // 占位 row
        pool.with(|c| {
            placeholder_session(c, "sess-ow");
            Ok::<_, AppError>(())
        })
        .unwrap();
        // Overwrite hidden=true
        pool.with(|c| {
            // Overwrite/Merge 模式不看 fresh 集合,传空即可
            apply_bool(
                c,
                "sess-ow",
                "hidden",
                true,
                &ImportMode::Overwrite,
                &HashSet::new(),
            )?;
            apply_bool(
                c,
                "sess-ow",
                "pinned",
                true,
                &ImportMode::Overwrite,
                &HashSet::new(),
            )?;
            apply_bool(
                c,
                "sess-ow",
                "archived",
                true,
                &ImportMode::Overwrite,
                &HashSet::new(),
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();

        let (hidden, pinned, archived): (bool, bool, bool) = pool
            .with(|c| {
                Ok(c.query_row(
                    "SELECT hidden, pinned, archived FROM session_override WHERE session_id = 'sess-ow'",
                    [],
                    |r| {
                        Ok((
                            r.get::<_, i64>(0)? != 0,
                            r.get::<_, i64>(1)? != 0,
                            r.get::<_, i64>(2)? != 0,
                        ))
                    },
                )?)
            })
            .unwrap();
        assert!(hidden);
        assert!(pinned);
        assert!(archived);

        // 再 Overwrite 一次 hidden=false — 必须真的更新 (不是被 IS NULL 漏掉)
        pool.with(|c| {
            apply_bool(
                c,
                "sess-ow",
                "hidden",
                false,
                &ImportMode::Overwrite,
                &HashSet::new(),
            )?;
            Ok::<_, AppError>(())
        })
        .unwrap();
        let hidden_after: bool = pool
            .with(|c| {
                Ok(c.query_row(
                    "SELECT hidden FROM session_override WHERE session_id = 'sess-ow'",
                    [],
                    |r| r.get::<_, i64>(0),
                )? != 0)
            })
            .unwrap();
        assert!(
            !hidden_after,
            "Overwrite 必须能翻 hidden=true → false (这是 v0.8.12 item D 修的同条 bug)"
        );
    }
}
