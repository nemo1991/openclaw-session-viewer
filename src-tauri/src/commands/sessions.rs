//! 会话列表与元数据命令

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use serde_json::Value;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::fs::paths;
use crate::fs::source::source_from_path;
use crate::model::{LivePidMeta, SessionMeta, TokenUsage};
use crate::parser::jsonl;
use crate::parser::openclaw_index::SessionsIndexEntry;
use crate::AppState;

// v0.8.10: SessionsIndexEntry / SessionsIndexOrigin 抽到 parser/openclaw_index.rs 共享
// (db/sync.rs::read_agent_info_from_index 之前独立定义一份,Item A 修了 camelCase)
// 这里只保留 alias 跟索引类型。

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
///
/// v0.8.0: 改读 observer.db(由后台 sync_loop 维护)
/// DB 同步完成后,这里就是个纯 SELECT,启动后秒出。
#[tauri::command]
pub async fn list_sessions(state: State<'_, Arc<AppState>>) -> AppResult<Vec<SessionMeta>> {
    list_sessions_inner(&state)
}

/// v0.8.13 item G: list_sessions 的 state-independent body — 可测。
pub(crate) fn list_sessions_inner(state: &Arc<AppState>) -> AppResult<Vec<SessionMeta>> {
    // v0.8.7 C: 纯读, 走 reader pool (跟其它读并发不互锁)
    let rows = state.db.with_read(crate::db::schema::list_all_joined)?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let mut m = r.meta;
        // 注入 override 字段
        m.display_title = r.display_title;
        m.hidden = r.hidden;
        m.pinned = r.pinned;
        m.archived = r.archived;
        m.notes = r.notes;
        m.tags = if r.tag_names.is_empty() {
            None
        } else {
            Some(r.tag_names)
        };
        out.push(m);
    }
    log::info!("list_sessions: 从 DB 返回 {} 个会话", out.len());
    Ok(out)
}

