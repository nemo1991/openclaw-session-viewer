//! v0.8.4 item 2: 派生指标的全量提取
//!
//! 与 `commands/sessions.rs::build_claude_session_meta` (quick path, 50 行)
//! 解耦: 本函数扫整个 jsonl (最多 5000 行) 提取:
//! - error_count
//! - user_message_count / assistant_message_count (排除 isSidechain)
//! - duration_seconds (last_ts - first_ts)
//! - first_response_latency_ms (first assistant - first user)
//! - agent_name (jsonl 里第一个 agent-name envelope 的 agentName)
//! - invoked_skills_count / plan_file_ref_count / compact_file_ref_count
//! - queued_command_count / attached_file_count
//!
//! 返回 MetaExtras, 由 db::sync::sync_once 调 db::schema::enrich_session_meta
//! 写到 session_meta。

use std::path::Path;

use crate::error::AppResult;
use crate::parser::blocks::tool_use::TOOL_USE_ALIASES;
use crate::parser::jsonl;

/// v0.8.4: 单次全量扫描的上限 (5000 行够 saturate 所有指标)
const META_FULL_MAX_LINES: usize = 5000;

/// v0.8.4 item 2': repeat_run 的 minCount(同 frontend `findRepeatRuns(entries, 3)`)
const REPEAT_RUN_MIN: usize = 3;

/// v0.8.4 item 2': idle_gap 的 5 分钟阈值(同 frontend `findIdleGaps(entries, 5*60_000)`)
const IDLE_GAP_THRESHOLD_MS: i64 = 5 * 60 * 1000;

/// 派生指标集合
#[derive(Debug, Default, Clone)]
pub struct MetaExtras {
    pub error_count: u32,
    pub user_message_count: u32,
    pub assistant_message_count: u32,
    pub duration_seconds: Option<u64>,
    pub first_response_latency_ms: Option<u64>,
    pub agent_name: Option<String>,
    pub invoked_skills_count: u32,
    pub plan_file_ref_count: u32,
    pub compact_file_ref_count: u32,
    pub queued_command_count: u32,
    pub attached_file_count: u32,
    // --- v0.8.4 item 2': SessionSummaryStrip 全固化 ---
    /// 文本消息数(user + assistant + tool 角色)
    pub text_message_count: u32,
    /// 全量 tool 分布,按 count 降序
    pub tool_usage: Vec<(String, u32)>,
    /// 阶段提示: "explore" | "implement" | "mixed" | "short"
    pub phase_hint: Option<String>,
    /// 阶段详情,例如 "47% 写操作" / "短 session"
    pub phase_detail: Option<String>,
    /// 相邻 assistant tool_use 同 tool ≥ REPEAT_RUN_MIN 次的 run 段数
    pub repeat_run_count: u32,
    /// 占比最大 run 的 tool name
    pub repeat_run_max_tool: Option<String>,
    /// 占比最大 run 的次数
    pub repeat_run_max_count: Option<u32>,
    /// 相邻 entry ts gap ≥ IDLE_GAP_THRESHOLD_MS 的次数
    pub idle_gap_count: u32,
    /// 最长间隔 ms
    pub idle_gap_max_ms: Option<u64>,
    // --- v0.8.4 item 2'': ContentFilterPanel "Model" 维度 chip 也要从 DB 读 ---
    /// 该 session 出现过的 model id(去重, 字典序),给 availableModels 用
    pub available_models: Vec<String>,
    // --- v0.8.5 A: per-tool 失败计数 ---
    /// tool 名 → 该 tool 的 tool_result.is_error 次数, 按 count 降序。
    /// 跟 `error_count` (message 级) 正交:error_count 数 stop_reason=="error" 的整条 assistant,
    /// tool_error 数 tool_result.is_error==true 的单个 tool 调用失败。
    pub tool_error: Vec<(String, u32)>,
    // --- v0.8.7 A: parent_uuids 列表 (去重) — 给 GraphView ParentUuid edges 用 ---
    pub parent_uuids: Vec<String>,
}

