//! 会话列表与元数据命令

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::fs::paths;
use crate::fs::walker;
use crate::model::{LivePidMeta, SessionMeta, TokenUsage};
use crate::parser::jsonl;
use crate::AppState;

/// sessions.json 中的每个 entry (只取必要字段,容错其它大块)
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionsIndexEntry {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    origin: SessionsIndexOrigin,
    #[serde(default)]
    last_channel: String,
    #[serde(default)]
    last_to: String,
}

#[derive(Debug, Default, Deserialize)]
struct SessionsIndexOrigin {
    #[serde(default)]
    label: String,
}

/// sessions.json 索引:sessionId → 元信息
type SessionsIndex = HashMap<String, SessionsIndexEntry>;

/// 读 sessions.json 索引。文件不存在或 JSON 损坏时返回空 HashMap,不报错。
fn read_sessions_index(path: &Path) -> SessionsIndex {
    let mut out = SessionsIndex::new();
    if !path.exists() {
        return out;
    }
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("读取 sessions.json 失败 {:?}: {}", path, e);
            return out;
        }
    };
    let value: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            log::warn!("解析 sessions.json 失败 {:?}: {}", path, e);
            return out;
        }
    };
    let obj = match value.as_object() {
        Some(o) => o,
        None => return out,
    };
    for (_key, entry) in obj {
        if let Ok(parsed) = serde_json::from_value::<SessionsIndexEntry>(entry.clone()) {
            if !parsed.session_id.is_empty() {
                out.insert(parsed.session_id.clone(), parsed);
            }
        }
    }
    out
}