/// 获取单个会话的元数据
///
/// v0.8.0: 优先 DB,fallback 现场解析(防御 DB 损坏或还没同步的新 session)
#[tauri::command]
pub async fn get_session_meta(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> AppResult<SessionMeta> {
    get_session_meta_inner(&path, &state)
}

/// v0.8.13 item G: get_session_meta 的 state-independent body — 可测。
pub(crate) fn get_session_meta_inner(path: &str, state: &Arc<AppState>) -> AppResult<SessionMeta> {
    let p = Path::new(path);

    // 路径安全:遍历所有 root 验证(支持 custom_root)
    paths::assert_within_any_root(&state.paths.read(), p)?;

    // 1) 优先查 DB(joined)
    if let Some(row) = state
        .db
        .with(|c| crate::db::schema::fetch_session_meta_by_path(c, path))?
    {
        let mut m = row.meta;
        m.display_title = row.display_title;
        m.hidden = row.hidden;
        m.pinned = row.pinned;
        m.archived = row.archived;
        m.notes = row.notes;
        m.tags = if row.tag_names.is_empty() {
            None
        } else {
            Some(row.tag_names)
        };
        return Ok(m);
    }

    // 2) Fallback:现场解析(可能在 DB 还没同步的新 session,或者 DB 损坏刚恢复)
    let live_pids = if let Some(c) = state.paths.read().default_root.claude.as_ref() {
        scan_live_pids(&c.sessions_dir).unwrap_or_default()
    } else {
        HashMap::new()
    };

    if path.contains("openclaw") || path.contains(".openclaw") {
        let agent_id = p
            .ancestors()
            .nth(2)
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let sessions_index = read_sessions_index(
            &p.ancestors()
                .nth(1)
                .unwrap_or_else(|| Path::new("/"))
                .join("sessions.json"),
        );
        let (agent_label, agent_channel, agent_target) = agent_info_from_index(&sessions_index);
        build_openclaw_session_meta(p, &agent_id, agent_label, agent_channel, agent_target)
    } else {
        // v0.9.0: kimi 在 fallback 走 build_kimi_session_meta;
        //       claude 仍是兜底
        match source_from_path(path) {
            "kimi" => build_kimi_session_meta_from_path(p, state),
            _ => build_claude_session_meta(p, state, &live_pids),
        }
    }
}

/// 强制刷新 (忽略缓存)
///
/// v0.8.0: 不再走 cache,而是通知后台 sync_loop 重新跑一次,
/// 然后返回 DB 当前结果(可能还是旧数据,sync 跑完后前端会收到 sessions-updated 事件再次刷新)
#[tauri::command]
pub async fn refresh_sessions(state: State<'_, Arc<AppState>>) -> AppResult<Vec<SessionMeta>> {
    refresh_sessions_inner(&state)
}

/// v0.8.13 item G: refresh_sessions 的 state-independent body — 可测。
/// notify sync_loop 重新跑 + 返回当前 DB 快照。
pub(crate) fn refresh_sessions_inner(state: &Arc<AppState>) -> AppResult<Vec<SessionMeta>> {
    state.refresh_requested.notify_waiters();
    list_sessions_inner(state)
}

/// v0.8.13 item B: 流式扫全 jsonl 取 (first_ts, last_ts, message_count)。
///
/// 之前 build_claude_session_meta / build_openclaw_session_meta 用 `parse_first_n(50)`
/// 算 first/last_ts + message_count,长会话的 last_ts 停在 head-only 范围,
/// message_count 被 `jsonl::count_lines()`(raw 行数,含 custom-title/ai-title/
/// file-history-snapshot 等非消息行)覆盖导致系统性偏大。
///
/// 修后用 `for_each_line` 流式扫一遍,只数 `type=user|assistant` (Claude) 或
/// `type=message` (OpenClaw),first_ts 取首条带 timestamp 的记录,last_ts 取末条。
/// token / thinking / tool_use 等 quick meta 仍走 head-only — 那些不用全文件也够准。
pub(crate) fn scan_full_stats(
    jsonl_path: &Path,
    source: &str,
) -> AppResult<(Option<String>, Option<String>, u32)> {
    let mut first: Option<String> = None;
    let mut last: Option<String> = None;
    let mut count: u32 = 0;
    jsonl::for_each_line(jsonl_path, |_, _, v| {
        let obj = match v.as_object() {
            Some(o) => o,
            None => return,
        };
        // v0.9.0: kimi 用 `time`(epoch ms);claude/openclaw 用 `timestamp` 字符串
        let ts_str = if source == "kimi" {
            kimi_timestamp(obj)
        } else {
            obj.get("timestamp")
                .and_then(|x| x.as_str())
                .map(String::from)
        };
        if let Some(ts) = ts_str {
            if first.is_none() {
                first = Some(ts.clone());
            }
            last = Some(ts);
        }
        let ty = obj.get("type").and_then(|x| x.as_str()).unwrap_or("");
        let is_msg = match source {
            "claude" => ty == "user" || ty == "assistant",
            "openclaw" => ty == "message",
            // v0.9.0: kimi 一条 turn = 一个 step.end 事件,或 context.append_message
            "kimi" => {
                ty == "context.append_message"
                    || (ty == "context.append_loop_event"
                        && obj
                            .get("event")
                            .and_then(|e| e.get("type"))
                            .and_then(|t| t.as_str())
                            == Some("step.end"))
            }
            _ => false,
        };
        if is_msg {
            count += 1;
        }
    })?;
    Ok((first, last, count))
}

/// v0.9.3: 扫 kimi wire.jsonl 聚合 `usage.record` 事件。
///
/// 返回 `(Option<TokenUsage>, Option<String>)`:
/// - TokenUsage: 累加 `usageScope=="turn"` 的 4 个字段 (input/output/cache_read/cache_write)
///   跳过 `usageScope=="session"` — 是 cache pool snapshot (~80K 不随时间变),
///   sum 全部会重复计入 cache 池。
/// - primary_model: 首个 usage.record.model (单 model,可作为 fallback)
pub(crate) fn scan_kimi_usage(
    jsonl_path: &Path,
) -> AppResult<(Option<crate::model::TokenUsage>, Option<String>)> {
    let mut input: u64 = 0;
    let mut output: u64 = 0;
    let mut cache_read: u64 = 0;
    let mut cache_write: u64 = 0;
    let mut model: Option<String> = None;
    let mut saw_any: bool = false;

    jsonl::for_each_line(jsonl_path, |_, _, v| {
        let obj = match v.as_object() {
            Some(o) => o,
            None => return,
        };
        if obj.get("type").and_then(|x| x.as_str()) != Some("usage.record") {
            return;
        }
        // v0.9.3: usageScope=='session' 跳过 — 是 cache pool snapshot,
        // 不是 per-turn delta。turn-scope 是确定进出。
        let scope = obj.get("usageScope").and_then(|x| x.as_str()).unwrap_or("");
        if scope != "turn" {
            return;
        }
        saw_any = true;
        if model.is_none() {
            model = obj.get("model").and_then(|x| x.as_str()).map(String::from);
        }
        let u = match obj.get("usage") {
            Some(u) => u,
            None => return,
        };
        input = input.saturating_add(u.get("inputOther").and_then(|x| x.as_u64()).unwrap_or(0));
        output = output.saturating_add(u.get("output").and_then(|x| x.as_u64()).unwrap_or(0));
        cache_read = cache_read.saturating_add(
            u.get("inputCacheRead")
                .and_then(|x| x.as_u64())
                .unwrap_or(0),
        );
        cache_write = cache_write.saturating_add(
            u.get("inputCacheCreation")
                .and_then(|x| x.as_u64())
                .unwrap_or(0),
        );
    })?;

    let usage = if saw_any {
        Some(crate::model::TokenUsage {
            input,
            output,
            cache_read,
            cache_write,
        })
    } else {
        None
    };
    Ok((usage, model))
}

pub(crate) fn build_claude_session_meta(
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

    // 解析头部 ~50 条提取 quick meta (custom_title/ai_title/first_user_text/
    // token_total/model_count/thinking/tool_use/top_tools — 这些 head-only 已够)
    let head = jsonl::parse_first_n(jsonl_path, 50).unwrap_or_default();
    let mut custom_title: Option<String> = None;
    let mut ai_title: Option<String> = None;
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

        // v0.8.13 item B: first_ts / last_ts / message_count 不再在 head-only 累加,
        // 改成后面 scan_full_stats 流式扫全文件 — 长会话的 last_ts 不能停在 head 范围,
        // message_count 不能被 raw count_lines 覆盖(包含非消息行)。

        match r#type {
            "user" => {
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
    // v0.8.4: top 3 -> top 5 (item 2: top_tools_json 复用, 扩大保存范围)
    let top_tools: Vec<String> = tool_pairs.into_iter().take(5).map(|(n, _)| n).collect();

    // v0.8.13 item B: first_ts / last_ts / message_count 用 scan_full_stats 流式扫全文件
    // 之前 head-only 算 last_ts 停在 head 范围,message_count 被 jsonl::count_lines
    // (raw 行数,含 custom-title/ai-title 等非消息行)覆盖导致系统性偏大。
    let (scanned_first, scanned_last, scanned_msg_count) =
        scan_full_stats(jsonl_path, "claude").unwrap_or((None, None, 0));
    let first_ts = scanned_first;
    let last_ts = scanned_last;
    let message_count = scanned_msg_count;

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

    // --- v0.5.0:枚举 subagent_count / subagent_ids ---
    // 用 std::fs::read_dir 直接枚举(O(条目数) μs 级,不开文件)
    // 与下面 SubagentPanel 用 list_subagents 命令结果保持顺序一致
    let (subagent_count, subagent_ids) = match &subagent_dir {
        Some(dir) => {
            let mut ids: Vec<String> = Vec::new();
            if let Ok(rd) = std::fs::read_dir(dir) {
                for entry in rd.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                        continue;
                    }
                    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                        // 文件名形如 agent-<id> → 提取 id
                        let id = stem.strip_prefix("agent-").unwrap_or(stem).to_string();
                        if !ids.contains(&id) {
                            ids.push(id);
                        }
                    }
                }
            }
            ids.sort();
            (
                Some(ids.len() as u32),
                if ids.is_empty() { None } else { Some(ids) },
            )
        }
        None => (None, None),
    };

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
        // Claude session 无 trajectory
        has_trajectory: None,
        trajectory_size_bytes: None,
        // v0.5.0 subagent 关联
        subagent_count,
        subagent_ids,
        // v0.8.0 override 字段默认空(sync 后由后续 query 填充)
        display_title: None,
        hidden: false,
        pinned: false,
        archived: false,
        notes: None,
        tags: None,
        // v0.8.4 item 2: 派生指标由 build_meta_full 二阶段填; quick path 留 None
        error_count: None,
        user_message_count: None,
        assistant_message_count: None,
        duration_seconds: None,
        first_response_latency_ms: None,
        agent_name: None,
        invoked_skills_count: None,
        plan_file_ref_count: None,
        compact_file_ref_count: None,
        queued_command_count: None,
        attached_file_count: None,
        // v0.8.4 item 2': SessionSummaryStrip 全固化
        // quick path 50 行不算这些, 等 enrich 二阶段填
        text_message_count: None,
        tool_usage: None,
        phase_hint: None,
        phase_detail: None,
        repeat_run_count: None,
        repeat_run_max_tool: None,
        repeat_run_max_count: None,
        idle_gap_count: None,
        idle_gap_max_ms: None,
        available_models: None,
        // v0.8.5 A: quick path (50 行头部解析) 不算 per-tool error, 留给 enrich 二阶段
        tool_error: None,
        // v0.8.7 A: quick path 不算 parent_uuids, 留给 enrich 二阶段
        parent_uuids_text: None,
    })
}

