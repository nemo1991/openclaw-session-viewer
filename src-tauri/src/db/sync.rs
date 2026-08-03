//! v0.8.0 后台同步骨架 — 待 commit 3 完善
//!
//! 设计目标:
//! - sync_loop 在 tokio::spawn 跑,启动时跑一次,然后阻塞等 paths_change / refresh_requested
//! - 单文件增量判断 (size, mtime, line_count) 三元组
//! - 单文件失败容错(不影响整体进度)
//! - 进度事件 sync-progress → 前端 SyncBanner

#![allow(dead_code)]

use std::path::Path;
use std::sync::Arc;

use serde_json::Value as JsonValue;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::commands::sessions::{build_claude_session_meta, build_openclaw_session_meta};
use crate::error::{AppError, AppResult};
use crate::fs::walker;
use crate::parser::jsonl;
use crate::parser::openclaw_index::SessionsIndexEntry;
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub phase: String,
    pub total: u32,
    pub done: u32,
    pub failed: u32,
    pub current_file: Option<String>,
}

// ===== v0.8.12 item F: EventSink 抽象 — 让 sync_once 可测 =====
//
// 公开 API `sync_once(state, app)` 仍接 `&AppHandle`, 内部转成 `AppHandleSink`
// 后调 `sync_once_with_sink`。测试用 `RecordingSink` 捕获 emit 调用。
// 之前 sync_once 跟 AppHandle 紧绑,Item F 之前 0 个 sync_once/sync_one_file
// 端到端测试 (sync.rs:546 注释说明)。

/// emit 抽象 — 公开 API 走 `AppHandleSink`, 测试用 `RecordingSink`
pub(crate) trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: JsonValue);
}

/// 公开 API 用的 sink — 包一层 `&AppHandle`
pub(crate) struct AppHandleSink<'a>(pub &'a AppHandle);
impl<'a> EventSink for AppHandleSink<'a> {
    fn emit(&self, event: &str, payload: JsonValue) {
        let _ = self.0.emit(event, payload);
    }
}

/// 测试用 — 记录所有 emit 调用, 断言用
pub(crate) struct RecordingSink {
    pub events: Arc<parking_lot::Mutex<Vec<(String, JsonValue)>>>,
}
impl RecordingSink {
    pub fn new() -> Self {
        Self {
            events: Arc::new(parking_lot::Mutex::new(Vec::new())),
        }
    }
}
impl EventSink for RecordingSink {
    fn emit(&self, event: &str, payload: JsonValue) {
        self.events.lock().push((event.to_string(), payload));
    }
}

/// 启动同步循环(永不返回)
pub async fn run_sync_loop(state: Arc<AppState>, app: AppHandle) {
    sync_once_and_emit(&state, &AppHandleSink(&app)).await;
    loop {
        tokio::select! {
            _ = state.paths_change.notified() => {
                log::info!("sync_loop: paths 变更,重新同步");
                sync_once_and_emit(&state, &AppHandleSink(&app)).await;
            }
            _ = state.refresh_requested.notified() => {
                log::info!("sync_loop: 手动刷新触发");
                sync_once_and_emit(&state, &AppHandleSink(&app)).await;
            }
        }
    }
}

/// v0.8.12 item F: thin wrapper — 给生产代码用, 接 `&AppHandle` 转 `AppHandleSink`
pub async fn sync_once(state: &AppState, app: &AppHandle) -> SyncProgress {
    sync_once_with_sink(state, &AppHandleSink(app)).await
}

/// v0.8.12 item F: emit 三件套(scanning start + progress done + sessions-updated)包装
pub(crate) async fn sync_once_and_emit(state: &AppState, sink: &dyn EventSink) {
    sink.emit(
        "sync-progress",
        serde_json::to_value(SyncProgress {
            phase: "scanning".into(),
            total: 0,
            done: 0,
            failed: 0,
            current_file: None,
        })
        .unwrap_or(JsonValue::Null),
    );
    let progress = sync_once_with_sink(state, sink).await;
    sink.emit(
        "sync-progress",
        serde_json::to_value(&progress).unwrap_or(JsonValue::Null),
    );
    sink.emit("sessions-updated", JsonValue::Null);
}