/// 从 sessions.json 索引里取 agent 的"代表性"展示信息(label/channel/target)
/// 用法:同 agent 下可能有多个 sessionKey (如 telegram direct/group/feishu),
/// 这里取 sessions.json 中第一个 entry 的字段作为 agent 默认展示。
fn agent_info_from_index(
    index: &SessionsIndex,
) -> (Option<String>, Option<String>, Option<String>) {
    let Some(first) = index.values().next() else {
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

/// 列出所有 Claude + OpenClaw 会话
#[tauri::command]
pub async fn list_sessions(state: State<'_, Arc<AppState>>) -> AppResult<Vec<SessionMeta>> {
    let mut out = Vec::new();

    // 锁粒度小:只 wrap 路径访问,不要 wrap 整个 list_sessions
    let paths_snapshot = state.paths.read().clone();

    // 1) 先扫 default Claude live pids(只有默认 ~/.claude 有 sessions/<pid>.json 机制)
    let live_pids = if let Some(c) = paths_snapshot.default_root.claude.as_ref() {
        scan_live_pids(&c.sessions_dir).unwrap_or_default()
    } else {
        HashMap::new()
    };

    // 2) 扫所有 Claude 项目目录(default + 每个 custom_root)
    for projects_dir in paths_snapshot.all_claude_projects_dirs() {
        let claude_jsonls = match walker::list_jsonl_files(projects_dir) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("无法列出 Claude 项目目录 {:?}: {}", projects_dir, e);
                continue;
            }
        };
        for jsonl_path in claude_jsonls {
            match build_claude_session_meta(&jsonl_path, &state, &live_pids) {
                Ok(meta) => out.push(meta),
                Err(e) => log::warn!("解析会话失败 {:?}: {}", jsonl_path, e),
            }
        }
    }

    // 3) 扫所有 OpenClaw agents 目录(default + 每个 custom_root)
    for agents_dir in paths_snapshot.all_openclaw_agents_dirs() {
        if !agents_dir.exists() {
            continue;
        }
        let agents: Vec<_> = std::fs::read_dir(agents_dir)
            .map(|d| d.filter_map(|e| e.ok()).collect())
            .unwrap_or_default();
        for agent_dir in agents {
            let sessions_dir = agent_dir.path().join("sessions");
            if !sessions_dir.exists() {
                continue;
            }
            let agent_id = agent_dir.file_name().to_string_lossy().to_string();
            let sessions_index = read_sessions_index(&sessions_dir.join("sessions.json"));
            let (agent_label, agent_channel, agent_target) = agent_info_from_index(&sessions_index);
            let oc_jsonls = walker::list_jsonl_files(&sessions_dir).unwrap_or_default();
            for jsonl_path in oc_jsonls {
                match build_openclaw_session_meta(
                    &jsonl_path,
                    &agent_id,
                    agent_label.clone(),
                    agent_channel.clone(),
                    agent_target.clone(),
                ) {
                    Ok(meta) => out.push(meta),
                    Err(e) => log::warn!("解析 OpenClaw 会话失败 {:?}: {}", jsonl_path, e),
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

    // 路径安全:遍历所有 root 验证(支持 custom_root)
    paths::assert_within_any_root(&state.paths.read(), p)?;

    // live_pids 只来自 default Claude(机制是 ~/.claude/sessions/<pid>.json)
    let live_pids = if let Some(c) = state.paths.read().default_root.claude.as_ref() {
        scan_live_pids(&c.sessions_dir)?
    } else {
        HashMap::new()
    };

    if path.contains("openclaw") || path.contains(".openclaw") {
        // 从路径反推 agentId: <root>/agents/<agentId>/sessions/<id>.jsonl
        let agent_id = p
            .ancestors()
            .nth(2)
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        // 读 agent 的 sessions.json 索引以补 agent 元信息
        let sessions_index = read_sessions_index(
            &p.ancestors()
                .nth(1)
                .unwrap_or_else(|| Path::new("/"))
                .join("sessions.json"),
        );
        let (agent_label, agent_channel, agent_target) = agent_info_from_index(&sessions_index);
        build_openclaw_session_meta(p, &agent_id, agent_label, agent_channel, agent_target)
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
    let mut thinking_count: u32 = 0;
    let mut tool_use_count: u32 = 0;
    let mut tool_name_count: HashMap<String, u32> = HashMap::new();

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
                    // 统计 content 块中的 thinking / tool_use
                    if let Some(arr) = msg.get("content").and_then(|x| x.as_array()) {
                        for item in arr {
                            let bt = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
                            if bt == "thinking" {
                                thinking_count += 1;
                            } else if bt == "tool_use" {
                                tool_use_count += 1;
                                if let Some(name) = item.get("name").and_then(|x| x.as_str()) {
                                    *tool_name_count.entry(name.to_string()).or_insert(0) += 1;
                                }
                            }
                        }
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

    // top 3 工具名(按频次降序,同名并列按字典序)
    let mut tool_pairs: Vec<(String, u32)> = tool_name_count.into_iter().collect();
    tool_pairs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let top_tools: Vec<String> = tool_pairs.into_iter().take(3).map(|(n, _)| n).collect();

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

    let title = custom_title
        .or(ai_title)
        .or_else(|| first_user_text.clone());
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
        first_timestamp: first_ts.clone(),
        last_timestamp: last_ts.clone(),
        message_count,
        title,
        live_pid,
        subagent_dir,
        total_tokens: Some(token_total),
        primary_model,
        agent_id: None,
        agent_label: None,
        agent_channel: None,
        agent_target: None,
        first_prompt: first_user_text.clone(),
        last_message_at: last_ts.clone(),
        thinking_count: Some(thinking_count),
        tool_use_count: Some(tool_use_count),
        top_tools: if top_tools.is_empty() {
            None
        } else {
            Some(top_tools)
        },
    })
}

fn build_openclaw_session_meta(
    jsonl_path: &Path,
    agent_id: &str,
    agent_label: Option<String>,
    agent_channel: Option<String>,
    agent_target: Option<String>,
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

    let head = jsonl::parse_first_n(jsonl_path, 50).unwrap_or_default();
    let mut first_ts: Option<String> = None;
    let mut last_ts: Option<String> = None;
    let mut name: Option<String> = None;
    let mut message_count: u32 = 0;
    let mut first_user_text: Option<String> = None;
    let mut thinking_count: u32 = 0;
    let mut tool_use_count: u32 = 0;
    let mut tool_name_count: HashMap<String, u32> = HashMap::new();

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
                if let Some(msg) = obj.get("message") {
                    if let Some(content) = msg.get("content") {
                        if first_user_text.is_none() {
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
                        // 统计 thinking / tool_use 块
                        if let Some(arr) = content.as_array() {
                            for item in arr {
                                let bt = item.get("type").and_then(|x| x.as_str()).unwrap_or("");
                                if bt == "thinking" {
                                    thinking_count += 1;
                                } else if bt == "tool_use" {
                                    tool_use_count += 1;
                                    if let Some(n) = item.get("name").and_then(|x| x.as_str()) {
                                        *tool_name_count.entry(n.to_string()).or_insert(0) += 1;
                                    }
                                }
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

    // top 3 工具名(按频次)
    let mut tool_pairs: Vec<(String, u32)> = tool_name_count.into_iter().collect();
    tool_pairs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let top_tools: Vec<String> = tool_pairs.into_iter().take(3).map(|(n, _)| n).collect();

    let total = jsonl::count_lines(jsonl_path).unwrap_or(head.len() as u64) as u32;
    let message_count = if total > head.len() as u32 {
        total
    } else {
        message_count.max(total)
    };

    // projectKey 加 "openclaw:" 前缀,避免和 Claude 的 projectKey 冲突
    // (例如 Claude 恰好有 projectKey="main" 的目录)
    let project_key = format!("openclaw:{}", agent_id);

    Ok(SessionMeta {
        session_id,
        project_key,
        workspace_guess: None,
        source: "openclaw".to_string(),
        jsonl_path: jsonl_path.to_string_lossy().to_string(),
        size_bytes: meta.len(),
        mtime_ms,
        first_timestamp: first_ts.clone(),
        last_timestamp: last_ts.clone(),
        message_count,
        title: name.or_else(|| first_user_text.clone()),
        live_pid: None,
        subagent_dir: None,
        total_tokens: None,
        primary_model: None,
        agent_id: Some(agent_id.to_string()),
        agent_label,
        agent_channel,
        agent_target,
        first_prompt: first_user_text,
        last_message_at: last_ts,
        thinking_count: Some(thinking_count),
        tool_use_count: Some(tool_use_count),
        top_tools: if top_tools.is_empty() {
            None
        } else {
            Some(top_tools)
        },
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    /// 写入指定内容到临时文件
    fn write_temp(content: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().expect("create tempfile");
        f.write_all(content.as_bytes()).expect("write");
        f
    }

    #[test]
    fn read_sessions_index_missing_file_returns_empty() {
        let path = Path::new("/nonexistent/sessions.json");
        let idx = read_sessions_index(path);
        assert!(idx.is_empty());
    }

    #[test]
    fn read_sessions_index_parses_known_fields() {
        let json = r#"{
            "agent:main:main": {
                "sessionId": "abc-123",
                "origin": { "label": "Main Agent" },
                "lastChannel": "main",
                "lastTo": "main"
            },
            "agent:telegram:direct:42": {
                "sessionId": "def-456",
                "origin": { "label": "forcetone (@forcetone) id:42" },
                "lastChannel": "telegram",
                "lastTo": "telegram:42"
            }
        }"#;
        let f = write_temp(json);
        let idx = read_sessions_index(f.path());
        assert_eq!(idx.len(), 2);
        assert_eq!(idx.get("abc-123").unwrap().last_channel, "main");
        assert_eq!(
            idx.get("def-456").unwrap().origin.label,
            "forcetone (@forcetone) id:42"
        );
    }

    #[test]
    fn read_sessions_index_ignores_entries_with_missing_session_id() {
        let json = r#"{
            "a": { "lastChannel": "x" },
            "b": { "sessionId": "valid", "lastChannel": "y" }
        }"#;
        let f = write_temp(json);
        let idx = read_sessions_index(f.path());
        assert_eq!(idx.len(), 1);
        assert!(idx.contains_key("valid"));
    }

    #[test]
    fn read_sessions_index_handles_garbage_json() {
        let f = write_temp("not json at all {{");
        let idx = read_sessions_index(f.path());
        assert!(idx.is_empty());
    }

    #[test]
    fn agent_info_from_index_extracts_first_entry() {
        let mut idx = SessionsIndex::new();
        idx.insert(
            "abc".into(),
            SessionsIndexEntry {
                session_id: "abc".into(),
                origin: SessionsIndexOrigin {
                    label: "forcetone".into(),
                },
                last_channel: "telegram".into(),
                last_to: "telegram:42".into(),
            },
        );
        let (label, channel, target) = agent_info_from_index(&idx);
        assert_eq!(label.as_deref(), Some("forcetone"));
        assert_eq!(channel.as_deref(), Some("telegram"));
        assert_eq!(target.as_deref(), Some("telegram:42"));
    }

    #[test]
    fn agent_info_from_index_returns_none_when_empty() {
        let idx = SessionsIndex::new();
        let (label, channel, target) = agent_info_from_index(&idx);
        assert!(label.is_none());
        assert!(channel.is_none());
        assert!(target.is_none());
    }
}
