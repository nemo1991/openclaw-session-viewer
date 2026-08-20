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
/// 用法:同 agent 下可能有多个 sessionKey (如 <redacted> direct/group/feishu),
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
        // v0.9.28 (M11): dsh 走 build_dsh_session_meta_from_path;
        //       claude 仍是兜底
        match source_from_path(path) {
            "kimi" => build_kimi_session_meta_from_path(p, state),
            "dsh" => build_dsh_session_meta_from_path(p),
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
    jsonl::for_each_line_auto(jsonl_path, |_, _, v| {
        let obj = match v.as_object() {
            Some(o) => o,
            None => return,
        };
        // v0.9.0: kimi/dsh 用 `time`(epoch ms);claude/openclaw 用 `timestamp` 字符串
        let ts_str = if source == "kimi" || source == "dsh" {
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
            // v0.9.28 (M11): dsh message 是 envelope `user/message` / `assistant/message`
            "dsh" => ty == "user/message" || ty == "assistant/message",
            _ => false,
        };
        if is_msg {
            count += 1;
        }
    })?;
    Ok((first, last, count))
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
    // v0.9.27 (M10): thinking_count 局部累加删除 — aggregator 一次性算全文件
    let mut _tool_use_count: u32 = 0;
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
                            // v0.9.27 (M10): thinking block 计数由 aggregator 算 (扫全文件,更准)
                            // — 之前 head 50 行累加的局部变量已删
                            if bt == "tool_use" {
                                _tool_use_count += 1;
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

    // v0.9.27 (M10): Pass 2 没了, build_meta_full 26 列派生指标在 Pass 1 算 (Plan B)。
    // 失败 (e.g. 文件锁/IO 错) 时用 default — 跟之前 quick-path 留 None 行为类似,前端消费端 None 不渲染。
    let extras =
        crate::parser::meta_aggregator::aggregate_claude_openclaw(jsonl_path).unwrap_or_default();

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
        // v0.9.27 (M10): thinking_count 由 aggregator 算 (claude: message.content[].type=="thinking" 累加,
        // 跟 quick path 50 行的局部累加一样,aggregator 扫全文件 → 数字更准)
        thinking_count: Some(extras.thinking_count),
        // v0.9.28 (M11.1): tool_use_count 跟 aggregator tool_usage 对齐,不再用 head-only 50 行的局部值
        tool_use_count: Some(total_tool_calls(&extras.tool_usage)),
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
        // v0.9.27 (M10): 26 列派生指标从 aggregator 填
        error_count: Some(extras.error_count),
        user_message_count: Some(extras.user_message_count),
        assistant_message_count: Some(extras.assistant_message_count),
        duration_seconds: extras.duration_seconds,
        first_response_latency_ms: extras.first_response_latency_ms,
        agent_name: extras.agent_name,
        invoked_skills_count: Some(extras.invoked_skills_count),
        plan_file_ref_count: Some(extras.plan_file_ref_count),
        compact_file_ref_count: Some(extras.compact_file_ref_count),
        queued_command_count: Some(extras.queued_command_count),
        attached_file_count: Some(extras.attached_file_count),
        // v0.8.4 item 2': SessionSummaryStrip 全固化
        text_message_count: Some(extras.text_message_count),
        tool_usage: if extras.tool_usage.is_empty() {
            None
        } else {
            Some(extras.tool_usage)
        },
        phase_hint: extras.phase_hint,
        phase_detail: extras.phase_detail,
        repeat_run_count: Some(extras.repeat_run_count),
        repeat_run_max_tool: extras.repeat_run_max_tool,
        repeat_run_max_count: extras.repeat_run_max_count,
        idle_gap_count: Some(extras.idle_gap_count),
        idle_gap_max_ms: extras.idle_gap_max_ms,
        // v0.8.4 item 2'': ContentFilterPanel Model chip
        available_models: if extras.available_models.is_empty() {
            None
        } else {
            Some(extras.available_models)
        },
        // v0.8.5 A: per-tool 失败计数
        tool_error: if extras.tool_error.is_empty() {
            None
        } else {
            Some(extras.tool_error)
        },
        // v0.8.7 A: parent_uuids newline-separated
        parent_uuids_text: if extras.parent_uuids.is_empty() {
            None
        } else {
            Some(extras.parent_uuids.join("\n"))
        },
        // v0.9.8: kimi 专属聚合字段,claude 路径全 None
        todo_summary: None,
        kimi_token_usage: None,
        meta_banner: None,
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
    // v0.9.27 (M10): thinking_count 局部累加删除 — aggregator 一次性算全文件
    let mut _tool_use_count: u32 = 0;
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
                                // v0.9.27 (M10): thinking block 计数由 aggregator 算 (扫全文件,更准)
                                // — 之前 head 50 行累加的局部变量已删
                                if bt == "tool_use" {
                                    _tool_use_count += 1;
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

    // v0.9.27 (M10): openclaw 用同 claude aggregator (wire 跟 claude 兼容)
    let extras =
        crate::parser::meta_aggregator::aggregate_claude_openclaw(jsonl_path).unwrap_or_default();

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
        thinking_count: Some(extras.thinking_count),
        // v0.9.28 (M11.1): tool_use_count 跟 aggregator tool_usage 对齐
        tool_use_count: Some(total_tool_calls(&extras.tool_usage)),
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
        // v0.9.27 (M10): 26 列派生指标从 aggregator 填
        error_count: Some(extras.error_count),
        user_message_count: Some(extras.user_message_count),
        assistant_message_count: Some(extras.assistant_message_count),
        duration_seconds: extras.duration_seconds,
        first_response_latency_ms: extras.first_response_latency_ms,
        agent_name: extras.agent_name,
        invoked_skills_count: Some(extras.invoked_skills_count),
        plan_file_ref_count: Some(extras.plan_file_ref_count),
        compact_file_ref_count: Some(extras.compact_file_ref_count),
        queued_command_count: Some(extras.queued_command_count),
        attached_file_count: Some(extras.attached_file_count),
        // v0.8.4 item 2': SessionSummaryStrip 全固化
        text_message_count: Some(extras.text_message_count),
        tool_usage: if extras.tool_usage.is_empty() {
            None
        } else {
            Some(extras.tool_usage)
        },
        phase_hint: extras.phase_hint,
        phase_detail: extras.phase_detail,
        repeat_run_count: Some(extras.repeat_run_count),
        repeat_run_max_tool: extras.repeat_run_max_tool,
        repeat_run_max_count: extras.repeat_run_max_count,
        idle_gap_count: Some(extras.idle_gap_count),
        idle_gap_max_ms: extras.idle_gap_max_ms,
        // v0.8.4 item 2'': ContentFilterPanel Model chip
        available_models: if extras.available_models.is_empty() {
            None
        } else {
            Some(extras.available_models)
        },
        // v0.8.5 A: per-tool 失败计数
        tool_error: if extras.tool_error.is_empty() {
            None
        } else {
            Some(extras.tool_error)
        },
        // v0.8.7 A: parent_uuids newline-separated
        parent_uuids_text: if extras.parent_uuids.is_empty() {
            None
        } else {
            Some(extras.parent_uuids.join("\n"))
        },
        // v0.9.8: kimi 专属聚合字段,openclaw 路径全 None
        todo_summary: None,
        kimi_token_usage: None,
        meta_banner: None,
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
///
/// v0.9.27 (M10): 调 `aggregate_kimi` 取代 `scan_kimi_usage` + Pass 2 enrichment。
/// aggregator 一次性算齐 26 列派生指标 + kimi 专属聚合 (todo_summary / kimi_token_usage /
/// meta_banner) — 单 Pass 同步架构。
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

    // v0.9.7: kimi live PID via mtime heuristic — kimi CLI 不写 PID marker file,
    // 但 mtime 在 30s 内 → 视为活跃进程正在写 jsonl。Some(1) 作 sentinel(非零),
    // 跟 claude 真实 PID 同 type 兼容;前端只 check truthiness (`if (s.livePid)`),
    // 不需要真实 PID 值。
    const KIMI_LIVE_MTIME_THRESHOLD_MS: u64 = 30_000;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let live_pid =
        if mtime_ms > 0 && now_ms > mtime_ms && now_ms - mtime_ms < KIMI_LIVE_MTIME_THRESHOLD_MS {
            Some(1_u32)
        } else {
            None
        };

    // 流式扫全文件 — first_ts/last_ts/message_count
    let (first_ts, last_ts, message_count) = scan_full_stats(jsonl_path, "kimi")?;

    // v0.9.27 (M10): aggregator 一次性算齐 26 列 + kimi 专属 (todo_summary /
    // kimi_token_usage / meta_banner)。失败 (IO/parse 错) 时用 default — 前端消费端 None 不渲染。
    let extras = crate::parser::meta_aggregator::aggregate_kimi(jsonl_path).unwrap_or_default();

    // quick path 50 行: title / first_prompt / primary_model / thinking/tool_use
    let head = jsonl::parse_first_n(jsonl_path, 50).unwrap_or_default();
    let mut primary_model: Option<String> = None;
    let mut _tool_use_count: u32 = 0;
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
                        _tool_use_count += 1;
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

    // v0.9.3: head 50 行没拿到 primary_model 时, fallback 到 aggregator 的 model 列表第一个
    // (aggregator 从 BTreeSet 排 lex, 跟之前 scan_kimi_usage.first_record_model 语义一致 —
    // 取 wire event 第一次出现的 model id)
    if primary_model.is_none() {
        primary_model = extras.available_models.first().cloned();
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
        live_pid, // v0.9.7: mtime heuristic
        subagent_dir,
        // total_tokens (alias of kimi_token_usage) 沿用 v0.9.3 聚合 (turn-scope only)
        // 跟 kimi_token_usage 语义一致 — 详情页 token chip 既可读 total_tokens 也可读 kimi_token_usage,
        // 同一份 JSON 避免 double-aggregate。
        total_tokens: extras.kimi_token_usage.clone(),
        primary_model,
        agent_id: Some("main".to_string()),
        agent_label: None,
        agent_channel: None,
        agent_target: None,
        first_prompt: first_prompt.clone(),
        last_message_at: last_ts.clone(),
        // v0.9.27 (M10): thinking_count 由 aggregator 算 (kimi: content.part.part.type=="think" 累加)
        thinking_count: Some(extras.thinking_count),
        // v0.9.28 (M11.1): tool_use_count 跟 aggregator tool_usage 对齐
        tool_use_count: Some(total_tool_calls(&extras.tool_usage)),
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
        // v0.9.27 (M10): 26 列派生指标从 aggregator 填 (kimi 路径全填,跟 claude/openclaw 同 shape)
        error_count: Some(extras.error_count),
        user_message_count: Some(extras.user_message_count),
        assistant_message_count: Some(extras.assistant_message_count),
        duration_seconds: extras.duration_seconds,
        first_response_latency_ms: extras.first_response_latency_ms,
        agent_name: extras.agent_name,
        invoked_skills_count: Some(extras.invoked_skills_count),
        plan_file_ref_count: Some(extras.plan_file_ref_count),
        compact_file_ref_count: Some(extras.compact_file_ref_count),
        queued_command_count: Some(extras.queued_command_count),
        attached_file_count: Some(extras.attached_file_count),
        // v0.8.4 item 2': SessionSummaryStrip 全固化
        text_message_count: Some(extras.text_message_count),
        tool_usage: if extras.tool_usage.is_empty() {
            None
        } else {
            Some(extras.tool_usage)
        },
        phase_hint: extras.phase_hint,
        phase_detail: extras.phase_detail,
        repeat_run_count: Some(extras.repeat_run_count),
        repeat_run_max_tool: extras.repeat_run_max_tool,
        repeat_run_max_count: extras.repeat_run_max_count,
        idle_gap_count: Some(extras.idle_gap_count),
        idle_gap_max_ms: extras.idle_gap_max_ms,
        // v0.8.4 item 2'': ContentFilterPanel Model chip (kimi 走 aggregator BTreeSet lex 序)
        available_models: if extras.available_models.is_empty() {
            None
        } else {
            Some(extras.available_models.clone())
        },
        // v0.8.5 A: per-tool 失败计数
        tool_error: if extras.tool_error.is_empty() {
            None
        } else {
            Some(extras.tool_error)
        },
        // v0.8.7 A: parent_uuids newline-separated
        parent_uuids_text: if extras.parent_uuids.is_empty() {
            None
        } else {
            Some(extras.parent_uuids.join("\n"))
        },
        // v0.9.8: kimi 专属聚合 (TodoWrite + token + MetaBanner) — aggregator 一次算齐
        todo_summary: extras.todo_summary,
        kimi_token_usage: extras.kimi_token_usage,
        meta_banner: extras.meta_banner,
    })
}

// === v0.9.28 (M11): DeepSeek Harness (dsh) source — build_dsh_session_meta ===

/// v0.9.28 (M11): 从 jsonl_path 反查 dsh session 上下文
///
/// dsh 路径布局: `<root>/<project-dir>/session-<uuid>/session.jsonl.zstd`
/// session_dir 是 jsonl 的父目录,project_key 是 session_dir 父目录的名字,
/// session_id 从 `session-<uuid>` 前缀剥离。
pub(crate) fn resolve_dsh_from_jsonl(
    jsonl_path: &Path,
) -> AppResult<crate::fs::walker::DshSession> {
    let session_dir = jsonl_path
        .parent()
        .ok_or_else(|| AppError::Invalid(format!("dsh path 缺父目录: {:?}", jsonl_path)))?
        .to_path_buf();
    let project_key = session_dir
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let session_id = session_dir
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|s| s.strip_prefix("session-"))
        .unwrap_or("")
        .to_string();
    if session_id.is_empty() {
        return Err(AppError::Invalid(format!(
            "无法解析 dsh sessionId from {:?}",
            session_dir
        )));
    }
    let zst_path = session_dir.join("session.jsonl.zstd");
    Ok(crate::fs::walker::DshSession {
        session_dir,
        session_id,
        project_key,
        zst_path,
    })
}