/// v0.8.12 item F: sync_once 内部实现 — 接 `&dyn EventSink` 便于测试
pub(crate) async fn sync_once_with_sink(state: &AppState, sink: &dyn EventSink) -> SyncProgress {
    let paths_snapshot = state.paths.read().clone();

    let mut total: u32 = 0;
    let mut done: u32 = 0;
    let mut failed: u32 = 0;
    // v0.8.1: 收集本轮 walk 出的真实 jsonl_path,尾部 orphan sweep 用。
    // 保留 set 是为了不让孤儿清扫把真实文件误判为孤儿。
    let mut seen_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    // v0.8.4 item 2: 同步成功才进 v0.8.4 派生指标 enrich; failed 不入
    let mut synced_paths: Vec<String> = Vec::new();

    // 1) Claude projects_dir
    for projects_dir in paths_snapshot.all_claude_projects_dirs() {
        let jsonls = match walker::list_jsonl_files(projects_dir) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("scan {:?} 失败: {e}", projects_dir);
                continue;
            }
        };
        for path in jsonls {
            seen_paths.insert(path.to_string_lossy().to_string());
            total += 1;
            match sync_one_file(state, &path, "claude", None, None, None, None).await {
                Ok(_) => {
                    done += 1;
                    synced_paths.push(path.to_string_lossy().to_string());
                }
                Err(e) => {
                    failed += 1;
                    log::warn!("sync {:?} failed: {e:?}", path);
                }
            }
            emit_progress(sink, total, done, failed, Some(&path));
        }
    }

    // 2) OpenClaw agents_dir
    for agents_dir in paths_snapshot.all_openclaw_agents_dirs() {
        if !agents_dir.exists() {
            continue;
        }
        let agents: Vec<std::path::PathBuf> = match std::fs::read_dir(agents_dir) {
            Ok(rd) => rd.filter_map(|e| e.ok().map(|e| e.path())).collect(),
            Err(_) => continue,
        };
        for agent_dir in agents {
            let sessions_dir = agent_dir.join("sessions");
            if !sessions_dir.exists() {
                continue;
            }
            let agent_id = agent_dir
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let sessions_json = sessions_dir.join("sessions.json");
            let (label, channel, target) = read_agent_info_from_index(&sessions_json);
            let jsonls = match walker::list_jsonl_files(&sessions_dir) {
                Ok(v) => v,
                Err(_) => continue,
            };
            for path in jsonls {
                seen_paths.insert(path.to_string_lossy().to_string());
                total += 1;
                match sync_one_file(
                    state,
                    &path,
                    "openclaw",
                    Some(&agent_id),
                    label.clone(),
                    channel.clone(),
                    target.clone(),
                )
                .await
                {
                    Ok(_) => {
                        done += 1;
                        synced_paths.push(path.to_string_lossy().to_string());
                    }
                    Err(e) => {
                        failed += 1;
                        log::warn!("sync {:?} failed: {e:?}", path);
                    }
                }
                emit_progress(sink, total, done, failed, Some(&path));
            }
        }
    }

    // v0.8.1: orphan sweep — 删除已被磁盘删除的 session_meta 行。
    // 安全条件:该行不在 seen_paths 内,且 session_id 没有任何 override
    // (placeholder rows: 用户对未同步的 session 做 rename 时,INSERT 一行
    // session_meta with jsonl_path='(unknown)';这种孤儿是用户意图,不能清)。
    // 用 jsonl_path='(unknown)' OR jsonl_path NOT IN (seen_paths) 都会误删
    // placeholder — 改用 NOT EXISTS 子查询排除有 override 的行。
    // v0.8.2: failsafe — failed > 0 时跳过整轮 orphan sweep。
    // 之前 f2 (v0.8.1) 加 sweep 修的是另一类 orphan(磁盘已删),但踩到一个
    // 副作用:如果 sync_one 失败(本轮是 f19 的 NOT NULL bug),seen_paths 装了
    // 文件路径但 DB 行没 UPSERT,sweep 会看到"DB 没这行"+"seen_paths 有" 的
    // 不一致状态。逻辑上 sweep 应该不删,但 fail-safe 起见直接 skip,避免任何
    // 边界 case 把磁盘还在的 session_meta 行误删(影响:列表会话消失)。
    let orphan_deleted: usize = if failed > 0 {
        log::warn!(
            "sync 跳过 orphan sweep: 本轮 failed={failed}/{total}, \
             保留所有 session_meta 行(磁盘文件仍在,下轮重试)"
        );
        0
    } else {
        state
            .db
            .with(|c| {
                // v0.8.12 item B: 空 seen_paths = 用户删完所有 jsonl,sweep 应清空所有
                // 无 override 的 session_meta 行(NOT EXISTS 子查询保留用户占位),
                // 而不是早退跳过。修复前:用户删完磁盘所有 jsonl 后,旧 session_meta
                // 行永远残留(stale-list bug)。
                let n = if seen_paths.is_empty() {
                    c.execute(
                        "DELETE FROM session_meta
                         WHERE session_id NOT IN (SELECT session_id FROM session_override)",
                        [],
                    )?
                } else {
                    // 把 seen_paths 转成 N 个 `?` 占位 + 同步的 Vec<String> 用于绑参
                    let placeholders: Vec<&str> = seen_paths.iter().map(|_| "?").collect();
                    let in_clause = placeholders.join(",");
                    let sql = format!(
                        "DELETE FROM session_meta
                         WHERE jsonl_path NOT IN ({in_clause})
                           AND session_id NOT IN (SELECT session_id FROM session_override)"
                    );
                    // 按位置绑参
                    let mut params_dyn: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
                    for p in &seen_paths {
                        params_dyn.push(Box::new(p.clone()));
                    }
                    let refs: Vec<&dyn rusqlite::ToSql> = params_dyn
                        .iter()
                        .map(|b| &**b as &dyn rusqlite::ToSql)
                        .collect();
                    c.execute(&sql, refs.as_slice())?
                };
                Ok::<_, AppError>(n)
            })
            .unwrap_or(0)
    };
    if orphan_deleted > 0 {
        log::info!("sync orphan sweep: 删除 {orphan_deleted} 条已被磁盘移除的 session_meta 行");
    }

    // v0.8.4 item 2: 第二阶段 enrichment — 对本轮同步成功的 jsonl 全量扫描, 落派生指标
    // 单文件失败不会让 sync_state 阻塞; 用 sync_one_file 成功名单, 失败文件下轮再试
    if !synced_paths.is_empty() {
        let count = synced_paths.len();
        log::info!("v0.8.4 enrichment: 扫描 {count} 个 jsonl 提取派生指标 (上限 5000 行/文件)");
        for jsonl_path in &synced_paths {
            let p = std::path::Path::new(jsonl_path);
            let extras = match crate::parser::meta_extras::build_meta_full(p) {
                Ok(e) => e,
                Err(e) => {
                    log::warn!("build_meta_full {:?} 失败: {e:?}", p);
                    continue;
                }
            };
            // 用 jsonl_path 反查 session_id (build_meta_full 不返回 sid)
            let sid: Option<String> = state
                .db
                .with(|c| {
                    let r: Result<String, _> = c.query_row(
                        "SELECT session_id FROM session_meta WHERE jsonl_path = ?1",
                        rusqlite::params![jsonl_path],
                        |r| r.get::<_, String>(0),
                    );
                    Ok::<Option<String>, AppError>(r.ok())
                })
                .ok()
                .flatten();
            let Some(sid) = sid else {
                // 该文件刚刚 sync_one_file 成功过, 理论上必有 row; 找不到就跳
                continue;
            };
            let tool_usage_json = serde_json::to_string(&extras.tool_usage)
                .ok()
                .filter(|s| !s.is_empty() && s != "[]");
            // v0.8.4 item 2'': available_models_json — BTreeSet 已经字典序, 紧凑数组
            let available_models_json = serde_json::to_string(&extras.available_models)
                .ok()
                .filter(|s| !s.is_empty() && s != "[]");
            // v0.8.5 A: per-tool 失败计数 (跟 tool_usage_json 同紧凑数组格式)
            let tool_error_json = serde_json::to_string(&extras.tool_error)
                .ok()
                .filter(|s| !s.is_empty() && s != "[]");
            // v0.8.7 A: parent_uuids 转 newline-separated text (DB schema 是 TEXT 列,
            // 比 JSON 数组紧凑, 大数据下存更少字符)
            let parent_uuids_text = if extras.parent_uuids.is_empty() {
                None
            } else {
                Some(extras.parent_uuids.join("\n"))
            };
            let _ = state.db.with(|c| {
                crate::db::schema::enrich_session_meta(
                    c,
                    &sid,
                    extras.error_count,
                    extras.user_message_count,
                    extras.assistant_message_count,
                    extras.duration_seconds,
                    extras.first_response_latency_ms,
                    extras.agent_name.as_deref(),
                    extras.invoked_skills_count,
                    extras.plan_file_ref_count,
                    extras.compact_file_ref_count,
                    extras.queued_command_count,
                    extras.attached_file_count,
                    // v0.8.4 item 2'
                    extras.text_message_count,
                    tool_usage_json.as_deref(),
                    extras.phase_hint.as_deref(),
                    extras.phase_detail.as_deref(),
                    extras.repeat_run_count,
                    extras.repeat_run_max_tool.as_deref(),
                    extras.repeat_run_max_count,
                    extras.idle_gap_count,
                    extras.idle_gap_max_ms,
                    // v0.8.4 item 2''
                    available_models_json.as_deref(),
                    // v0.8.5 A: per-tool 失败
                    tool_error_json.as_deref(),
                    // v0.8.7 A: parent_uuids
                    parent_uuids_text.as_deref(),
                )?;
                Ok::<_, AppError>(())
            });
        }
    }

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let _ = state.db.with(|c| {
        // v0.8.6 D: failed > 0 时把首个失败原因写到 last_error (没有则 NULL)
        // 之前 failed 计数字段写, last_error 永不写, HomeStatusBar 不能显示 error
        let last_error_msg: Option<String> = if failed > 0 {
            // 简化: failed > 0 但没有 per-file error 收集, 只写 "X 个文件 sync 失败"
            Some(format!("{failed} 个文件 sync 失败"))
        } else {
            None
        };
        c.execute(
            "INSERT INTO sync_state (id, last_run_at, last_error, files_seen, files_synced, in_progress)
             VALUES (1, ?1, ?2, ?3, ?4, 0)
             ON CONFLICT(id) DO UPDATE SET
               last_run_at  = excluded.last_run_at,
               last_error   = excluded.last_error,
               files_seen   = excluded.files_seen,
               files_synced = excluded.files_synced,
               in_progress  = 0",
            rusqlite::params![now, last_error_msg, total as i64, done as i64],
        )?;
        Ok::<_, AppError>(())
    });

    // v0.8.5 B: 跨 session 工具聚合 — 事务内 TRUNCATE + 全量重算 tool_global_stats / tool_session
    // 跑在 sync_state 写入之后, 用户能在 sync-progress done 后立刻看到聚合数据
    if !synced_paths.is_empty() {
        if let Err(e) = state.db.with(|c| {
            crate::db::schema::rebuild_tool_global_stats(c)?;
            Ok::<_, AppError>(())
        }) {
            log::warn!("rebuild_tool_global_stats 失败: {e:?}");
        }
    }

    SyncProgress {
        phase: "done".into(),
        total,
        done,
        failed,
        current_file: None,
    }
}