pub(crate) fn build_openclaw_session_meta(
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
    let mut name: Option<String> = None;
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

        // v0.8.13 item B: first_ts / last_ts / message_count 改用 scan_full_stats 流式扫全文件

        match r#type {
            "message" => {
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
    // v0.8.4: top 3 -> top 5 (item 2: top_tools_json 复用, 扩大保存范围)
    let top_tools: Vec<String> = tool_pairs.into_iter().take(5).map(|(n, _)| n).collect();

    // v0.8.13 item B: first_ts / last_ts / message_count 用 scan_full_stats 流式扫全文件
    // 之前 OpenClaw 跟 Claude 一样被 jsonl::count_lines (raw 行数) 覆盖 message_count,
    // 长会话 last_ts 停在 head-only 范围。
    let (first_ts, last_ts, message_count) =
        scan_full_stats(jsonl_path, "openclaw").unwrap_or((None, None, 0));

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
        // --- v0.4.0 trajectory 探测 ---
        has_trajectory: detect_trajectory(jsonl_path),
        trajectory_size_bytes: trajectory_size(jsonl_path),
        // v0.5.0:OpenClaw 无 Claude 风格 subagent 机制
        subagent_count: None,
        subagent_ids: None,
        // v0.8.0 override 字段默认空
        display_title: None,
        hidden: false,
        pinned: false,
        archived: false,
        notes: None,
        tags: None,
        // v0.8.4 item 2: 派生指标由 build_meta_full 二阶段填; quick path 留 None
        error_count: None,
        user_message_count: None,
        assistant_message_count: None,
        duration_seconds: None,
        first_response_latency_ms: None,
        agent_name: None,
        invoked_skills_count: None,
        plan_file_ref_count: None,
        compact_file_ref_count: None,
        queued_command_count: None,
        attached_file_count: None,
        // v0.8.4 item 2': SessionSummaryStrip 全固化
        // quick path 50 行不算这些, 等 enrich 二阶段填
        text_message_count: None,
        tool_usage: None,
        phase_hint: None,
        phase_detail: None,
        repeat_run_count: None,
        repeat_run_max_tool: None,
        repeat_run_max_count: None,
        idle_gap_count: None,
        idle_gap_max_ms: None,
        available_models: None,
        // v0.8.5 A: quick path (50 行头部解析) 不算 per-tool error, 留给 enrich 二阶段
        tool_error: None,
        // v0.8.7 A: quick path 不算 parent_uuids, 留给 enrich 二阶段
        parent_uuids_text: None,
    })
}

// === v0.9.0: Kimi Code source — build_kimi_session_meta ===

/// v0.9.0: Kimi state.json 子集 — 用于 build_kimi_session_meta 输入
#[derive(serde::Deserialize, Default, Debug)]
struct KimiStateForMeta {
    #[serde(default)]
    title: Option<String>,
    // kimi state.json 用 camelCase (`workDir` / `lastPrompt`)
    #[serde(default, rename = "workDir")]
    work_dir: Option<String>,
    #[serde(default, rename = "lastPrompt")]
    last_prompt: Option<String>,
    #[serde(default)]
    agents: std::collections::BTreeMap<String, serde_json::Value>,
}