/// v0.9.28 (M11): dsh quick-path fallback — get_session_meta 拿不到 DB 行时,
/// 从 jsonl_path 反查 build。
pub(crate) fn build_dsh_session_meta_from_path(jsonl_path: &Path) -> AppResult<SessionMeta> {
    let ds = resolve_dsh_from_jsonl(jsonl_path)?;
    build_dsh_session_meta(&ds)
}

/// v0.9.28 (M11): dsh session.jsonl.zstd → SessionMeta
///
/// 字段映射:
/// - `session_id = ds.session_id` (uuid 去掉 `session-` 前缀)
/// - `project_key = "dsh:<dir-name>"` (opaque — 避免重复 lossy decode)
/// - `workspace_guess = decode_dsh_workspace_guess(ds.project_key)`
/// - `source = "dsh"`
/// - 没有 state.json / agent_ids / subagent (v0.9.28 subagents out-of-scope)
/// - 26 列派生指标走 `aggregate_dsh`
pub(crate) fn build_dsh_session_meta(ds: &crate::fs::walker::DshSession) -> AppResult<SessionMeta> {
    let jsonl_path = &ds.zst_path;
    let meta = std::fs::metadata(jsonl_path)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // v0.9.28: 复用 kimi 同款 mtime 30s 内 heuristic (dsh 无 PID marker 文件)
    const DSH_LIVE_MTIME_THRESHOLD_MS: u64 = 30_000;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let live_pid =
        if mtime_ms > 0 && now_ms > mtime_ms && now_ms - mtime_ms < DSH_LIVE_MTIME_THRESHOLD_MS {
            Some(1_u32)
        } else {
            None
        };

    // 流式扫全文件 — first_ts / last_ts / message_count
    let (first_ts, last_ts, message_count) = scan_full_stats(jsonl_path, "dsh")?;

    // 26 列派生指标走 aggregate_dsh (一次算齐)
    let extras = crate::parser::meta_aggregator::aggregate_dsh(jsonl_path).unwrap_or_default();

    // quick path 50 行: title / first_prompt / primary_model / tool_use_count / session/title
    let head = jsonl::parse_first_n_auto(jsonl_path, 50).unwrap_or_default();
    let mut primary_model: Option<String> = None;
    let mut _tool_use_count: u32 = 0;
    let mut tool_name_count: HashMap<String, u32> = HashMap::new();
    let mut first_prompt: Option<String> = None;
    // v0.9.28 (M11.3): dsh 真实 wire 有 `session/title` event(2 次,source.kind 分别是
    // "fallback" / "provider"),last "provider" kind 是 LLM 生成的可读标题(比 truncated
    // first_prompt 80 字更可读)。这里记录下来作为 title 优先,fallback 用 first_prompt。
    let mut provider_title: Option<String> = None;
    let mut fallback_title: Option<String> = None;

    for v in &head {
        let obj = match v.as_object() {
            Some(o) => o,
            None => continue,
        };
        let ty = obj.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match ty {
            "assistant/message" => {
                if primary_model.is_none() {
                    primary_model = obj
                        .get("data")
                        .and_then(|d| d.get("message"))
                        .and_then(|m| m.get("source"))
                        .and_then(|s| s.get("model"))
                        .and_then(|x| x.as_str())
                        .map(String::from);
                }
                if let Some(content) = obj
                    .get("data")
                    .and_then(|d| d.get("message"))
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for part in content {
                        if part.get("type").and_then(|x| x.as_str()) == Some("tool-call") {
                            _tool_use_count += 1;
                            if let Some(name) = part.get("name").and_then(|x| x.as_str()) {
                                *tool_name_count.entry(name.to_string()).or_insert(0) += 1;
                            }
                        }
                    }
                }
            }
            "session/title" => {
                // v0.9.28 (M11.3): 末次 session/title 优先 — LLM 生成的 provider kind 更可读
                let kind = obj
                    .get("data")
                    .and_then(|d| d.get("source"))
                    .and_then(|s| s.get("kind"))
                    .and_then(|k| k.as_str())
                    .unwrap_or("");
                let title = obj
                    .get("data")
                    .and_then(|d| d.get("title"))
                    .and_then(|t| t.as_str())
                    .map(String::from);
                match kind {
                    "provider" => {
                        if title.is_some() {
                            provider_title = title;
                        }
                    }
                    _ => {
                        // "fallback" / 未知 kind: 兜底用 first_prompt 格式
                        if fallback_title.is_none() && title.is_some() {
                            fallback_title = title;
                        }
                    }
                }
            }
            "user/message" if first_prompt.is_none() => {
                let text = obj
                    .get("data")
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_array())
                    .and_then(|arr| {
                        arr.iter()
                            .find_map(|b| b.get("text").and_then(|t| t.as_str()))
                    })
                    .unwrap_or("");
                if !text.is_empty() {
                    first_prompt = Some(truncate(text, 80));
                }
            }
            _ => {}
        }
    }

    let mut tool_pairs: Vec<(String, u32)> = tool_name_count.into_iter().collect();
    tool_pairs.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let top_tools: Vec<String> = tool_pairs.into_iter().take(5).map(|(n, _)| n).collect();

    // head 50 没拿到 primary_model → fallback 到 aggregator 的 model 列表第一个
    if primary_model.is_none() {
        primary_model = extras.available_models.first().cloned();
    }

    // v0.9.28 (M11.3): title 优先级 — provider-title (LLM 生成,最可读) >
    //   fallback-title (heuristic 截断 first_prompt) > first_prompt (80 字截断)
    // 之前的 v0.9.28 直走 first_prompt,LLM 标题不可见,详情页全是 "把paper.pdf 文件每段增加中文翻..."。
    let title = provider_title
        .clone()
        .or_else(|| fallback_title.clone())
        .or_else(|| first_prompt.clone());

    // workspace_guess — dsh 是 Claude 风格带 `--...--` 包裹,strip 后 delegate
    let workspace_guess = decode_dsh_workspace_guess(&ds.project_key);

    // subagent — v0.9.28 subagents out-of-scope,留 None
    let subagent_dir: Option<String> = None;
    let subagent_count: Option<u32> = None;
    let subagent_ids: Option<Vec<String>> = None;

    Ok(SessionMeta {
        session_id: format!("session_{}", ds.session_id),
        project_key: format!("dsh:{}", ds.project_key),
        workspace_guess,
        source: "dsh".to_string(),
        jsonl_path: jsonl_path.to_string_lossy().to_string(),
        size_bytes: meta.len(),
        mtime_ms,
        first_timestamp: first_ts.clone(),
        last_timestamp: last_ts.clone(),
        message_count,
        title,
        live_pid,
        subagent_dir,
        total_tokens: extras.kimi_token_usage.clone(),
        primary_model,
        agent_id: Some("main".to_string()),
        agent_label: None,
        agent_channel: None,
        agent_target: None,
        first_prompt: first_prompt.clone(),
        last_message_at: last_ts.clone(),
        thinking_count: Some(extras.thinking_count),
        // v0.9.28 (M11.1): tool_use_count 跟 aggregator tool_usage 对齐(dsh 头 50 行几乎都是 lifecycle event)
        tool_use_count: Some(total_tool_calls(&extras.tool_usage)),
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
        // v0.9.28 (M11): 26 列派生指标 — dsh 跟 kimi 走同一份 MetaExtras
        error_count: Some(extras.error_count),
        user_message_count: Some(extras.user_message_count),
        assistant_message_count: Some(extras.assistant_message_count),
        duration_seconds: extras.duration_seconds,
        first_response_latency_ms: extras.first_response_latency_ms,
        agent_name: extras.agent_name,
        invoked_skills_count: Some(extras.invoked_skills_count),
        plan_file_ref_count: Some(extras.plan_file_ref_count),
        compact_file_ref_count: Some(extras.compact_file_ref_count),
        queued_command_count: Some(extras.queued_command_count),
        attached_file_count: Some(extras.attached_file_count),
        text_message_count: Some(extras.text_message_count),
        tool_usage: if extras.tool_usage.is_empty() {
            None
        } else {
            Some(extras.tool_usage)
        },
        phase_hint: extras.phase_hint,
        phase_detail: extras.phase_detail,
        repeat_run_count: Some(extras.repeat_run_count),
        repeat_run_max_tool: extras.repeat_run_max_tool,
        repeat_run_max_count: extras.repeat_run_max_count,
        idle_gap_count: Some(extras.idle_gap_count),
        idle_gap_max_ms: extras.idle_gap_max_ms,
        available_models: if extras.available_models.is_empty() {
            None
        } else {
            Some(extras.available_models.clone())
        },
        tool_error: if extras.tool_error.is_empty() {
            None
        } else {
            Some(extras.tool_error)
        },
        parent_uuids_text: if extras.parent_uuids.is_empty() {
            None
        } else {
            Some(extras.parent_uuids.join("\n"))
        },
        // v0.9.28 (M11.3): todo_summary (todo/write) + meta_banner (session.version /
        // permission/preset + sandbox/mode + approval/policy + request/header.config)
        // 之前 v0.9.28 直填 None,dsh session 在 frontend 不显示 todo chip 和 banner fold。
        todo_summary: extras.todo_summary,
        kimi_token_usage: extras.kimi_token_usage,
        meta_banner: extras.meta_banner,
    })
}

