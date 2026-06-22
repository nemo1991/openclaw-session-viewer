//! 会话列表与元数据命令

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::fs::paths;
use crate::fs::walker;
use crate::model::{LivePidMeta, SessionMeta, TokenUsage};
use crate::parser::jsonl;
use crate::AppState;

/// 列出所有 Claude + OpenClaw 会话
#[tauri::command]
pub async fn list_sessions(state: State<'_, Arc<AppState>>) -> AppResult<Vec<SessionMeta>> {
    let mut out = Vec::new();

    // 1) 先扫 ~/.claude/sessions/<pid>.json, 拿到 sessionId → pid 映射
    let live_pids = scan_live_pids(&state.paths.claude.sessions_dir).unwrap_or_default();

    // 2) 扫 Claude 项目目录
    let claude_jsonls = match walker::list_jsonl_files(&state.paths.claude.projects_dir) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("无法列出 Claude 项目目录: {}", e);
            vec![]
        }
    };
    for jsonl_path in claude_jsonls {
        match build_claude_session_meta(&jsonl_path, &state, &live_pids) {
            Ok(meta) => out.push(meta),
            Err(e) => log::warn!("解析会话失败 {:?}: {}", jsonl_path, e),
        }
    }

    // 3) 扫 OpenClaw
    if let Some(oc) = &state.paths.openclaw {
        if oc.agents_dir.exists() {
            let agents: Vec<_> = std::fs::read_dir(&oc.agents_dir)
                .map(|d| d.filter_map(|e| e.ok()).collect())
                .unwrap_or_default();
            for agent_dir in agents {
                let sessions_dir = agent_dir.path().join("sessions");
                if !sessions_dir.exists() {
                    continue;
                }
                let agent_id = agent_dir.file_name().to_string_lossy().to_string();
                let oc_jsonls = walker::list_jsonl_files(&sessions_dir).unwrap_or_default();
                for jsonl_path in oc_jsonls {
                    match build_openclaw_session_meta(&jsonl_path, &agent_id) {
                        Ok(meta) => out.push(meta),
                        Err(e) => log::warn!("解析 OpenClaw 会话失败 {:?}: {}", jsonl_path, e),
                    }
                }
            }
        }
    }

    // 按最后更新时间倒序
    out.sort_by_key(|s| std::cmp::Reverse(s.mtime_ms));
    log::info!("list_sessions: 返回 {} 个会话", out.len());
    Ok(out)
}