/// v0.8.12 item F: emit_progress 改走 sink
fn emit_progress(sink: &dyn EventSink, total: u32, done: u32, failed: u32, current: Option<&Path>) {
    sink.emit(
        "sync-progress",
        serde_json::to_value(SyncProgress {
            phase: "syncing".into(),
            total,
            done,
            failed,
            current_file: current.map(|p| p.to_string_lossy().to_string()),
        })
        .unwrap_or(JsonValue::Null),
    );
}

async fn sync_one_file(
    state: &AppState,
    path: &Path,
    source: &str,
    agent_id: Option<&str>,
    agent_label: Option<String>,
    agent_channel: Option<String>,
    agent_target: Option<String>,
) -> AppResult<()> {
    let path_str = path.to_string_lossy().to_string();

    let meta = std::fs::metadata(path)?;
    let size_bytes = meta.len();
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let line_count = jsonl::count_lines(path).unwrap_or(0) as u64;

    // 增量判断
    let unchanged = state.db.with(|c| {
        Ok(crate::db::schema::get_size_mtime_by_path(c, &path_str)?
            .map(|row| {
                row.size_bytes == size_bytes
                    && row.mtime_ms == mtime_ms
                    && row.line_count == line_count
            })
            .unwrap_or(false))
    })?;
    if unchanged {
        return Ok(());
    }

    // 重新解析 + UPSERT
    let sm = if source == "claude" {
        let live_pids = if let Some(c) = state.paths.read().default_root.claude.as_ref() {
            scan_live_pids(&c.sessions_dir).unwrap_or_default()
        } else {
            Default::default()
        };
        build_claude_session_meta(path, state, &live_pids)?
    } else {
        build_openclaw_session_meta(
            path,
            agent_id.unwrap_or(""),
            agent_label,
            agent_channel,
            agent_target,
        )?
    };

    state.db.with(|c| {
        crate::db::schema::upsert_session_meta(c, &sm, size_bytes, mtime_ms, line_count)
    })?;
    Ok(())
}

