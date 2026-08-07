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
use crate::fs::source::source_from_path;
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
    // --- v0.9.5: thinking_count — kimi content.part.part.type=="think" 计数
    // 跟 claude/openclaw path 算 user/assistant.text_message_count 互补:
    // claude/openclaw 暂未拆 thinking/text,统一算 text_message_count;
    // kimi 因为 wire 事件显式区分 `think`/`text` 两个 part,直接统计 think 数。
    pub thinking_count: u32,
}

/// 扫 jsonl 全量(或 5000 行上限), 提取派生指标
pub fn build_meta_full(path: &Path) -> AppResult<MetaExtras> {
    // v0.9.0: kimi wire.jsonl 是事件流而非 message 流,正则按 parentUuid 匹配
    // 的 enrich 算法对 kimi 不适用。跳过,返回默认值 — 用户在详情页看到的是
    // build_kimi_session_meta quick-path 拿到的 phaseHint/textMessageCount 等,
    // repeatRun / idleGap / toolError 等 v0.9.x 再补 kimi 专属 enrich。
    // v0.9.4: 但 tool_usage 聚合(`context.append_loop_event.event.type=='tool.call'`
    // event.name)对 kimi 也适用,够简单,直接算。tool_error 留空 (kimi 无 is_error 事件信号)。
    // v0.9.4: 用 source_from_path 替代 path.contains(".kimi") — 测试 fixture 文件名
    // 可能不含 ".kimi" (e.g. /tmp/kimi_tools.jsonl),但 sync_one_file 传过来时已
    // 经 source= kimi 验证过;这里改用 path substring 是兜底。
    if path.to_string_lossy().contains(".kimi")
        || source_from_path(&path.to_string_lossy()) == "kimi"
    {
        return build_meta_full_kimi(path);
    }
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

        // v0.8.10: 用 CLAUDE_PARENT_KEY / OPENCLAW_PARENT_KEY const (从 parser/claude.rs
        // 和 parser/openclaw.rs 共享), 跟 TOOL_USE_ALIASES 同 pattern — 避免硬编码
        // "parentUuid" / "parentId" 字符串跟其它路径脱节。
        // 用 prefix 'oc:' 区分 OpenClaw 的 id (避免跟 Claude 的 UUID 冲突)
        if let Some(p) = obj
            .get(crate::parser::claude::CLAUDE_PARENT_KEY)
            .and_then(|v| v.as_str())
        {
            if !p.is_empty() {
                parent_uuids_set.insert(p.to_string());
            }
        }
        if let Some(p) = obj
            .get(crate::parser::openclaw::OPENCLAW_PARENT_KEY)
            .and_then(|v| v.as_str())
        {
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
                            // v0.9.6: thinking_count 跨 source 全填 — claude message.content[].type=="thinking"
                            // 累加;openclaw 路径同 pattern 但 OpenClaw wire 没 content[] thinking block
                            // (OpenClaw 走独立 thinking_level_change event, docs/OPENCLAW_SESSION_FORMAT.md:108),
                            // 同循环 0 命中,thinking_count 保持 0,符合预期
                            if t == "thinking" {
                                out.thinking_count += 1;
                            }
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

/// v0.9.5: kimi wire.jsonl 的全量 enrich — 跨 source 跟 claude/openclaw 对齐
/// `MetaExtras` 字段子集。覆盖:
/// - C: `available_models` via `usage.record.model`
/// - D: `thinking_count` via `content.part.part.type=="think"`
/// - E: `duration_seconds` (last - first step.end.time) + `first_response_latency_ms`
///   (first step.end.time - first turn.prompt.time)
/// - A: `error_count` (step.end.finishReason=="error") + `tool_error`
///   (per-tool 计数: step 配 stepUuid → 该 step 内所有 tool.call.uuid → tool name)
/// - B: `repeat_run_count/max_tool/max_count` (consecutive tool.call 同名 ≥ 3,
///   flush 在 step.end 切换) + `idle_gap_count/max_ms` (相邻 step.end.time gap ≥ 5min)
///
/// v0.9.4: 之前只算 tool_usage;其余 enrich 字段 (parent_uuids 等) 暂仍 default。
/// 不依赖 state machine — kimi wire event stream 字段名直接读,不依赖 normalize_kimi_record。
///
/// 注: content.part.part.type 字段值是 "think" (不是 "thinking") — 见
/// fixtures/kimi/wire-with-usage.jsonl 验证。finishReason 在真实 kimi 还有
/// "stop"/"length"/"tool_use" 等,这里只对 "error" 累加,其他当作成功。
fn build_meta_full_kimi(path: &Path) -> AppResult<MetaExtras> {
    use std::collections::{BTreeSet, HashMap};
    let mut out = MetaExtras::default();
    // v0.9.4 + v0.9.5: tool_usage via tool.call.name (per-tool count)
    let mut tool_counts: HashMap<String, u32> = HashMap::new();
    // C: available_models via usage.record.model
    let mut model_set: BTreeSet<String> = BTreeSet::new();
    // E: first/last step.end.time (ms epoch)
    let mut first_step_end_time: Option<i64> = None;
    let mut last_step_end_time: Option<i64> = None;
    // E: first_response_latency = first_step_end.time - first_turn_prompt.time
    let mut first_turn_prompt_time: Option<i64> = None;
    // A: stepUuid -> 该 step 内所有 tool.call.uuid (按 wire 顺序), 用于 step.error → tool.error 反查
    let mut step_to_tool_uuids: HashMap<String, Vec<String>> = HashMap::new();
    let mut tool_uuid_to_name: HashMap<String, String> = HashMap::new();
    let mut tool_error_counts: HashMap<String, u32> = HashMap::new();
    // B: repeat_run 跟踪 (current_tool / current_count, step.end 切时 flush)
    let mut current_tool: Option<String> = None;
    let mut current_count: u32 = 0;
    // B: idle_gap 跟踪 (相邻 step.end.time gap)
    let mut prev_step_end_time: Option<i64> = None;

    crate::parser::jsonl::for_each_line(path, |_idx, _raw, v| {
        let obj = match v.as_object() {
            Some(o) => o,
            None => return,
        };
        let top_type = match obj.get("type").and_then(|x| x.as_str()) {
            Some(t) => t,
            None => return,
        };
        let time = obj.get("time").and_then(|x| x.as_i64());

        match top_type {
            "turn.prompt" => {
                if first_turn_prompt_time.is_none() {
                    first_turn_prompt_time = time;
                }
            }
            "usage.record" => {
                if let Some(m) = obj.get("model").and_then(|x| x.as_str()) {
                    model_set.insert(m.to_string());
                }
            }
            "context.append_loop_event" => {
                let ev = match obj.get("event") {
                    Some(e) => e,
                    None => return,
                };
                let ev_type = ev.get("type").and_then(|x| x.as_str()).unwrap_or("");
                // kimi 把 time 字段放在嵌套 ev 内 (dcwin11 fixture 验证),
                // 跟 turn.prompt/usage.record 不同 — 重新从 ev 顶层读。
                let ev_time = ev.get("time").and_then(|x| x.as_i64());
                match ev_type {
                    "content.part" => {
                        // D: thinking_count — part.type=="think" 累加 (kimi 字段名是 "think" 非 "thinking")
                        if let Some(part) = ev.get("part") {
                            if part.get("type").and_then(|x| x.as_str()) == Some("think") {
                                out.thinking_count += 1;
                            }
                        }
                    }
                    "tool.call" => {
                        let uuid = ev.get("uuid").and_then(|x| x.as_str());
                        let step_uuid = ev.get("stepUuid").and_then(|x| x.as_str());
                        let name = ev.get("name").and_then(|x| x.as_str());
                        if let Some(name) = name {
                            // v0.9.4: tool_usage 累加不依赖 stepUuid/uuid (轻量,只数 name)
                            *tool_counts.entry(name.to_string()).or_insert(0) += 1;
                            // uuid + stepUuid 用于 A: error_count → tool_error 反查 (best-effort,缺则跳过该 tool)
                            if let (Some(uuid), Some(step_uuid)) = (uuid, step_uuid) {
                                step_to_tool_uuids
                                    .entry(step_uuid.to_string())
                                    .or_default()
                                    .push(uuid.to_string());
                                tool_uuid_to_name.insert(uuid.to_string(), name.to_string());
                            }
                            // B: repeat_run tracking — 同一 step 内连续同名累加
                            if Some(name) == current_tool.as_deref() {
                                current_count += 1;
                            } else {
                                flush_repeat_run_kimi(
                                    &mut out,
                                    &mut current_tool,
                                    &mut current_count,
                                );
                                current_tool = Some(name.to_string());
                                current_count = 1;
                            }
                        }
                    }
                    "step.end" => {
                        let step_uuid = ev.get("uuid").and_then(|x| x.as_str()).map(String::from);
                        let finish_reason = ev
                            .get("finishReason")
                            .and_then(|x| x.as_str())
                            .unwrap_or("");
                        if finish_reason == "error" {
                            out.error_count += 1;
                            if let Some(su) = &step_uuid {
                                if let Some(tool_uuids) = step_to_tool_uuids.get(su) {
                                    for tu in tool_uuids {
                                        if let Some(name) = tool_uuid_to_name.get(tu) {
                                            *tool_error_counts.entry(name.clone()).or_insert(0) +=
                                                1;
                                        }
                                    }
                                }
                            }
                        }
                        // B + E: step.end.time → idle_gap + first/last
                        if let Some(t) = ev_time {
                            if first_step_end_time.is_none() {
                                first_step_end_time = Some(t);
                            }
                            last_step_end_time = Some(t);
                            if let Some(prev) = prev_step_end_time {
                                let delta = t - prev;
                                if delta >= IDLE_GAP_THRESHOLD_MS {
                                    out.idle_gap_count += 1;
                                    out.idle_gap_max_ms = Some(match out.idle_gap_max_ms {
                                        Some(p) => p.max(delta as u64),
                                        None => delta as u64,
                                    });
                                }
                            }
                            prev_step_end_time = Some(t);
                        }
                        // step.end flushes repeat_run (跨 step 不算连续)
                        flush_repeat_run_kimi(&mut out, &mut current_tool, &mut current_count);
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    })?;

    // 末尾 flush
    flush_repeat_run_kimi(&mut out, &mut current_tool, &mut current_count);

    // E: duration_seconds
    if let (Some(f), Some(l)) = (first_step_end_time, last_step_end_time) {
        let dur_ms = (l - f).max(0) as u64;
        out.duration_seconds = Some(dur_ms / 1000);
    }
    // E: first_response_latency_ms
    if let (Some(ut), Some(st)) = (first_turn_prompt_time, first_step_end_time) {
        let delta = st - ut;
        if delta > 0 {
            out.first_response_latency_ms = Some(delta as u64);
        }
    }
    // A: tool_error sort desc
    let mut tool_err_vec: Vec<(String, u32)> = tool_error_counts.into_iter().collect();
    tool_err_vec.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out.tool_error = tool_err_vec;
    // tool_usage sort desc (跟 claude 路径同 pattern)
    let mut tool_vec: Vec<(String, u32)> = tool_counts.into_iter().collect();
    tool_vec.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out.tool_usage = tool_vec;
    // C: available_models BTreeSet → Vec (字典序)
    out.available_models = model_set.into_iter().collect();

    Ok(out)
}

/// v0.9.5: kimi 专属 repeat_run flush — 跟 claude 路径的 flush_repeat_run 同算法,
/// 但通过 current_tool 切位 (Option<String>) 隔离命名, 不污染 claude 路径。
fn flush_repeat_run_kimi(
    out: &mut MetaExtras,
    current_tool: &mut Option<String>,
    current_count: &mut u32,
) {
    if let Some(tool) = current_tool.take() {
        if *current_count as usize >= REPEAT_RUN_MIN {
            out.repeat_run_count += 1;
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

    // v0.8.7 A: 边界 — 空字符串 parentUuid/parentId 不入 set (防御 malformed jsonl)
    #[test]
    fn parent_uuids_empty_string_not_collected() {
        let jsonl = r#"{"type":"assistant","timestamp":"2026-07-08T10:00:00Z","parentUuid":"","message":{"role":"assistant","content":[]}}
{"type":"user","timestamp":"2026-07-08T10:00:01Z","parentId":"","message":{"role":"user"}}
{"type":"assistant","timestamp":"2026-07-08T10:00:02Z","parentUuid":"real-uuid","message":{"role":"assistant","content":[]}}
"#;
        let p = write_tmp("parent_uuids_empty.jsonl", jsonl);
        let m = build_meta_full(&p).unwrap();
        // 两个空字符串不入集合, 只留真实那个
        assert_eq!(m.parent_uuids, vec!["real-uuid"]);
    }

    // v0.8.10: 锁住 PARENT_KEY const 值 — 改了 const 必然要更新 build_meta_full 引用
    // (跟 TOOL_USE_ALIASES 测试同 pattern)
    #[test]
    fn parent_key_const_values_locked() {
        use crate::parser::claude::CLAUDE_PARENT_KEY;
        use crate::parser::openclaw::OPENCLAW_PARENT_KEY;
        assert_eq!(
            CLAUDE_PARENT_KEY, "parentUuid",
            "Claude parent key 必须仍是 parentUuid"
        );
        assert_eq!(
            OPENCLAW_PARENT_KEY, "parentId",
            "OpenClaw parent key 必须仍是 parentId"
        );
        // 两个必须不同 (OpenClaw 用 oc: prefix 区分)
        assert_ne!(CLAUDE_PARENT_KEY, OPENCLAW_PARENT_KEY);
    }

    // ===== v0.9.4: kimi tool_usage 跨 session 聚合 =====

    #[test]
    fn build_meta_full_kimi_aggregates_tool_usage() {
        let jsonl = "\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"name\":\"Bash\"},\"time\":1}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"name\":\"Bash\"},\"time\":2}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"name\":\"Read\"},\"time\":3}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"name\":\"Read\"},\"time\":4}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"name\":\"Read\"},\"time\":5}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\"},\"time\":6}\n\
{\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":100,\"output\":50,\"inputCacheRead\":0,\"inputCacheCreation\":0},\"usageScope\":\"turn\",\"time\":7}\n\
";
        let p = write_tmp(".kimi_tools.jsonl", jsonl);
        let extras = build_meta_full(&p).expect("build_meta_full");
        // tool_usage 按 count desc 排序: Read=3, Bash=2
        assert_eq!(
            extras.tool_usage,
            vec![("Read".to_string(), 3), ("Bash".to_string(), 2),]
        );
        // tool_error 留空 (fixture 没 finishReason=error)
        assert!(extras.tool_error.is_empty());
        // v0.9.5: 同一 step 内 Read × 3 连续 → repeat_run_count=1
        assert_eq!(extras.repeat_run_count, 1);
        assert_eq!(extras.repeat_run_max_tool.as_deref(), Some("Read"));
        assert_eq!(extras.repeat_run_max_count, Some(3));
        // error_count=0 (fixture 没 error)
        assert_eq!(extras.error_count, 0);
    }

    #[test]
    fn build_meta_full_kimi_ignores_non_tool_call_loop_events() {
        let jsonl = "\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\"},\"time\":1}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"text\":\"x\"},\"time\":2}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\"},\"time\":3}\n\
{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"content\":\"hi\"},\"time\":4}\n";
        let p = write_tmp(".kimi_no_tools.jsonl", jsonl);
        let extras = build_meta_full(&p).expect("build_meta_full");
        // 只有 step/append_message 事件,tool_usage 空
        assert!(extras.tool_usage.is_empty());
    }

    // ===== v0.9.5: kimi MetaExtras 5 字段跨 source 对齐 =====

    /// C: usage.record.model 去重 → available_models
    #[test]
    fn build_meta_full_kimi_v095_collects_available_models() {
        let jsonl = "\
{\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":100,\"output\":50,\"inputCacheRead\":0,\"inputCacheCreation\":0},\"usageScope\":\"turn\",\"time\":1}\n\
{\"type\":\"usage.record\",\"model\":\"kimi-k2\",\"usage\":{\"inputOther\":50,\"output\":30,\"inputCacheRead\":0,\"inputCacheCreation\":0},\"usageScope\":\"turn\",\"time\":2}\n\
{\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":80,\"output\":40,\"inputCacheRead\":0,\"inputCacheCreation\":0},\"usageScope\":\"turn\",\"time\":3}\n\
{\"type\":\"usage.record\",\"model\":\"kimi-k2\",\"usage\":{\"inputOther\":60,\"output\":35,\"inputCacheRead\":0,\"inputCacheCreation\":0},\"usageScope\":\"session\",\"time\":4}\n";
        let p = write_tmp(".kimi_models.jsonl", jsonl);
        let extras = build_meta_full(&p).expect("build_meta_full");
        // BTreeSet 字典序: "deepseek-v4-flash" < "kimi-k2" (d < k)
        assert_eq!(
            extras.available_models,
            vec!["deepseek-v4-flash".to_string(), "kimi-k2".to_string()]
        );
    }

    /// D: content.part.part.type=="think" 累加 → thinking_count
    /// (同时验证 part.type=="text" 不计入)
    #[test]
    fn build_meta_full_kimi_v095_counts_thinking_parts() {
        let jsonl = "\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"part\":{\"type\":\"think\",\"think\":\"thinking 1\"}},\"time\":1}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"part\":{\"type\":\"text\",\"text\":\"text 1\"}},\"time\":2}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"part\":{\"type\":\"think\",\"think\":\"thinking 2\"}},\"time\":3}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"part\":{\"type\":\"think\",\"think\":\"thinking 3\"}},\"time\":4}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"part\":{\"type\":\"text\",\"text\":\"text 2\"}},\"time\":5}\n";
        let p = write_tmp(".kimi_thinking.jsonl", jsonl);
        let extras = build_meta_full(&p).expect("build_meta_full");
        // 3 个 think + 2 个 text → thinking_count = 3
        assert_eq!(extras.thinking_count, 3);
    }

    /// E: duration_seconds (last - first step.end.time) + first_response_latency_ms
    /// (first step.end.time - first turn.prompt.time)
    #[test]
    fn build_meta_full_kimi_v095_computes_duration_and_latency() {
        // first turn.prompt.time = 1000
        // first step.end.time = 1500 (latency = 500ms)
        // second step.end.time = 2000
        // last step.end.time = 7000 (duration = (7000-1500)/1000 = 5s)
        let jsonl = "\
{\"type\":\"turn.prompt\",\"input\":[{\"type\":\"text\",\"text\":\"hi\"}],\"time\":1000}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"step-1\",\"finishReason\":\"tool_use\",\"time\":1500}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"step-2\",\"finishReason\":\"tool_use\",\"time\":2000}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"step-3\",\"finishReason\":\"stop\",\"time\":7000}}\n";
        let p = write_tmp(".kimi_timing.jsonl", jsonl);
        let extras = build_meta_full(&p).expect("build_meta_full");
        assert_eq!(extras.first_response_latency_ms, Some(500));
        assert_eq!(extras.duration_seconds, Some(5));
    }

    /// A: step.end.finishReason=="error" → error_count + 配对 tool.call → tool_error
    #[test]
    fn build_meta_full_kimi_v095_aggregates_tool_error_from_finish_reason() {
        // step-1: 1 个 Bash tool.call, finishReason=tool_use → ok
        // step-2: 1 个 Read tool.call, finishReason=error → Read 累计 +1
        // step-3: 1 个 Bash tool.call, finishReason=tool_use → ok
        let jsonl = "\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\",\"uuid\":\"step-1\",\"time\":1}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"call-1\",\"toolCallId\":\"call-1\",\"name\":\"Bash\",\"stepUuid\":\"step-1\",\"time\":2}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"step-1\",\"finishReason\":\"tool_use\",\"time\":3}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\",\"uuid\":\"step-2\",\"time\":4}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"call-2\",\"toolCallId\":\"call-2\",\"name\":\"Read\",\"stepUuid\":\"step-2\",\"time\":5}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"step-2\",\"finishReason\":\"error\",\"time\":6}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\",\"uuid\":\"step-3\",\"time\":7}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"call-3\",\"toolCallId\":\"call-3\",\"name\":\"Bash\",\"stepUuid\":\"step-3\",\"time\":8}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"step-3\",\"finishReason\":\"tool_use\",\"time\":9}}\n";
        let p = write_tmp(".kimi_errors.jsonl", jsonl);
        let extras = build_meta_full(&p).expect("build_meta_full");
        assert_eq!(extras.error_count, 1, "1 个 step.finishReason=error");
        assert_eq!(
            extras.tool_error,
            vec![("Read".to_string(), 1)],
            "tool_error 仅 Read 计 1"
        );
        // 验证 Bash 不在 tool_error 里 (tool_use 成功的 step 不入 error)
        assert!(!extras.tool_error.iter().any(|(n, _)| n == "Bash"));
    }

    /// A 边界: 1 个 step 含 2 个 tool, error → 2 个 tool 都入 error count
    #[test]
    fn build_meta_full_kimi_v095_error_step_with_multiple_tools() {
        // step-1 含 Bash + Read → error 时两个 tool name 都 +1
        let jsonl = "\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\",\"uuid\":\"step-1\",\"time\":1}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c1\",\"toolCallId\":\"c1\",\"name\":\"Bash\",\"stepUuid\":\"step-1\",\"time\":2}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c2\",\"toolCallId\":\"c2\",\"name\":\"Read\",\"stepUuid\":\"step-1\",\"time\":3}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"step-1\",\"finishReason\":\"error\",\"time\":4}}\n";
        let p = write_tmp(".kimi_error_multi.jsonl", jsonl);
        let extras = build_meta_full(&p).expect("build_meta_full");
        assert_eq!(extras.error_count, 1);
        // 字典序: Bash < Read
        assert_eq!(
            extras.tool_error,
            vec![("Bash".to_string(), 1), ("Read".to_string(), 1)]
        );
    }

    /// B: repeat_run (consecutive tool.call 同名 ≥3) + idle_gap (相邻 step.end.time gap ≥ 5min)
    #[test]
    fn build_meta_full_kimi_v095_detects_repeat_run_and_idle_gap() {
        // step-1: Bash × 3 (repeat) + Read × 1 → repeat_run_count = 1, max_tool = Bash, max_count = 3
        // step-2: Bash × 2 (跨 step,不连续) → 不重复计
        // step-3: 跟 step-2 间隔 10 分钟 (> 5min) → idle_gap_count = 1
        let jsonl = "\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\",\"uuid\":\"s1\",\"time\":1000}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c1\",\"toolCallId\":\"c1\",\"name\":\"Bash\",\"stepUuid\":\"s1\",\"time\":1100}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c2\",\"toolCallId\":\"c2\",\"name\":\"Bash\",\"stepUuid\":\"s1\",\"time\":1200}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c3\",\"toolCallId\":\"c3\",\"name\":\"Bash\",\"stepUuid\":\"s1\",\"time\":1300}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c4\",\"toolCallId\":\"c4\",\"name\":\"Read\",\"stepUuid\":\"s1\",\"time\":1400}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s1\",\"finishReason\":\"tool_use\",\"time\":1500}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\",\"uuid\":\"s2\",\"time\":2000}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c5\",\"toolCallId\":\"c5\",\"name\":\"Bash\",\"stepUuid\":\"s2\",\"time\":2100}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c6\",\"toolCallId\":\"c6\",\"name\":\"Bash\",\"stepUuid\":\"s2\",\"time\":2200}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s2\",\"finishReason\":\"tool_use\",\"time\":2300}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\",\"uuid\":\"s3\",\"time\":601000}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s3\",\"finishReason\":\"stop\",\"time\":601500}}\n";
        let p = write_tmp(".kimi_repeat_idle.jsonl", jsonl);
        let extras = build_meta_full(&p).expect("build_meta_full");
        // repeat_run: s1 里 Bash × 3, s2 里 Bash × 2 不连续(被 step.end flush) → repeat_run_count = 1
        assert_eq!(extras.repeat_run_count, 1);
        assert_eq!(extras.repeat_run_max_tool.as_deref(), Some("Bash"));
        assert_eq!(extras.repeat_run_max_count, Some(3));
        // idle_gap: s2.time=2300, s3.time=601500, gap=599200ms ≈ 9.99min > 5min
        assert_eq!(extras.idle_gap_count, 1);
        assert_eq!(extras.idle_gap_max_ms, Some(599200));
    }

    /// B 边界: 不足 REPEAT_RUN_MIN=3 不计 repeat run
    #[test]
    fn build_meta_full_kimi_v095_repeat_run_below_threshold() {
        // Bash × 2 → < 3,不计入 repeat
        let jsonl = "\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c1\",\"toolCallId\":\"c1\",\"name\":\"Bash\",\"stepUuid\":\"s1\",\"time\":1}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c2\",\"toolCallId\":\"c2\",\"name\":\"Bash\",\"stepUuid\":\"s1\",\"time\":2}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s1\",\"finishReason\":\"tool_use\",\"time\":3}}\n";
        let p = write_tmp(".kimi_no_repeat.jsonl", jsonl);
        let extras = build_meta_full(&p).expect("build_meta_full");
        assert_eq!(extras.repeat_run_count, 0);
    }

    // ===== v0.9.6: thinking_count 跨 source 全填 =====

    /// claude path: message.content[].type=="thinking" 累加
    #[test]
    fn claude_path_counts_thinking_blocks() {
        // 3 个 assistant, content[] 各含 1 个 thinking + 1 个 text → thinking_count = 3
        let jsonl = "\
{\"type\":\"assistant\",\"timestamp\":\"2026-07-08T10:00:00Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"t1\"},{\"type\":\"text\",\"text\":\"x\"}]}}\n\
{\"type\":\"assistant\",\"timestamp\":\"2026-07-08T10:01:00Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"t2\"},{\"type\":\"text\",\"text\":\"y\"}]}}\n\
{\"type\":\"assistant\",\"timestamp\":\"2026-07-08T10:02:00Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"t3\"},{\"type\":\"text\",\"text\":\"z\"}]}}\n";
        let p = write_tmp("claude_thinking.jsonl", jsonl);
        let m = build_meta_full(&p).expect("build_meta_full");
        assert_eq!(m.thinking_count, 3);
        assert_eq!(m.assistant_message_count, 3);
    }

    /// claude path: 同 message 内多 thinking blocks 全部累加
    #[test]
    fn claude_path_multiple_thinking_per_message() {
        let jsonl = "\
{\"type\":\"assistant\",\"timestamp\":\"2026-07-08T10:00:00Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"a\"},{\"type\":\"thinking\",\"thinking\":\"b\"},{\"type\":\"text\",\"text\":\"x\"}]}}\n\
{\"type\":\"assistant\",\"timestamp\":\"2026-07-08T10:01:00Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"thinking\",\"thinking\":\"c\"},{\"type\":\"text\",\"text\":\"y\"}]}}\n";
        let p = write_tmp("claude_multi_thinking.jsonl", jsonl);
        let m = build_meta_full(&p).expect("build_meta_full");
        assert_eq!(m.thinking_count, 3);
    }

    /// openclaw path: 同样走 content[] 循环,但 OpenClaw wire 实际不含 type=="thinking"
    /// (OpenClaw thinking 是独立 event, docs/OPENCLAW_SESSION_FORMAT.md:108)
    /// 验证 default 0,不 panic
    #[test]
    fn openclaw_path_thinking_count_default_zero() {
        // OpenClaw 风格: assistant message.content[] = [text, toolUse] (无 thinking)
        let jsonl = "\
{\"type\":\"message\",\"id\":\"m1\",\"timestamp\":\"2026-07-08T10:00:00Z\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"hi\"},{\"type\":\"toolUse\",\"id\":\"tu1\",\"name\":\"Read\",\"input\":{}}]}}\n\
{\"type\":\"message\",\"id\":\"m2\",\"timestamp\":\"2026-07-08T10:01:00Z\",\"message\":{\"role\":\"user\",\"content\":\"ok\"}}\n";
        let p = write_tmp("openclaw_no_thinking.jsonl", jsonl);
        let m = build_meta_full(&p).expect("build_meta_full");
        assert_eq!(m.thinking_count, 0);
    }
}