/// 获取单个会话的元数据
#[tauri::command]
pub async fn get_session_meta(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<SessionMeta> {
    let p = Path::new(&path);
    // 路径安全
    if let Some(parent) = p.parent() {
        if parent.starts_with(&state.paths.claude.projects_dir) {
            paths::assert_within_lexical(&state.paths.claude.projects_dir, p)?;
        } else if let Some(oc) = &state.paths.openclaw {
            if parent.starts_with(&oc.agents_dir) {
                paths::assert_within_lexical(&oc.agents_dir, p)?;
            }
        }
    }

    let live_pids = scan_live_pids(&state.paths.claude.sessions_dir)?;
    if path.contains("openclaw") || path.contains(".openclaw") {
        let agent_id = p
            .ancestors()
            .nth(2)
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        build_openclaw_session_meta(p, &agent_id)
    } else {
        build_claude_session_meta(p, &state, &live_pids)
    }
}

/// 强制刷新 (忽略缓存)
#[tauri::command]
pub async fn refresh_sessions(state: State<'_, Arc<AppState>>) -> AppResult<Vec<SessionMeta>> {
    list_sessions(state).await
}

fn build_claude_session_meta(
    jsonl_path: &Path,
    state: &AppState,
    live_pids: &HashMap<String, u32>,
) -> AppResult<SessionMeta> {
    let meta = std::fs::metadata(jsonl_path)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let session_id = jsonl_path
        .file_stem()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Invalid("无法解析 sessionId".into()))?
        .to_string();

    let project_key = jsonl_path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    // 解析头部 ~50 条提取 quick meta
    let head = jsonl::parse_first_n(jsonl_path, 50).unwrap_or_default();
    let mut first_ts: Option<String> = None;
    let mut last_ts: Option<String> = None;
    let mut custom_title: Option<String> = None;
    let mut ai_title: Option<String> = None;
    let mut message_count: u32 = 0;
    let mut first_user_text: Option<String> = None;
    let mut token_total = TokenUsage::default();
    let mut model_count: HashMap<String, u32> = HashMap::new();

    for v in &head {
        let obj = match v.as_object() {
            Some(o) => o,
            None => continue,
        };
        let r#type = obj.get("type").and_then(|x| x.as_str()).unwrap_or("");

        // 时间戳
        if let Some(ts) = obj.get("timestamp").and_then(|x| x.as_str()) {
            if first_ts.is_none() {
                first_ts = Some(ts.to_string());
            }
            last_ts = Some(ts.to_string());
        }

        match r#type {
            "user" => {
                message_count += 1;
                if first_user_text.is_none() {
                    if let Some(msg) = obj.get("message") {
                        if let Some(content) = msg.get("content") {
                            if let Some(s) = content.as_str() {
                                first_user_text = Some(truncate(s.trim(), 80));
                            } else if let Some(arr) = content.as_array() {
                                for item in arr {
                                    if let Some(text) = item.get("text").and_then(|x| x.as_str()) {
                                        first_user_text = Some(truncate(text.trim(), 80));
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "assistant" => {
                message_count += 1;
                if let Some(msg) = obj.get("message") {
                    if let Some(model) = msg.get("model").and_then(|x| x.as_str()) {
                        *model_count.entry(model.to_string()).or_insert(0) += 1;
                    }
                    if let Some(usage) = msg.get("usage") {
                        token_total.input += usage
                            .get("input_tokens")
                            .and_then(|x| x.as_u64())
                            .unwrap_or(0);
                        token_total.output += usage
                            .get("output_tokens")
                            .and_then(|x| x.as_u64())
                            .unwrap_or(0);
                        token_total.cache_read += usage
                            .get("cache_read_input_tokens")
                            .and_then(|x| x.as_u64())
                            .unwrap_or(0);
                        token_total.cache_write += usage
                            .get("cache_creation_input_tokens")
                            .and_then(|x| x.as_u64())
                            .unwrap_or(0);
                    }
                }
            }
            "custom-title" => {
                if let Some(t) = obj.get("title").and_then(|x| x.as_str()) {
                    custom_title = Some(t.to_string());
                }
            }
            "ai-title" => {
                if let Some(t) = obj.get("title").and_then(|x| x.as_str()) {
                    ai_title = Some(t.to_string());
                }
            }
            _ => {}
        }
    }

    // 完整计数 (可能比 50 多)
    let total = jsonl::count_lines(jsonl_path).unwrap_or(head.len() as u64) as u32;
    let message_count = if total > head.len() as u32 {
        total
    } else {
        message_count.max(total)
    };

    // 主模型 (使用次数最多的)
    let primary_model = model_count
        .into_iter()
        .max_by_key(|(_, c)| *c)
        .map(|(m, _)| m);

    let title = custom_title.or(ai_title).or(first_user_text);
    let live_pid = live_pids.get(&session_id).copied();

    // 子代理目录
    let subagent_dir = jsonl_path
        .with_extension("")
        .join("subagents")
        .exists()
        .then(|| {
            jsonl_path
                .with_extension("")
                .join("subagents")
                .to_string_lossy()
                .to_string()
        });

    let _ = state; // 暂不缓存读取

    Ok(SessionMeta {
        session_id: session_id.clone(),
        project_key: project_key.clone(),
        workspace_guess: Some(decode_workspace_guess(&project_key)),
        source: "claude".to_string(),
        jsonl_path: jsonl_path.to_string_lossy().to_string(),
        size_bytes: meta.len(),
        mtime_ms,
        first_timestamp: first_ts,
        last_timestamp: last_ts,
        message_count,
        title,
        live_pid,
        subagent_dir,
        total_tokens: Some(token_total),
        primary_model,
    })
}

fn build_openclaw_session_meta(jsonl_path: &Path, agent_id: &str) -> AppResult<SessionMeta> {
    let meta = std::fs::metadata(jsonl_path)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let session_id = jsonl_path
        .file_stem()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::Invalid("无法解析 sessionId".into()))?
        .to_string();

    let head = jsonl::parse_first_n(jsonl_path, 50).unwrap_or_default();
    let mut first_ts: Option<String> = None;
    let mut last_ts: Option<String> = None;
    let mut name: Option<String> = None;
    let mut message_count: u32 = 0;
    let mut first_user_text: Option<String> = None;

    for v in &head {
        let obj = match v.as_object() {
            Some(o) => o,
            None => continue,
        };
        let r#type = obj.get("type").and_then(|x| x.as_str()).unwrap_or("");

        if let Some(ts) = obj.get("timestamp").and_then(|x| x.as_str()) {
            if first_ts.is_none() {
                first_ts = Some(ts.to_string());
            }
            last_ts = Some(ts.to_string());
        }

        match r#type {
            "message" => {
                message_count += 1;
                if first_user_text.is_none() {
                    if let Some(msg) = obj.get("message") {
                        if let Some(content) = msg.get("content") {
                            if let Some(s) = content.as_str() {
                                first_user_text = Some(truncate(s.trim(), 80));
                            }
                        }
                    }
                }
            }
            "session_info" => {
                if let Some(n) = obj.get("name").and_then(|x| x.as_str()) {
                    name = Some(n.to_string());
                }
            }
            _ => {}
        }
    }

    let total = jsonl::count_lines(jsonl_path).unwrap_or(head.len() as u64) as u32;
    let message_count = if total > head.len() as u32 {
        total
    } else {
        message_count.max(total)
    };

    Ok(SessionMeta {
        session_id,
        project_key: agent_id.to_string(),
        workspace_guess: None,
        source: "openclaw".to_string(),
        jsonl_path: jsonl_path.to_string_lossy().to_string(),
        size_bytes: meta.len(),
        mtime_ms,
        first_timestamp: first_ts,
        last_timestamp: last_ts,
        message_count,
        title: name.or(first_user_text),
        live_pid: None,
        subagent_dir: None,
        total_tokens: None,
        primary_model: None,
    })
}

fn scan_live_pids(dir: &Path) -> AppResult<HashMap<String, u32>> {
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

fn truncate(s: &str, max: usize) -> String {
    let s = s.replace('\n', " ");
    if s.chars().count() <= max {
        s
    } else {
        let truncated: String = s.chars().take(max).collect();
        format!("{}…", truncated)
    }
}

/// 从 projectKey 推 workspace 路径(与前端保持一致)
fn decode_workspace_guess(project_key: &str) -> String {
    // projectKey 形如 -Users-alice-projects-website
    // 解码为 /Users/alice/projects/website (粗略)
    if !project_key.starts_with('-') {
        return project_key.to_string();
    }
    let stripped = &project_key[1..];
    let decoded = stripped.replace('-', "/");
    format!("/{}", decoded)
}

// 给 live.rs 用
pub fn read_live_pids_meta(dir: &Path) -> AppResult<Vec<LivePidMeta>> {
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
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
                out.push(LivePidMeta {
                    pid,
                    session_id: v
                        .get("sessionId")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    cwd: v
                        .get("cwd")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    status: v
                        .get("status")
                        .and_then(|x| x.as_str())
                        .unwrap_or("unknown")
                        .to_string(),
                    started_at: v.get("startedAt").and_then(|x| x.as_u64()).unwrap_or(0),
                    version: v
                        .get("version")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string()),
                    waiting_for: v
                        .get("waitingFor")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string()),
                });
            }
        }
    }
    Ok(out)
}