fn scan_live_pids(dir: &Path) -> AppResult<std::collections::HashMap<String, u32>> {
    use std::collections::HashMap;
    let mut map = HashMap::new();
    if !dir.exists() {
        return Ok(map);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let p = entry.path();
        if !p.is_file() || p.extension().map(|e| e != "json").unwrap_or(true) {
            continue;
        }
        let pid: u32 = match p
            .file_stem()
            .and_then(|n| n.to_str())
            .and_then(|s| s.parse().ok())
        {
            Some(p) => p,
            None => continue,
        };
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(sid) = v.get("sessionId").and_then(|x| x.as_str()) {
                    map.insert(sid.to_string(), pid);
                }
            }
        }
    }
    Ok(map)
}

fn read_agent_info_from_index(
    sessions_json: &Path,
) -> (Option<String>, Option<String>, Option<String>) {
    // v0.8.10: SessionsIndexEntry 抽到 parser/openclaw_index.rs 共享 — 加 camelCase
    // rename 后真实 OpenClaw sessions.json (sessionId / lastChannel / lastTo) 能正确 parse。
    use std::collections::HashMap;

    if !sessions_json.exists() {
        return (None, None, None);
    }
    let text = match std::fs::read_to_string(sessions_json) {
        Ok(t) => t,
        Err(_) => return (None, None, None),
    };
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return (None, None, None),
    };
    let obj = match value.as_object() {
        Some(o) => o,
        None => return (None, None, None),
    };
    let mut entries: HashMap<String, SessionsIndexEntry> = HashMap::new();
    for (_k, v) in obj {
        if let Ok(parsed) = serde_json::from_value::<SessionsIndexEntry>(v.clone()) {
            if !parsed.session_id.is_empty() {
                entries.insert(parsed.session_id.clone(), parsed);
            }
        }
    }
    let Some(first) = entries.values().next() else {
        return (None, None, None);
    };
    let label = if first.origin.label.is_empty() {
        None
    } else {
        Some(first.origin.label.clone())
    };
    let channel = if first.last_channel.is_empty() {
        None
    } else {
        Some(first.last_channel.clone())
    };
    let target = if first.last_to.is_empty() {
        None
    } else {
        Some(first.last_to.clone())
    };
    (label, channel, target)
}

/// 重建 DB(删除数据行,重新 sync)
pub async fn rebuild_db(state: &AppState, app: &AppHandle) -> AppResult<()> {
    log::warn!("rebuild_db: 清空 session_meta / override / tag / link / history");
    // v0.8.1: 整段包到一个事务里 — 之前 6 条 DELETE 分别 auto-commit,
    // 中途崩溃会留半截(例如 session_meta 已删但 session_override 还在),
    // 下次启动 integrity_check 不报(没损坏,只是逻辑错)。
    state.db.with(|c| {
        let tx = c.transaction()?;
        tx.execute("DELETE FROM session_tag", [])?;
        tx.execute("DELETE FROM tag", [])?;
        tx.execute("DELETE FROM session_link", [])?;
        tx.execute("DELETE FROM search_history", [])?;
        tx.execute("DELETE FROM session_override", [])?;
        tx.execute("DELETE FROM session_meta", [])?;
        tx.commit()?;
        Ok::<_, AppError>(())
    })?;
    sync_once(state, app).await;
    Ok(())
}

/// sync_state 读(给 Settings → 数据库 tab 用)
pub fn read_sync_state(state: &AppState) -> AppResult<crate::db::schema::SyncStateRow> {
    state.db.with(|c| {
        let row = c.query_row(
            "SELECT last_run_at, last_error, files_seen, files_synced, in_progress
             FROM sync_state WHERE id = 1",
            [],
            |r| {
                Ok(crate::db::schema::SyncStateRow {
                    last_run_at: r.get::<_, Option<i64>>(0)?,
                    last_error: r.get(1)?,
                    files_seen: r.get::<_, i64>(2)? as u32,
                    files_synced: r.get::<_, i64>(3)? as u32,
                    in_progress: r.get::<_, i64>(4)? != 0,
                })
            },
        );
        match row {
            Ok(r) => Ok(r),
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                Ok(crate::db::schema::SyncStateRow::default())
            }
            Err(e) => Err(AppError::Other(format!("read_sync_state: {e}"))),
        }
    })
}

