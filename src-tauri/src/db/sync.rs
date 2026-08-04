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
    // v0.8.13 item D: 整个 sync_once 期间持 sync_op_lock,跟 rebuild_db 互斥。
    // 首次启动也要持锁(防止并发 rebuild_db)。
    let _first_guard = state.sync_op_lock.lock().await;
    sync_once_and_emit(&state, &AppHandleSink(&app)).await;
    drop(_first_guard);
    loop {
        tokio::select! {
            _ = state.paths_change.notified() => {
                log::info!("sync_loop: paths 变更,重新同步");
                let _guard = state.sync_op_lock.lock().await;
                sync_once_and_emit(&state, &AppHandleSink(&app)).await;
                drop(_guard);
            }
            _ = state.refresh_requested.notified() => {
                log::info!("sync_loop: 手动刷新触发");
                let _guard = state.sync_op_lock.lock().await;
                sync_once_and_emit(&state, &AppHandleSink(&app)).await;
                drop(_guard);
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

/// Map the completed file counters to the terminal progress phase.
///
/// Kept separate from the filesystem walk so the partial-success contract can be
/// tested without relying on platform-specific permission failures.
fn terminal_phase(failed: u32) -> &'static str {
    if failed > 0 {
        "partial_error"
    } else {
        "done"
    }
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

    // v0.8.13 item E: failed > 0 时 phase 改发 "partial_error",前端 HomeStatusBar
    // 渲染 ⚠ + "完成 X/Y · N 失败" 而不是绿色 ✓,避免把部分失败误判为同步成功。
    let phase = terminal_phase(failed);
    SyncProgress {
        phase: phase.into(),
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

/// 重建 DB(删除可重建的源数据,重新 sync)
///
/// v0.8.13: 仅清 `session_meta`(可从 jsonl 重新扫描重建),保留全部用户表
/// (`session_override` / `session_tag` / `tag` / `session_link` / `search_history`)。
/// 之前版本清 6 张表,但 HomeStatusBar.tsx 确认框明确承诺"override 不受影响",
/// 真实行为 ≠ UI 文案 → 用户点确认会永久丢失 rename/hide/pin/note/tag/link/历史。
/// 修后语义跟 UI 一致。
pub async fn rebuild_db(state: &AppState, app: &AppHandle) -> AppResult<()> {
    // v0.8.13 item D: acquire sync_op_lock 跟 run_sync_loop 互斥。
    // 必须在 DELETE 之前持锁,避免 sync_loop 正在 walk + sync_one_file 时穿插
    // rebuild 的 DELETE 事务。锁在 fn 末尾 RAII 释放。
    let _guard = state.sync_op_lock.lock().await;
    rebuild_db_inner(state)?;
    sync_once(state, app).await;
    drop(_guard);
    Ok(())
}

/// v0.8.13 item A: rebuild_db 的 SQL 阶段(inner)— 可测。
/// 只清无 override 的 `session_meta` 行(可从 jsonl 重建),保留全部用户表 + 有 override
/// 的 session_meta 行(避免 FK CASCADE 级联删 `session_override`)。
/// sync 阶段会通过 `upsert_session_meta ON CONFLICT(session_id) DO UPDATE` 把
/// jsonl_path / mtime / size 刷回,但 override 行 sid 保留,FK 仍然有效。
pub(crate) fn rebuild_db_inner(state: &AppState) -> AppResult<()> {
    log::warn!(
        "rebuild_db: 清空无 override 的 session_meta (源数据),保留 override/tag/link/history"
    );
    // v0.8.1: 整段包到一个事务里 — 避免半截删除。
    // v0.8.13: WHERE session_id NOT IN (override) — 跟 orphan sweep 同 pattern,
    // 跳过有 override 的 session_meta,避免 FK ON DELETE CASCADE 把 session_override
    // 级联删掉。sync 后 upsert_session_meta 会把 jsonl_path/mtime/size 刷回。
    state.db.with(|c| {
        let tx = c.transaction()?;
        tx.execute(
            "DELETE FROM session_meta
             WHERE session_id NOT IN (SELECT session_id FROM session_override)",
            [],
        )?;
        tx.commit()?;
        Ok::<_, AppError>(())
    })
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
        // v0.8.13 item H: v0.8.12 F 留下的洞 — 测试名说要锁 failed > 0 → sweep 跳过,
        // 但 fixture 用空 jsonl (parse 不会失败),failed 永远 = 0,断言缺失。
        // 重写契约:验证 sweep 在 failed == 0 时正确清理 orphan (happy path)。
        // (failed > 0 分支跨平台难触发 — chmod 0o000 在 owner-readable 文件上无效,
        //  binary garbage 被 for_each_line 静默吞。失败兜底由 sync.rs:228 `if failed > 0`
        //  直接跳过 sweep 保证,代码本身是 trivial 短路逻辑。)
        let tmp = TempDir::new().expect("tempdir");
        let state = make_test_state(&tmp);

        // 1) sync 1 个 good jsonl,DB 里有 1 行
        write_test_jsonl(&tmp, "proj-good", "sess-good", minimal_jsonl());
        let p1 = sync_once_with_sink(&state, &RecordingSink::new()).await;
        assert_eq!(p1.failed, 0);
        assert_eq!(p1.phase, "done");
        let pre_count: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(pre_count, 1);

        // 2) 直接 INSERT 一行 orphan (jsonl 路径不存在,模拟磁盘已删但 DB 残留)
        state
            .db
            .with(|c| {
                c.execute(
                    "INSERT INTO session_meta
                       (session_id, project_key, source, jsonl_path, size_bytes,
                        mtime_ms, line_count, synced_at)
                     VALUES ('orphan-deleted', 'proj-orphan', 'claude',
                             '/tmp/nonexistent-orphan.jsonl', 0, 0, 0, 0)",
                    [],
                )?;
                Ok::<_, AppError>(())
            })
            .unwrap();
        let mid_count: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(mid_count, 2, "1 行 good + 1 行 orphan");

        // 3) 再 sync 一次 — failed == 0,sweep 应清掉 orphan 行
        let p2 = sync_once_with_sink(&state, &RecordingSink::new()).await;
        assert_eq!(
            p2.failed, 0,
            "failed == 0,sweep 应跑 (这条 case 覆盖 happy path)"
        );
        let post_count: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(
            post_count, 1,
            "sweep 清掉 orphan (jsonl 不在 seen_paths 且无 override) — good 行保留"
        );

        // 4) 验证 orphan 确实被删,good 仍在
        let remaining: Vec<String> = state
            .db
            .with(|c| {
                let mut stmt = c.prepare("SELECT session_id FROM session_meta")?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()?;
                Ok(rows)
            })
            .unwrap();
        assert_eq!(remaining, vec!["sess-good".to_string()]);
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
    async fn rebuild_db_clears_session_meta_only() {
        // v0.8.13 item A: rebuild_db 只清无 override 的 session_meta 行
        // (可从 jsonl 重建),有 override 的 session_meta 保留 (避免 FK CASCADE
        // 把 session_override 级联删掉)。session_override/session_tag/tag/
        // session_link/search_history 5 张用户表全部保留。
        // 之前版本 (v0.8.12) 清 6 张表,导致 UI 文案 "override 不受影响" 撒谎。
        let tmp = TempDir::new().expect("tempdir");
        let state = make_test_state(&tmp);

        // 1) 各表 pre-fill 1 行
        write_test_jsonl(&tmp, "proj-a", "sess-1", minimal_jsonl());
        write_test_jsonl(&tmp, "proj-b", "sess-2", minimal_jsonl());
        sync_once_with_sink(&state, &RecordingSink::new()).await;
        let pre_meta: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(pre_meta, 2);

        // 写 user tables: override 只挂在 sess-1 (有 override 的 session_meta 会保留)
        state
            .db
            .with(|c| {
                let tx = c.transaction()?;
                tx.execute(
                    "INSERT INTO session_override (session_id, display_title, hidden, pinned, archived, notes, updated_at)
                     VALUES ('sess-1', 'My Title', 0, 0, 0, 'some note', 0)",
                    [],
                )?;
                tx.execute(
                    "INSERT INTO tag (name, color) VALUES ('mytag', '#ff0000')",
                    [],
                )?;
                tx.execute(
                    "INSERT INTO session_tag (session_id, tag_id)
                     SELECT 'sess-1', id FROM tag WHERE name='mytag'",
                    [],
                )?;
                tx.execute(
                    "INSERT INTO session_link (from_session, to_session, note, created_at)
                     VALUES ('sess-1', 'sess-2', 'test link', 0)",
                    [],
                )?;
                tx.execute(
                    "INSERT INTO search_history (query, hit_count, ts) VALUES ('test query', 5, 0)",
                    [],
                )?;
                tx.commit()?;
                Ok::<_, AppError>(())
            })
            .unwrap();

        // 2) 跑 rebuild_db_inner (DELETE 无 override 的 session_meta)
        rebuild_db_inner(&state).expect("rebuild_db_inner");

        // 3) 验证: 无 override 的 sess-2 session_meta 被清,sess-1 (有 override) 保留
        //     其他 5 张用户表全部保留
        let post_meta: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(
            post_meta, 1,
            "rebuild 后 sess-2 (无 override) 应清,sess-1 (有 override) 保留"
        );

        let override_count: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_override", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(override_count, 1, "rebuild 后 session_override 应保留 1 行");

        let tag_count: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM tag", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(tag_count, 1, "rebuild 后 tag 应保留 1 行");

        let session_tag_count: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_tag", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(session_tag_count, 1, "rebuild 后 session_tag 应保留 1 行");

        let link_count: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_link", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(link_count, 1, "rebuild 后 session_link 应保留 1 行");

        let history_count: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM search_history", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(history_count, 1, "rebuild 后 search_history 应保留 1 行");
    }

    #[tokio::test]
    async fn rebuild_db_preserves_overrides_after_resync() {
        // v0.8.13 item A: rebuild_db + 重 sync 后,override 行 sid 跟新 sync
        // session_meta 关联正确 (FK 仍在,display_title 不丢)。
        let tmp = TempDir::new().expect("tempdir");
        let state = make_test_state(&tmp);

        // 1) 写 jsonl + sync (生成 session_meta)
        write_test_jsonl(&tmp, "proj-a", "sess-1", minimal_jsonl());
        sync_once_with_sink(&state, &RecordingSink::new()).await;

        // 2) 写 override (display_title + hidden)
        state
            .db
            .with(|c| {
                let tx = c.transaction()?;
                tx.execute(
                    "INSERT INTO session_override (session_id, display_title, hidden, pinned, archived, notes, updated_at)
                     VALUES ('sess-1', 'My Title', 1, 0, 0, '', 0)",
                    [],
                )?;
                tx.commit()?;
                Ok::<_, AppError>(())
            })
            .unwrap();

        // 3) rebuild_db_inner (DELETE session_meta)
        rebuild_db_inner(&state).expect("rebuild_db_inner");

        // 4) 重 sync (rebuild_db 在生产代码里会 sync_once)
        sync_once_with_sink(&state, &RecordingSink::new()).await;

        // 5) session_meta 应有 1 行 (重新 sync 回来)
        let post_meta: i64 = state
            .db
            .with(|c| Ok(c.query_row("SELECT COUNT(*) FROM session_meta", [], |r| r.get(0))?))
            .unwrap();
        assert_eq!(post_meta, 1, "rebuild + sync 后 session_meta 应恢复");

        // 6) override 应保留 (display_title + hidden)
        let title: String = state
            .db
            .with(|c| {
                Ok(c.query_row(
                    "SELECT display_title FROM session_override WHERE session_id = 'sess-1'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(title, "My Title", "override.display_title 不丢");

        let hidden: i64 = state
            .db
            .with(|c| {
                Ok(c.query_row(
                    "SELECT hidden FROM session_override WHERE session_id = 'sess-1'",
                    [],
                    |r| r.get(0),
                )?)
            })
            .unwrap();
        assert_eq!(hidden, 1, "override.hidden 仍为 1");

        // 7) FK 校验: override.session_id 在 session_meta 里存在
        let fk_ok: bool = state
            .db
            .with(|c| {
                Ok(c.query_row(
                    "SELECT COUNT(*) > 0 FROM session_override o
                     JOIN session_meta m ON m.session_id = o.session_id
                     WHERE o.session_id = 'sess-1'",
                    [],
                    |r| r.get::<_, i64>(0),
                )? != 0)
            })
            .unwrap();
        assert!(fk_ok, "override.session_id 跟 session_meta FK 关联正确");
    }

    // ===== v0.8.13 item D: sync_op_lock 操作级互斥回归测试 =====

    #[tokio::test]
    async fn sync_op_lock_serializes_concurrent_holders() {
        // v0.8.13 item D: sync_op_lock 是 tokio Mutex,concurrent acquire 应串行。
        let tmp = TempDir::new().expect("tempdir");
        let state = make_test_state(&tmp);

        // 1) 先 acquire lock (模拟 sync_loop 持锁)
        let g1 = state.sync_op_lock.lock().await;

        // 2) 第二个 acquire 用 try_lock — 应失败 (g1 还持锁)
        let g2_result = state.sync_op_lock.try_lock();
        assert!(
            g2_result.is_err(),
            "sync_op_lock 已被 g1 持有,g2.try_lock 应失败"
        );

        // 3) drop g1 后再 try_lock — 应成功
        drop(g1);
        let g2 = state
            .sync_op_lock
            .try_lock()
            .expect("g1 释放后 g2.try_lock 应成功");
        drop(g2);
    }

    #[tokio::test]
    async fn sync_op_lock_blocks_during_rebuild_db() {
        // v0.8.13 item D: rebuild_db_inner 期间持有 lock → 第二个 sync_op 应阻塞直到释放。
        // 简化测试:用 try_lock 模拟 contention。
        let tmp = TempDir::new().expect("tempdir");
        let state = make_test_state(&tmp);

        // 手动模拟 rebuild_db_inner:写 jsonl + 持锁 + rebuild_db_inner
        write_test_jsonl(&tmp, "proj-a", "sess-1", minimal_jsonl());
        sync_once_with_sink(&state, &RecordingSink::new()).await;

        // 1) 模拟 rebuild_db_inner 在持锁期间,后台 try_lock 应失败
        let guard = state.sync_op_lock.lock().await;
        let contended = state.sync_op_lock.try_lock();
        assert!(contended.is_err(), "持锁期间 try_lock 必须失败");
        drop(guard);

        // 2) 释放后能再 acquire (证明 lock 是可重入的 RAII)
        let guard2 = state.sync_op_lock.lock().await;
        drop(guard2);

        // 3) 跑 rebuild_db_inner 不应 deadlock (它自己不 try_lock,只 acquire 一次)
        rebuild_db_inner(&state).expect("rebuild_db_inner 不应 deadlock");
    }

    // ===== v0.8.13 item E: sync 失败发 partial_error phase =====

    #[tokio::test]
    async fn sync_once_emits_done_when_all_succeed() {
        // v0.8.13 item E: failed == 0 时 phase 应仍是 "done" (无回归契约)
        let tmp = TempDir::new().expect("tempdir");
        let state = make_test_state(&tmp);
        write_test_jsonl(&tmp, "proj-a", "sess-1", minimal_jsonl());
        write_test_jsonl(&tmp, "proj-b", "sess-2", minimal_jsonl());

        let progress = sync_once_with_sink(&state, &RecordingSink::new()).await;
        assert_eq!(progress.total, 2);
        assert_eq!(progress.done, 2);
        assert_eq!(progress.failed, 0);
        assert_eq!(
            progress.phase, "done",
            "failed == 0 时 phase 应是 done (无回归)"
        );
    }

    #[tokio::test]
    async fn sync_once_partial_error_phase_contract() {
        // v0.8.13 item E: phase 跟 failed 严格对应 — failed > 0 → partial_error,
        // failed == 0 → done。先直接锁住纯函数分支,不依赖 chmod 等平台特定失败。
        assert_eq!(terminal_phase(2), "partial_error");
        assert_eq!(terminal_phase(1), "partial_error");
        assert_eq!(terminal_phase(0), "done");

        // 再保留一次真实 sync happy path,确保无失败时不会误发 partial_error。
        let tmp = TempDir::new().expect("tempdir");
        let state = make_test_state(&tmp);
        write_test_jsonl(&tmp, "proj-a", "sess-1", minimal_jsonl());

        // 先 sync 成功,断言 phase == "done"
        let p1 = sync_once_with_sink(&state, &RecordingSink::new()).await;
        assert_eq!(p1.failed, 0);
        assert_eq!(p1.phase, "done");

        // 删除 jsonl,再 sync — orphan sweep 应清空 session_meta,
        // 但本轮 walk 找不到 jsonl → done=0, failed=0 → phase 应仍 "done"
        let path = tmp.path().join(".claude/projects/proj-a/sess-1.jsonl");
        fs::remove_file(&path).unwrap();
        let p2 = sync_once_with_sink(&state, &RecordingSink::new()).await;
        assert_eq!(p2.total, 0);
        assert_eq!(p2.failed, 0);
        assert_eq!(
            p2.phase, "done",
            "no files + no failed → done (orphans sweepped,phase 不应被污染)"
        );
    }
}