/// v0.9.0: 从 jsonl_path 反查 Kimi session 上下文
///
/// `sync_one_file` 只拿到 jsonl_path,但 build_kimi_session_meta 需要
/// state.json(标题/workDir/agents 列表)。wire.jsonl 在 `<session>/agents/main/wire.jsonl`,
/// state.json 在 `<session>/state.json`,session_dir 在 wire.jsonl 往上 3 级。
pub(crate) fn resolve_kimi_from_jsonl(
    jsonl_path: &Path,
) -> AppResult<crate::fs::walker::KimiSession> {
    // wire.jsonl → agents/main → agents → session_dir
    let session_dir = jsonl_path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or_else(|| AppError::Invalid(format!("kimi path 层级不对: {:?}", jsonl_path)))?
        .to_path_buf();
    let state_json = session_dir.join("state.json");
    let wd_name = session_dir
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let session_id = session_dir
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|s| s.strip_prefix("session_"))
        .unwrap_or("")
        .to_string();
    if session_id.is_empty() {
        return Err(AppError::Invalid(format!(
            "无法解析 kimi sessionId from {:?}",
            session_dir
        )));
    }

    let state: KimiStateForMeta = std::fs::File::open(&state_json)
        .ok()
        .and_then(|f| serde_json::from_reader(f).ok())
        .unwrap_or_default();

    let agents_dir = session_dir.join("agents");
    let mut agent_ids: Vec<String> = if agents_dir.exists() {
        std::fs::read_dir(&agents_dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .filter(|e| e.path().is_dir())
                    .filter_map(|e| e.file_name().to_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    if agent_ids.is_empty() {
        // fallback: 用 state.json 解析的 keys(如果 agents_dir 不存在或读不到)
        agent_ids = state.agents.keys().cloned().collect();
    }
    agent_ids.sort();

    Ok(crate::fs::walker::KimiSession {
        session_dir,
        session_id,
        wd_name,
        main_wire: Some(jsonl_path.to_path_buf()),
        state_json,
        work_dir: state.work_dir,
        title: state.title,
        agent_ids,
    })
}

/// v0.9.0: kimi quick-path fallback — get_session_meta 拿不到 DB 行时,
/// 从 jsonl_path 反查 build。
pub(crate) fn build_kimi_session_meta_from_path(
    jsonl_path: &Path,
    _state: &AppState,
) -> AppResult<SessionMeta> {
    let ks = resolve_kimi_from_jsonl(jsonl_path)?;
    build_kimi_session_meta(&ks)
}

/// v0.9.0: kimi wire.jsonl → SessionMeta
///
/// 字段映射见 v0.9.0 plan §B.2。subagent 计数含 main(跟 OpenClaw 对齐)。
pub(crate) fn build_kimi_session_meta(
    ks: &crate::fs::walker::KimiSession,
) -> AppResult<SessionMeta> {
    let jsonl_path = ks.main_wire.as_ref().ok_or_else(|| {
        AppError::Invalid(format!("kimi session 缺 main wire: {:?}", ks.session_dir))
    })?;
    let meta = std::fs::metadata(jsonl_path)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // 流式扫全文件 — first_ts/last_ts/message_count
    let (first_ts, last_ts, message_count) = scan_full_stats(jsonl_path, "kimi")?;

    // v0.9.3: 聚合 usage.record (turn-scope only) → total_tokens + primary_model fallback
    let (kimi_total_tokens, kimi_model_from_usage) = scan_kimi_usage(jsonl_path)?;

    // quick path 50 行: title / first_prompt / primary_model / thinking/tool_use
    let head = jsonl::parse_first_n(jsonl_path, 50).unwrap_or_default();
    let mut primary_model: Option<String> = None;
    let mut tool_use_count: u32 = 0;
    let mut tool_name_count: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();
    let mut first_prompt: Option<String> = None;

    for v in &head {
        let obj = match v.as_object() {
            Some(o) => o,
            None => continue,
        };
        let ty = obj.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match ty {
            "llm.request" => {
                if primary_model.is_none() {
                    primary_model = obj.get("model").and_then(|x| x.as_str()).map(String::from);
                }
            }
            "config.update" => {
                if primary_model.is_none() {
                    primary_model = obj
                        .get("modelAlias")
                        .and_then(|x| x.as_str())
                        .map(String::from);
                }
            }
            "turn.prompt" => {
                if first_prompt.is_none() {
                    let text = obj
                        .get("input")
                        .and_then(|i| i.as_array())
                        .and_then(|arr| {
                            arr.iter()
                                .find_map(|b| b.get("text").and_then(|t| t.as_str()))
                        })
                        .unwrap_or("");
                    if !text.is_empty() {
                        first_prompt = Some(truncate(text, 80));
                    }
                }
            }
            "context.append_loop_event" => {
                if let Some(ev) = obj.get("event") {
                    if ev.get("type").and_then(|x| x.as_str()) == Some("tool.call") {
                        tool_use_count += 1;
                        if let Some(name) = ev.get("name").and_then(|x| x.as_str()) {
                            *tool_name_count.entry(name.to_string()).or_insert(0) += 1;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let mut tool_pairs: Vec<(String, u32)> = tool_name_count.into_iter().collect();
    tool_pairs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let top_tools: Vec<String> = tool_pairs.into_iter().take(5).map(|(n, _)| n).collect();

    // v0.9.3: head 50 行没拿到 primary_model 时,fallback 到 usage.record.model
    if primary_model.is_none() {
        primary_model = kimi_model_from_usage;
    }

    // title: state.json.title → fallback state.json.lastPrompt → fallback first_prompt
    let state_json_raw: KimiStateForMeta = std::fs::File::open(&ks.state_json)
        .ok()
        .and_then(|f| serde_json::from_reader(f).ok())
        .unwrap_or_default();
    let title = state_json_raw
        .title
        .or(state_json_raw.last_prompt)
        .or_else(|| first_prompt.clone());

    let subagent_dir = if ks.agent_ids.len() > 1 {
        // 含 main + agent-N → 有 subagent
        Some(ks.session_dir.join("agents").to_string_lossy().to_string())
    } else {
        None
    };
    let subagent_count = if subagent_dir.is_some() {
        Some(ks.agent_ids.len() as u32)
    } else {
        None
    };
    let subagent_ids = if ks.agent_ids.is_empty() {
        None
    } else {
        Some(ks.agent_ids.clone())
    };

    Ok(SessionMeta {
        session_id: format!("session_{}", ks.session_id),
        project_key: format!("kimi:{}", ks.wd_name),
        workspace_guess: ks.work_dir.clone(),
        source: "kimi".to_string(),
        jsonl_path: jsonl_path.to_string_lossy().to_string(),
        size_bytes: meta.len(),
        mtime_ms,
        first_timestamp: first_ts.clone(),
        last_timestamp: last_ts.clone(),
        message_count,
        title,
        live_pid: None,
        subagent_dir,
        total_tokens: kimi_total_tokens, // v0.9.3: 聚合 usage.record (turn-scope only)
        primary_model,
        agent_id: Some("main".to_string()),
        agent_label: None,
        agent_channel: None,
        agent_target: None,
        first_prompt: first_prompt.clone(),
        last_message_at: last_ts.clone(),
        thinking_count: None, // quick path 不数 content.part thinking
        tool_use_count: Some(tool_use_count),
        top_tools: if top_tools.is_empty() {
            None
        } else {
            Some(top_tools)
        },
        has_trajectory: None,
        trajectory_size_bytes: None,
        subagent_count,
        subagent_ids,
        display_title: None,
        hidden: false,
        pinned: false,
        archived: false,
        notes: None,
        tags: None,
        // enrich 阶段全 None (meta_extras 早 return for kimi)
        error_count: None,
        user_message_count: None,
        assistant_message_count: None,
        duration_seconds: None,
        first_response_latency_ms: None,
        agent_name: None,
        invoked_skills_count: None,
        plan_file_ref_count: None,
        compact_file_ref_count: None,
        queued_command_count: None,
        attached_file_count: None,
        text_message_count: None,
        tool_usage: None,
        phase_hint: None,
        phase_detail: None,
        repeat_run_count: None,
        repeat_run_max_tool: None,
        repeat_run_max_count: None,
        idle_gap_count: None,
        idle_gap_max_ms: None,
        available_models: None,
        tool_error: None,
        parent_uuids_text: None,
    })
}

/// v0.9.0: scan_full_stats 第三路 — kimi message count
///
/// 一条 turn = 一个 `step.end` 事件;或一条 `context.append_message`(非 loop)。
/// `timestamp` 来自 `time` (epoch ms) 转 rfc3339;回退 `timestamp` 字符串。
fn kimi_timestamp(obj: &serde_json::Map<String, Value>) -> Option<String> {
    obj.get("time")
        .and_then(|v| v.as_i64())
        .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms).map(|dt| dt.to_rfc3339()))
        .or_else(|| {
            obj.get("timestamp")
                .and_then(|v| v.as_str())
                .map(String::from)
        })
}

/// 检测 session 是否有关联 trajectory 文件
/// 优先查 .trajectory-path.json, fallback 同目录 .trajectory.jsonl
fn detect_trajectory(session_path: &Path) -> Option<bool> {
    let stem = session_path.file_stem().and_then(|s| s.to_str())?;
    let dir = session_path.parent()?;
    let pointer = dir.join(format!("{}.trajectory-path.json", stem));
    if pointer.exists() {
        return Some(true);
    }
    let default = dir.join(format!("{}.trajectory.jsonl", stem));
    Some(default.exists())
}

/// trajectory 文件大小(字节),不存在返回 None
fn trajectory_size(session_path: &Path) -> Option<u64> {
    let stem = session_path.file_stem().and_then(|s| s.to_str())?;
    let dir = session_path.parent()?;
    // 优先 pointer 指向的路径
    let pointer = dir.join(format!("{}.trajectory-path.json", stem));
    if pointer.exists() {
        if let Ok(text) = std::fs::read_to_string(&pointer) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(runtime) = v.get("runtimeFile").and_then(|x| x.as_str()) {
                    if let Ok(meta) = std::fs::metadata(runtime) {
                        return Some(meta.len());
                    }
                }
            }
        }
    }
    let default = dir.join(format!("{}.trajectory.jsonl", stem));
    std::fs::metadata(default).ok().map(|m| m.len())
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
    use crate::parser::openclaw_index::SessionsIndexOrigin;
    use std::io::Write;
    use std::path::PathBuf;
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

    // ===== v0.8.13 item B: scan_full_stats + message_count/last_ts 全文件 =====
    //
    // 之前 build_*_session_meta 用 parse_first_n(50) + jsonl::count_lines(),长会话的
    // message_count 被 raw 行数覆盖(包含 custom-title 等非消息行),last_ts 停在 head
    // 范围。修后用 scan_full_stats 流式扫全文件,只数 type=user|assistant。

    /// fixture — 30 user + 30 assistant + 20 custom-title = 80 行 (Claude)
    fn fixture_claude_80_lines() -> String {
        let mut s = String::new();
        // 30 user + 30 assistant 各带 timestamp
        for i in 0..30 {
            s.push_str(&format!(
                r#"{{"type":"user","timestamp":"2026-08-01T10:{:02}:00Z","message":{{"content":"user msg {i}"}}}}
"#,
                i % 60
            ));
        }
        for i in 0..30 {
            s.push_str(&format!(
                r#"{{"type":"assistant","timestamp":"2026-08-01T11:{:02}:00Z","message":{{"model":"claude-fable-5","content":[{{"type":"text","text":"hi {i}"}}],"usage":{{"input_tokens":1,"output_tokens":1}}}}}}
"#,
                i % 60
            ));
        }
        // 20 custom-title 行(不应被计入 message_count)
        for i in 0..20 {
            s.push_str(&format!(
                r#"{{"type":"custom-title","timestamp":"2026-08-01T12:{:02}:00Z","title":"custom title {i}"}}
"#,
                i % 60
            ));
        }
        s
    }

    /// fixture — Claude 80 行,末尾的 custom-title 时间戳最晚
    fn fixture_claude_last_ts_after_head() -> String {
        let mut s = String::new();
        // 60 行 user/assistant + 1 行末尾的 file-history-snapshot(ts 是 12:30)
        for i in 0..30 {
            s.push_str(&format!(
                r#"{{"type":"user","timestamp":"2026-08-01T10:{:02}:00Z","message":{{"content":"u{i}"}}}}
"#,
                i % 60
            ));
        }
        for i in 0..30 {
            s.push_str(&format!(
                r#"{{"type":"assistant","timestamp":"2026-08-01T11:{:02}:00Z","message":{{"content":"a{i}"}}}}
"#,
                i % 60
            ));
        }
        // 末尾 non-message 行带最晚 timestamp (T2)
        s.push_str(
            r#"{"type":"file-history-snapshot","timestamp":"2026-08-01T15:00:00Z","data":{}}"#,
        );
        s
    }

    #[test]
    fn scan_full_stats_claude_counts_only_user_assistant() {
        // v0.8.13 item B: 80 行 fixture (60 msg + 20 custom-title) → message_count=60,
        // 不是 raw count_lines=80。first_ts/last_ts 也对。
        let tmp = NamedTempFile::new().expect("tempfile");
        std::fs::write(tmp.path(), fixture_claude_80_lines()).unwrap();

        let (first, last, count) = scan_full_stats(tmp.path(), "claude").expect("scan");
        assert_eq!(count, 60, "只数 user+assistant,custom-title 不算");
        assert!(first.is_some(), "first_ts 应有值");
        assert!(last.is_some(), "last_ts 应有值");
        // first_ts 是 user msg 0 的 10:00,last_ts 是 assistant msg 29 的 11:29
        assert!(first.as_deref().unwrap().starts_with("2026-08-01T10:"));
        // last_ts 是末尾 custom-title 行 (T12),不是 head-only 范围的 assistant (T11)
        assert!(
            last.as_deref().unwrap().starts_with("2026-08-01T12:"),
            "last_ts 应是末尾 custom-title 行的 12:xx,证明全文件扫描生效"
        );
    }

    #[test]
    fn scan_full_stats_uses_last_record_timestamp() {
        // v0.8.13 item B: 末尾 non-message 行的 timestamp 也算 last_ts (T2=15:00),
        // 之前 head-only 停在 11:29,T2 是用户活跃时间但被忽略。
        let tmp = NamedTempFile::new().expect("tempfile");
        std::fs::write(tmp.path(), fixture_claude_last_ts_after_head()).unwrap();

        let (_first, last, _count) = scan_full_stats(tmp.path(), "claude").expect("scan");
        assert_eq!(
            last.as_deref().unwrap(),
            "2026-08-01T15:00:00Z",
            "last_ts 应是末尾 file-history-snapshot 的 15:00,不是 head-only 的 11:29"
        );
    }

    #[test]
    fn scan_full_stats_openclaw_counts_only_message_type() {
        // v0.8.13 item B: OpenClaw 同 pattern,只数 type=message
        let tmp = NamedTempFile::new().expect("tempfile");
        let content = r#"{"type":"session_info","timestamp":"2026-08-01T09:00:00Z","name":"my session"}
{"type":"message","timestamp":"2026-08-01T09:01:00Z","message":{"content":"hi"}}
{"type":"message","timestamp":"2026-08-01T09:02:00Z","message":{"content":"back"}}
{"type":"progress","timestamp":"2026-08-01T09:03:00Z","data":{}}
"#;
        std::fs::write(tmp.path(), content).unwrap();

        let (first, last, count) = scan_full_stats(tmp.path(), "openclaw").expect("scan");
        assert_eq!(
            count, 2,
            "只数 type=message (2 条),session_info/progress 不算"
        );
        assert_eq!(first.as_deref().unwrap(), "2026-08-01T09:00:00Z");
        assert_eq!(last.as_deref().unwrap(), "2026-08-01T09:03:00Z");
    }

    // ===== v0.8.13 item G: list_sessions / get_session_meta / refresh_sessions inner =====

    /// helper — 构造最小 AppState,跟 db::sync::tests::make_test_state 同 pattern
    fn make_test_state(tmp: &tempfile::TempDir) -> Arc<AppState> {
        use crate::commands::settings::AppSettings;
        use crate::fs::paths::AppPaths;
        let home = tmp.path().to_path_buf();
        let config = tmp.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        let paths = AppPaths::new(home.clone(), &[]);
        let settings = AppSettings::default();
        Arc::new(AppState::new(home, config, paths, settings).expect("new state"))
    }

    /// fixture — 写 jsonl + 跑 sync_once 一次,让 DB 里有 session_meta 行
    fn setup_session_meta(tmp: &tempfile::TempDir) -> Arc<AppState> {
        use crate::db::sync::sync_once_with_sink;
        let state = make_test_state(tmp);
        let project = tmp.path().join(".claude/projects/proj-a");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join("sess-1.jsonl"),
            r#"{"type":"user","timestamp":"2026-08-01T10:00:00Z","message":{"content":"hi"}}
{"type":"assistant","timestamp":"2026-08-01T10:01:00Z","message":{"model":"claude-fable-5","content":[{"type":"text","text":"hello"}]}}
"#,
        )
        .unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            sync_once_with_sink(&state, &crate::db::sync::RecordingSink::new()).await;
        });
        state
    }

    #[test]
    fn list_sessions_inner_returns_db_rows_with_override_injection() {
        // v0.8.13 item G: list_sessions_inner 必须从 DB joined row 注入 override 字段
        // (display_title/hidden/pinned/archived/notes/tags) 到 SessionMeta
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let state = setup_session_meta(&tmp);

        // 写 override: display_title + hidden + pinned + 1 个 tag
        state
            .db
            .with(|c| {
                let tx = c.transaction()?;
                tx.execute(
                    "INSERT INTO session_override
                       (session_id, display_title, hidden, pinned, archived, notes, updated_at)
                     VALUES ('sess-1', 'My Title', 1, 1, 0, 'a note', 0)",
                    [],
                )?;
                tx.execute(
                    "INSERT INTO tag (name, color) VALUES ('urgent', '#ff0000')",
                    [],
                )?;
                tx.execute(
                    "INSERT INTO session_tag (session_id, tag_id)
                     SELECT 'sess-1', id FROM tag WHERE name='urgent'",
                    [],
                )?;
                tx.commit()?;
                Ok::<_, AppError>(())
            })
            .unwrap();

        let out = list_sessions_inner(&state).expect("list_sessions_inner");
        assert_eq!(out.len(), 1, "1 个 session_meta");
        let m = &out[0];
        assert_eq!(m.session_id, "sess-1");
        assert_eq!(
            m.display_title.as_deref(),
            Some("My Title"),
            "override.display_title 注入"
        );
        assert!(m.hidden, "override.hidden 注入");
        assert!(m.pinned, "override.pinned 注入");
        assert!(!m.archived);
        assert_eq!(m.notes.as_deref(), Some("a note"));
        assert_eq!(
            m.tags.as_deref(),
            Some(&vec!["urgent".to_string()][..]),
            "tag_names 注入"
        );
    }

    #[test]
    fn list_sessions_inner_no_override_keeps_defaults() {
        // 没有 override 的 session_meta,list_sessions_inner 必须返 None override 字段
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let state = setup_session_meta(&tmp);

        let out = list_sessions_inner(&state).expect("list_sessions_inner");
        assert_eq!(out.len(), 1);
        let m = &out[0];
        assert!(
            m.display_title.is_none(),
            "无 override → display_title None"
        );
        assert!(!m.hidden);
        assert!(!m.pinned);
        assert!(!m.archived);
        assert!(m.notes.is_none());
        assert!(m.tags.is_none(), "无 tag → tags None (不是空 Vec)");
    }

    #[test]
    fn get_session_meta_inner_db_hit_returns_joined_row() {
        // v0.8.13 item G: DB hit path — fetch_session_meta_by_path 命中时直接返 joined row
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let state = setup_session_meta(&tmp);

        state
            .db
            .with(|c| {
                c.execute(
                    "INSERT INTO session_override
                       (session_id, display_title, hidden, pinned, archived, notes, updated_at)
                     VALUES ('sess-1', 'From DB', 0, 0, 0, '', 0)",
                    [],
                )?;
                Ok::<_, AppError>(())
            })
            .unwrap();

        // 直接按 jsonl_path 命中
        let path = tmp.path().join(".claude/projects/proj-a/sess-1.jsonl");
        let path_str = path.to_string_lossy().to_string();
        let m = get_session_meta_inner(&path_str, &state).expect("get_session_meta_inner");
        assert_eq!(m.session_id, "sess-1");
        assert_eq!(m.display_title.as_deref(), Some("From DB"));
    }

    #[test]
    fn get_session_meta_inner_path_outside_roots_rejected() {
        // v0.8.13 item G: 路径安全校验 — 必须在 Claude/OpenClaw root 下
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let state = setup_session_meta(&tmp);

        // /etc/passwd 不在任何 root 下
        let m = get_session_meta_inner("/etc/passwd", &state);
        assert!(m.is_err(), "path outside roots 应被拒绝");
    }

    #[test]
    fn refresh_sessions_inner_notifies_and_returns_list() {
        // v0.8.13 item G: refresh_sessions_inner 必须 notify + 返当前 snapshot
        let tmp = tempfile::TempDir::new().expect("tempdir");
        let state = setup_session_meta(&tmp);

        let out = refresh_sessions_inner(&state).expect("refresh_sessions_inner");
        assert_eq!(out.len(), 1, "notify 后返当前 DB snapshot");
        assert_eq!(out[0].session_id, "sess-1");
        // notify_waiters 是即时唤醒;这里没阻塞 awaiter,所以无需 await。
        // 我们只验证 API 路径 + 结果契约,notify 副作用由 sync_loop 测试覆盖。
    }

    // ===== v0.9.0: Kimi build/scan tests =====

    /// 临时建一个 kimi session 目录:state.json + agents/main/wire.jsonl + agents/agent-N
    fn make_kimi_session(
        tmp: &tempfile::TempDir,
        wd_name: &str,
        session_id: &str,
        with_subagents: bool,
    ) -> (PathBuf, PathBuf) {
        let sess_dir = tmp
            .path()
            .join(wd_name)
            .join(format!("session_{session_id}"));
        std::fs::create_dir_all(sess_dir.join("agents").join("main")).unwrap();
        std::fs::create_dir_all(sess_dir.join("agents").join("agent-0")).unwrap();
        std::fs::write(
            sess_dir.join("state.json"),
            r#"{"createdAt":"2026-07-21T09:16:40.225Z","updatedAt":"2026-07-21T09:16:51.196Z","title":"kimi test session","isCustomTitle":false,"agents":{"main":{"type":"main","parentAgentId":null}},"workDir":"C:/Users/dc/test","lastPrompt":"hello"}"#,
        ).unwrap();
        // 主 agent wire.jsonl (5 行事件,跟 wire-short fixture 形状一致)
        let wire = sess_dir.join("agents").join("main").join("wire.jsonl");
        // 模拟真实 kimi wire.jsonl 形状:loop event 包裹在 context.append_loop_event
        std::fs::write(
            &wire,
            "{}\n{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\",\"time\":1}}\n{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"text\":\"hi\",\"time\":2}}\n{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"time\":3}}\n{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"content\":\"y\"},\"time\":4}\n{\"type\":\"turn.prompt\",\"input\":[{\"type\":\"text\",\"text\":\"next\"}],\"time\":5}\n",
        ).unwrap();
        if with_subagents {
            std::fs::create_dir_all(sess_dir.join("agents").join("agent-1")).unwrap();
        }
        (sess_dir, wire)
    }

    #[test]
    fn build_kimi_session_meta_populates_title_from_state() {
        let tmp = tempfile::tempdir().unwrap();
        let (_sess_dir, wire) = make_kimi_session(&tmp, "wd_alpha", "abc-123", false);
        let ks = crate::fs::walker::KimiSession {
            session_dir: tmp.path().join("wd_alpha").join("session_abc-123"),
            session_id: "abc-123".to_string(),
            wd_name: "wd_alpha".to_string(),
            main_wire: Some(wire.clone()),
            state_json: tmp
                .path()
                .join("wd_alpha")
                .join("session_abc-123")
                .join("state.json"),
            work_dir: Some("C:/Users/dc/test".to_string()),
            title: Some("kimi test session".to_string()),
            agent_ids: vec!["main".to_string()],
        };
        let sm = build_kimi_session_meta(&ks).expect("build kimi");
        assert_eq!(sm.source, "kimi");
        assert_eq!(sm.title.as_deref(), Some("kimi test session"));
        assert_eq!(sm.workspace_guess.as_deref(), Some("C:/Users/dc/test"));
        assert_eq!(sm.session_id, "session_abc-123");
        assert_eq!(sm.project_key, "kimi:wd_alpha");
        assert_eq!(sm.agent_id.as_deref(), Some("main"));
        // 无 subagent → subagent_count/ids 都 None
        assert!(sm.subagent_count.is_none());
        assert!(sm.subagent_dir.is_none());
    }

    #[test]
    fn build_kimi_session_meta_records_subagent_count_including_main() {
        let tmp = tempfile::tempdir().unwrap();
        let (_sess_dir, wire) = make_kimi_session(&tmp, "wd_alpha", "abc-123", true);
        let ks = crate::fs::walker::KimiSession {
            session_dir: tmp.path().join("wd_alpha").join("session_abc-123"),
            session_id: "abc-123".to_string(),
            wd_name: "wd_alpha".to_string(),
            main_wire: Some(wire),
            state_json: tmp
                .path()
                .join("wd_alpha")
                .join("session_abc-123")
                .join("state.json"),
            work_dir: Some("C:/Users/dc/test".to_string()),
            title: Some("kimi test session".to_string()),
            agent_ids: vec![
                "agent-0".to_string(),
                "agent-1".to_string(),
                "main".to_string(),
            ],
        };
        let sm = build_kimi_session_meta(&ks).expect("build kimi");
        // subagent_count = 总数(含 main) = 3,跟 OpenClaw :401-424 对齐
        assert_eq!(sm.subagent_count, Some(3));
        assert!(sm.subagent_dir.is_some());
        assert_eq!(
            sm.subagent_ids,
            Some(vec![
                "agent-0".to_string(),
                "agent-1".to_string(),
                "main".to_string()
            ])
        );
    }

    #[test]
    fn build_kimi_session_meta_skips_sessions_without_main_wire() {
        let ks = crate::fs::walker::KimiSession {
            session_dir: PathBuf::from("/tmp/nonexistent"),
            session_id: "abc-123".to_string(),
            wd_name: "wd_alpha".to_string(),
            main_wire: None,
            state_json: PathBuf::from("/tmp/nonexistent/state.json"),
            work_dir: None,
            title: None,
            agent_ids: vec![],
        };
        let err = build_kimi_session_meta(&ks).unwrap_err();
        assert!(err.to_string().contains("缺 main wire"), "got: {err}");
    }

    #[test]
    fn scan_full_stats_kimi_counts_step_end() {
        let tmp = tempfile::tempdir().unwrap();
        let wire = tmp.path().join("wire.jsonl");
        // 写: 真实 kimi 形状 — step.* 包裹在 context.append_loop_event.event
        std::fs::write(
            &wire,
            "{\"type\":\"metadata\",\"protocol_version\":\"1.4\",\"created_at\":1,\"time\":1700000000000}\n{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\",\"time\":1700000001000}}\n{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"text\":\"x\",\"time\":1700000002000}}\n{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"time\":1700000003000}}\n{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"content\":\"y\"},\"time\":1700000004000}\n{\"type\":\"turn.prompt\",\"input\":[{\"text\":\"z\"}],\"time\":1700000005000}\n",
        ).unwrap();
        let (first, last, count) = scan_full_stats(&wire, "kimi").unwrap();
        // first/last 应来自 epoch ms → rfc3339
        assert!(first.is_some());
        assert!(last.is_some());
        // step.end(在 loop event 里)+ context.append_message = 2 turns
        assert_eq!(count, 2, "step.end + context.append_message = 2 turns");
    }

    #[test]
    fn resolve_kimi_from_jsonl_finds_state_json_4_levels_up() {
        let tmp = tempfile::tempdir().unwrap();
        let (_sess_dir, wire) = make_kimi_session(&tmp, "wd_alpha", "deadbeef", false);
        let ks = resolve_kimi_from_jsonl(&wire).expect("resolve");
        assert_eq!(ks.session_id, "deadbeef");
        assert_eq!(ks.wd_name, "wd_alpha");
        assert!(ks.main_wire.is_some());
        assert!(ks.state_json.exists());
        assert_eq!(ks.work_dir.as_deref(), Some("C:/Users/dc/test"));
    }

    // ===== v0.9.3: scan_kimi_usage tests =====

    /// turn-scope 累加正确;session-scope 跳过;primary_model 取首个
    #[test]
    fn scan_kimi_usage_aggregates_turn_scope_skips_session_scope() {
        // 2 turn + 1 session — 预期只 sum turn 的 2 条
        // turn A: inputOther=100, output=50, inputCacheRead=20, inputCacheCreation=5 → 175
        // turn B: inputOther=200, output=80, inputCacheRead=0,   inputCacheCreation=0 → 280
        // session: inputOther=1000, output=500, inputCacheRead=100, inputCacheCreation=0 → 1600 (跳过)
        let wire = write_temp(
            "{\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":100,\"output\":50,\"inputCacheRead\":20,\"inputCacheCreation\":5},\"usageScope\":\"turn\",\"time\":1}\n\
             {\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":200,\"output\":80,\"inputCacheRead\":0,\"inputCacheCreation\":0},\"usageScope\":\"turn\",\"time\":2}\n\
             {\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":1000,\"output\":500,\"inputCacheRead\":100,\"inputCacheCreation\":0},\"usageScope\":\"session\",\"time\":3}\n",
        );
        let (usage, model) = scan_kimi_usage(wire.path()).expect("scan");
        let u = usage.expect("saw turn records");
        // total = 175 + 280 = 455
        assert_eq!(u.input, 300);
        assert_eq!(u.output, 130);
        assert_eq!(u.cache_read, 20);
        assert_eq!(u.cache_write, 5);
        assert_eq!(model.as_deref(), Some("deepseek-v4-flash"));
    }

    /// 无 usage.record → None (兼容 v0.9.0 老 session)
    #[test]
    fn scan_kimi_usage_returns_none_when_no_records() {
        let wire = write_temp(
            "{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\"}}\n\
             {\"type\":\"context.append_message\",\"message\":{\"role\":\"assistant\"}}\n",
        );
        let (usage, model) = scan_kimi_usage(wire.path()).expect("scan");
        assert!(usage.is_none(), "no usage.record → total_tokens None");
        assert!(model.is_none());
    }

    /// primary_model 在多 model 时取首个
    #[test]
    fn scan_kimi_usage_uses_first_record_model() {
        let wire = write_temp(
            "{\"type\":\"usage.record\",\"model\":\"model-A\",\"usage\":{\"inputOther\":1,\"output\":1,\"inputCacheRead\":0,\"inputCacheCreation\":0},\"usageScope\":\"turn\",\"time\":1}\n\
             {\"type\":\"usage.record\",\"model\":\"model-B\",\"usage\":{\"inputOther\":1,\"output\":1,\"inputCacheRead\":0,\"inputCacheCreation\":0},\"usageScope\":\"turn\",\"time\":2}\n",
        );
        let (_usage, model) = scan_kimi_usage(wire.path()).expect("scan");
        assert_eq!(model.as_deref(), Some("model-A"));
    }

    /// build_kimi_session_meta 集成:total_tokens 透传 usage.record 数字
    #[test]
    fn build_kimi_session_meta_populates_total_tokens_from_usage_record() {
        let tmp = tempfile::tempdir().unwrap();
        let (_sess_dir, wire) = make_kimi_session(&tmp, "wd_alpha", "tok-1", false);
        // 覆盖默认 wire 内容(5 行无 usage.record)→ 写 usage.record 2 条
        std::fs::write(
            &wire,
            "{\"type\":\"llm.request\",\"model\":\"deepseek-v4-flash\",\"time\":1}\n\
             {\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":100,\"output\":50,\"inputCacheRead\":20,\"inputCacheCreation\":5},\"usageScope\":\"turn\",\"time\":2}\n\
             {\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":1000,\"output\":500,\"inputCacheRead\":100,\"inputCacheCreation\":0},\"usageScope\":\"session\",\"time\":3}\n",
        ).unwrap();
        let ks = crate::fs::walker::KimiSession {
            session_dir: tmp.path().join("wd_alpha").join("session_tok-1"),
            session_id: "tok-1".to_string(),
            wd_name: "wd_alpha".to_string(),
            main_wire: Some(wire),
            state_json: tmp
                .path()
                .join("wd_alpha")
                .join("session_tok-1")
                .join("state.json"),
            work_dir: Some("C:/Users/dc/test".to_string()),
            title: Some("kimi test session".to_string()),
            agent_ids: vec!["main".to_string()],
        };
        let sm = build_kimi_session_meta(&ks).expect("build kimi");
        let u = sm.total_tokens.expect("kimi 总 token 应非空");
        // 仅 turn-scope 的 175 累加, session-scope 跳过
        assert_eq!(u.input, 100);
        assert_eq!(u.output, 50);
        assert_eq!(u.cache_read, 20);
        assert_eq!(u.cache_write, 5);
        // primary_model: llm.request.model 优先 (deepseek-v4-flash) — 与 usage.record.model 一致
        assert_eq!(sm.primary_model.as_deref(), Some("deepseek-v4-flash"));
    }
}