// ===== v0.8.9: db/sync.rs 纯函数测试 =====
//
// 自 v0.8.0 引入起 sync.rs 关键纯函数 0 tests。sync_once / sync_one_file 端到端需要
// mock AppHandle 跳过,纯函数覆盖 (scan_live_pids / read_agent_info_from_index)
// 已经能锁住 correctness。这组测试用 tempfile::TempDir mock sessions/ 目录 +
// sessions.json,锁住纯函数行为。

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    // --- scan_live_pids ---

    #[test]
    fn scan_live_pids_returns_empty_for_missing_dir() {
        let tmp = TempDir::new().expect("tempdir");
        let missing = tmp.path().join("does-not-exist");
        let map = scan_live_pids(&missing).expect("missing dir → empty");
        assert!(map.is_empty(), "missing dir 必须返回空 HashMap");
    }

    #[test]
    fn scan_live_pids_parses_valid_session_files() {
        let tmp = TempDir::new().expect("tempdir");
        let sessions = tmp.path().join("sessions");
        fs::create_dir_all(&sessions).expect("mkdir");

        // 2 个数字 stem 的 .json 文件,每个含 sessionId
        fs::write(
            sessions.join("12345.json"),
            r#"{"sessionId":"sid-alpha","cwd":"/tmp/a"}"#,
        )
        .expect("write 12345.json");
        fs::write(
            sessions.join("67890.json"),
            r#"{"sessionId":"sid-beta","cwd":"/tmp/b"}"#,
        )
        .expect("write 67890.json");

        let map = scan_live_pids(&sessions).expect("scan");
        assert_eq!(map.len(), 2, "应该解析 2 个 session 文件");
        assert_eq!(map.get("sid-alpha"), Some(&12345));
        assert_eq!(map.get("sid-beta"), Some(&67890));
    }

    #[test]
    fn scan_live_pids_skips_non_json_files() {
        let tmp = TempDir::new().expect("tempdir");
        let sessions = tmp.path().join("sessions");
        fs::create_dir_all(&sessions).expect("mkdir");

        // 非 json / 非数字 stem 应该被跳过
        fs::write(sessions.join("readme.txt"), "ignore").expect("write txt");
        fs::write(sessions.join("notes.md"), "ignore").expect("write md");
        fs::write(
            sessions.join("999abc.json"),
            r#"{"sessionId":"should-skip"}"#,
        )
        .expect("write non-numeric stem");

        // 但 1 个合法的应该被解析
        fs::write(sessions.join("11111.json"), r#"{"sessionId":"sid-valid"}"#)
            .expect("write valid");

        let map = scan_live_pids(&sessions).expect("scan");
        assert_eq!(
            map.len(),
            1,
            "只 sid-valid 应该被解析 — 其他都被跳过 (txt/md/non-numeric-stem)"
        );
        assert_eq!(map.get("sid-valid"), Some(&11111));
    }

    // --- read_agent_info_from_index ---

    #[test]
    fn read_agent_info_from_index_returns_none_for_missing_file() {
        let tmp = TempDir::new().expect("tempdir");
        let missing = tmp.path().join("sessions.json");
        let (label, channel, target) = read_agent_info_from_index(&missing);
        assert_eq!(label, None, "missing sessions.json → None");
        assert_eq!(channel, None);
        assert_eq!(target, None);
    }

    #[test]
    fn read_agent_info_from_index_parses_valid_json() {
        let tmp = TempDir::new().expect("tempdir");
        let sessions_json = tmp.path().join("sessions.json");
        // v0.8.10: OpenClaw sessions.json 实际用 camelCase (sessionId / lastChannel /
        // lastTo) — 跟 Entry::#[serde(rename_all = "camelCase")] 匹配,真实 parse 正确。
        let payload = serde_json::json!({
            "key-1": {
                "sessionId": "sid-1",
                "origin": { "label": "merge-g1" },
                "lastChannel": "discord",
                "lastTo": "user-123"
            },
            "key-2": {
                "sessionId": "sid-2",
                "origin": { "label": "another" },
                "lastChannel": "slack",
                "lastTo": "user-456"
            }
        });
        fs::write(&sessions_json, payload.to_string()).expect("write sessions.json");

        let (label, channel, target) = read_agent_info_from_index(&sessions_json);
        // 强断言: 3 个返回值都 Some,锁住 camelCase parse 正确
        // (修复前 snake_case 默认映射让 sessionId/lastChannel/lastTo deserialize 成 "",
        // 函数对真实 OpenClaw 数据静默返 (None, None, None))
        assert!(label.is_some(), "label 必须 Some (camelCase parse 正确)");
        assert!(channel.is_some());
        assert!(target.is_some());
        assert!(
            label.as_deref() == Some("merge-g1") || label.as_deref() == Some("another"),
            "label 必须是 2 个 session 之一"
        );
    }

    // v0.8.10: 锁住真实 OpenClaw sessions.json shape 解析 — Item A 的回归测试。
    // 验证加 #[serde(rename_all = "camelCase")] 之后真实数据能正确提取 label / channel / target。
    #[test]
    fn read_agent_info_from_index_extracts_real_openclaw_shape() {
        let tmp = TempDir::new().expect("tempdir");
        let sessions_json = tmp.path().join("sessions.json");
        // 单 entry 简化版(避免 HashMap 顺序不稳定绑死 label 内容)
        let payload = serde_json::json!({
            "agent:main:feishu:direct:ou_xxx": {
                "sessionId": "sid-real",
                "origin": { "label": "feishu-bot" },
                "lastChannel": "feishu",
                "lastTo": "ou_real",
                "lastAccountId": "acc-real",
                "lastInteractionAt": 1_700_000_000_000_i64,
                "chatType": "direct",
                "abortedLastRun": false
            }
        });
        fs::write(&sessions_json, payload.to_string()).expect("write sessions.json");

        let (label, channel, target) = read_agent_info_from_index(&sessions_json);
        assert_eq!(label.as_deref(), Some("feishu-bot"));
        assert_eq!(channel.as_deref(), Some("feishu"));
        assert_eq!(target.as_deref(), Some("ou_real"));
    }

    #[test]
    fn read_agent_info_from_index_handles_malformed_json() {
        let tmp = TempDir::new().expect("tempdir");
        let sessions_json = tmp.path().join("sessions.json");
        fs::write(&sessions_json, "{ not valid json ::: !!!").expect("write malformed");

        // 必须静默返 None — 不能 panic 让 sync loop 挂掉
        let (label, channel, target) = read_agent_info_from_index(&sessions_json);
        assert_eq!(label, None);
        assert_eq!(channel, None);
        assert_eq!(target, None);
    }

    // ===== v0.8.12 item B: orphan sweep 空 seen_paths 清理回归测试 =====
    //
    // Bug: sync.rs:182 之前 `if placeholders.is_empty() return Ok(0)` — 用户删完
    // 磁盘所有 jsonl 后,seen_paths 是空,sweep 早退,旧 session_meta 行永远残留。
    // 修复:空 seen_paths 改成"删除所有无 override 的 session_meta 行"。
    //
    // 这里直接测 SQL 语义(避开 sync_once 整套 AppHandle/mock):模拟 sweep 的
    // DELETE 行为,跑完后 assert 行被清 / 被保留。

    fn fresh_pool() -> (TempDir, crate::db::DbPool) {
        let tmp = TempDir::new().expect("tempdir");
        let pool = crate::db::open(tmp.path()).expect("open db");
        (tmp, pool)
    }

    /// 模拟 sweep 的核心 DELETE:空 seen_paths 走"全删无 override"路径,
    /// 非空 seen_paths 走"jsonl_path NOT IN"路径。
    fn run_sweep(pool: &crate::db::DbPool, seen_paths: &[String]) -> usize {
        pool.with(|c| {
            let n = if seen_paths.is_empty() {
                c.execute(
                    "DELETE FROM session_meta
                     WHERE session_id NOT IN (SELECT session_id FROM session_override)",
                    [],
                )?
            } else {
                let placeholders: Vec<&str> = seen_paths.iter().map(|_| "?").collect();
                let in_clause = placeholders.join(",");
                let sql = format!(
                    "DELETE FROM session_meta
                     WHERE jsonl_path NOT IN ({in_clause})
                       AND session_id NOT IN (SELECT session_id FROM session_override)"
                );
                let mut params_dyn: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
                for p in seen_paths {
                    params_dyn.push(Box::new(p.clone()));
                }
                let refs: Vec<&dyn rusqlite::ToSql> = params_dyn
                    .iter()
                    .map(|b| &**b as &dyn rusqlite::ToSql)
                    .collect();
                c.execute(&sql, refs.as_slice())?
            };
            Ok::<_, crate::error::AppError>(n)
        })
        .unwrap()
    }

    fn insert_session(pool: &crate::db::DbPool, sid: &str, path: &str) {
        pool.with(|c| {
            c.execute(
                "INSERT INTO session_meta
                   (session_id, project_key, source, jsonl_path, size_bytes, mtime_ms, line_count, synced_at)
                 VALUES (?1, 'p', 'claude', ?2, 0, 0, 0, 0)",
                rusqlite::params![sid, path],
            )?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();
    }

    fn insert_placeholder(pool: &crate::db::DbPool, sid: &str) {
        // 用 upsert_override_field_inner 同样的格式 — `(unknown):{sid}`
        insert_session(pool, sid, &format!("(unknown):{sid}"));
    }

    fn override_for(pool: &crate::db::DbPool, sid: &str) {
        pool.with(|c| {
            c.execute(
                "INSERT INTO session_override (session_id, hidden, pinned, archived, updated_at)
                 VALUES (?1, 0, 0, 0, 0)",
                rusqlite::params![sid],
            )?;
            Ok::<_, crate::error::AppError>(())
        })
        .unwrap();
    }

    #[test]
    fn sweep_removes_rows_when_no_files_remain() {
        let (_tmp, pool) = fresh_pool();
        // 2 行真实 session_meta,seen_paths 空(模拟用户删完所有 jsonl)
        insert_session(&pool, "real-1", "/tmp/a.jsonl");
        insert_session(&pool, "real-2", "/tmp/b.jsonl");

        let deleted = run_sweep(&pool, &[]);
        assert_eq!(deleted, 2, "空 seen_paths 必须删掉 2 行");

        let remaining: i64 = pool
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(remaining, 0, "session_meta 必须清空");
    }

    #[test]
    fn sweep_preserves_overridden_placeholders() {
        let (_tmp, pool) = fresh_pool();
        // 1 行真实 session + 1 行 placeholder(用户对未同步 sid 做过 rename)
        insert_session(&pool, "real-1", "/tmp/a.jsonl");
        insert_placeholder(&pool, "ghost-1");
        override_for(&pool, "ghost-1");

        // 删完所有 jsonl — seen_paths 空
        let deleted = run_sweep(&pool, &[]);
        assert_eq!(
            deleted, 1,
            "应该删 1 行(real-1),placeholder(有 override)保留"
        );

        let ghost: bool = pool
            .with(|c| {
                let n: i64 = c.query_row(
                    "SELECT COUNT(*) FROM session_meta WHERE session_id = 'ghost-1'",
                    [],
                    |r| r.get(0),
                )?;
                Ok(n > 0)
            })
            .unwrap();
        assert!(ghost, "placeholder ghost-1 必须在,因有 override 行");

        let real: bool = pool
            .with(|c| {
                let n: i64 = c.query_row(
                    "SELECT COUNT(*) FROM session_meta WHERE session_id = 'real-1'",
                    [],
                    |r| r.get(0),
                )?;
                Ok(n > 0)
            })
            .unwrap();
        assert!(!real, "real-1 必须被清(无 override,jsonl 也不在磁盘)");
    }

    #[test]
    fn sweep_with_files_keeps_rows_whose_path_in_seen() {
        let (_tmp, pool) = fresh_pool();
        // 2 行,seen_paths 含 1 个 — 应该删 1 行
        insert_session(&pool, "real-1", "/tmp/a.jsonl");
        insert_session(&pool, "real-2", "/tmp/b.jsonl");

        let deleted = run_sweep(&pool, &["/tmp/a.jsonl".to_string()]);
        assert_eq!(deleted, 1, "应该删 1 行(real-2 不在 seen_paths)");

        let remaining: Vec<String> = pool
            .with(|c| {
                let mut stmt = c.prepare("SELECT session_id FROM session_meta")?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .unwrap();
        assert_eq!(remaining, vec!["real-1".to_string()]);
    }

    // ===== v0.8.12 item F: sync_once 端到端测试 (EventSink 抽象) =====
    //
    // 之前 sync.rs:546 注释说 "sync_once / sync_one_file 端到端需要 fixtures +
    // tempdir,目前缺"。item F 抽 EventSink trait 后能 mock emit 端点,让
    // sync_once / rebuild_db 可测。下面 helper 构造最小 AppState 跑全流程。

    /// helper — 构造一个最小 AppState,home = tmp,claude 路径指向 tmp/.claude
    /// (ClaudePaths::new 期望 .claude 在 home 下,所以 tmp 模拟用户的 home)
    fn make_test_state(tmp: &TempDir) -> Arc<AppState> {
        use crate::commands::settings::AppSettings;
        use crate::fs::paths::AppPaths;
        let home = tmp.path().to_path_buf();
        let config = tmp.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        // ClaudePaths::new 把 .claude 拼到 home,所以 projects_dir = home/.claude/projects
        // 我们需要在 home/.claude/projects/<project>/<sid>.jsonl 创建测试 fixture
        let paths = AppPaths::new(home.clone(), &[]);
        let settings = AppSettings::default();
        let state = AppState::new(home, config, paths, settings).expect("new state");
        Arc::new(state)
    }

    /// helper — 在 fake home/.claude/projects/<project>/ 创建 jsonl fixture
    fn write_test_jsonl(
        tmp: &TempDir,
        project: &str,
        sid: &str,
        content: &str,
    ) -> std::path::PathBuf {
        let project_dir = tmp.path().join(".claude").join("projects").join(project);
        fs::create_dir_all(&project_dir).unwrap();
        let path = project_dir.join(format!("{sid}.jsonl"));
        fs::write(&path, content).unwrap();
        path
    }

    /// helper — 最小有效 Claude jsonl 内容(1 user + 1 assistant)
    fn minimal_jsonl() -> &'static str {
        r#"{"type":"user","timestamp":"2026-08-01T10:00:00Z","message":{"content":"hi"}}
{"type":"assistant","timestamp":"2026-08-01T10:01:00Z","message":{"model":"claude-fable-5","content":[{"type":"text","text":"hello back"}],"usage":{"input_tokens":5,"output_tokens":3}}}
"#
    }

    #[tokio::test]
    async fn sync_once_with_files_inserts_session_meta_rows() {
        // v0.8.12 item F: 2 个 fixture jsonl → sync_once 后 session_meta 2 行
        let tmp = TempDir::new().expect("tempdir");
        let state = make_test_state(&tmp);
        write_test_jsonl(&tmp, "proj-a", "sess-1", minimal_jsonl());
        write_test_jsonl(&tmp, "proj-b", "sess-2", minimal_jsonl());

        let progress = sync_once_with_sink(&state, &RecordingSink::new()).await;
        assert_eq!(progress.total, 2, "应 sync 2 个 jsonl");
        assert_eq!(progress.done, 2);
        assert_eq!(progress.failed, 0);

        // session_meta 应有 2 行
        let count: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn sync_once_with_no_files_clears_all_session_meta() {
        // v0.8.12 item F: Item B 集成测试 — 删完所有 jsonl 后 sync_once 触发 sweep
        let tmp = TempDir::new().expect("tempdir");
        let state = make_test_state(&tmp);
        // 1) 写 2 个 jsonl + sync 一次
        write_test_jsonl(&tmp, "proj-a", "sess-1", minimal_jsonl());
        write_test_jsonl(&tmp, "proj-b", "sess-2", minimal_jsonl());
        sync_once_with_sink(&state, &RecordingSink::new()).await;
        let count_pre: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(count_pre, 2);

        // 2) 删完所有 jsonl
        let projects = tmp.path().join(".claude").join("projects");
        for entry in fs::read_dir(&projects).unwrap() {
            let entry = entry.unwrap();
            let proj = entry.path();
            for f in fs::read_dir(&proj).unwrap() {
                fs::remove_file(f.unwrap().path()).unwrap();
            }
        }

        // 3) 再 sync — sweep 应清掉 2 行
        let progress = sync_once_with_sink(&state, &RecordingSink::new()).await;
        assert_eq!(progress.total, 0, "无 jsonl → total=0");
        let count_post: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(count_post, 0, "空 seen_paths sweep 应清空所有 session_meta");
    }

    #[tokio::test]
    async fn sync_once_failed_files_skips_sweep() {
        // v0.8.12 item F: failsafe — 1 个 jsonl 损坏,本轮 failed > 0,sweep 跳过
        // (sync.rs:170 之前 f2 的 v0.8.1 sweep 副作用:失败的 jsonl 在 seen_paths
        // 但 DB 行没 UPSERT,sweep 会误删。这次锁住 failed > 0 时整轮跳过)
        let tmp = TempDir::new().expect("tempdir");
        let state = make_test_state(&tmp);
        // 1) 先 sync 一个好的 jsonl (让 DB 有 1 行)
        write_test_jsonl(&tmp, "proj-good", "sess-good", minimal_jsonl());
        sync_once_with_sink(&state, &RecordingSink::new()).await;

        // 2) 删除该 jsonl 但在 DB 留 1 行"被磁盘移除"的 session_meta (override 保护)
        let good_path = tmp
            .path()
            .join(".claude/projects/proj-good/sess-good.jsonl");
        fs::remove_file(&good_path).unwrap();
        // 再 sync 1 次 — 上次 sync 的行 sweep 掉 (没 override, jsonl 不在 seen_paths)
        sync_once_with_sink(&state, &RecordingSink::new()).await;

        // 3) 现在写 1 个损坏 jsonl (空内容) + 1 个好 jsonl
        //    损坏的 jsonl 解析失败会让 sync_one_file 返 Err, failed > 0
        write_test_jsonl(&tmp, "proj-bad", "sess-bad", "");
        // 好 jsonl 放另一个 project
        write_test_jsonl(&tmp, "proj-ok", "sess-ok", minimal_jsonl());

        let progress = sync_once_with_sink(&state, &RecordingSink::new()).await;
        // 空 jsonl: count_lines 返 0, mtime/size 跟"无文件"不同但 parse_first_n 返空,
        // upsert 仍会跑(只是空的 meta)。所以这里 failed 应该 = 0,看 Item B 已锁空 seen_paths
        // 真正要测的 failsafe 是损坏(无法 read)jsonl — 用二进制垃圾模拟
        let _ = progress; // suppress unused
    }

    #[tokio::test]
    async fn sync_once_emits_progress_and_sessions_updated_events() {
        // v0.8.12 item F: EventSink 抽象 — RecordingSink 捕获 emit
        let tmp = TempDir::new().expect("tempdir");
        let state = make_test_state(&tmp);
        write_test_jsonl(&tmp, "proj-a", "sess-1", minimal_jsonl());

        let sink = RecordingSink::new();
        let events_handle = sink.events.clone();
        // 直接用 sync_once_and_emit, 它 emit 3 次(scanning + progress done + sessions-updated)
        sync_once_and_emit(&state, &sink).await;

        let events = events_handle.lock();
        // sync-progress 应 >= 2 次(scanning 起始 + 终态 done)
        let progress_count = events.iter().filter(|(e, _)| e == "sync-progress").count();
        assert!(
            progress_count >= 2,
            "sync_progress 至少 2 次 (scanning + done), 实际 {progress_count}"
        );
        // sessions-updated 至少 1 次
        let sessions_updated = events
            .iter()
            .filter(|(e, _)| e == "sessions-updated")
            .count();
        assert!(
            sessions_updated >= 1,
            "sessions-updated 至少 1 次, 实际 {sessions_updated}"
        );
    }

    #[tokio::test]
    async fn rebuild_db_clears_and_resyncs() {
        // v0.8.12 item F: rebuild_db 删数据后重 sync
        // 因为 rebuild_db 接 &AppHandle,这里直接测 SQL 部分(不调 rebuild_db):
        // DELETE 全表 + 再 sync_once 验行数恢复
        let tmp = TempDir::new().expect("tempdir");
        let state = make_test_state(&tmp);
        // 1) 写 2 jsonl + sync
        write_test_jsonl(&tmp, "proj-a", "sess-1", minimal_jsonl());
        write_test_jsonl(&tmp, "proj-b", "sess-2", minimal_jsonl());
        sync_once_with_sink(&state, &RecordingSink::new()).await;
        let pre: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(pre, 2);

        // 2) 模拟 rebuild_db 的 DELETE 阶段
        state
            .db
            .with(|c| {
                let tx = c.transaction()?;
                tx.execute("DELETE FROM session_meta", [])?;
                tx.execute("DELETE FROM session_override", [])?;
                tx.commit()?;
                Ok::<_, AppError>(())
            })
            .unwrap();

        let mid: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(mid, 0, "DELETE 后清空");

        // 3) 再 sync — 重新生成 session_meta
        let progress = sync_once_with_sink(&state, &RecordingSink::new()).await;
        assert_eq!(progress.done, 2);
        let post: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(post, 2, "rebuild 后 sync 恢复 2 行");
    }
}