/// 扫 jsonl 全量(或 5000 行上限), 提取派生指标
pub fn build_meta_full(path: &Path) -> AppResult<MetaExtras> {
    let mut out = MetaExtras::default();
    let mut first_user_ts: Option<String> = None;
    let mut first_assistant_ts: Option<String> = None;
    let mut last_ts: Option<String> = None;
    let mut first_ts: Option<String> = None;
    let mut line_idx: usize = 0;
    let mut found_agent_name = false;
    // v0.8.4 item 2': SessionSummaryStrip 全固化的扫描状态
    let mut tool_counts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut model_set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut read_count: u32 = 0;
    let mut write_count: u32 = 0;
    // repeat_run 跟踪 — 跟 frontend findRepeatRuns 算法一致
    let mut current_tool: Option<String> = None;
    let mut current_count: u32 = 0;
    // idle_gap 跟踪
    let mut prev_ts_ms: Option<i64> = None;
    // v0.8.5 A: tool_result 失败追踪 — assistant 扫到 tool_use 时把 id→name 记下来,
    // user 扫到 tool_result.is_error 时查 map 累加 per-tool error count
    let mut tool_use_id_to_name: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut tool_error_counts: std::collections::HashMap<String, u32> =
        std::collections::HashMap::new();
    // v0.8.7 A: parent_uuids 累积 (去重, 每个 session 收集所有 entry 的 parentUuid 引用)
    let mut parent_uuids_set: std::collections::BTreeSet<String> =
        std::collections::BTreeSet::new();

    jsonl::for_each_line(path, |idx, _raw, value| {
        if idx >= META_FULL_MAX_LINES {
            return;
        }
        line_idx = idx;
        let obj = match value.as_object() {
            Some(o) => o,
            None => return,
        };
        let r#type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let is_sidechain = obj
            .get("isSidechain")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let ts = obj
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(String::from);

        // first / last ts (不限 sidechain)
        if let Some(t) = &ts {
            if first_ts.is_none() {
                first_ts = Some(t.clone());
            }
            last_ts = Some(t.clone());
        }

        // v0.8.7 A: 累积所有 entry 的 parentUuid 引用 (Claude 用 parentUuid, OpenClaw 用 parentId)
        // 用 prefix 'oc:' 区分 OpenClaw 的 id (避免跟 Claude 的 UUID 冲突)
        if let Some(p) = obj.get("parentUuid").and_then(|v| v.as_str()) {
            if !p.is_empty() {
                parent_uuids_set.insert(p.to_string());
            }
        }
        if let Some(p) = obj.get("parentId").and_then(|v| v.as_str()) {
            if !p.is_empty() {
                parent_uuids_set.insert(format!("oc:{p}"));
            }
        }

        // idle_gap: 跟当前 prev_ts 比 gap, ≥ 5min 计数 + 更新 max
        if let Some(t) = &ts {
            if let Some(curr_ms) = parse_rfc3339_to_ms(t) {
                if let Some(p) = prev_ts_ms {
                    let delta = curr_ms - p;
                    if delta >= IDLE_GAP_THRESHOLD_MS {
                        out.idle_gap_count += 1;
                        out.idle_gap_max_ms = Some(match out.idle_gap_max_ms {
                            Some(prev) => prev.max(delta as u64),
                            None => delta as u64,
                        });
                    }
                }
                prev_ts_ms = Some(curr_ms);
            }
        }

        match r#type {
            "user" if !is_sidechain => {
                out.user_message_count += 1;
                out.text_message_count += 1;
                if first_user_ts.is_none() {
                    first_user_ts = ts.clone();
                }
                // v0.8.5 A: 扫 user content array 找 tool_result.is_error, 累加 per-tool error
                if let Some(content) = obj
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for item in content {
                        if let Some(item_obj) = item.as_object() {
                            let t = item_obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if t == "tool_result" {
                                let is_error = item_obj
                                    .get("is_error")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(false);
                                if is_error {
                                    if let Some(tool_use_id) =
                                        item_obj.get("tool_use_id").and_then(|v| v.as_str())
                                    {
                                        if let Some(name) = tool_use_id_to_name.get(tool_use_id) {
                                            *tool_error_counts.entry(name.clone()).or_insert(0) +=
                                                1;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            "assistant" if !is_sidechain => {
                out.assistant_message_count += 1;
                out.text_message_count += 1;
                if first_assistant_ts.is_none() {
                    first_assistant_ts = ts.clone();
                }
                // model: assistant.message.model, 给 ContentFilterPanel availableModels 用
                if let Some(m) = obj
                    .get("message")
                    .and_then(|m| m.get("model"))
                    .and_then(|v| v.as_str())
                {
                    model_set.insert(m.to_string());
                }
                // error 判断: stop_reason=="error" 或 message.is_error==true
                let msg = obj.get("message").and_then(|v| v.as_object());
                let stop_reason = msg
                    .and_then(|m| m.get("stop_reason"))
                    .and_then(|v| v.as_str());
                let is_error = obj
                    .get("is_error")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if stop_reason == Some("error") || is_error {
                    out.error_count += 1;
                }
                // tool_use 扫描: 跟 frontend summarizeSession 同款逻辑
                if let Some(content) = msg
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    let mut first_tool: Option<String> = None;
                    for item in content {
                        if let Some(item_obj) = item.as_object() {
                            let t = item_obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if TOOL_USE_ALIASES.contains(&t) {
                                if let Some(name) = item_obj.get("name").and_then(|v| v.as_str()) {
                                    let name = name.to_string();
                                    *tool_counts.entry(name.clone()).or_insert(0) += 1;
                                    // v0.8.5 A: 记 tool_use.id → tool_name, 给后面 user tool_result 反查用
                                    if let Some(id) = item_obj.get("id").and_then(|v| v.as_str()) {
                                        tool_use_id_to_name.insert(id.to_string(), name.clone());
                                    }
                                    // phase 统计
                                    match name.as_str() {
                                        "Read" => read_count += 1,
                                        "Write" | "Edit" => write_count += 1,
                                        _ => {}
                                    }
                                    if first_tool.is_none() {
                                        first_tool = Some(name);
                                    }
                                }
                            }
                        }
                    }
                    // repeat_run 跟踪: 切到新 tool 时 flush, 同 tool 累加
                    if let Some(tool) = first_tool {
                        if Some(&tool) == current_tool.as_ref() {
                            current_count += 1;
                        } else {
                            // flush 旧 run
                            flush_repeat_run(&mut out, &mut current_tool, &mut current_count);
                            current_tool = Some(tool);
                            current_count = 1;
                        }
                    } else {
                        // assistant 但没 tool_use → flush
                        flush_repeat_run(&mut out, &mut current_tool, &mut current_count);
                    }
                } else {
                    // assistant message.content 不是 array → flush
                    flush_repeat_run(&mut out, &mut current_tool, &mut current_count);
                }
            }
            "tool" => {
                // tool role 消息 (tool_result 等) — 算 text_message_count 但不算 repeat_run
                out.text_message_count += 1;
                flush_repeat_run(&mut out, &mut current_tool, &mut current_count);
            }
            "agent-name" if !found_agent_name => {
                if let Some(n) = obj.get("agentName").and_then(|v| v.as_str()) {
                    out.agent_name = Some(n.to_string());
                    found_agent_name = true;
                }
                flush_repeat_run(&mut out, &mut current_tool, &mut current_count);
            }
            "attachment" => {
                if let Some(att) = obj.get("attachment").and_then(|v| v.as_object()) {
                    match att.get("type").and_then(|v| v.as_str()) {
                        Some("invoked_skills") => out.invoked_skills_count += 1,
                        Some("plan_file_reference") => out.plan_file_ref_count += 1,
                        Some("compact_file_reference") => out.compact_file_ref_count += 1,
                        Some("queued_command") => out.queued_command_count += 1,
                        Some("file") => out.attached_file_count += 1,
                        _ => {}
                    }
                }
                flush_repeat_run(&mut out, &mut current_tool, &mut current_count);
            }
            _ => {
                // 其他 type 也算 flush
                flush_repeat_run(&mut out, &mut current_tool, &mut current_count);
            }
        }
    })?;

    // 文件末尾 flush 最后一段 run
    flush_repeat_run(&mut out, &mut current_tool, &mut current_count);

    log::debug!(
        "build_meta_full {} ({} lines): user={} asst={} err={} skills={} plans={} text={} repeat={} idle={}",
        path.display(),
        line_idx,
        out.user_message_count,
        out.assistant_message_count,
        out.error_count,
        out.invoked_skills_count,
        out.plan_file_ref_count,
        out.text_message_count,
        out.repeat_run_count,
        out.idle_gap_count,
    );

    // duration_seconds
    if let (Some(f), Some(l)) = (&first_ts, &last_ts) {
        out.duration_seconds = compute_seconds_between(f, l);
    }
    // first_response_latency_ms
    if let (Some(u), Some(a)) = (&first_user_ts, &first_assistant_ts) {
        out.first_response_latency_ms = compute_ms_between(u, a);
    }
    // tool_usage 按 count 降序
    let mut tool_vec: Vec<(String, u32)> = tool_counts.into_iter().collect();
    tool_vec.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out.tool_usage = tool_vec;
    // v0.8.5 A: tool_error 按 count desc 排 (跟 tool_usage 同 pattern)
    let mut tool_err_vec: Vec<(String, u32)> = tool_error_counts.into_iter().collect();
    tool_err_vec.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out.tool_error = tool_err_vec;
    // v0.8.7 A: parent_uuids BTreeSet 转 Vec (顺序天然)
    out.parent_uuids = parent_uuids_set.into_iter().collect();
    // available_models BTreeSet 已经字典序, 直接转
    out.available_models = model_set.into_iter().collect();
    // phase 启发式 (同 frontend summarizeSession 末尾逻辑)
    let total_file = read_count + write_count;
    let text_msg = out.text_message_count;
    if text_msg < 5 {
        out.phase_hint = Some("short".to_string());
        out.phase_detail = Some("短 session".to_string());
    } else if total_file == 0 {
        out.phase_hint = Some("mixed".to_string());
        out.phase_detail = Some("无文件操作".to_string());
    } else {
        let write_pct = (write_count as f64) / (total_file as f64);
        let read_pct = (read_count as f64) / (total_file as f64);
        if write_pct >= 0.5 {
            out.phase_hint = Some("implement".to_string());
            out.phase_detail = Some(format!("{}% 写操作", (write_pct * 100.0).round() as u32));
        } else if read_pct >= 0.7 {
            out.phase_hint = Some("explore".to_string());
            out.phase_detail = Some(format!("{}% 读操作", (read_pct * 100.0).round() as u32));
        } else {
            out.phase_hint = Some("mixed".to_string());
            out.phase_detail = Some(format!(
                "{}% 读 / {}% 写",
                (read_pct * 100.0).round() as u32,
                (write_pct * 100.0).round() as u32
            ));
        }
    }

    Ok(out)
}

/// flush repeat_run: 计数 +1 当 ≥ minCount; 同时记录 max(run)
fn flush_repeat_run(
    out: &mut MetaExtras,
    current_tool: &mut Option<String>,
    current_count: &mut u32,
) {
    if let Some(tool) = current_tool.take() {
        if *current_count as usize >= REPEAT_RUN_MIN {
            out.repeat_run_count += 1;
            // 记录占比最大 run
            let should_update = match (out.repeat_run_max_tool.as_ref(), out.repeat_run_max_count) {
                (None, _) => true,
                (Some(_), Some(prev)) if *current_count > prev => true,
                _ => false,
            };
            if should_update {
                out.repeat_run_max_tool = Some(tool);
                out.repeat_run_max_count = Some(*current_count);
            }
        }
        *current_count = 0;
    }
}

/// 解析 ISO-8601 时间戳到毫秒(None 当解析失败)
fn parse_rfc3339_to_ms(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// 计算两个 ISO-8601 时间戳的秒差 (l - f)。失败返回 None。
fn compute_seconds_between(first: &str, last: &str) -> Option<u64> {
    let f = chrono::DateTime::parse_from_rfc3339(first).ok()?;
    let l = chrono::DateTime::parse_from_rfc3339(last).ok()?;
    let dur = l.signed_duration_since(f).num_seconds();
    if dur < 0 {
        None
    } else {
        Some(dur as u64)
    }
}

/// 毫秒差 (l - f)
fn compute_ms_between(first: &str, last: &str) -> Option<u64> {
    let f = chrono::DateTime::parse_from_rfc3339(first).ok()?;
    let l = chrono::DateTime::parse_from_rfc3339(last).ok()?;
    let dur = l.signed_duration_since(f).num_milliseconds();
    if dur < 0 {
        None
    } else {
        Some(dur as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_tmp(name: &str, content: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("ocsv_meta_extras_test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        p
    }

    #[test]
    fn builds_basic_extras() {
        let jsonl = r#"{"type":"user","timestamp":"2026-07-08T10:00:00Z","message":{"role":"user","content":"hi"}}
{"type":"assistant","timestamp":"2026-07-08T10:00:05Z","message":{"role":"assistant","content":"hey","stop_reason":"end_turn"}}
{"type":"agent-name","timestamp":"2026-07-08T10:00:06Z","agentName":"test-agent","sessionId":"abc"}
{"type":"assistant","timestamp":"2026-07-08T10:00:10Z","message":{"role":"assistant","content":"oops","stop_reason":"error"}}
{"type":"attachment","timestamp":"2026-07-08T10:00:11Z","attachment":{"type":"invoked_skills","skills":[]}}
{"type":"attachment","timestamp":"2026-07-08T10:00:12Z","attachment":{"type":"plan_file_reference","planFilePath":"/x"}}
{"type":"attachment","timestamp":"2026-07-08T10:00:13Z","attachment":{"type":"file","filename":"/y"}}
{"type":"attachment","timestamp":"2026-07-08T10:00:14Z","attachment":{"type":"queued_command","prompt":"<x>"}}
{"type":"attachment","timestamp":"2026-07-08T10:00:15Z","attachment":{"type":"compact_file_reference","filename":"/z"}}
"#;
        let p = write_tmp("basic.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        assert_eq!(m.user_message_count, 1);
        assert_eq!(m.assistant_message_count, 2);
        assert_eq!(m.error_count, 1);
        assert_eq!(m.agent_name.as_deref(), Some("test-agent"));
        assert_eq!(m.invoked_skills_count, 1);
        assert_eq!(m.plan_file_ref_count, 1);
        assert_eq!(m.attached_file_count, 1);
        assert_eq!(m.queued_command_count, 1);
        assert_eq!(m.compact_file_ref_count, 1);
        assert_eq!(m.duration_seconds, Some(15));
        assert_eq!(m.first_response_latency_ms, Some(5_000));
    }

    #[test]
    fn excludes_sidechain_from_counts() {
        let jsonl = r#"{"type":"user","timestamp":"2026-07-08T10:00:00Z","message":{"role":"user"}}
{"type":"user","timestamp":"2026-07-08T10:00:01Z","isSidechain":true,"message":{"role":"user"}}
{"type":"assistant","timestamp":"2026-07-08T10:00:02Z","isSidechain":true,"message":{"role":"assistant"}}
"#;
        let p = write_tmp("sidechain.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        assert_eq!(m.user_message_count, 1);
        assert_eq!(m.assistant_message_count, 0);
    }

    #[test]
    fn picks_first_agent_name() {
        let jsonl = r#"{"type":"agent-name","agentName":"first","sessionId":"x"}
{"type":"agent-name","agentName":"second","sessionId":"x"}
"#;
        let p = write_tmp("agent_name.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        assert_eq!(m.agent_name.as_deref(), Some("first"));
    }

    #[test]
    fn empty_file_yields_zeros() {
        let p = write_tmp("empty.jsonl", "");
        let m = build_meta_full(&p).unwrap();
        assert_eq!(m.user_message_count, 0);
        assert_eq!(m.assistant_message_count, 0);
        assert_eq!(m.error_count, 0);
        assert!(m.agent_name.is_none());
        assert!(m.duration_seconds.is_none());
        assert!(m.first_response_latency_ms.is_none());
        assert_eq!(m.text_message_count, 0);
        assert!(m.tool_usage.is_empty());
        // 空文件 text_msg=0 < 5 → phase_hint=Some("short")
        assert_eq!(m.phase_hint.as_deref(), Some("short"));
        assert_eq!(m.repeat_run_count, 0);
        assert_eq!(m.idle_gap_count, 0);
    }

    // v0.8.4 item 2' — 8 个新字段
    #[test]
    fn captures_tool_usage_full_distribution() {
        // Bash × 2, Read × 5, Edit × 1
        let jsonl = r#"{"type":"assistant","timestamp":"2026-07-08T10:00:00Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:01Z","message":{"role":"assistant","content":[{"type":"toolUse","name":"Read","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:02Z","message":{"role":"assistant","content":[{"type":"toolUse","name":"Read","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:03Z","message":{"role":"assistant","content":[{"type":"toolUse","name":"Read","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:04Z","message":{"role":"assistant","content":[{"type":"toolCall","name":"Bash","arguments":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:05Z","message":{"role":"assistant","content":[{"type":"function_call","name":"Edit","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:06Z","message":{"role":"assistant","content":[{"type":"toolUse","name":"Read","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:07Z","message":{"role":"assistant","content":[{"type":"toolUse","name":"Read","input":{}}]}}
"#;
        let p = write_tmp("tool_usage.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        // 按 count 降序
        assert_eq!(
            m.tool_usage,
            vec![
                ("Read".to_string(), 5),
                ("Bash".to_string(), 2),
                ("Edit".to_string(), 1),
            ]
        );
    }

    #[test]
    fn phase_hint_implement_when_write_heavy() {
        // Write × 3, Read × 1 → 75% 写 → implement
        let jsonl = r#"{"type":"assistant","timestamp":"2026-07-08T10:00:00Z","message":{"role":"user"}}
{"type":"user","timestamp":"2026-07-08T10:00:01Z","message":{"role":"user"}}
{"type":"assistant","timestamp":"2026-07-08T10:00:02Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:03Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Write","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:04Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:05Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{}}]}}
"#;
        let p = write_tmp("phase_implement.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        assert_eq!(m.phase_hint.as_deref(), Some("implement"));
        assert!(m.phase_detail.as_ref().unwrap().contains("写"));
    }

    #[test]
    fn phase_hint_explore_when_read_heavy() {
        // Read × 4, Write × 0 → 100% 读 → explore
        let jsonl = r#"{"type":"user","timestamp":"2026-07-08T10:00:00Z","message":{"role":"user"}}
{"type":"assistant","timestamp":"2026-07-08T10:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:02Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:03Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:04Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:05Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:06Z","message":{"role":"assistant","content":[]}}
"#;
        let p = write_tmp("phase_explore.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        assert_eq!(m.phase_hint.as_deref(), Some("explore"));
    }

    #[test]
    fn phase_hint_short_when_few_messages() {
        let jsonl = r#"{"type":"user","timestamp":"2026-07-08T10:00:00Z","message":{"role":"user"}}
{"type":"assistant","timestamp":"2026-07-08T10:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}}]}}
"#;
        let p = write_tmp("phase_short.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        assert_eq!(m.phase_hint.as_deref(), Some("short"));
    }

    #[test]
    fn detects_repeat_runs() {
        // 4 个连续 Bash + 1 个 Read,期望 repeat_run_count=1, max=Bash × 4
        let jsonl = r#"{"type":"assistant","timestamp":"2026-07-08T10:00:00Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:02Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:03Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:04Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Read","input":{}}]}}
"#;
        let p = write_tmp("repeat.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        assert_eq!(m.repeat_run_count, 1);
        assert_eq!(m.repeat_run_max_tool.as_deref(), Some("Bash"));
        assert_eq!(m.repeat_run_max_count, Some(4));
    }

    #[test]
    fn detects_idle_gaps_above_5_minutes() {
        // ts gap: 1min, 6min(>5min), 10s — 期望 idle_gap_count=1, max=6min
        let jsonl = r#"{"type":"user","timestamp":"2026-07-08T10:00:00Z","message":{"role":"user"}}
{"type":"assistant","timestamp":"2026-07-08T10:01:00Z","message":{"role":"assistant"}}
{"type":"assistant","timestamp":"2026-07-08T10:07:00Z","message":{"role":"assistant"}}
{"type":"assistant","timestamp":"2026-07-08T10:07:10Z","message":{"role":"assistant"}}
"#;
        let p = write_tmp("idle.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        assert_eq!(m.idle_gap_count, 1);
        assert_eq!(m.idle_gap_max_ms, Some(6 * 60 * 1000));
    }

    #[test]
    fn collects_unique_models_sorted() {
        // 3 个 assistant, 2 个 opus 1 个 sonnet → 字典序 [opus, sonnet]
        let jsonl = r#"{"type":"assistant","timestamp":"2026-07-08T10:00:00Z","message":{"role":"assistant","model":"claude-opus-4","content":[]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:01Z","message":{"role":"assistant","model":"claude-sonnet-5","content":[]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:02Z","message":{"role":"assistant","model":"claude-opus-4","content":[]}}
{"type":"user","timestamp":"2026-07-08T10:00:03Z","message":{"role":"user"}} // user 没 model, 不算
"#;
        let p = write_tmp("models.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        assert_eq!(
            m.available_models,
            vec!["claude-opus-4".to_string(), "claude-sonnet-5".to_string()]
        );
    }

    // v0.8.5 A — tool_result.is_error 累积 + 跟 tool_use.id 关联
    #[test]
    fn captures_tool_error_per_tool() {
        // 2 Bash 成功, 1 Bash 失败, 1 Read 失败 → tool_error = [(Bash,1),(Read,1)]
        let jsonl = r#"{"type":"assistant","timestamp":"2026-07-08T10:00:00Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Bash","input":{}}]}}
{"type":"user","timestamp":"2026-07-08T10:00:01Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"ok","is_error":false}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:02Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_2","name":"Bash","input":{}}]}}
{"type":"user","timestamp":"2026-07-08T10:00:03Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_2","content":"failed","is_error":true}]}}
{"type":"assistant","timestamp":"2026-07-08T10:00:04Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_3","name":"Read","input":{}}]}}
{"type":"user","timestamp":"2026-07-08T10:00:05Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_3","content":"missing","is_error":true}]}}
"#;
        let p = write_tmp("tool_error.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        // tool_error 按 count desc, 字典序 tie-break
        assert_eq!(
            m.tool_error,
            vec![("Bash".to_string(), 1), ("Read".to_string(), 1),]
        );
        // 跟 error_count 正交: error_count 是 message-level, 这里全是 tool-level, error_count=0
        assert_eq!(m.error_count, 0);
        // tool_usage 不受影响
        assert_eq!(
            m.tool_usage,
            vec![("Bash".to_string(), 2), ("Read".to_string(), 1)]
        );
    }

    #[test]
    fn tool_error_unknown_tool_use_id_skipped() {
        // tool_result 引用不存在的 tool_use_id → 不累积, 不 panic
        let jsonl = r#"{"type":"assistant","timestamp":"2026-07-08T10:00:00Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_real","name":"Bash","input":{}}]}}
{"type":"user","timestamp":"2026-07-08T10:00:01Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_orphan","content":"x","is_error":true}]}}
"#;
        let p = write_tmp("tool_error_orphan.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        // tu_orphan 找不到对应 name → 不累加
        assert!(m.tool_error.is_empty());
    }

    // v0.8.7 A — parent_uuids 累积 + 去重
    #[test]
    fn captures_parent_uuids_dedup() {
        // 3 个 entry, 全部 parentUuid 不同 → 应该有 3 个
        let jsonl = r#"{"type":"assistant","timestamp":"2026-07-08T10:00:00Z","parentUuid":"uuid-a","message":{"role":"assistant","content":[]}}
{"type":"user","timestamp":"2026-07-08T10:00:01Z","parentUuid":"uuid-b","message":{"role":"user"}}
{"type":"assistant","timestamp":"2026-07-08T10:00:02Z","parentUuid":"uuid-c","message":{"role":"assistant","content":[]}}
"#;
        let p = write_tmp("parent_uuids.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        assert_eq!(m.parent_uuids, vec!["uuid-a", "uuid-b", "uuid-c"]);
    }

    #[test]
    fn parent_uuids_dedup_and_openclaw_prefix() {
        // 同一 parentUuid 出现两次, dedup + OpenClaw 用 oc: prefix
        let jsonl = r#"{"type":"assistant","timestamp":"2026-07-08T10:00:00Z","parentUuid":"uuid-a","message":{"role":"assistant","content":[]}}
{"type":"user","timestamp":"2026-07-08T10:00:01Z","parentUuid":"uuid-a","message":{"role":"user"}}
{"type":"message","timestamp":"2026-07-08T10:00:02Z","parentId":"uuid-b","message":{"role":"assistant"}}
{"type":"message","timestamp":"2026-07-08T10:00:03Z","parentId":"uuid-b","message":{"role":"assistant"}}
"#;
        let p = write_tmp("parent_uuids_dedup.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        // BTreeSet 字典序 ('oc:' ASCII 96 < 'u' ASCII 117): oc:uuid-b < uuid-a
        assert_eq!(m.parent_uuids, vec!["oc:uuid-b", "uuid-a"]);
    }
}
