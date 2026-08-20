//! v0.9.27 (M10): Pass 1 聚合 (前身 v0.8.4 item 2 Pass 2 enrichment)
//!
//! 由 `commands/sessions.rs::build_*_session_meta` 直接调,聚合结果作为
//! SessionMeta 字段一并 `upsert_session_meta` 写 47 列 DB (无 UPDATE 二阶段)。
//! v0.9.26 之前是 Pass 2 enrichment (`db/sync.rs` 二阶段 loop 调 `aggregate_claude_openclaw`
//! 重开文件扫,`enrich_session_meta` 单独 UPDATE 26 列) — M10 删 sync loop 后
//! 这层搬到 Pass 1。
//!
//! 两个入口,按 source 选:
//! - `aggregate_claude_openclaw` — Claude Code + OpenClaw wire format
//! - `aggregate_kimi` — Kimi Code wire format (事件流,字段名不一样)
//!
//! 扫整个 jsonl (最多 5000 行 `META_FULL_MAX_LINES`) 提取:
//! - error_count / user_message_count / assistant_message_count (排除 isSidechain)
//! - duration_seconds (last_ts - first_ts)
//! - first_response_latency_ms (first assistant - first user)
//! - agent_name (jsonl 里第一个 agent-name envelope 的 agentName)
//! - invoked_skills_count / plan_file_ref_count / compact_file_ref_count /
//!   queued_command_count / attached_file_count
//! - text_message_count / tool_usage / phase_hint / phase_detail
//! - repeat_run_count / repeat_run_max_tool / repeat_run_max_count
//! - idle_gap_count / idle_gap_max_ms
//! - available_models / tool_error / parent_uuids (Vec<String> newline-joined 后写)
//! - kimi-only: thinking_count / todo_summary / kimi_token_usage / meta_banner

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
    // --- v0.9.5: thinking_count — kimi content.part.part.type=="think" 计数
    // 跟 claude/openclaw path 算 user/assistant.text_message_count 互补:
    // claude/openclaw 暂未拆 thinking/text,统一算 text_message_count;
    // kimi 因为 wire 事件显式区分 `think`/`text` 两个 part,直接统计 think 数。
    pub thinking_count: u32,
    // --- v0.9.8: kimi TodoWrite 状态 + token 聚合 + MetaBanner 配置/权限/压缩快照 ---
    /// `tools.update_store{key:"todo"}` 末次 value 解析出的当前 todo 状态
    pub todo_summary: Option<crate::model::TodoSummary>,
    /// `usage.record{usageScope:"turn"}` 累加 inputOther/output/inputCacheRead/inputCacheCreation
    /// 跟 `total_tokens` 区分:这个是 session 内自聚合,total_tokens 是从 llm.request 单点取
    pub kimi_token_usage: Option<crate::model::TokenUsage>,
    /// 顶部 MetaBanner 折叠快照:protocol_version / profile/model 演化 / permission mode /
    /// active tool 数 / approval / compaction 计数
    pub meta_banner: Option<crate::model::MetaBanner>,
}