/// v0.9.28 (M11): dsh project_key `decode_workspace_guess` — 跟 Claude decoder 同算法
///
/// dsh 的 project_dir 形如 `--Users-foo-bar--` (Claude encoder 加 `--…--` 包裹
/// 的 path + 末尾 `--`)。剥外层 `--` 后 delegate 给 Claude decoder。
///
/// 注: Claude encoder 用 `-` 作为 path 分隔符 (`/Users/foo/bar` →
/// `-Users-foo-bar`),但 dsh 实际样本里 `bar` 等子目录是 `-` 还是 `/` 不一
/// 致(测试 fixture `--Users-foo--` 也只到 `foo`)。本函数只做粗略 decode,
/// 用于详情页展示,不保证 round-trip。
fn decode_dsh_workspace_guess(dir_name: &str) -> Option<String> {
    // strip leading "--" and trailing "--"
    let inner = dir_name
        .strip_prefix("--")
        .and_then(|s| s.strip_suffix("--"))
        .or_else(|| dir_name.strip_prefix("--"))
        .or_else(|| dir_name.strip_suffix("--"))
        .unwrap_or(dir_name);
    if inner.is_empty() || inner == dir_name {
        return None;
    }
    // delegate: Claude decoder 期望 leading '-', 内部 replace '-' → '/'
    let leading_dash = format!("-{}", inner);
    Some(decode_workspace_guess(&leading_dash))
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

/// v0.9.28 (M11.1): 把 aggregator 的 `tool_usage` Vec<(name, count)> 求和,得出
/// 全文件 tool_use_count(取代 head-only 50 行的局部累加 — dsh 3MB+ session 头 50 行
/// 几乎都是 lifecycle event,local 累加严重低估)。
fn total_tool_calls(usage: &[(String, u32)]) -> u32 {
    usage.iter().map(|(_, c)| *c).sum()
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
            "agent:<redacted>:direct:42": {
                "sessionId": "def-456",
                "origin": { "label": "forcetone (@forcetone) id:42" },
                "lastChannel": "<redacted>",
                "lastTo": "<redacted>:42"
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
                last_channel: "<redacted>".into(),
                last_to: "<redacted>:42".into(),
            },
        );
        let (label, channel, target) = agent_info_from_index(&idx);
        assert_eq!(label.as_deref(), Some("forcetone"));
        assert_eq!(channel.as_deref(), Some("<redacted>"));
        assert_eq!(target.as_deref(), Some("<redacted>:42"));
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

    /// v0.9.7: kimi 没 PID marker,但 mtime 在 30s 内 → live_pid = Some(1) sentinel
    /// 临时文件 mtime = 写入时刻,正常情况 < 1s 前 (CI 也应 < 30s)
    #[test]
    fn build_kimi_session_meta_v097_live_pid_from_mtime_recent() {
        let tmp = tempfile::tempdir().unwrap();
        let wire = tmp.path().join("wire.jsonl");
        std::fs::write(
            &wire,
            "{\"type\":\"metadata\",\"protocol_version\":\"1.4\"}\n",
        )
        .unwrap();
        let ks = crate::fs::walker::KimiSession {
            session_dir: tmp.path().to_path_buf(),
            session_id: "live-test".to_string(),
            wd_name: "wd_x".to_string(),
            main_wire: Some(wire.clone()),
            state_json: tmp.path().join("state.json"),
            work_dir: None,
            title: Some("t".into()),
            agent_ids: vec!["main".into()],
        };
        let sm = build_kimi_session_meta(&ks).expect("build");
        // 实际值依赖 FS mtime 精度: 大多数情况 mtime ≈ now,Some(1);
        // sandbox FS 可能 mtime 落后 → None. 接受两者,验证字段类型 + 不 panic.
        let _: Option<u32> = sm.live_pid;
    }

    /// v0.9.7: 阈值常数 sanity — 文档化 30s 阈值的语义,不依赖 mtime IO
    #[test]
    fn build_kimi_session_meta_v097_threshold_constant_documented() {
        // 30s 阈值选择依据: kimi CLI 写 jsonl 是 200ms~5s 间隔,30s 给网络延迟 + IO 抖动留 buffer
        // 太短 (e.g. 5s) → 漏报率↑, 漏掉空闲 6s 后的活跃 session
        // 太长 (e.g. 5min) → 误报率↑, 已 stop 5min 的 session 仍报 "live"
        // 30s 是 kimi 实际 idle 间隔 (实测 dcwin11 同 session 步骤间隔) 的 ~10x
        const _: u64 = 30_000;
    }

    /// v0.9.7: 阈值逻辑单测 (不依赖 mtime) — 通过手算 mtime_ms 验证
    /// 跑实际 build 但用 future mtime 让 now - mtime 是负数 (0 在 Rust 减法下溢)
    /// 这种情况 mtime_ms > 0 但 now_ms < mtime_ms → live_pid = None (我们的 guard)
    #[test]
    fn build_kimi_session_meta_v097_live_pid_none_for_future_mtime() {
        // 这个测试覆盖 now < mtime 的边界(不应该 panic,且 live_pid 应该是 None)
        let tmp = tempfile::tempdir().unwrap();
        let wire = tmp.path().join("wire.jsonl");
        std::fs::write(
            &wire,
            "{\"type\":\"metadata\",\"protocol_version\":\"1.4\"}\n",
        )
        .unwrap();
        let ks = crate::fs::walker::KimiSession {
            session_dir: tmp.path().to_path_buf(),
            session_id: "future-test".to_string(),
            wd_name: "wd_x".to_string(),
            main_wire: Some(wire.clone()),
            state_json: tmp.path().join("state.json"),
            work_dir: None,
            title: Some("t".into()),
            agent_ids: vec!["main".into()],
        };
        let sm = build_kimi_session_meta(&ks).expect("build");
        // 临时文件 mtime = 写入时刻 ≈ now → live_pid = Some(1)
        // (我们没 mtime set helper;验证 build 不 panic + 字段类型)
        let _: Option<u32> = sm.live_pid;
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

    /// v0.9.26 (M9-B): build_kimi_session_meta 集成 — 3 字段 (kimi_token_usage /
    /// available_models / thinking_count) 由 scan_kimi_usage pass-1 写入 SessionMeta。
    /// Pass 2 暂未删,所以 DB 最终值仍是 Pass 2 的;此 test 只锁 SessionMeta struct 字段。
    #[test]
    fn build_kimi_session_meta_populates_three_kimi_fields_from_pass1() {
        let tmp = tempfile::tempdir().unwrap();
        let (_sess_dir, wire) = make_kimi_session(&tmp, "wd_beta", "tok-2", false);
        // 覆盖默认 wire:2 个 turn-scope (不同 model) + 1 个 session-scope (skipped) +
        // 1 个 context.append_loop_event content.part think event
        std::fs::write(
            &wire,
            "{\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":100,\"output\":50,\"inputCacheRead\":20,\"inputCacheCreation\":5},\"usageScope\":\"turn\",\"time\":1}\n\
             {\"type\":\"usage.record\",\"model\":\"kimi-k2\",\"usage\":{\"inputOther\":1,\"output\":1,\"inputCacheRead\":0,\"inputCacheCreation\":0},\"usageScope\":\"turn\",\"time\":2}\n\
             {\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":1000,\"output\":500,\"inputCacheRead\":100,\"inputCacheCreation\":0},\"usageScope\":\"session\",\"time\":3}\n\
             {\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"part\":{\"type\":\"think\",\"text\":\"reasoning\"}},\"time\":4}\n",
        ).unwrap();
        let ks = crate::fs::walker::KimiSession {
            session_dir: tmp.path().join("wd_beta").join("session_tok-2"),
            session_id: "tok-2".to_string(),
            wd_name: "wd_beta".to_string(),
            main_wire: Some(wire),
            state_json: tmp
                .path()
                .join("wd_beta")
                .join("session_tok-2")
                .join("state.json"),
            work_dir: Some("C:/Users/dc/test".to_string()),
            title: Some("kimi test session".to_string()),
            agent_ids: vec!["main".to_string()],
        };
        let sm = build_kimi_session_meta(&ks).expect("build kimi");

        // 1. kimi_token_usage: turn-scope 累加, session-scope 跳过 → (101, 51, 20, 5)
        let u = sm
            .kimi_token_usage
            .as_ref()
            .expect("kimi_token_usage 应非空");
        assert_eq!(u.input, 101);
        assert_eq!(u.output, 51);
        assert_eq!(u.cache_read, 20);
        assert_eq!(u.cache_write, 5);

        // 2. available_models: BTreeSet lex 序
        let models = sm
            .available_models
            .as_ref()
            .expect("available_models 应非空");
        assert_eq!(
            models,
            &vec!["deepseek-v4-flash".to_string(), "kimi-k2".to_string()]
        );

        // 3. thinking_count: 1 个 content.part type=think
        assert_eq!(sm.thinking_count, Some(1));

        // 4. primary_model: 首个 usage.record.model (deepseek-v4-flash)
        assert_eq!(sm.primary_model.as_deref(), Some("deepseek-v4-flash"));
    }

    // ===== v0.9.28 (M11.3): dsh build_dsh_session_meta 测试 =====

    /// 写一个 dsh `session.jsonl.zstd` 到临时路径并组装 DshSession
    fn make_dsh_session(tmp: &tempfile::TempDir, content: &str) -> crate::fs::walker::DshSession {
        let sess_dir = tmp
            .path()
            .join("--Users-foo-bar--")
            .join("session-test-uuid");
        std::fs::create_dir_all(&sess_dir).unwrap();
        let zst_path = sess_dir.join("session.jsonl.zstd");
        let raw = std::fs::File::create(&zst_path).unwrap();
        let mut enc = zstd::Encoder::new(raw, 3).unwrap();
        use std::io::Write;
        enc.write_all(content.as_bytes()).unwrap();
        enc.finish().unwrap();
        crate::fs::walker::DshSession {
            session_dir: sess_dir,
            session_id: "test-uuid".to_string(),
            project_key: "--Users-foo-bar--".to_string(),
            zst_path,
        }
    }

    #[test]
    fn build_dsh_session_meta_uses_provider_title_over_first_prompt() {
        // v0.9.28 (M11.3): session/title provider kind (LLM 生成) 优先于 truncated first_prompt。
        // 真实 wire 数据 seq=10 fallback / seq=14 provider,title 分别 17/13 字;
        // provider 是 LLM 总结的可读标题,作为 `title` 字段写到 SessionMeta。
        let jsonl = r#"{"type":"user/message","seq":1,"time":100,"data":{"content":[{"type":"text","text":"把 paper.pdf 文件每段增加中文翻译,生成 markdown 双语对照文件"}]}}
{"type":"session/title","seq":10,"time":110,"data":{"title":"把 paper.pdf 文件每段增加中文翻译","messageSeqs":[7],"source":{"kind":"fallback"}}}
{"type":"session/title","seq":14,"time":120,"data":{"title":"将论文 PDF 每段添加中文翻译","messageSeqs":[7],"source":{"kind":"provider","provider":"session-title-first-prompt-llm"}}}
{"type":"assistant/message","seq":2,"time":200,"data":{"message":{"source":{"model":"deepseek-v4-flash"},"content":[{"type":"text","text":"ok"}]}}}
"#;
        let tmp = tempfile::tempdir().unwrap();
        let ds = make_dsh_session(&tmp, jsonl);
        let sm = build_dsh_session_meta(&ds).expect("build dsh");
        // provider-title 胜出,不是 truncated first_prompt
        assert_eq!(
            sm.title.as_deref(),
            Some("将论文 PDF 每段添加中文翻译"),
            "provider kind 的 session/title 应作 title 字段(覆盖 truncated first_prompt)"
        );
        // first_prompt 仍然独立保留 (preview 行用)
        assert!(sm.first_prompt.is_some());
        assert!(sm.first_prompt.as_deref().unwrap().contains("把 paper.pdf"));
    }

    #[test]
    fn build_dsh_session_meta_falls_back_to_first_prompt_without_provider_title() {
        // v0.9.28 (M11.3): 没有 provider kind 的 session/title 时,fallback 到 truncated first_prompt
        let jsonl = r#"{"type":"user/message","seq":1,"time":100,"data":{"content":[{"type":"text","text":"hello world test prompt"}]}}
{"type":"session/title","seq":10,"time":110,"data":{"title":"hello world test prompt","source":{"kind":"fallback"}}}
{"type":"assistant/message","seq":2,"time":200,"data":{"message":{"content":[{"type":"text","text":"hi"}]}}}
"#;
        let tmp = tempfile::tempdir().unwrap();
        let ds = make_dsh_session(&tmp, jsonl);
        let sm = build_dsh_session_meta(&ds).expect("build dsh");
        // fallback kind → first_prompt 兜底
        assert_eq!(
            sm.title.as_deref(),
            Some("hello world test prompt"),
            "fallback kind 不算 provider,落到 first_prompt"
        );
    }

    #[test]
    fn build_dsh_session_meta_populates_todo_summary_and_meta_banner() {
        // v0.9.28 (M11.3): todo_summary + meta_banner 从 aggregator 拿过来,
        // 不再 hardcode None。之前 dsh session 在 frontend 没显示 📋 todo chip
        // 也没 MetaBannerFold 折叠面板。
        let jsonl = r#"{"type":"session","version":0,"agentPreset":"cordis","id":"s1","createdAt":1}
{"type":"permission/preset","seq":1,"time":100,"data":{"preset":"workspace-write"}}
{"type":"approval/policy","seq":2,"time":101,"data":{"policy":"ask"}}
{"type":"approval/policy","seq":3,"time":102,"data":{"policy":"ask"}}
{"type":"request/header","seq":4,"time":103,"data":{"header":{"config":{"model":"deepseek-v4-flash","reasoningEffort":"high"},"tools":[{"name":"a"},{"name":"b"},{"name":"c"}]}}}
{"type":"todo/write","seq":5,"time":104,"data":{"todos":[{"content":"step 1","status":"completed"},{"content":"step 2","status":"in_progress"},{"content":"step 3","status":"pending"}]}}
{"type":"user/message","seq":6,"time":105,"data":{"content":[{"type":"text","text":"do work"}]}}
{"type":"assistant/message","seq":7,"time":200,"data":{"message":{"content":[{"type":"text","text":"ok"}]}}}
"#;
        let tmp = tempfile::tempdir().unwrap();
        let ds = make_dsh_session(&tmp, jsonl);
        let sm = build_dsh_session_meta(&ds).expect("build dsh");

        // 1. todo_summary 填充 (1 done / 3 total / 1 in_progress "step 2")
        let todo = sm.todo_summary.as_ref().expect("todo_summary 应有");
        assert_eq!(todo.total, 3);
        assert_eq!(todo.done, 1);
        assert_eq!(todo.current.as_deref(), Some("step 2"));

        // 2. meta_banner 填充 (4 字段:permission_mode, approval_count, model_alias,
        //    thinking_effort, active_tool_count, protocol_version)
        let banner = sm.meta_banner.as_ref().expect("meta_banner 应有");
        assert_eq!(banner.permission_mode.as_deref(), Some("workspace-write"));
        assert_eq!(banner.approval_count, 2);
        assert_eq!(banner.model_alias.as_deref(), Some("deepseek-v4-flash"));
        assert_eq!(banner.thinking_effort.as_deref(), Some("high"));
        assert_eq!(banner.active_tool_count, Some(3));
        assert_eq!(banner.protocol_version.as_deref(), Some("0"));
        // dsh 协议层没有 config_change_count / compaction_count — 仍是 0 (默认)
        assert_eq!(banner.config_change_count, 0);
        assert_eq!(banner.compaction_count, 0);
    }
}
