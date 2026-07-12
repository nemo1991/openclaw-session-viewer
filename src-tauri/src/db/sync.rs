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

/// 启动同步循环(永不返回)
pub async fn run_sync_loop(state: Arc<AppState>, app: AppHandle) {
    sync_once_and_emit(&state, &app).await;
    loop {
        tokio::select! {
            _ = state.paths_change.notified() => {
                log::info!("sync_loop: paths 变更,重新同步");
                sync_once_and_emit(&state, &app).await;
            }
            _ = state.refresh_requested.notified() => {
                log::info!("sync_loop: 手动刷新触发");
                sync_once_and_emit(&state, &app).await;
            }
        }
    }
}

async fn sync_once_and_emit(state: &AppState, app: &AppHandle) {
    let _ = app.emit(
        "sync-progress",
        SyncProgress {
            phase: "scanning".into(),
            total: 0,
            done: 0,
            failed: 0,
            current_file: None,
        },
    );
    let progress = sync_once(state, app).await;
    let _ = app.emit("sync-progress", &progress);
    let _ = app.emit("sessions-updated", ());
}

pub async fn sync_once(state: &AppState, app: &AppHandle) -> SyncProgress {
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
            emit_progress(app, total, done, failed, Some(&path));
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
                emit_progress(app, total, done, failed, Some(&path));
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
                // 把 seen_paths 转成 N 个 `?` 占位 + 同步的 Vec<String> 用于绑参
                let placeholders: Vec<&str> = seen_paths.iter().map(|_| "?").collect();
                if placeholders.is_empty() {
                    return Ok::<usize, AppError>(0);
                }
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
                let n = c.execute(&sql, refs.as_slice())?;
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

fn emit_progress(app: &AppHandle, total: u32, done: u32, failed: u32, current: Option<&Path>) {
    let _ = app.emit(
        "sync-progress",
        SyncProgress {
            phase: "syncing".into(),
            total,
            done,
            failed,
            current_file: current.map(|p| p.to_string_lossy().to_string()),
        },
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
}