/// 扫 claude/openclaw jsonl 全量(或 5000 行上限), 提取派生指标
pub fn aggregate_claude_openclaw(path: &Path) -> AppResult<MetaExtras> {
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
        "aggregate_claude_openclaw {} ({} lines): user={} asst={} err={} skills={} plans={} text={} repeat={} idle={}",
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

/// v0.9.5 + v0.9.7: kimi wire.jsonl 的全量 enrich — 跨 source 跟 claude/openclaw 对齐
/// `MetaExtras` 字段子集。覆盖:
/// - C: `available_models` via `usage.record.model`
/// - D: `thinking_count` via `content.part.part.type=="think"`
/// - E: `duration_seconds` (last - first step.end.time) + `first_response_latency_ms`
///   (first step.end.time - first turn.prompt.time)
/// - A: `error_count` + `tool_error`:
///     - v0.9.7 主要信号: `tool.result.result.isError == true` → 反查 parentUuid → tool name
///     - v0.9.5 旧信号: `step.end.finishReason == "error"` (real kimi 0 命中,保留作 defensive)
/// - B: `repeat_run_count/max_tool/max_count` (consecutive tool.call 同名 ≥ 3,
///   flush 在 step.end 切换) + `idle_gap_count/max_ms` (相邻 step.end.time gap ≥ 5min)
///
/// v0.9.4: 之前只算 tool_usage;其余 enrich 字段 (parent_uuids 等) 暂仍 default。
/// 不依赖 state machine — kimi wire event stream 字段名直接读,不依赖 normalize_kimi_record。
///
/// v0.9.7 关键修正 (dcwin11 真实样本验证):
/// - kimi wire event `time` 字段在**顶层**(`{"type":..., "time":...}`),不在 `event`
///   嵌套对象内。v0.9.5 误读 `ev.get("time")` 总是 None,导致 duration_seconds/first_response_latency_ms/idle_gap 在真实数据上全是 default。
/// - kimi 错误信号是 `tool.result.result.isError == true`,不是 `step.end.finishReason`。
///   dcwin11 11 个 session 共 37 个 isError 事件 (5/6/21 三个长 session),finishReason
///   真实值仅 `tool_use` (353) 和 `end_turn` (11) 两种,`error` 永远 0 命中。
pub fn aggregate_kimi(path: &Path) -> AppResult<MetaExtras> {
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
    // v0.9.8: TodoWrite 状态 — 末次 tools.update_store{key:"todo"}
    let mut todo_summary: Option<crate::model::TodoSummary> = None;
    // v0.9.8: token 聚合 — usage.record{usageScope:"turn"} 累加
    let mut token_input: u64 = 0;
    let mut token_output: u64 = 0;
    let mut token_cache_read: u64 = 0;
    let mut token_cache_write: u64 = 0;
    let mut token_seen: bool = false;
    // v0.9.8: MetaBanner 折叠快照
    let mut banner = crate::model::MetaBanner::default();
    // compaction begin/complete 配对跟踪 — 每对算 duration_ms
    let mut compaction_begin_time: Option<i64> = None;
    let mut last_compaction_duration_ms: Option<u64> = None;

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
                // v0.9.8: token 聚合 — 仅累加 scope=="turn" (scope=="context" 是 context cache read, 不计)
                let scope = obj.get("usageScope").and_then(|x| x.as_str());
                if scope == Some("turn") {
                    if let Some(u) = obj.get("usage").and_then(|v| v.as_object()) {
                        token_seen = true;
                        token_input += u.get("inputOther").and_then(|v| v.as_u64()).unwrap_or(0);
                        token_output += u.get("output").and_then(|v| v.as_u64()).unwrap_or(0);
                        token_cache_read += u
                            .get("inputCacheRead")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                        token_cache_write += u
                            .get("inputCacheCreation")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0);
                    }
                }
            }
            "context.append_loop_event" => {
                let ev = match obj.get("event") {
                    Some(e) => e,
                    None => return,
                };
                let ev_type = ev.get("type").and_then(|x| x.as_str()).unwrap_or("");
                // v0.9.7 修正: kimi wire event `time` 字段在**顶层** (跟 turn.prompt 同位置),
                // 不在嵌套 `event` 内。v0.9.5 误用 `ev.get("time")` 总是 None,导致
                // duration_seconds / first_response_latency_ms / idle_gap 全部失效。
                let ev_time = time;
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
                    "tool.result" => {
                        // v0.9.7: kimi 真实错误信号是 tool.result.result.isError == true
                        // (dcwin11: 5/6/21 个事件,finishReason 真实值只 tool_use/end_turn)。
                        // 用 parentUuid 反查先前 tool.call.uuid → tool name,累加 tool_error_counts。
                        // parentUuid 缺/反查失败时: tool_error 累不到该 name,但 error_count 仍 +1
                        // (best-effort per-tool breakdown)。
                        let res = ev.get("result");
                        let is_error = res
                            .and_then(|r| r.get("isError"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        if is_error {
                            out.error_count += 1;
                            let parent = ev.get("parentUuid").and_then(|x| x.as_str());
                            if let Some(p) = parent {
                                if let Some(name) = tool_uuid_to_name.get(p) {
                                    *tool_error_counts.entry(name.clone()).or_insert(0) += 1;
                                }
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
            // v0.9.8: MetaBanner + TodoWrite 聚合 (top-level events)
            "metadata" => {
                // 仅取首个;后续 proto_version 通常不变
                if banner.protocol_version.is_none() {
                    banner.protocol_version = obj
                        .get("protocol_version")
                        .and_then(|x| x.as_str())
                        .map(String::from);
                }
            }
            "config.update" => {
                banner.config_change_count += 1;
                if banner.profile_name.is_none() {
                    banner.profile_name = obj
                        .get("profileName")
                        .and_then(|x| x.as_str())
                        .map(String::from);
                }
                if banner.model_alias.is_none() {
                    banner.model_alias = obj
                        .get("modelAlias")
                        .and_then(|x| x.as_str())
                        .map(String::from);
                }
                if banner.thinking_effort.is_none() {
                    banner.thinking_effort = obj
                        .get("thinkingEffort")
                        .and_then(|x| x.as_str())
                        .map(String::from);
                }
            }
            "permission.set_mode" => {
                // 取末次 mode (覆盖之前的) — user 改 mode 是 idempotent
                if let Some(m) = obj.get("mode").and_then(|x| x.as_str()) {
                    banner.permission_mode = Some(m.to_string());
                }
            }
            "tools.set_active_tools" => {
                if banner.active_tool_count.is_none() {
                    if let Some(arr) = obj.get("names").and_then(|x| x.as_array()) {
                        banner.active_tool_count = Some(arr.len() as u32);
                    }
                }
            }
            "tools.update_store" => {
                // 仅 key=="todo" — dcwin11 bpm 已验证只此值
                if obj.get("key").and_then(|x| x.as_str()) == Some("todo") {
                    if let Some(arr) = obj.get("value").and_then(|x| x.as_array()) {
                        let mut total: u32 = 0;
                        let mut done: u32 = 0;
                        let mut current: Option<String> = None;
                        for item in arr {
                            total += 1;
                            let status = item.get("status").and_then(|x| x.as_str()).unwrap_or("");
                            let title =
                                item.get("title").and_then(|x| x.as_str()).map(String::from);
                            if status == "done" {
                                done += 1;
                            } else if status == "in_progress" && current.is_none() {
                                current = title.clone();
                            }
                        }
                        todo_summary = Some(crate::model::TodoSummary {
                            total,
                            done,
                            current,
                            updated_at_ms: time,
                        });
                    }
                }
            }
            "permission.record_approval_result" => {
                banner.approval_count += 1;
            }
            "full_compaction.begin" => {
                compaction_begin_time = time;
            }
            "full_compaction.complete" => {
                // 配对 begin 算 duration_ms (kimi 是 begin→complete 顺序保证)
                if let (Some(b), Some(c)) = (compaction_begin_time, time) {
                    if c > b {
                        last_compaction_duration_ms = Some((c - b) as u64);
                    }
                }
                banner.compaction_count += 1;
                compaction_begin_time = None;
            }
            _ => {}
        }
    })?;

    // 末尾 flush
    flush_repeat_run_kimi(&mut out, &mut current_tool, &mut current_count);

    // v0.9.8: 把 3 个聚合状态写入 out
    out.todo_summary = todo_summary;
    if token_seen {
        out.kimi_token_usage = Some(crate::model::TokenUsage {
            input: token_input,
            output: token_output,
            cache_read: token_cache_read,
            cache_write: token_cache_write,
        });
    }
    banner.last_compaction_duration_ms = last_compaction_duration_ms;
    out.meta_banner = Some(banner);

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

// ===== v0.9.28 (M11): DeepSeek Harness (dsh) wire format aggregator =====
/// v0.9.28 (M11): dsh wire envelope 全量 enrich — 跟 kimi 同思路(读 envelope
/// `data.*` 子对象),但字段名映射 dsh 的 `assistant/message` / `tool/result`
/// / `user/message` 形态。token 列复用 `kimi_token_usage` (Option A 决策:
/// 推迟到 v0.9.29 重命名列)。
///
/// 关键差异:
/// - 用 `for_each_line_auto` 透明支持 `.jsonl.zstd`
/// - `assistant/message` 已经是 pre-collapsed 终态(per-turn aggregate),
///   一条 record 计一个 assistant message,thinking/text/tool-call 都从
///   `data.message.content[]` 内 sub-part 派生
/// - `tool/call` 提供 `data.callId → data.name` 反查,`tool/result` 错
///   误时按 `data.message.source.callId` 反查到 tool name
pub fn aggregate_dsh(path: &Path) -> AppResult<MetaExtras> {
    use std::collections::{BTreeSet, HashMap};
    let mut out = MetaExtras::default();
    let mut tool_counts: HashMap<String, u32> = HashMap::new();
    let mut model_set: BTreeSet<String> = BTreeSet::new();
    // E: first/last assistant/message.time + first user/message.time
    let mut first_user_time: Option<i64> = None;
    let mut first_assistant_time: Option<i64> = None;
    let mut last_assistant_time: Option<i64> = None;
    // A: callId → tool name (tool/call 反查 tool/result)
    let mut call_id_to_name: HashMap<String, String> = HashMap::new();
    let mut tool_error_counts: HashMap<String, u32> = HashMap::new();
    // B: repeat_run tracking (consecutive assistant/message 同 tool ≥ REPEAT_RUN_MIN)
    let mut current_tool: Option<String> = None;
    let mut current_count: u32 = 0;
    // B: idle_gap tracking (相邻 assistant/message.time gap)
    let mut prev_assistant_time: Option<i64> = None;
    // token 聚合
    let mut token_input: u64 = 0;
    let mut token_output: u64 = 0;
    let mut token_cache_read: u64 = 0;
    let mut token_cache_write: u64 = 0;
    let mut token_seen: bool = false;
    // v0.9.28 (M11.3): todo_summary (todo/write 末次 value) + meta_banner
    // (permission/preset, sandbox/mode, approval/policy, session.version, request/header.config)
    let mut todo_summary: Option<crate::model::TodoSummary> = None;
    let mut banner = crate::model::MetaBanner::default();

    jsonl::for_each_line_auto(path, |_idx, _byte, v| {
        let obj = match v.as_object() {
            Some(o) => o,
            None => return,
        };
        let top_type = match obj.get("type").and_then(|x| x.as_str()) {
            Some(t) => t,
            None => return,
        };
        let data = obj.get("data").and_then(|x| x.as_object());
        let time = obj.get("time").and_then(|x| x.as_i64());

        match top_type {
            "session" => {
                if out.agent_name.is_none() {
                    // v0.9.28: agentPreset 在 dsh wire 上是 envelope 顶层字段 (跟 data.agentPreset 不同)
                    let preset = obj.get("agentPreset").and_then(|x| x.as_str()).or_else(|| {
                        data.and_then(|d| d.get("agentPreset"))
                            .and_then(|x| x.as_str())
                    });
                    if let Some(p) = preset {
                        out.agent_name = Some(p.to_string());
                    }
                }
                // v0.9.28 (M11.3): banner.protocol_version ← envelope.version (u64, 转字符串)
                if banner.protocol_version.is_none() {
                    if let Some(v) = obj.get("version").and_then(|x| x.as_u64()) {
                        banner.protocol_version = Some(v.to_string());
                    }
                }
            }
            "todo/write" => {
                // v0.9.28 (M11.3): 末次 todo/write 的 value 数组聚合。
                // dsh 状态值跟 kimi 不同:done / completed 都算完成;in_progress / pending / cancelled 各算一类。
                // 真实 wire 样本:status ∈ {"completed", "in_progress", "pending"}
                let arr = data.and_then(|d| d.get("todos")).and_then(|v| v.as_array());
                if let Some(arr) = arr {
                    let mut total: u32 = 0;
                    let mut done: u32 = 0;
                    let mut current: Option<String> = None;
                    for item in arr {
                        total += 1;
                        let status = item.get("status").and_then(|x| x.as_str()).unwrap_or("");
                        let title = item
                            .get("content")
                            .and_then(|x| x.as_str())
                            .map(String::from);
                        if status == "done" || status == "completed" {
                            done += 1;
                        } else if status == "in_progress" && current.is_none() {
                            current = title.clone();
                        }
                    }
                    todo_summary = Some(crate::model::TodoSummary {
                        total,
                        done,
                        current,
                        updated_at_ms: time,
                    });
                }
            }
            "permission/preset" => {
                // v0.9.28 (M11.3): banner.permission_mode ← data.preset
                if let Some(m) = data.and_then(|d| d.get("preset")).and_then(|x| x.as_str()) {
                    banner.permission_mode = Some(m.to_string());
                }
            }
            "sandbox/mode" => {
                // v0.9.28 (M11.5): sandbox 是独立语义维度(workspace-write / docker /
                // restricted 等),不再覆盖 permission_mode。permission/preset 跟 sandbox/mode
                // 在真实 wire 里通常是同值 ("workspace-write") 但语义不同 — M11.3 错写到
                // permission_mode 会 silent 改写 preset 值,这次修到 sandbox_mode。
                if let Some(m) = data.and_then(|d| d.get("mode")).and_then(|x| x.as_str()) {
                    banner.sandbox_mode = Some(m.to_string());
                }
            }
            "approval/policy" => {
                // v0.9.28 (M11.5): banner.approval_count 累加 (每次 policy 切换一次)
                // 同时 banner.approval_policy ← data.policy ("ask" / "auto" / "deny")
                // — 之前只计 count、policy 值被丢,UI 看不出当前生效策略。
                banner.approval_count += 1;
                if banner.approval_policy.is_none() {
                    if let Some(p) = data.and_then(|d| d.get("policy")).and_then(|x| x.as_str()) {
                        banner.approval_policy = Some(p.to_string());
                    }
                }
            }
            "request/header" => {
                // v0.9.28 (M11.3): banner.model_alias / thinking_effort / active_tool_count
                let header = data.and_then(|d| d.get("header"));
                let config = header.and_then(|h| h.get("config"));
                if banner.model_alias.is_none() {
                    if let Some(m) = config.and_then(|c| c.get("model")).and_then(|x| x.as_str()) {
                        banner.model_alias = Some(m.to_string());
                    }
                }
                if banner.thinking_effort.is_none() {
                    if let Some(e) = config
                        .and_then(|c| c.get("reasoningEffort"))
                        .and_then(|x| x.as_str())
                    {
                        banner.thinking_effort = Some(e.to_string());
                    }
                }
                if banner.active_tool_count.is_none() {
                    if let Some(arr) = header
                        .and_then(|h| h.get("tools"))
                        .and_then(|t| t.as_array())
                    {
                        banner.active_tool_count = Some(arr.len() as u32);
                    }
                }
            }
            "user/message" => {
                out.user_message_count += 1;
                if first_user_time.is_none() {
                    first_user_time = time;
                }
            }
            "assistant/message" => {
                out.assistant_message_count += 1;
                let message = data
                    .and_then(|d| d.get("message"))
                    .and_then(|x| x.as_object());

                // model from data.message.source.model
                if let Some(model) = message
                    .and_then(|m| m.get("source"))
                    .and_then(|s| s.get("model"))
                    .and_then(|x| x.as_str())
                {
                    model_set.insert(model.to_string());
                }

                // content[] → reasoning/text/tool-call 计数 + repeat_run tracking
                // v0.9.28: 每条 assistant/message 可能含多个 tool-call part,按
                // 出现顺序累加 repeat_run — 跟 kimi 同算法,只是把 tool.call event
                // 替换成 content[] 内的 tool-call part。
                let mut tool_call_count: u32 = 0;
                if let Some(arr) = message
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                {
                    for part in arr {
                        let pt = part.get("type").and_then(|x| x.as_str()).unwrap_or("");
                        match pt {
                            "reasoning" => {
                                out.thinking_count += 1;
                                out.text_message_count += 1;
                            }
                            "text" => {
                                out.text_message_count += 1;
                            }
                            "tool-call" => {
                                tool_call_count += 1;
                                if let Some(name) = part.get("name").and_then(|x| x.as_str()) {
                                    *tool_counts.entry(name.to_string()).or_insert(0) += 1;
                                    // B: repeat_run — 同名累加, 改名 flush
                                    if Some(name) == current_tool.as_deref() {
                                        current_count += 1;
                                    } else {
                                        flush_repeat_run_dsh(
                                            &mut out,
                                            &mut current_tool,
                                            &mut current_count,
                                        );
                                        current_tool = Some(name.to_string());
                                        current_count = 1;
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }

                // 整条 assistant/message 无 tool-call → flush 上一 run
                if tool_call_count == 0 {
                    flush_repeat_run_dsh(&mut out, &mut current_tool, &mut current_count);
                }

                // B + E: assistant/message.time → first/last + idle_gap
                if let Some(t) = time {
                    if first_assistant_time.is_none() {
                        first_assistant_time = Some(t);
                    }
                    last_assistant_time = Some(t);
                    if let Some(prev) = prev_assistant_time {
                        let delta = t - prev;
                        if delta >= IDLE_GAP_THRESHOLD_MS {
                            out.idle_gap_count += 1;
                            out.idle_gap_max_ms = Some(match out.idle_gap_max_ms {
                                Some(p) => p.max(delta as u64),
                                None => delta as u64,
                            });
                        }
                    }
                    prev_assistant_time = Some(t);
                }

                // token 聚合 (data.usage.{input,output,cacheRead,cacheCreation,reasoning}Tokens)
                if let Some(u) = data.and_then(|d| d.get("usage")) {
                    token_seen = true;
                    token_input += u.get("inputTokens").and_then(|x| x.as_u64()).unwrap_or(0);
                    token_output += u.get("outputTokens").and_then(|x| x.as_u64()).unwrap_or(0);
                    token_cache_read += u
                        .get("cacheReadTokens")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0);
                    token_cache_write += u
                        .get("cacheCreationTokens")
                        .and_then(|x| x.as_u64())
                        .unwrap_or(0);
                    // reasoningTokens 不进 TokenUsage (4 元组没位置) — 静默 skip
                }
            }
            "tool/call" => {
                // A: 反查表 — tool/result 用 callId 找 name
                let call_id = data.and_then(|d| d.get("callId")).and_then(|x| x.as_str());
                let name = data.and_then(|d| d.get("name")).and_then(|x| x.as_str());
                if let (Some(cid), Some(n)) = (call_id, name) {
                    call_id_to_name.insert(cid.to_string(), n.to_string());
                    // v0.9.28: 独立 `tool/call` event 也算一次 tool_usage(某些 dsh
                    // session 把 tool-call 信息放在独立 envelope,不在
                    // assistant/message.content[] 内)
                    *tool_counts.entry(n.to_string()).or_insert(0) += 1;
                }
            }
            "tool/result" => {
                // A: data.message.content[0].isError → 反查 source.callId → name
                let message = data.and_then(|d| d.get("message"));
                let first_part = message
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_array())
                    .and_then(|arr| arr.first());
                let is_error = first_part
                    .and_then(|p| p.get("isError"))
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false);
                if is_error {
                    out.error_count += 1;
                    let call_id = message
                        .and_then(|m| m.get("source"))
                        .and_then(|s| s.get("callId"))
                        .and_then(|x| x.as_str());
                    if let Some(cid) = call_id {
                        if let Some(name) = call_id_to_name.get(cid) {
                            *tool_error_counts.entry(name.clone()).or_insert(0) += 1;
                        }
                    }
                }
            }
            _ => {}
        }
    })?;

    // 末尾 flush
    flush_repeat_run_dsh(&mut out, &mut current_tool, &mut current_count);

    // E: duration_seconds = last_assistant_time - first_assistant_time
    if let (Some(f), Some(l)) = (first_assistant_time, last_assistant_time) {
        let dur_ms = (l - f).max(0) as u64;
        out.duration_seconds = Some(dur_ms / 1000);
    }
    // E: first_response_latency_ms = first_assistant_time - first_user_time
    if let (Some(ut), Some(at)) = (first_user_time, first_assistant_time) {
        let delta = at - ut;
        if delta > 0 {
            out.first_response_latency_ms = Some(delta as u64);
        }
    }
    // A: tool_error sort desc
    let mut tool_err_vec: Vec<(String, u32)> = tool_error_counts.into_iter().collect();
    tool_err_vec.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out.tool_error = tool_err_vec;
    // tool_usage sort desc
    let mut tool_vec: Vec<(String, u32)> = tool_counts.into_iter().collect();
    tool_vec.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    out.tool_usage = tool_vec;
    // available_models BTreeSet → Vec (字典序)
    out.available_models = model_set.into_iter().collect();
    // kimi_token_usage (复用, dsh 也写这里)
    if token_seen {
        out.kimi_token_usage = Some(crate::model::TokenUsage {
            input: token_input,
            output: token_output,
            cache_read: token_cache_read,
            cache_write: token_cache_write,
        });
    }
    // v0.9.28 (M11.3): todo_summary + meta_banner
    out.todo_summary = todo_summary;
    out.meta_banner = Some(banner);

    Ok(out)
}

/// v0.9.28 (M11): dsh 专属 repeat_run flush — 跟 kimi flush 同算法,隔离命名空间
fn flush_repeat_run_dsh(
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
        let dir = std::env::temp_dir().join("ocsv_meta_aggregator_test");
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
        let m = aggregate_claude_openclaw(&p).unwrap();
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
        let m = aggregate_claude_openclaw(&p).unwrap();
        assert_eq!(m.user_message_count, 1);
        assert_eq!(m.assistant_message_count, 0);
    }

    #[test]
    fn picks_first_agent_name() {
        let jsonl = r#"{"type":"agent-name","agentName":"first","sessionId":"x"}
{"type":"agent-name","agentName":"second","sessionId":"x"}
"#;
        let p = write_tmp("agent_name.jsonl", jsonl);
        let m = aggregate_claude_openclaw(&p).unwrap();
        assert_eq!(m.agent_name.as_deref(), Some("first"));
    }

    #[test]
    fn empty_file_yields_zeros() {
        let p = write_tmp("empty.jsonl", "");
        let m = aggregate_claude_openclaw(&p).unwrap();
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
        let m = aggregate_claude_openclaw(&p).unwrap();
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
        let m = aggregate_claude_openclaw(&p).unwrap();
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
        let m = aggregate_claude_openclaw(&p).unwrap();
        assert_eq!(m.phase_hint.as_deref(), Some("explore"));
    }

    #[test]
    fn phase_hint_short_when_few_messages() {
        let jsonl = r#"{"type":"user","timestamp":"2026-07-08T10:00:00Z","message":{"role":"user"}}
{"type":"assistant","timestamp":"2026-07-08T10:00:01Z","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{}}]}}
"#;
        let p = write_tmp("phase_short.jsonl", jsonl);
        let m = aggregate_claude_openclaw(&p).unwrap();
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
        let m = aggregate_claude_openclaw(&p).unwrap();
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
        let m = aggregate_claude_openclaw(&p).unwrap();
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
        let m = aggregate_claude_openclaw(&p).unwrap();
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
        let m = aggregate_claude_openclaw(&p).unwrap();
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
        let m = aggregate_claude_openclaw(&p).unwrap();
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
        let m = aggregate_claude_openclaw(&p).unwrap();
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
        let m = aggregate_claude_openclaw(&p).unwrap();
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
        let m = aggregate_claude_openclaw(&p).unwrap();
        // 两个空字符串不入集合, 只留真实那个
        assert_eq!(m.parent_uuids, vec!["real-uuid"]);
    }

    // v0.8.10: 锁住 PARENT_KEY const 值 — 改了 const 必然要更新 aggregate_claude_openclaw 引用
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
    fn aggregate_kimi_aggregates_tool_usage() {
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
        let extras = aggregate_kimi(&p).expect("aggregate_kimi");
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
    fn aggregate_kimi_ignores_non_tool_call_loop_events() {
        let jsonl = "\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\"},\"time\":1}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"text\":\"x\"},\"time\":2}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\"},\"time\":3}\n\
{\"type\":\"context.append_message\",\"message\":{\"role\":\"user\",\"content\":\"hi\"},\"time\":4}\n";
        let p = write_tmp(".kimi_no_tools.jsonl", jsonl);
        let extras = aggregate_kimi(&p).expect("aggregate_kimi");
        // 只有 step/append_message 事件,tool_usage 空
        assert!(extras.tool_usage.is_empty());
    }

    // ===== v0.9.5: kimi MetaExtras 5 字段跨 source 对齐 =====

    /// C: usage.record.model 去重 → available_models
    #[test]
    fn aggregate_kimi_v095_collects_available_models() {
        let jsonl = "\
{\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":100,\"output\":50,\"inputCacheRead\":0,\"inputCacheCreation\":0},\"usageScope\":\"turn\",\"time\":1}\n\
{\"type\":\"usage.record\",\"model\":\"kimi-k2\",\"usage\":{\"inputOther\":50,\"output\":30,\"inputCacheRead\":0,\"inputCacheCreation\":0},\"usageScope\":\"turn\",\"time\":2}\n\
{\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":80,\"output\":40,\"inputCacheRead\":0,\"inputCacheCreation\":0},\"usageScope\":\"turn\",\"time\":3}\n\
{\"type\":\"usage.record\",\"model\":\"kimi-k2\",\"usage\":{\"inputOther\":60,\"output\":35,\"inputCacheRead\":0,\"inputCacheCreation\":0},\"usageScope\":\"session\",\"time\":4}\n";
        let p = write_tmp(".kimi_models.jsonl", jsonl);
        let extras = aggregate_kimi(&p).expect("aggregate_kimi");
        // BTreeSet 字典序: "deepseek-v4-flash" < "kimi-k2" (d < k)
        assert_eq!(
            extras.available_models,
            vec!["deepseek-v4-flash".to_string(), "kimi-k2".to_string()]
        );
    }

    /// D: content.part.part.type=="think" 累加 → thinking_count
    /// (同时验证 part.type=="text" 不计入)
    #[test]
    fn aggregate_kimi_v095_counts_thinking_parts() {
        let jsonl = "\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"part\":{\"type\":\"think\",\"think\":\"thinking 1\"}},\"time\":1}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"part\":{\"type\":\"text\",\"text\":\"text 1\"}},\"time\":2}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"part\":{\"type\":\"think\",\"think\":\"thinking 2\"}},\"time\":3}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"part\":{\"type\":\"think\",\"think\":\"thinking 3\"}},\"time\":4}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"content.part\",\"part\":{\"type\":\"text\",\"text\":\"text 2\"}},\"time\":5}\n";
        let p = write_tmp(".kimi_thinking.jsonl", jsonl);
        let extras = aggregate_kimi(&p).expect("aggregate_kimi");
        // 3 个 think + 2 个 text → thinking_count = 3
        assert_eq!(extras.thinking_count, 3);
    }

    /// E: duration_seconds (last - first step.end.time) + first_response_latency_ms
    /// (first step.end.time - first turn.prompt.time)
    /// v0.9.7: `time` 字段移到顶层 (跟真实 kimi wire 一致;v0.9.5 误放 event 内)
    #[test]
    fn aggregate_kimi_v095_computes_duration_and_latency() {
        // first turn.prompt.time = 1000
        // first step.end.time = 1500 (latency = 500ms)
        // second step.end.time = 2000
        // last step.end.time = 7000 (duration = (7000-1500)/1000 = 5s)
        let jsonl = "\
{\"type\":\"turn.prompt\",\"input\":[{\"type\":\"text\",\"text\":\"hi\"}],\"time\":1000}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"step-1\",\"finishReason\":\"tool_use\"},\"time\":1500}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"step-2\",\"finishReason\":\"tool_use\"},\"time\":2000}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"step-3\",\"finishReason\":\"stop\"},\"time\":7000}\n";
        let p = write_tmp(".kimi_timing.jsonl", jsonl);
        let extras = aggregate_kimi(&p).expect("aggregate_kimi");
        assert_eq!(extras.first_response_latency_ms, Some(500));
        assert_eq!(extras.duration_seconds, Some(5));
    }

    /// A: step.end.finishReason=="error" → error_count + 配对 tool.call → tool_error
    #[test]
    fn aggregate_kimi_v095_aggregates_tool_error_from_finish_reason() {
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
        let extras = aggregate_kimi(&p).expect("aggregate_kimi");
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
    fn aggregate_kimi_v095_error_step_with_multiple_tools() {
        // step-1 含 Bash + Read → error 时两个 tool name 都 +1
        let jsonl = "\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\",\"uuid\":\"step-1\",\"time\":1}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c1\",\"toolCallId\":\"c1\",\"name\":\"Bash\",\"stepUuid\":\"step-1\",\"time\":2}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c2\",\"toolCallId\":\"c2\",\"name\":\"Read\",\"stepUuid\":\"step-1\",\"time\":3}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"step-1\",\"finishReason\":\"error\",\"time\":4}}\n";
        let p = write_tmp(".kimi_error_multi.jsonl", jsonl);
        let extras = aggregate_kimi(&p).expect("aggregate_kimi");
        assert_eq!(extras.error_count, 1);
        // 字典序: Bash < Read
        assert_eq!(
            extras.tool_error,
            vec![("Bash".to_string(), 1), ("Read".to_string(), 1)]
        );
    }

    /// B: repeat_run (consecutive tool.call 同名 ≥3) + idle_gap (相邻 step.end.time gap ≥ 5min)
    /// v0.9.7: `time` 字段移到顶层 (跟真实 kimi wire 一致)
    #[test]
    fn aggregate_kimi_v095_detects_repeat_run_and_idle_gap() {
        // step-1: Bash × 3 (repeat) + Read × 1 → repeat_run_count = 1, max_tool = Bash, max_count = 3
        // step-2: Bash × 2 (跨 step,不连续) → 不重复计
        // step-3: 跟 step-2 间隔 10 分钟 (> 5min) → idle_gap_count = 1
        let jsonl = "\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\",\"uuid\":\"s1\"},\"time\":1000}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c1\",\"toolCallId\":\"c1\",\"name\":\"Bash\",\"stepUuid\":\"s1\"},\"time\":1100}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c2\",\"toolCallId\":\"c2\",\"name\":\"Bash\",\"stepUuid\":\"s1\"},\"time\":1200}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c3\",\"toolCallId\":\"c3\",\"name\":\"Bash\",\"stepUuid\":\"s1\"},\"time\":1300}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c4\",\"toolCallId\":\"c4\",\"name\":\"Read\",\"stepUuid\":\"s1\"},\"time\":1400}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s1\",\"finishReason\":\"tool_use\"},\"time\":1500}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\",\"uuid\":\"s2\"},\"time\":2000}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c5\",\"toolCallId\":\"c5\",\"name\":\"Bash\",\"stepUuid\":\"s2\"},\"time\":2100}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c6\",\"toolCallId\":\"c6\",\"name\":\"Bash\",\"stepUuid\":\"s2\"},\"time\":2200}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s2\",\"finishReason\":\"tool_use\"},\"time\":2300}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.begin\",\"uuid\":\"s3\"},\"time\":601000}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s3\",\"finishReason\":\"stop\"},\"time\":601500}\n";
        let p = write_tmp(".kimi_repeat_idle.jsonl", jsonl);
        let extras = aggregate_kimi(&p).expect("aggregate_kimi");
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
    fn aggregate_kimi_v095_repeat_run_below_threshold() {
        // Bash × 2 → < 3,不计入 repeat
        let jsonl = "\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c1\",\"toolCallId\":\"c1\",\"name\":\"Bash\",\"stepUuid\":\"s1\",\"time\":1}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c2\",\"toolCallId\":\"c2\",\"name\":\"Bash\",\"stepUuid\":\"s1\",\"time\":2}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s1\",\"finishReason\":\"tool_use\",\"time\":3}}\n";
        let p = write_tmp(".kimi_no_repeat.jsonl", jsonl);
        let extras = aggregate_kimi(&p).expect("aggregate_kimi");
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
        let m = aggregate_claude_openclaw(&p).expect("aggregate_claude_openclaw");
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
        let m = aggregate_claude_openclaw(&p).expect("aggregate_claude_openclaw");
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
        let m = aggregate_claude_openclaw(&p).expect("aggregate_claude_openclaw");
        assert_eq!(m.thinking_count, 0);
    }

    // ===== v0.9.7: dcwin11 真实样本驱动 kimi meta 解析 =====

    /// v0.9.7 fix: kimi 真实错误信号是 `tool.result.result.isError == true`
    /// (不是 `step.end.finishReason == "error"`,后者在 11 个 dcwin11 session 0 命中)。
    /// 验证 isError → error_count + per-tool breakdown。
    #[test]
    fn aggregate_kimi_v097_detects_iserror_tool_results() {
        // step-1: 1 个 Bash,result.isError=true → error_count=1, tool_error[Bash]=1
        // step-2: 1 个 Read,result.isError=false → 不算 error
        // step-3: 1 个 Grep,result.isError=true → error_count=2, tool_error[Grep]=1
        let jsonl = "\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c1\",\"toolCallId\":\"c1\",\"name\":\"Bash\",\"stepUuid\":\"s1\",\"time\":1000}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.result\",\"parentUuid\":\"c1\",\"toolCallId\":\"c1\",\"result\":{\"output\":\"exit 2\",\"isError\":true},\"time\":1100}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s1\",\"finishReason\":\"tool_use\",\"time\":1200}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c2\",\"toolCallId\":\"c2\",\"name\":\"Read\",\"stepUuid\":\"s2\",\"time\":2000}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.result\",\"parentUuid\":\"c2\",\"toolCallId\":\"c2\",\"result\":{\"output\":\"# file contents\"},\"time\":2100}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s2\",\"finishReason\":\"tool_use\",\"time\":2200}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.call\",\"uuid\":\"c3\",\"toolCallId\":\"c3\",\"name\":\"Grep\",\"stepUuid\":\"s3\",\"time\":3000}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"tool.result\",\"parentUuid\":\"c3\",\"toolCallId\":\"c3\",\"result\":{\"output\":\"no match\",\"isError\":true},\"time\":3100}}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s3\",\"finishReason\":\"tool_use\",\"time\":3200}}\n";
        let p = write_tmp(".kimi_iserror.jsonl", jsonl);
        let extras = aggregate_kimi(&p).expect("aggregate_kimi");
        assert_eq!(extras.error_count, 2, "Bash + Grep 各 1 个 isError");
        // Bash 和 Grep 各 1 次,desc 排: count 相同 → 字典序 Bash < Grep
        assert_eq!(
            extras.tool_error,
            vec![("Bash".to_string(), 1), ("Grep".to_string(), 1)]
        );
        // Read 不在 tool_error(成功)
        assert!(!extras.tool_error.iter().any(|(n, _)| n == "Read"));
    }

    /// v0.9.7 fix: kimi wire event `time` 字段在**顶层**(`{"type":...,"time":...}`),
    /// 不在嵌套 `event` 内。v0.9.5 误读 `ev.get("time")` 永远 None,导致 duration/latency
    /// 在真实数据上全 default。验证顶层 time 正确传递到 first/last step.end.time。
    #[test]
    fn aggregate_kimi_v097_uses_top_level_time_field() {
        // 3 个 step.end,顶层 time: 1000, 2000, 3000
        // duration = 3000 - 1000 = 2000ms → 2s
        // first_response_latency = 1000 - 500 = 500ms (turn.prompt at 500)
        let jsonl = "\
{\"type\":\"turn.prompt\",\"input\":[{\"type\":\"text\",\"text\":\"hi\"}],\"time\":500}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s1\",\"finishReason\":\"tool_use\"},\"time\":1000}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s2\",\"finishReason\":\"end_turn\"},\"time\":2000}\n\
{\"type\":\"context.append_loop_event\",\"event\":{\"type\":\"step.end\",\"uuid\":\"s3\",\"finishReason\":\"tool_use\"},\"time\":3000}\n";
        let p = write_tmp(".kimi_toplevel_time.jsonl", jsonl);
        let extras = aggregate_kimi(&p).expect("aggregate_kimi");
        assert_eq!(extras.duration_seconds, Some(2));
        assert_eq!(extras.first_response_latency_ms, Some(500));
    }

    /// 真实样本: dcwin11 das-portal session (1096 lines, 5 errors Bash×4 + Grep×1)
    /// 验证 5 errors、thinking_count=125、step_end=124、turn_prompts=12、model=deepseek-v4-flash

    /// 真实样本: dcwin11 platform 5-agent session main wire (859 lines, 6 errors)
    /// 验证多 agent 场景 + 0 thinking_count (model=minimax-m3 不产 think part)

    /// 真实样本: dcwin11 bpm 大 session (3431 lines, 21 errors, 364 thinking)
    /// 性能 + 大数据量 sanity check,确保循环不 OOM/panic

    // ===== v0.9.8: Kimi 聚合字段 (TodoWrite + token + MetaBanner) =====

    /// dcwin11 bpm session 真实 fixture:5834 行 wire.jsonl,验证 3 个聚合:
    /// - todo_summary: 55 次 tools.update_store{key:"todo"} 末次状态
    /// - kimi_token_usage: 623 个 usage.record{usageScope:"turn"} 累加 ≈
    ///   inputOther:2.3M / output:716k / inputCacheRead:30.9M / inputCacheCreation:0
    /// - meta_banner: {protocol:"1.4", config_change_count:>0, approval_count:20, compaction_count:22}

    /// 单元 fixture 测试: 单条 tools.update_store{key:"todo"} → todo_summary 提取
    #[test]
    fn aggregate_kimi_v098_aggregates_todo_from_in_memory() {
        let tmp = std::env::temp_dir().join(format!("ocsv_kimi_todo_{}.jsonl", std::process::id()));
        let content = "{\"type\":\"metadata\",\"protocol_version\":\"1.4\",\"created_at\":1,\"time\":100}\n\
                       {\"type\":\"tools.update_store\",\"key\":\"todo\",\"value\":[{\"title\":\"A\",\"status\":\"done\"},{\"title\":\"B\",\"status\":\"in_progress\"},{\"title\":\"C\",\"status\":\"pending\"}],\"time\":200}\n";
        std::fs::write(&tmp, content).unwrap();
        let extras = aggregate_kimi(&tmp).expect("build");
        std::fs::remove_file(&tmp).ok();
        let todo = extras.todo_summary.expect("todo 应有");
        assert_eq!(todo.total, 3);
        assert_eq!(todo.done, 1);
        assert_eq!(todo.current.as_deref(), Some("B"));
        assert_eq!(todo.updated_at_ms, Some(200));
    }

    /// 单元 fixture 测试: usage.record{usageScope:"turn"} 累加,不累计 scope=="context" 的
    #[test]
    fn aggregate_kimi_v098_aggregates_tokens_only_turn_scope() {
        let tmp =
            std::env::temp_dir().join(format!("ocsv_kimi_token_{}.jsonl", std::process::id()));
        let content = "{\"type\":\"metadata\",\"protocol_version\":\"1.4\",\"created_at\":1,\"time\":100}\n\
                       {\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":100,\"output\":50,\"inputCacheRead\":1000,\"inputCacheCreation\":0},\"usageScope\":\"turn\",\"time\":200}\n\
                       {\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":200,\"output\":80,\"inputCacheRead\":2000,\"inputCacheCreation\":0},\"usageScope\":\"context\",\"time\":300}\n\
                       {\"type\":\"usage.record\",\"model\":\"deepseek-v4-flash\",\"usage\":{\"inputOther\":150,\"output\":40,\"inputCacheRead\":500,\"inputCacheCreation\":0},\"usageScope\":\"turn\",\"time\":400}\n";
        std::fs::write(&tmp, content).unwrap();
        let extras = aggregate_kimi(&tmp).expect("build");
        std::fs::remove_file(&tmp).ok();
        let tok = extras.kimi_token_usage.expect("token 应有");
        // 累加 2 条 turn: input=100+150=250, output=50+40=90, cache_read=1000+500=1500
        assert_eq!(tok.input, 250);
        assert_eq!(tok.output, 90);
        assert_eq!(tok.cache_read, 1500);
        // context 跳过
    }

    // ===== v0.9.28 (M11): aggregate_dsh tests =====

    #[test]
    fn aggregate_dsh_basic_envelope_counts() {
        // v0.9.28: 1 user/message + 1 assistant/message + 1 tool/result
        let jsonl = r#"{"type":"session","id":"s1","agentPreset":"cordis","createdAt":1787100548509}
{"type":"user/message","seq":1,"time":1787100701000,"data":{"id":"u1","content":[{"type":"text","text":"hi"}],"role":"user"}}
{"type":"assistant/message","seq":2,"time":1787100704000,"data":{"turn":1,"step":1,"message":{"role":"assistant","source":{"kind":"model","provider":"deepseek-official","model":"deepseek-v4-flash"},"id":"a1","content":[{"type":"reasoning","text":"thinking"},{"type":"text","text":"hello"}]}}}
{"type":"tool/call","seq":3,"time":1787100704100,"data":{"callId":"call_00_1","name":"Bash","arguments":"{\"command\":\"ls\"}"}}
{"type":"tool/result","seq":4,"time":1787100704200,"data":{"message":{"source":{"kind":"tool","callId":"call_00_1"},"content":[{"type":"tool-result","isError":false}]}}}
"#;
        let p = write_tmp("dsh_basic.jsonl", jsonl);
        let m = aggregate_dsh(&p).unwrap();
        assert_eq!(m.agent_name.as_deref(), Some("cordis"));
        assert_eq!(m.user_message_count, 1);
        assert_eq!(m.assistant_message_count, 1);
        assert_eq!(m.thinking_count, 1, "1 个 reasoning part");
        assert_eq!(
            m.text_message_count, 2,
            "1 reasoning + 1 text 都算 text_message_count"
        );
        assert_eq!(m.tool_usage, vec![("Bash".to_string(), 1)]);
        assert_eq!(m.available_models, vec!["deepseek-v4-flash".to_string()]);
        assert_eq!(m.error_count, 0, "isError=false 不计数");
        // duration = last - first assistant = 0 (只有 1 条 assistant)
        assert_eq!(m.duration_seconds, Some(0));
        // first_response_latency = assistant.time - user.time = 4000-1000 = 3000ms
        assert_eq!(m.first_response_latency_ms, Some(3000));
    }

    #[test]
    fn aggregate_dsh_aggregates_tokens_and_writes_to_kimi_column() {
        // v0.9.28 Option A 决策: dsh token 复用 `kimi_token_usage` 列
        let jsonl = r#"{"type":"assistant/message","seq":1,"time":1000,"data":{"message":{"role":"assistant","source":{"model":"m1"},"content":[{"type":"text","text":"x"}]},"usage":{"inputTokens":100,"outputTokens":50,"cacheReadTokens":200,"cacheCreationTokens":10}}}
{"type":"assistant/message","seq":2,"time":2000,"data":{"message":{"role":"assistant","source":{"model":"m1"},"content":[{"type":"text","text":"y"}]},"usage":{"inputTokens":150,"outputTokens":75,"cacheReadTokens":300,"cacheCreationTokens":20}}}
"#;
        let p = write_tmp("dsh_tokens.jsonl", jsonl);
        let m = aggregate_dsh(&p).unwrap();
        let tok = m.kimi_token_usage.expect("token 应该有");
        assert_eq!(tok.input, 250);
        assert_eq!(tok.output, 125);
        assert_eq!(tok.cache_read, 500);
        assert_eq!(tok.cache_write, 30);
    }

    #[test]
    fn aggregate_dsh_counts_errors_with_call_id_reverse_lookup() {
        // v0.9.28: tool/result isError=true 累加 error_count,反查 tool/call.callId → tool name
        let jsonl = r#"{"type":"tool/call","seq":1,"time":100,"data":{"callId":"c1","name":"Bash"}}
{"type":"tool/result","seq":2,"time":200,"data":{"message":{"source":{"kind":"tool","callId":"c1"},"content":[{"type":"tool-result","isError":true,"content":[{"type":"text","text":"ENOENT"}]}]}}}
{"type":"tool/call","seq":3,"time":300,"data":{"callId":"c2","name":"Read"}}
{"type":"tool/result","seq":4,"time":400,"data":{"message":{"source":{"kind":"tool","callId":"c2"},"content":[{"type":"tool-result","isError":false}]}}}
{"type":"tool/call","seq":5,"time":500,"data":{"callId":"c3","name":"Edit"}}
{"type":"tool/result","seq":6,"time":600,"data":{"message":{"source":{"kind":"tool","callId":"c3"},"content":[{"type":"tool-result","isError":true}]}}}
"#;
        let p = write_tmp("dsh_errors.jsonl", jsonl);
        let m = aggregate_dsh(&p).unwrap();
        assert_eq!(m.error_count, 2, "2 个 isError=true 事件");
        assert_eq!(
            m.tool_error,
            vec![("Bash".to_string(), 1), ("Edit".to_string(), 1)]
        );
    }

    #[test]
    fn aggregate_dsh_detects_repeat_run_and_idle_gap() {
        // v0.9.28: 同 kimi 算法,锚点 assistant/message.time (epoch ms)
        let jsonl = r#"{"type":"user/message","seq":1,"time":0,"data":{"content":[{"type":"text","text":"u"}]}}
{"type":"assistant/message","seq":2,"time":100,"data":{"message":{"content":[{"type":"tool-call","name":"Bash","id":"c1"}]}}}
{"type":"assistant/message","seq":3,"time":200,"data":{"message":{"content":[{"type":"tool-call","name":"Bash","id":"c2"}]}}}
{"type":"assistant/message","seq":4,"time":300,"data":{"message":{"content":[{"type":"tool-call","name":"Bash","id":"c3"}]}}}
{"type":"assistant/message","seq":5,"time":400,"data":{"message":{"content":[{"type":"tool-call","name":"Read","id":"c4"}]}}}
{"type":"assistant/message","seq":6,"time":400000,"data":{"message":{"content":[{"type":"text","text":"done"}]}}}
"#;
        let p = write_tmp("dsh_repeat.jsonl", jsonl);
        let m = aggregate_dsh(&p).unwrap();
        // 3 连续 Bash + 1 Read + 1 text-only → repeat_run_count=1 (Bash × 3 ≥ minCount=3)
        assert_eq!(m.repeat_run_count, 1);
        assert_eq!(m.repeat_run_max_tool.as_deref(), Some("Bash"));
        assert_eq!(m.repeat_run_max_count, Some(3));
        // idle_gap: 400→400000 = 399600ms ≈ 6.66min > 5min → 1 个
        assert_eq!(m.idle_gap_count, 1);
        assert!(m.idle_gap_max_ms.unwrap_or(0) >= 5 * 60 * 1000);
    }

    #[test]
    fn aggregate_dsh_thinking_count_distinguishes_reasoning_from_text() {
        // v0.9.28: reasoning → thinking_count+1, text → thinking_count 不动;两者都 +text_message_count
        let jsonl = r#"{"type":"assistant/message","seq":1,"time":1000,"data":{"message":{"content":[{"type":"reasoning","text":"r1"},{"type":"text","text":"t1"},{"type":"reasoning","text":"r2"}]}}}
{"type":"assistant/message","seq":2,"time":2000,"data":{"message":{"content":[{"type":"text","text":"t2"}]}}}
"#;
        let p = write_tmp("dsh_thinking.jsonl", jsonl);
        let m = aggregate_dsh(&p).unwrap();
        assert_eq!(m.thinking_count, 2, "2 reasoning parts");
        assert_eq!(
            m.text_message_count, 4,
            "reasoning+text 都算 text_message_count"
        );
    }

    #[test]
    fn aggregate_dsh_handles_zstd_fixture_transparently() {
        // v0.9.28: for_each_line_auto 透明支持 .jsonl.zstd — 写一个 zstd fixture 确认 aggregator 走得通
        let dir = std::env::temp_dir().join(format!("ocsv_dsh_zst_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let zst_path = dir.join("dsh.jsonl.zstd");
        let jsonl = r#"{"type":"session","agentPreset":"a","id":"s1","createdAt":1}
{"type":"user/message","seq":1,"time":100,"data":{"content":[{"type":"text","text":"u"}]}}
{"type":"assistant/message","seq":2,"time":200,"data":{"message":{"source":{"model":"m"},"content":[{"type":"text","text":"a"}]}}}
"#;
        let raw = std::fs::File::create(&zst_path).unwrap();
        let mut enc = zstd::Encoder::new(raw, 3).unwrap();
        use std::io::Write;
        enc.write_all(jsonl.as_bytes()).unwrap();
        enc.finish().unwrap();

        let m = aggregate_dsh(&zst_path).expect("aggregate_dsh over zstd");
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(m.agent_name.as_deref(), Some("a"));
        assert_eq!(m.user_message_count, 1);
        assert_eq!(m.assistant_message_count, 1);
        assert_eq!(m.available_models, vec!["m".to_string()]);
    }

    #[test]
    fn aggregate_dsh_todo_summary_uses_last_todo_write_with_completed_status() {
        // v0.9.28 (M11.3): todo/write 末次 value 聚合;status "completed" 跟 kimi 的 "done" 同义。
        // 3 次 todo/write:首次 1/2 done → 中间 2/3 done → 末次 2/4 completed。
        // 末次 todo_summary 应该是 4 total / 2 done / 1 in_progress。
        let jsonl = r#"{"type":"todo/write","seq":1,"time":100,"data":{"todos":[{"content":"a","status":"done"},{"content":"b","status":"pending"}]}}
{"type":"todo/write","seq":2,"time":200,"data":{"todos":[{"content":"a","status":"done"},{"content":"b","status":"done"},{"content":"c","status":"pending"}]}}
{"type":"todo/write","seq":3,"time":300,"data":{"todos":[{"content":"a","status":"completed"},{"content":"b","status":"completed"},{"content":"c","status":"in_progress"},{"content":"d","status":"pending"}]}}
"#;
        let p = write_tmp("dsh_todo.jsonl", jsonl);
        let m = aggregate_dsh(&p).unwrap();
        let t = m.todo_summary.expect("todo_summary 应有");
        assert_eq!(t.total, 4);
        assert_eq!(t.done, 2, "completed 算 done");
        assert_eq!(
            t.current.as_deref(),
            Some("c"),
            "首个 in_progress 的 content 作为 current"
        );
        assert_eq!(t.updated_at_ms, Some(300));
    }

    #[test]
    fn aggregate_dsh_meta_banner_fills_protocol_permission_sandbox_approval_and_request_header() {
        // v0.9.28 (M11.5): banner 全字段聚合。
        // - session.version → protocol_version
        // - permission/preset → permission_mode (独立字段,不再被 sandbox/mode 覆盖)
        // - sandbox/mode → sandbox_mode (M11.5 之前被错写到 permission_mode)
        // - approval/policy × 2 → approval_count + 首次 policy 提到 approval_policy
        //   (M11.5 之前 policy 值被丢)
        // - request/header.config.{model,reasoningEffort} → model_alias / thinking_effort
        // - request/header.tools[].length → active_tool_count
        let jsonl = r#"{"type":"session","version":0,"agentPreset":"cordis","id":"s1","createdAt":1}
{"type":"permission/preset","seq":1,"time":100,"data":{"preset":"workspace-write"}}
{"type":"sandbox/mode","seq":2,"time":101,"data":{"mode":"workspace-write"}}
{"type":"approval/policy","seq":3,"time":102,"data":{"policy":"ask"}}
{"type":"approval/policy","seq":4,"time":103,"data":{"policy":"ask"}}
{"type":"request/header","seq":5,"time":104,"data":{"header":{"config":{"provider":"deepseek-official","model":"deepseek-v4-flash","reasoningEffort":"high"},"tools":[{"name":"a"},{"name":"b"},{"name":"c"}]}}}
"#;
        let p = write_tmp("dsh_banner.jsonl", jsonl);
        let m = aggregate_dsh(&p).unwrap();
        let b = m.meta_banner.expect("meta_banner 应有");
        assert_eq!(
            b.protocol_version.as_deref(),
            Some("0"),
            "session.version=0 → \"0\""
        );
        assert_eq!(
            b.permission_mode.as_deref(),
            Some("workspace-write"),
            "permission/preset 写到 permission_mode"
        );
        assert_eq!(
            b.sandbox_mode.as_deref(),
            Some("workspace-write"),
            "M11.5: sandbox/mode 独立字段,不再覆盖 permission_mode"
        );
        assert_eq!(
            b.approval_policy.as_deref(),
            Some("ask"),
            "M11.5: 首次 approval/policy 提取 policy 值"
        );
        assert_eq!(b.approval_count, 2, "2 次 approval/policy");
        assert_eq!(b.model_alias.as_deref(), Some("deepseek-v4-flash"));
        assert_eq!(b.thinking_effort.as_deref(), Some("high"));
        assert_eq!(
            b.active_tool_count,
            Some(3),
            "request/header.tools[].length"
        );
        assert_eq!(b.config_change_count, 0, "dsh 没有 config.update event");
        assert_eq!(b.compaction_count, 0, "dsh 没有 full_compaction event");
    }

    #[test]
    fn aggregate_dsh_sandbox_mode_does_not_overwrite_permission_mode_when_different() {
        // v0.9.28 (M11.5) regression: M11.3 行为是 sandbox 后发 silent 覆盖 preset,
        // 一旦两者值不同会丢信息。真实 wire 通常同值 ("workspace-write"),但
        // sandbox 切到 docker 时必须保持 preset = "workspace-write"。
        let jsonl = r#"{"type":"permission/preset","seq":1,"time":100,"data":{"preset":"workspace-write"}}
{"type":"sandbox/mode","seq":2,"time":101,"data":{"mode":"docker"}}
"#;
        let p = write_tmp("dsh_sandbox_diff.jsonl", jsonl);
        let m = aggregate_dsh(&p).unwrap();
        let b = m.meta_banner.expect("meta_banner 应有");
        assert_eq!(b.permission_mode.as_deref(), Some("workspace-write"));
        assert_eq!(
            b.sandbox_mode.as_deref(),
            Some("docker"),
            "sandbox/mode 切到 docker 后,permission_mode 应保持 preset 值"
        );
    }
}
