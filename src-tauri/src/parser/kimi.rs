//! v0.9.0: Kimi Code wire.jsonl 归一化
//!
//! Kimi `wire.jsonl` 是 **事件流** 而非 message 流。完整 transcript 需要 state
//! machine 在多个 event 上累积,见 `normalize_session`。
//!
//! 单条事件路径 `normalize_kimi_record` 是 fallback — streaming reader
//! (`commands/transcript.rs::stream_transcript`) 一行一行喂数据,只能 emit 单
//! event 为 meta block。**完整 collapse 由调用方用 `normalize_session` 拿到
//! 整个 jsonl 后跑**(目前 export / analyze / scan_full_stats 都还没用,
//! transcript 流式路径就是单条 fallback)。
//!
//! 事件分类:
//! - `step.begin` / `step.end` — 步生命周期,state machine 状态切换
//! - `content.part` — assistant text / thinking 块
//! - `tool.call` / `tool.result` — 工具调用,parentUuid 配对
//! - `turn.prompt` — 用户输入
//! - `context.append_message` — 整条 message(非 loop,直接 role-based emit)
//! - `metadata` / `config.update` / `permission.set_mode` / `tools.set_active_tools`
//!   — 会话开头 1 条 meta,带 label + payload
//! - `llm.request` / `usage.record` — 协议层,**单条路径**仍 skip;**batch 路径**
//!   在 normalize_session 末尾聚合:v0.9.14 usage.record → 1 个 usage.chart meta
//!   (per-turn token chart), v0.9.15 llm.request → 1 个 request.chart meta
//!   (maxTokens context headroom + config drift)
//! - `llm.tools_snapshot` (v0.9.13) — 走 build_tools_snapshot_meta,
//!   详情页可见 "Tools configured for this session"
//!
//! 协议版本:
//! - `metadata.protocol_version` `1.x` 支持;`2.x` 及以上跳过该 session
//!   (`list_kimi_sessions` 阶段检查),静默拒绝未来 schema。

use std::collections::HashMap;

use serde_json::{json, Value};

use super::claude::{NormalizedBlock, NormalizedMessage};

/// Kimi `tool.result.parentUuid` 的 JSON key 名(对应 tool.call.uuid)
pub const KIMI_PARENT_KEY: &str = "parentUuid";

/// v0.9.9: dcwin11 真实样本揭示 — `context.append_loop_event` 是 envelope,
/// 内部 `event.type` 才是真正的 loop event (step.begin/content.part/tool.call/
/// tool.result)。所有 6 个 dcwin11 活跃 session 都把 step.begin 包在这里
/// (bpm-large 624/624, das-portal 127/127, platform-multiagent 123/123)。
///
/// 此函数: 从 envelope 取 inner event,merge 进 envelope 顶层字段(`time` /
/// `turnId` 等)以便后续 arm 用 `obj.get("type")` / `obj.get("time")` 路径走
/// 通。返回 owned Map 避免 borrow 跨迭代边界。
///
/// 返回 `None` 表示 envelope 缺 inner event / type — skip。
fn unwrap_loop_envelope_owned(
    envelope: &Value,
) -> Option<(serde_json::Map<String, Value>, String)> {
    let env_obj = envelope.as_object()?;
    let inner = env_obj.get("event")?.as_object()?.clone();
    // clone inner event fields, overlay envelope's top-level `time` (canonical)
    let mut merged = inner;
    if let Some(time) = env_obj.get("time") {
        merged.insert("time".to_string(), time.clone());
    }
    // inner event type 是 dispatch key
    let inner_type = merged.get("type").and_then(|v| v.as_str())?.to_string();
    Some((merged, inner_type))
}

/// v0.9.0: 单条 wire event 归一化 — 用于 streaming 路径。
///
/// 不跑 state machine;loop event 各自 emit 成 meta block。
/// `turn.prompt` → role=user, `context.append_message` → role=message.role,
/// `step.begin`/`step.end`/`content.part`/`tool.call`/`tool.result` → role=meta。
/// 协议层 event(metadata/config/permission/tools/llm/usage)→ 跳过(None)。
pub fn normalize_kimi_record(record: &Value, index: usize) -> Option<NormalizedMessage> {
    let obj = record.as_object()?;
    let r#type = obj.get("type")?.as_str()?;

    let _id = format!("kimi-{}-{}", r#type, index);
    let timestamp = obj
        .get("time")
        .and_then(|v| v.as_i64())
        .map(|ms| {
            chrono::DateTime::from_timestamp_millis(ms)
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| ms.to_string())
        })
        .or_else(|| {
            obj.get("timestamp")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        });

    match r#type {
        "turn.prompt" => Some(build_turn_prompt(obj, index, timestamp)),
        "context.append_message" => Some(build_append_message(obj, index, timestamp)),
        "metadata" | "config.update" | "permission.set_mode" | "tools.set_active_tools" => {
            Some(build_meta_from_event(obj, r#type, index, timestamp))
        }
        "step.begin" | "step.end" | "content.part" | "tool.call" | "tool.result" => {
            Some(build_loop_event_meta(obj, r#type, index, timestamp))
        }
        // v0.9.13: llm.tools_snapshot 走专属 builder (24 个 tool schema +
        // hash) — 不再 skip。详情页可见 "Tools configured for this session"。
        "llm.tools_snapshot" => Some(build_tools_snapshot_meta(obj, index, timestamp)),
        // 协议层 — 跳过 (wire 协议层细节,无 user value)
        // v0.9.14: usage.record 聚合在 normalize_session 完成 (645 → 1 chart)
        // v0.9.15: llm.request 聚合在 normalize_session 完成 (648 → 1 chart)
        "llm.request" | "usage.record" => None,
        // v0.9.10: 用户可观察事件 — emit 为 meta block 让详情页可见
        // (turn.steer 用户 mid-turn 改方向, turn.cancel 用户取消, plan_mode
        //  进入/退出 plan 模式)。permission.record_approval_result /
        // full_compaction.* / context.apply_compaction 已在
        // v0.9.8 batch path 显式 emit,streaming path 也加进来保持一致。
        //
        // v0.9.11: `plan_mode.exit` 是 kimi dcwin11 platform fixture 用的别名 —
        // wire 1.4 schema 出现 schema drift (bpm-large 用 `plan_mode.cancel`,
        // platform 用 `plan_mode.exit`,两者语义完全相同: 都是用户批准 plan 后
        // 退出 plan mode)。统一进 plan_mode arm,保留 wire 原 raw_type
        // (build_meta_from_event 用 r#type 作 raw_type,不变)。
        //
        // v0.9.16: tools.update_store 从这 arm 移除 — 单条 record 不构成 chart
        // (见同 key 处独立 arm 返回 None),aggregation 由 normalize_session 完成。
        "permission.record_approval_result"
        | "turn.steer"
        | "turn.cancel"
        | "full_compaction.begin"
        | "full_compaction.complete"
        | "plan_mode.enter"
        | "plan_mode.cancel"
        | "plan_mode.exit" => Some(build_meta_from_event(obj, r#type, index, timestamp)),
        // v0.9.16: tools.update_store 单条 event 不构成 chart → streaming 路径 skip
        // (aggregation happens in normalize_session batch path)
        "tools.update_store" => None,
        // v0.9.12: context.apply_compaction 单独走 build_apply_compaction_meta —
        // 把 summary + 压缩统计提到 block 顶层,前端 CompactionMetaBlock 直接读
        "context.apply_compaction" => Some(build_apply_compaction_meta(obj, index, timestamp)),
        // 未知 event type — emit 为 meta,不 panic
        _ => Some(build_meta_from_event(obj, r#type, index, timestamp)),
    }
}

/// v0.9.0: 跑完整 state machine,返回重建后的 NormalizedMessage 列表
///
/// 输入是整个 session 的所有 wire event(serde_json::Value 列表)。
/// 输出按 step.end 切分;每个 assistant turn 一条 NormalizedMessage。
///
/// 不调用此函数 — streaming 路径不读完整文件,无法跑 state machine。
/// 保留接口给未来 export/analyze 一次性消费的优化。
#[allow(dead_code)]
pub fn normalize_session(records: impl IntoIterator<Item = Value>) -> Vec<NormalizedMessage> {
    let mut out = Vec::new();
    let mut current: Option<StepAccumulator> = None;
    // tool.call.uuid → 在 current step 里的位置(单 step 内顺序挂 tool_result)
    let mut pending_tool_calls: HashMap<String, usize> = HashMap::new();
    // v0.9.14: 收集 usage.record event 用于末尾 emit 1 个聚合 meta (per-turn chart)
    // 645 events → 1 个聚合,避免详情页被 645 个 noise meta block 撑爆
    let mut usage_records: Vec<UsageRecord> = Vec::new();
    // v0.9.15: 收集 llm.request event 用于末尾 emit 1 个聚合 request.chart meta
    // (context headroom + config drift detection)。648 events → 1 个聚合,
    // 跟 usage.chart 同模式 (单条 emit 会撑爆详情页)。
    let mut request_records: Vec<RequestRecord> = Vec::new();
    // v0.9.16: 收集 tools.update_store event 用于末尾 emit 1 个聚合 todos.chart meta
    // (LLM plan execution narrative: 状态机信号 + churn)。57 events → 1 个聚合,
    // 跟 usage.chart / request.chart 同模式 (单条 emit 会撑爆详情页)。
    let mut todo_records: Vec<TodoRecord> = Vec::new();

    for (idx, record) in records.into_iter().enumerate() {
        // v0.9.9: dcwin11 真实样本揭示 — `context.append_loop_event` 是 envelope,
        // 内部 `event.type` 才是真正的 loop event (step.begin/content.part/
        // tool.call/tool.result)。之前 fall-through 到 catch-all arm emit 成 meta
        // block,导致所有 assistant message + tool_use 全部丢失。
        // 解法: 顶部 unwrap — 把 inner event 提升为 effective obj,overlay envelope
        // 的 time 字段(inner event 一般没有顶层 time)。
        let obj_owned;
        let obj =
            if record.get("type").and_then(|v| v.as_str()) == Some("context.append_loop_event") {
                let Some((inner_map, _)) = unwrap_loop_envelope_owned(&record) else {
                    continue;
                };
                obj_owned = Value::Object(inner_map);
                obj_owned.as_object().expect("just constructed")
            } else {
                let Some(o) = record.as_object() else {
                    continue;
                };
                o
            };
        let r#type = match obj.get("type").and_then(|v| v.as_str()) {
            Some(t) => t,
            None => continue,
        };
        match r#type {
            "step.begin" => {
                if let Some(acc) = current.take() {
                    out.push(acc.into_message());
                }
                current = Some(StepAccumulator::new(idx));
            }
            "step.end" => {
                if let Some(acc) = current.take() {
                    out.push(acc.into_message());
                }
            }
            "content.part" => {
                if let Some(acc) = current.as_mut() {
                    acc.append_content_part(obj);
                } else {
                    out.push(normalize_kimi_record(&record, idx).unwrap_or_else(|| {
                        build_meta_from_object(obj, "kimi.orphan_content_part", idx, None)
                    }));
                }
            }
            "tool.call" => {
                if let Some(uuid) = obj.get("uuid").and_then(|v| v.as_str()) {
                    let name = obj.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                    let args = obj.get("args").cloned().unwrap_or(Value::Null);
                    let description = obj
                        .get("description")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    let block_idx = if let Some(acc) = current.as_mut() {
                        acc.blocks.push(NormalizedBlock {
                            kind: "tool_use".to_string(),
                            data: serde_json::Map::from_iter(
                                [
                                    ("name".to_string(), Value::String(name.to_string())),
                                    ("input".to_string(), args),
                                ]
                                .into_iter()
                                .chain(
                                    description
                                        .map(|d| ("description".to_string(), Value::String(d))),
                                ),
                            ),
                        });
                        acc.blocks.len() - 1
                    } else {
                        out.push(normalize_kimi_record(&record, idx).unwrap_or_else(|| {
                            build_meta_from_object(obj, "kimi.orphan_tool_call", idx, None)
                        }));
                        continue;
                    };
                    pending_tool_calls.insert(uuid.to_string(), block_idx);
                }
            }
            "tool.result" => {
                let lookup_uuid = obj
                    .get(KIMI_PARENT_KEY)
                    .and_then(|v| v.as_str())
                    .or_else(|| obj.get("toolCallId").and_then(|v| v.as_str()));
                if let Some(uuid) = lookup_uuid {
                    if let Some(&block_idx) = pending_tool_calls.get(uuid) {
                        let result = obj.get("result").cloned().unwrap_or(Value::Null);
                        let is_error = result.get("error").is_some();
                        let content = result
                            .get("output")
                            .cloned()
                            .or_else(|| result.get("error").cloned())
                            .unwrap_or(Value::Null);
                        if let Some(acc) = current.as_mut() {
                            if let Some(block) = acc.blocks.get_mut(block_idx) {
                                block
                                    .data
                                    .insert("is_error".to_string(), Value::Bool(is_error));
                                block.data.insert("content".to_string(), content.clone());
                                // 升级 block.kind tool_use → tool_result? 保留 tool_use + 添 tool_result 兄弟
                                acc.blocks.push(NormalizedBlock {
                                    kind: "tool_result".to_string(),
                                    data: serde_json::Map::from_iter([
                                        ("content".to_string(), content),
                                        ("is_error".to_string(), Value::Bool(is_error)),
                                    ]),
                                });
                            }
                        }
                    } else {
                        // 没找到配对 → emit 为 orphan meta
                        out.push(normalize_kimi_record(&record, idx).unwrap_or_else(|| {
                            build_meta_from_object(obj, "kimi.orphan_tool_result", idx, None)
                        }));
                    }
                }
            }
            "turn.prompt" => {
                if let Some(acc) = current.take() {
                    out.push(acc.into_message());
                }
                out.push(build_turn_prompt(obj, idx, extract_time(obj)));
            }
            // v0.9.8: 完整 wire event type 集合 — 之前 streaming 路径只 emit 4 个,
            // 实际 dcwin11 真实 schema 含 17 个 top-level event。详情页应全部可见
            // (meta block),即便被顶部 MetaBanner 折叠也是 collapse 后的可见。
            // compaction 事件单独 routing 到 build_meta_from_event — generate 阶段
            // 会从 payload.time / summary 提取 summary_len / begin_time 等显示信息。
            // 各事件独立 emit (而非 begin+complete 配对) 因为 normalize_session 是单
            // pass — UI 在 normalize_kimi_record 这边拿到 raw payload 自行配对。
            "metadata"
            | "config.update"
            | "permission.set_mode"
            | "tools.set_active_tools"
            | "permission.record_approval_result"
            | "full_compaction.begin"
            | "full_compaction.complete"
            | "turn.steer"
            | "turn.cancel"
            | "plan_mode.enter"
            | "plan_mode.cancel"
            | "plan_mode.exit" => {
                out.push(build_meta_from_event(obj, r#type, idx, extract_time(obj)));
            }
            // v0.9.12: 同 streaming 路径 — context.apply_compaction 走专属 builder
            "context.apply_compaction" => {
                out.push(build_apply_compaction_meta(obj, idx, extract_time(obj)));
            }
            // v0.9.13: llm.tools_snapshot — 走专属 builder 不再 skip
            "llm.tools_snapshot" => {
                out.push(build_tools_snapshot_meta(obj, idx, extract_time(obj)));
            }
            // v0.9.14: usage.record 不在此 emit (645 event 单条 emit 会撑爆详情页),
            // 而是在循环末尾聚合为 1 个 usage.chart meta block (per-turn chart + 22
            // 个 session-scope compaction-aligned subsection)。单条记录仍 capture
            // 到 usage_records vector 供末尾 emit。
            "usage.record" => {
                if let Some(u) = parse_usage_record(obj) {
                    usage_records.push(u);
                }
            }
            // v0.9.15: llm.request 不在此 emit (648 event 单条 emit 会撑爆详情页),
            // 而是在循环末尾聚合为 1 个 request.chart meta block (maxTokens context
            // headroom + toolsHash/systemPromptHash drift detection + loop/compaction
            // kind 分流)。单条记录 capture 到 request_records vector 供末尾 emit。
            "llm.request" => {
                if let Some(r) = parse_request_record(obj) {
                    request_records.push(r);
                }
            }
            // v0.9.16: tools.update_store 不在此 emit (57 events 单条 emit 会撑爆
            // 详情页),而是在循环末尾聚合为 1 个 todos.chart meta block (LLM plan
            // execution narrative: 状态机 + churn detection)。单条记录 capture 到
            // todo_records vector 供末尾 emit。
            "tools.update_store" => {
                if let Some(t) = parse_todo_record(obj) {
                    todo_records.push(t);
                }
            }
            _ => {
                // 单条 fallback — 协议层跳过 (llm.request/usage.record/etc.)
                if let Some(n) = normalize_kimi_record(&record, idx) {
                    out.push(n);
                }
            }
        }
    }
    if let Some(acc) = current.take() {
        out.push(acc.into_message());
    }
    // v0.9.14: 末尾 emit 1 个 usage.chart meta block (聚合 645 events)
    // 0 events → 不 emit (空 meta 没 user value)
    if !usage_records.is_empty() {
        let chart_idx = out.len();
        if let Some(chart_msg) = build_usage_chart_meta(&usage_records, chart_idx) {
            out.push(chart_msg);
        }
    }
    // v0.9.15: 末尾 emit 1 个 request.chart meta block (聚合 648 events)
    // 0 events → 不 emit。放在 usage.chart 之后,UI 顺序: user → assistant → ...
    // → compaction meta → tools snapshot → usage.chart → request.chart
    if !request_records.is_empty() {
        let chart_idx = out.len();
        if let Some(chart_msg) = build_request_chart_meta(&request_records, chart_idx) {
            out.push(chart_msg);
        }
    }
    // v0.9.16: 末尾 emit 1 个 todos.chart meta block (聚合 57 events)
    // 0 events → 不 emit。放在 request.chart 之后,UI 顺序: user → assistant → ...
    // → compaction meta → tools snapshot → usage.chart → request.chart → todos.chart
    if !todo_records.is_empty() {
        let chart_idx = out.len();
        if let Some(chart_msg) = build_todo_chart_meta(&todo_records, chart_idx) {
            out.push(chart_msg);
        }
    }
    out
}

/// Step accumulator — 在 step.begin → step.end 期间累积 blocks
struct StepAccumulator {
    blocks: Vec<NormalizedBlock>,
    started_at: Option<String>,
}

impl StepAccumulator {
    fn new(_start_idx: usize) -> Self {
        Self {
            blocks: Vec::new(),
            started_at: None,
        }
    }

    fn append_content_part(&mut self, obj: &serde_json::Map<String, Value>) {
        // v0.9.9: dcwin11 揭示 — `obj.part` 是 object `{type, text|think}`,不是
        // 字符串。之前 `obj.get("part").as_str()` 永远 None,part_type 落空 → 全部
        // 走 `_ => "text"` 兜底,thinking 块全部错误归类为 text。同时实际 part.type
        // 值是 "think"(不是 "thinking")。
        let part = obj.get("part").and_then(|v| v.as_object());
        let part_type = part
            .and_then(|p| p.get("type"))
            .and_then(|t| t.as_str())
            .unwrap_or("");
        let role = obj
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("assistant");
        let mut data = serde_json::Map::new();
        let kind = match part_type {
            // 真实 dcwin11 wire 用 "think" — 保留 "thinking" 兼容未来 schema
            "think" | "thinking" => {
                // thinking content 在 obj.part.think (wire v1.4 验证)
                let think_text = part
                    .and_then(|p| p.get("think"))
                    .and_then(|t| t.as_str())
                    .or_else(|| obj.get("text").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .to_string();
                data.insert("thinking".to_string(), Value::String(think_text));
                "thinking"
            }
            "text" => {
                // text content 在 obj.part.text
                let text_content = part
                    .and_then(|p| p.get("text"))
                    .and_then(|t| t.as_str())
                    .or_else(|| obj.get("text").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .to_string();
                data.insert("text".to_string(), Value::String(text_content));
                "text"
            }
            _ => {
                // 未知 part.type → 兜底从 obj.text 或 obj.content 取
                if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                    data.insert("text".to_string(), Value::String(text.to_string()));
                } else if let Some(content) = obj.get("content") {
                    data.insert("content".to_string(), content.clone());
                }
                "text"
            }
        };
        if self.started_at.is_none() {
            self.started_at = extract_time_from_obj(obj);
        }
        let _ = role; // 当前未用;保留给未来按 role 分块
        self.blocks.push(NormalizedBlock {
            kind: kind.to_string(),
            data,
        });
    }

    fn into_message(self) -> NormalizedMessage {
        NormalizedMessage {
            id: format!("kimi-step-{}", uuid_v4_like()),
            role: "assistant".to_string(),
            timestamp: self.started_at,
            blocks: self.blocks,
            model: None,
            stop_reason: None,
            token_usage: None,
            is_sidechain: None,
            subagent_id: None,
            parent_uuid: None,
            raw_type: "kimi.step".to_string(),
        }
    }
}

fn uuid_v4_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", n)
}

fn extract_time(obj: &serde_json::Map<String, Value>) -> Option<String> {
    extract_time_from_obj(obj)
}

fn extract_time_from_obj(obj: &serde_json::Map<String, Value>) -> Option<String> {
    obj.get("time")
        .and_then(|v| v.as_i64())
        .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms).map(|dt| dt.to_rfc3339()))
}

fn build_turn_prompt(
    obj: &serde_json::Map<String, Value>,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let text = obj
        .get("input")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find_map(|b| b.get("text").and_then(|t| t.as_str()).map(String::from))
        })
        .unwrap_or_default();
    let mut data = serde_json::Map::new();
    data.insert("text".to_string(), Value::String(text));
    NormalizedMessage {
        id: format!("kimi-turn_prompt-{}", index),
        role: "user".to_string(),
        timestamp,
        blocks: vec![NormalizedBlock {
            kind: "text".to_string(),
            data,
        }],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: "turn.prompt".to_string(),
    }
}

fn build_append_message(
    obj: &serde_json::Map<String, Value>,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let message = obj.get("message");
    let role = message
        .and_then(|m| m.get("role"))
        .and_then(|v| v.as_str())
        .unwrap_or("user")
        .to_string();
    let content = message
        .and_then(|m| m.get("content"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut data = serde_json::Map::new();
    data.insert("text".to_string(), content);
    NormalizedMessage {
        id: format!("kimi-append_message-{}", index),
        role,
        timestamp,
        blocks: vec![NormalizedBlock {
            kind: "text".to_string(),
            data,
        }],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: "context.append_message".to_string(),
    }
}

fn build_meta_from_event(
    obj: &serde_json::Map<String, Value>,
    type_label: &str,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    build_meta_from_object(obj, type_label, index, timestamp)
}

fn build_loop_event_meta(
    obj: &serde_json::Map<String, Value>,
    type_label: &str,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let mut data = serde_json::Map::new();
    data.insert(
        "label".to_string(),
        Value::String(format!("kimi.{}", type_label)),
    );
    data.insert("payload".to_string(), Value::Object(obj.clone()));
    NormalizedMessage {
        id: format!("kimi-{}-{}", type_label, index),
        role: "meta".to_string(),
        timestamp,
        blocks: vec![NormalizedBlock {
            kind: "meta".to_string(),
            data,
        }],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: type_label.to_string(),
    }
}

fn build_meta_from_object(
    obj: &serde_json::Map<String, Value>,
    label: &str,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let mut data = serde_json::Map::new();
    data.insert("label".to_string(), Value::String(label.to_string()));
    data.insert("payload".to_string(), Value::Object(obj.clone()));
    NormalizedMessage {
        id: format!("kimi-{}-{}", label, index),
        role: "meta".to_string(),
        timestamp,
        blocks: vec![NormalizedBlock {
            kind: "meta".to_string(),
            data,
        }],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: label.to_string(),
    }
}

/// v0.9.12: `context.apply_compaction` 专属 builder — 把 LLM 生成的 summary 文本
/// 和压缩统计提到 block 顶层,让前端 CompactionMetaBlock 能直接渲染,不用再
/// 走 UnknownBlockCard 让用户手动展开看 raw JSON。
///
/// dcwin11 bpm-large 真实 schema (`apply_compaction` 携带):
/// - `summary` (str) — LLM 生成的交接笔记,中文叙述当前任务/已确认决策/下一步
/// - `contextSummary` (str) — kimi 写给 LLM 的"上下文已压缩,以下是摘要"系统 prompt
/// - `tokensBefore` (u64) — 压缩前 token 数
/// - `tokensAfter` (u64) — 压缩后 token 数
/// - `compactedCount` (u64) — 被压缩的消息数
/// - `keptUserMessageCount` (u64) — 保留的用户消息数
///
/// `compression_ratio` 自动计算 (tokensBefore/tokensAfter),若除 0 或缺失则 None。
fn build_apply_compaction_meta(
    obj: &serde_json::Map<String, Value>,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let mut data = serde_json::Map::new();
    data.insert(
        "label".to_string(),
        Value::String("context.apply_compaction".to_string()),
    );

    // 顶层字段 — 跟 kimi 其他 meta block 的 `label` + `payload` 风格保持一致,
    // payload 也保留 (back-compat,任何消费 payload 的前端逻辑不破)。
    let tokens_before = obj
        .get("tokensBefore")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            obj.get("tokensBefore")
                .and_then(|v| v.as_i64())
                .and_then(|n| u64::try_from(n).ok())
        });
    let tokens_after = obj.get("tokensAfter").and_then(|v| v.as_u64()).or_else(|| {
        obj.get("tokensAfter")
            .and_then(|v| v.as_i64())
            .and_then(|n| u64::try_from(n).ok())
    });
    let compacted_count = obj
        .get("compactedCount")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            obj.get("compactedCount")
                .and_then(|v| v.as_i64())
                .and_then(|n| u64::try_from(n).ok())
        });
    let kept_user_count = obj
        .get("keptUserMessageCount")
        .and_then(|v| v.as_u64())
        .or_else(|| {
            obj.get("keptUserMessageCount")
                .and_then(|v| v.as_i64())
                .and_then(|n| u64::try_from(n).ok())
        });

    if let Some(s) = obj.get("summary").and_then(|v| v.as_str()) {
        data.insert("summary".to_string(), Value::String(s.to_string()));
    }
    if let Some(s) = obj.get("contextSummary").and_then(|v| v.as_str()) {
        data.insert("context_summary".to_string(), Value::String(s.to_string()));
    }
    if let Some(n) = tokens_before {
        data.insert("tokens_before".to_string(), Value::from(n));
    }
    if let Some(n) = tokens_after {
        data.insert("tokens_after".to_string(), Value::from(n));
    }
    if let Some(n) = compacted_count {
        data.insert("compacted_count".to_string(), Value::from(n));
    }
    if let Some(n) = kept_user_count {
        data.insert("kept_user_message_count".to_string(), Value::from(n));
    }

    // 压缩比 — tokens_before/tokens_after,f64;缺失/除 0 留 None
    let compression_ratio = match (tokens_before, tokens_after) {
        (Some(b), Some(a)) if a > 0 => Some(b as f64 / a as f64),
        _ => None,
    };
    if let Some(r) = compression_ratio {
        if let Some(num) = serde_json::Number::from_f64(r) {
            data.insert("compression_ratio".to_string(), Value::Number(num));
        }
    }

    // 原始 payload 也保留 — 任何旧逻辑 (UnknownBlockCard 等) 还能用
    data.insert("payload".to_string(), Value::Object(obj.clone()));

    NormalizedMessage {
        id: format!("kimi-apply_compaction-{}", index),
        role: "meta".to_string(),
        timestamp,
        blocks: vec![NormalizedBlock {
            kind: "meta".to_string(),
            data,
        }],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: "context.apply_compaction".to_string(),
    }
}

/// v0.9.13: `llm.tools_snapshot` 走专属 builder — kimi session 启动时 dump
/// 的完整 tool schema (Agent / Bash / Read / Edit / TodoList 等 20+ 工具 +
/// 长 description + SHA256 hash)。之前 protocol-layer skip 路径直接 `None`,
/// 详情页完全不可见。但 user value 很高: "这个 session 配了哪些 tool?" 是
/// 理解 session 行为的基础信息 (比如能调 AgentSwarm / CronCreate 的 session
/// 跟只能用基础 tool 的 session 行为模式完全不同)。
///
/// Builder 策略:
/// - `tool_count` → 顶层数字
/// - `tool_names` → 顶层字符串数组 (按 wire 原顺序)
/// - `tool_descriptions` → 顶层 Map<name, 截断到 120 字符的 description>
///   (LLM 看到的完整 prompt 摘要;raw 完整版在 payload 里)
/// - `snapshot_hash` → 顶层字符串 (LLM 缓存键, 跨 session 共享相同 tool 配置
///   时可以 dedup)
/// - `payload` 保留 raw event — back-compat 老数据消费方
///
/// Wire 原 raw_type ("llm.tools_snapshot") 保留 — UI 后续如想区分
/// "snapshot 来自 kimi v1.4 / v1.5" 有依据。
fn build_tools_snapshot_meta(
    obj: &serde_json::Map<String, Value>,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let mut data = serde_json::Map::new();
    data.insert(
        "label".to_string(),
        Value::String("llm.tools_snapshot".to_string()),
    );

    let hash = obj.get("hash").and_then(|v| v.as_str()).map(String::from);
    if let Some(h) = &hash {
        data.insert("snapshot_hash".to_string(), Value::String(h.clone()));
    }

    // tools[] → 顶层 tool_names + tool_count + tool_descriptions
    let tools = obj.get("tools").and_then(|v| v.as_array());
    let tool_names: Vec<String> = tools
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    data.insert(
        "tool_count".to_string(),
        Value::from(tool_names.len() as u64),
    );
    data.insert(
        "tool_names".to_string(),
        Value::Array(
            tool_names
                .iter()
                .map(|n| Value::String(n.clone()))
                .collect(),
        ),
    );

    // tool_descriptions — Map<name, truncated desc>;raw 完整版在 payload 里。
    // 截断 120 字符防止 meta block 撑爆 (LLM 看到 tool 时附的 doc 经常
    // 300-500 字符; 24 个 tool 全展开 ~6KB)。
    if let Some(arr) = tools {
        let mut descs = serde_json::Map::new();
        for t in arr {
            if let (Some(name), Some(desc)) = (
                t.get("name").and_then(|n| n.as_str()),
                t.get("description").and_then(|d| d.as_str()),
            ) {
                let truncated: String = desc.chars().take(120).collect();
                let truncated = if desc.chars().count() > 120 {
                    format!("{truncated}…")
                } else {
                    truncated
                };
                descs.insert(name.to_string(), Value::String(truncated));
            }
        }
        data.insert("tool_descriptions".to_string(), Value::Object(descs));
    }

    // 原始 payload — back-compat 任何消费完整 payload 的逻辑
    data.insert("payload".to_string(), Value::Object(obj.clone()));

    NormalizedMessage {
        id: format!("kimi-tools_snapshot-{index}"),
        role: "meta".to_string(),
        timestamp,
        blocks: vec![NormalizedBlock {
            kind: "meta".to_string(),
            data,
        }],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: "llm.tools_snapshot".to_string(),
    }
}

/// v0.9.14: usage.record 内部 struct — 4 维度 token + scope + time
///
/// 单条 wire event:
/// ```json
/// {"type":"usage.record","model":"deepseek-v4-flash","usage":{"inputOther":21841,"output":220,"inputCacheRead":0,"inputCacheCreation":0},"usageScope":"turn","time":1785915243417}
/// ```
#[derive(Debug, Clone)]
struct UsageRecord {
    model: String,
    input_other: u64,
    output: u64,
    input_cache_read: u64,
    input_cache_creation: u64,
    usage_scope: String, // "turn" | "session" (后者 1:1 配对 apply_compaction)
    time: u64,
}

/// v0.9.14: 从 raw usage.record wire event 提取关键字段
fn parse_usage_record(obj: &serde_json::Map<String, Value>) -> Option<UsageRecord> {
    let model = obj
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let usage = obj.get("usage").and_then(|v| v.as_object())?;
    let input_other = usage
        .get("inputOther")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output = usage.get("output").and_then(|v| v.as_u64()).unwrap_or(0);
    let input_cache_read = usage
        .get("inputCacheRead")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let input_cache_creation = usage
        .get("inputCacheCreation")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let usage_scope = obj
        .get("usageScope")
        .and_then(|v| v.as_str())
        .unwrap_or("turn")
        .to_string();
    let time = obj.get("time").and_then(|v| v.as_u64()).unwrap_or(0);
    Some(UsageRecord {
        model,
        input_other,
        output,
        input_cache_read,
        input_cache_creation,
        usage_scope,
        time,
    })
}

/// v0.9.14: 645 (或 N) 个 usage.record event → 1 个聚合 meta block
///
/// 设计动机 (跟 v0.9.13 tools_snapshot 区别):
/// - tools_snapshot: 1 session 1 event,单条 emit 没问题
/// - usage.record: 1 session 645 events,单条 emit 会撑爆详情页
///   解决:在 `normalize_session` 末尾聚合,emit 1 个 meta,带:
/// - 顶层 stats: total_tokens / input_other / output / input_cache_read /
///   input_cache_creation / cache_hit_ratio / turn_count / session_scope_count /
///   first_token_at / last_token_at / duration_ms / model
/// - buckets[]: 60 个时间窗口(若 events < 60 则 1:1对应), 每个含
///   bucket_start / input_other / output / input_cache_read / turn_count
///   (前端 inline SVG stacked bar chart 直接渲染)
/// - session_scope_events[]: session-scope (跟 apply_compaction 1:1) 的 22 条
///   compaction-aligned snapshot,前端 subsection 显示
/// - payload.raw_events: 前 5 + 后 5 raw event sample (drill-down)
///
/// wire 原 raw_type "usage.record" 保留 — UI 后续版本可识别。
fn build_usage_chart_meta(
    usage_records: &[UsageRecord],
    index: usize,
) -> Option<NormalizedMessage> {
    if usage_records.is_empty() {
        return None;
    }

    // 1. 分离 turn-scope vs session-scope
    let turn_records: Vec<&UsageRecord> = usage_records
        .iter()
        .filter(|r| r.usage_scope == "turn")
        .collect();
    let session_scope: Vec<&UsageRecord> = usage_records
        .iter()
        .filter(|r| r.usage_scope == "session")
        .collect();

    // 2. 顶层 stats
    let total_input_other: u64 = turn_records.iter().map(|r| r.input_other).sum();
    let total_output: u64 = turn_records.iter().map(|r| r.output).sum();
    let total_cache_read: u64 = turn_records.iter().map(|r| r.input_cache_read).sum();
    let total_cache_creation: u64 = turn_records.iter().map(|r| r.input_cache_creation).sum();
    let total_tokens = total_input_other + total_output + total_cache_read + total_cache_creation;
    let input_total = total_input_other + total_cache_read;
    let cache_hit_ratio = if input_total > 0 {
        Some(total_cache_read as f64 / input_total as f64)
    } else {
        None
    };

    let first_token_at = usage_records.iter().map(|r| r.time).min().unwrap_or(0);
    let last_token_at = usage_records.iter().map(|r| r.time).max().unwrap_or(0);
    let duration_ms = last_token_at.saturating_sub(first_token_at);
    let model = usage_records
        .iter()
        .find_map(|r| {
            if !r.model.is_empty() {
                Some(r.model.clone())
            } else {
                None
            }
        })
        .unwrap_or_default();

    // 3. 时间窗口 bucketing — N events → ≤ BUCKET_TARGET 个 bucket
    // BUCKET_TARGET=60: 645 events → 60 buckets (~12.5min/bar), 视觉得当
    // 少于 60 events → 1:1 对应 (最大化分辨率)
    // 算法: bucket_count = min(N, BUCKET_TARGET). 若 N ≤ BUCKET_TARGET → 1:1
    // 对应;若 N > BUCKET_TARGET → ceil(N/BUCKET_TARGET) events/bucket,前面
    // (N % BUCKET_TARGET) 个 bucket 多 1 event. 200 events / 60 buckets →
    // 4 events/bucket,但 ceil(200/60)=4, 50 个 bucket 全部分配,空 bucket
    // 不 emit (cap 60 → 实际 50).
    const BUCKET_TARGET: usize = 60;
    let bucket_count = turn_records.len().clamp(1, BUCKET_TARGET);
    let mut buckets: Vec<serde_json::Value> = Vec::with_capacity(bucket_count);
    if !turn_records.is_empty() {
        let time_start = turn_records.first().map(|r| r.time).unwrap_or(0);
        let time_end = turn_records.last().map(|r| r.time).unwrap_or(0);
        let span = time_end.saturating_sub(time_start).max(1);
        let n = turn_records.len();
        let base_size = n / bucket_count; // 200/60 = 3
        let extra_count = n % bucket_count; // 200 % 60 = 20
        let mut start = 0usize;
        for i in 0..bucket_count {
            let size = base_size + if i < extra_count { 1 } else { 0 };
            let end = (start + size).min(n);
            if start >= n || size == 0 {
                break; // N ≤ BUCKET_TARGET 时只 emit 实际有的 bucket
            }
            let slice = &turn_records[start..end];
            let b_input_other: u64 = slice.iter().map(|r| r.input_other).sum();
            let b_output: u64 = slice.iter().map(|r| r.output).sum();
            let b_cache_read: u64 = slice.iter().map(|r| r.input_cache_read).sum();
            let b_cache_creation: u64 = slice.iter().map(|r| r.input_cache_creation).sum();
            // bucket_start/bucket_end: 估算时间窗口 (linear interpolation)
            let bucket_start = time_start + (span * start as u64) / n as u64;
            let bucket_end = time_start + (span * end as u64) / n as u64;
            buckets.push(json!({
                "bucket_start": bucket_start,
                "bucket_end": bucket_end,
                "input_other": b_input_other,
                "output": b_output,
                "input_cache_read": b_cache_read,
                "input_cache_creation": b_cache_creation,
                "turn_count": (end - start) as u32,
            }));
            start = end;
        }
    }

    // 4. session_scope_events — 22 个 compaction-aligned snapshot
    let session_scope_events: Vec<serde_json::Value> = session_scope
        .iter()
        .map(|r| {
            json!({
                "time": r.time,
                "input_other": r.input_other,
                "output": r.output,
                "input_cache_read": r.input_cache_read,
                "input_cache_creation": r.input_cache_creation,
            })
        })
        .collect();

    // 5. raw payload sample — 前 5 + 后 5 raw event (drill-down)
    let raw_events: Vec<serde_json::Value> = if usage_records.len() <= 10 {
        usage_records.iter().map(raw_event_value).collect()
    } else {
        let head: Vec<serde_json::Value> = usage_records[..5].iter().map(raw_event_value).collect();
        let tail: Vec<serde_json::Value> = usage_records[usage_records.len() - 5..]
            .iter()
            .map(raw_event_value)
            .collect();
        head.into_iter().chain(tail).collect()
    };

    // 6. 顶层 data 字段
    let mut data = serde_json::Map::new();
    data.insert(
        "label".to_string(),
        Value::String("usage.chart".to_string()),
    );
    data.insert("total_tokens".to_string(), Value::from(total_tokens));
    data.insert("input_other".to_string(), Value::from(total_input_other));
    data.insert("output".to_string(), Value::from(total_output));
    data.insert(
        "input_cache_read".to_string(),
        Value::from(total_cache_read),
    );
    data.insert(
        "input_cache_creation".to_string(),
        Value::from(total_cache_creation),
    );
    if let Some(r) = cache_hit_ratio {
        if let Some(n) = serde_json::Number::from_f64(r) {
            data.insert("cache_hit_ratio".to_string(), Value::Number(n));
        }
    }
    data.insert("model".to_string(), Value::String(model));
    data.insert(
        "turn_count".to_string(),
        Value::from(turn_records.len() as u64),
    );
    data.insert(
        "session_scope_count".to_string(),
        Value::from(session_scope.len() as u64),
    );
    data.insert("first_token_at".to_string(), Value::from(first_token_at));
    data.insert("last_token_at".to_string(), Value::from(last_token_at));
    data.insert("duration_ms".to_string(), Value::from(duration_ms));
    data.insert("buckets".to_string(), Value::Array(buckets));
    data.insert(
        "session_scope_events".to_string(),
        Value::Array(session_scope_events),
    );
    // raw payload — 用于 back-compat 任何消费完整数据的逻辑
    data.insert(
        "payload".to_string(),
        json!({
            "raw_events": raw_events,
            "raw_count": usage_records.len(),
        }),
    );

    let timestamp =
        chrono::DateTime::from_timestamp_millis(first_token_at as i64).map(|dt| dt.to_rfc3339());

    Some(NormalizedMessage {
        id: format!("kimi-usage-chart-{index}"),
        role: "meta".to_string(),
        timestamp,
        blocks: vec![NormalizedBlock {
            kind: "meta".to_string(),
            data,
        }],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: "usage.record".to_string(),
    })
}

/// v0.9.14: 把 UsageRecord 渲染回 wire 原始 JSON shape (drill-down sample 用)
fn raw_event_value(r: &UsageRecord) -> serde_json::Value {
    json!({
        "type": "usage.record",
        "model": r.model,
        "usage": {
            "inputOther": r.input_other,
            "output": r.output,
            "inputCacheRead": r.input_cache_read,
            "inputCacheCreation": r.input_cache_creation,
        },
        "usageScope": r.usage_scope,
        "time": r.time,
    })
}

/// v0.9.15: llm.request 内部 struct — context headroom + drift detection +
/// compaction-vs-loop 分流
///
/// 单条 wire event:
/// ```json
/// {"type":"llm.request","kind":"loop","provider":"openai","model":"deepseek-v4-flash","maxTokens":131072,"toolsHash":"22f4...","systemPromptHash":"b0e8...","messageCount":1,"turnStep":"0.1","time":1785915236910}
/// ```
#[derive(Debug, Clone)]
struct RequestRecord {
    model: String,
    provider: String,
    kind: String, // "loop" | "compaction" — loop 是常规 turn LLM 调用,compaction 是 summary/compact 触发
    max_tokens: u64, // 上下文剩余预算 (输出 token 上限);prompt 越长,值越低
    message_count: u32, // 累计消息数 (session 长度 trace)
    turn_index: u32, // turnStep "8.29" → 8
    step_index: u32, // turnStep "8.29" → 29
    tools_hash: String, // tool config fingerprint — 跨 session 不变 = 配置稳定
    system_prompt_hash: String, // system prompt fingerprint — 跨 session 变化 = 配置 drift
    system_prompt_inline: bool, // 本 event 是否携带完整 system_prompt 文本
    time: u64,
}

/// v0.9.15: 从 raw llm.request wire event 提取关键字段
fn parse_request_record(obj: &serde_json::Map<String, Value>) -> Option<RequestRecord> {
    let model = obj
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let provider = obj
        .get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let kind = obj
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("loop")
        .to_string();
    let max_tokens = obj.get("maxTokens").and_then(|v| v.as_u64()).unwrap_or(0);
    let message_count = obj
        .get("messageCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let turn_step = obj
        .get("turnStep")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0");
    let (turn_index, step_index) = match turn_step.split_once('.') {
        Some((t, s)) => (t.parse::<u32>().unwrap_or(0), s.parse::<u32>().unwrap_or(0)),
        None => (turn_step.parse::<u32>().unwrap_or(0), 0),
    };
    let tools_hash = obj
        .get("toolsHash")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let system_prompt_hash = obj
        .get("systemPromptHash")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // 判定: 顶层带 systemPrompt 字段且是 string → 携带完整文本 (罕见, 首次 hash 引入)
    let system_prompt_inline = obj.get("systemPrompt").and_then(|v| v.as_str()).is_some();
    let time = obj.get("time").and_then(|v| v.as_u64()).unwrap_or(0);
    Some(RequestRecord {
        model,
        provider,
        kind,
        max_tokens,
        message_count,
        turn_index,
        step_index,
        tools_hash,
        system_prompt_hash,
        system_prompt_inline,
        time,
    })
}

/// v0.9.15: 648 个 llm.request event → 1 个聚合 request.chart meta block
///
/// 跟 v0.9.14 usage.chart 区别:
/// - usage.chart: per-turn token 成本 (input/output/cache 4 维度)
/// - request.chart: per-turn **context headroom** (maxTokens 随时间变化) +
///   **config drift detection** (toolsHash / systemPromptHash 跨 session 稳定性)
///   + **kind 分流** (loop vs compaction LLM 调用)
///
/// 设计动机:
/// - v0.9.14 揭示 "cacheRead 主导成本" (91.2%) — 用户关心 "我花了多少"
/// - v0.9.15 揭示 "上下文还剩多少" + "我的 kimi session 中途切换了几次
///   system prompt" — bpm-large 实测: 23 个独立 system_prompt_hash,
///   23 个 compaction kind LLM 调用,tools_hash 全程稳定 (0 drift)
/// - 648 单条 emit 会撑爆详情页,聚合为 1 个 meta
///
/// 顶层 stats:
/// - request_count, kind_loop, kind_compaction, compaction_pct
/// - max_tokens_min / max_tokens_max / max_tokens_avg
/// - message_count_min / max, turn_index_range (e.g. "0..18")
/// - tools_hash baseline + drift_count
/// - system_prompt_hash_distinct (跨 session 出现的独立 hash 数)
/// - model, provider, duration_ms
///
/// buckets[] (60 时间窗口):
/// - bucket_start / bucket_end (ms 时间戳)
/// - max_tokens_min / max_tokens_max / max_tokens_avg (单 bucket 内所有请求)
/// - request_count / kind_compaction_count
///
/// system_prompt_drift_events[]:
/// - 每个新 hash 第一次出现的时间戳 + 该 hash 的 request_index
/// - system_prompt_inline 标记是否该 event 携带了完整 system prompt 文本
///
/// payload.raw_events: 前 5 + 后 5 raw request event (drill-down)
fn build_request_chart_meta(
    request_records: &[RequestRecord],
    index: usize,
) -> Option<NormalizedMessage> {
    if request_records.is_empty() {
        return None;
    }

    // 1. kind 分流 — loop vs compaction
    let loop_count = request_records.iter().filter(|r| r.kind == "loop").count();
    let compaction_count = request_records
        .iter()
        .filter(|r| r.kind == "compaction")
        .count();
    let total = request_records.len();
    let compaction_pct = if total > 0 {
        Some(compaction_count as f64 / total as f64)
    } else {
        None
    };

    // 2. max_tokens stats
    let max_tokens_min = request_records
        .iter()
        .map(|r| r.max_tokens)
        .min()
        .unwrap_or(0);
    let max_tokens_max = request_records
        .iter()
        .map(|r| r.max_tokens)
        .max()
        .unwrap_or(0);
    let max_tokens_sum: u64 = request_records.iter().map(|r| r.max_tokens).sum();
    let max_tokens_avg = if total > 0 {
        max_tokens_sum / total as u64
    } else {
        0
    };

    // 3. message_count / turn_index range
    let message_count_min = request_records
        .iter()
        .map(|r| r.message_count)
        .min()
        .unwrap_or(0);
    let message_count_max = request_records
        .iter()
        .map(|r| r.message_count)
        .max()
        .unwrap_or(0);
    let turn_index_min = request_records
        .iter()
        .map(|r| r.turn_index)
        .min()
        .unwrap_or(0);
    let turn_index_max = request_records
        .iter()
        .map(|r| r.turn_index)
        .max()
        .unwrap_or(0);

    // 4. hash drift detection
    //    tools_hash: 取最高频 hash 为 baseline,统计 drift_count
    //    system_prompt_hash: 独立值计数 (无 baseline — drift 是 signal 本身)
    let mut tools_hash_count: HashMap<&str, usize> = HashMap::new();
    let mut distinct_system_prompt_hashes: std::collections::BTreeSet<&str> =
        std::collections::BTreeSet::new();
    for r in request_records {
        if !r.tools_hash.is_empty() {
            *tools_hash_count.entry(r.tools_hash.as_str()).or_insert(0) += 1;
        }
        if !r.system_prompt_hash.is_empty() {
            distinct_system_prompt_hashes.insert(r.system_prompt_hash.as_str());
        }
    }
    let (tools_hash_baseline, tools_hash_drift_count) =
        match tools_hash_count.iter().max_by_key(|(_, c)| *c) {
            Some((baseline_hash, baseline_count)) => {
                let drift = total - baseline_count;
                (baseline_hash.to_string(), drift)
            }
            None => (String::new(), 0),
        };

    // 5. model / provider — 取第一个非空
    let model = request_records
        .iter()
        .find_map(|r| {
            if !r.model.is_empty() {
                Some(r.model.clone())
            } else {
                None
            }
        })
        .unwrap_or_default();
    let provider = request_records
        .iter()
        .find_map(|r| {
            if !r.provider.is_empty() {
                Some(r.provider.clone())
            } else {
                None
            }
        })
        .unwrap_or_default();

    // 6. 时间 stats
    let first_request_at = request_records.iter().map(|r| r.time).min().unwrap_or(0);
    let last_request_at = request_records.iter().map(|r| r.time).max().unwrap_or(0);
    let duration_ms = last_request_at.saturating_sub(first_request_at);

    // 7. 时间窗口 bucketing — 跟 v0.9.14 同算法
    const BUCKET_TARGET: usize = 60;
    let bucket_count = request_records.len().clamp(1, BUCKET_TARGET);
    let mut buckets: Vec<serde_json::Value> = Vec::with_capacity(bucket_count);
    let time_start = request_records.first().map(|r| r.time).unwrap_or(0);
    let time_end = request_records.last().map(|r| r.time).unwrap_or(0);
    let span = time_end.saturating_sub(time_start).max(1);
    let n = request_records.len();
    let base_size = n / bucket_count;
    let extra_count = n % bucket_count;
    let mut start = 0usize;
    for i in 0..bucket_count {
        let size = base_size + if i < extra_count { 1 } else { 0 };
        let end = (start + size).min(n);
        if start >= n || size == 0 {
            break;
        }
        let slice = &request_records[start..end];
        let b_max_min: u64 = slice.iter().map(|r| r.max_tokens).min().unwrap_or(0);
        let b_max_max: u64 = slice.iter().map(|r| r.max_tokens).max().unwrap_or(0);
        let b_max_sum: u64 = slice.iter().map(|r| r.max_tokens).sum();
        let b_max_avg = b_max_sum / slice.len() as u64;
        let b_compaction_count = slice.iter().filter(|r| r.kind == "compaction").count();
        let bucket_start = time_start + (span * start as u64) / n as u64;
        let bucket_end = time_start + (span * end as u64) / n as u64;
        buckets.push(json!({
            "bucket_start": bucket_start,
            "bucket_end": bucket_end,
            "max_tokens_min": b_max_min,
            "max_tokens_max": b_max_max,
            "max_tokens_avg": b_max_avg,
            "request_count": slice.len() as u32,
            "kind_compaction_count": b_compaction_count as u32,
        }));
        start = end;
    }

    // 8. system_prompt_drift_events — 每个新 hash 第一次出现的时间
    let mut seen_hashes: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut drift_events: Vec<serde_json::Value> = Vec::new();
    for (i, r) in request_records.iter().enumerate() {
        if r.system_prompt_hash.is_empty() {
            continue;
        }
        if seen_hashes.insert(r.system_prompt_hash.as_str()) {
            drift_events.push(json!({
                "time": r.time,
                "hash": r.system_prompt_hash,
                "request_index": i as u32,
                "system_prompt_inline": r.system_prompt_inline,
                "max_tokens": r.max_tokens,
                "kind": r.kind,
            }));
        }
    }

    // 9. raw payload sample — 前 5 + 后 5 raw event (drill-down)
    let raw_events: Vec<serde_json::Value> = if request_records.len() <= 10 {
        request_records
            .iter()
            .map(raw_request_event_value)
            .collect()
    } else {
        let head: Vec<serde_json::Value> = request_records[..5]
            .iter()
            .map(raw_request_event_value)
            .collect();
        let tail: Vec<serde_json::Value> = request_records[request_records.len() - 5..]
            .iter()
            .map(raw_request_event_value)
            .collect();
        head.into_iter().chain(tail).collect()
    };

    // 10. 顶层 data 字段
    let mut data = serde_json::Map::new();
    data.insert(
        "label".to_string(),
        Value::String("request.chart".to_string()),
    );
    data.insert("request_count".to_string(), Value::from(total as u64));
    data.insert("kind_loop".to_string(), Value::from(loop_count as u64));
    data.insert(
        "kind_compaction".to_string(),
        Value::from(compaction_count as u64),
    );
    if let Some(p) = compaction_pct {
        if let Some(n) = serde_json::Number::from_f64(p) {
            data.insert("compaction_pct".to_string(), Value::Number(n));
        }
    }
    data.insert("max_tokens_min".to_string(), Value::from(max_tokens_min));
    data.insert("max_tokens_max".to_string(), Value::from(max_tokens_max));
    data.insert("max_tokens_avg".to_string(), Value::from(max_tokens_avg));
    data.insert(
        "message_count_min".to_string(),
        Value::from(message_count_min as u64),
    );
    data.insert(
        "message_count_max".to_string(),
        Value::from(message_count_max as u64),
    );
    data.insert(
        "turn_index_min".to_string(),
        Value::from(turn_index_min as u64),
    );
    data.insert(
        "turn_index_max".to_string(),
        Value::from(turn_index_max as u64),
    );
    data.insert(
        "tools_hash_baseline".to_string(),
        Value::String(tools_hash_baseline.clone()),
    );
    data.insert(
        "tools_hash_drift_count".to_string(),
        Value::from(tools_hash_drift_count as u64),
    );
    data.insert(
        "system_prompt_hash_distinct".to_string(),
        Value::from(distinct_system_prompt_hashes.len() as u64),
    );
    data.insert("model".to_string(), Value::String(model));
    data.insert("provider".to_string(), Value::String(provider));
    data.insert(
        "first_request_at".to_string(),
        Value::from(first_request_at),
    );
    data.insert("last_request_at".to_string(), Value::from(last_request_at));
    data.insert("duration_ms".to_string(), Value::from(duration_ms));
    data.insert("buckets".to_string(), Value::Array(buckets));
    data.insert(
        "system_prompt_drift_events".to_string(),
        Value::Array(drift_events),
    );
    // raw payload — 用于 back-compat
    data.insert(
        "payload".to_string(),
        json!({
            "raw_events": raw_events,
            "raw_count": request_records.len(),
        }),
    );

    let timestamp =
        chrono::DateTime::from_timestamp_millis(first_request_at as i64).map(|dt| dt.to_rfc3339());

    Some(NormalizedMessage {
        id: format!("kimi-request-chart-{index}"),
        role: "meta".to_string(),
        timestamp,
        blocks: vec![NormalizedBlock {
            kind: "meta".to_string(),
            data,
        }],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: "llm.request".to_string(),
    })
}

/// v0.9.15: 把 RequestRecord 渲染回 wire 原始 JSON shape (drill-down sample 用)
fn raw_request_event_value(r: &RequestRecord) -> serde_json::Value {
    json!({
        "type": "llm.request",
        "kind": r.kind,
        "provider": r.provider,
        "model": r.model,
        "maxTokens": r.max_tokens,
        "messageCount": r.message_count,
        "turnStep": format!("{}.{}", r.turn_index, r.step_index),
        "toolsHash": r.tools_hash,
        "systemPromptHash": r.system_prompt_hash,
        "systemPromptInline": r.system_prompt_inline,
        "time": r.time,
    })
}

/// v0.9.16: tools.update_store 内部 struct — todo 状态 + churn detection
///
/// 单条 wire event:
/// ```json
/// {"type":"tools.update_store","key":"todo","value":[{"title":"...","status":"done"},...],"time":1785915308477}
/// ```
#[derive(Debug, Clone)]
struct TodoRecord {
    items: Vec<TodoItem>, // 全量快照 (4-8 items, 跟 wire 完全一致)
    item_count: u32,
    done_count: u32,
    in_progress_count: u32,
    pending_count: u32,
    time: u64,
}

#[derive(Debug, Clone)]
struct TodoItem {
    title: String,
    status: String, // "done" | "in_progress" | "pending"
}

/// v0.9.16: 从 raw tools.update_store wire event 提取关键字段
fn parse_todo_record(obj: &serde_json::Map<String, Value>) -> Option<TodoRecord> {
    let key = obj.get("key").and_then(|v| v.as_str()).unwrap_or("");
    if key != "todo" {
        return None; // skip non-todo update_store
    }
    let value = obj.get("value")?.as_array()?;
    let mut items: Vec<TodoItem> = Vec::with_capacity(value.len());
    let mut done_count = 0u32;
    let mut in_progress_count = 0u32;
    let mut pending_count = 0u32;
    for item in value {
        let title = item
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let status = item
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("pending")
            .to_string();
        if title.is_empty() {
            continue; // skip nameless items
        }
        match status.as_str() {
            "done" => done_count += 1,
            "in_progress" => in_progress_count += 1,
            _ => pending_count += 1,
        }
        items.push(TodoItem { title, status });
    }
    let item_count = items.len() as u32;
    let time = obj.get("time").and_then(|v| v.as_u64()).unwrap_or(0);
    Some(TodoRecord {
        items,
        item_count,
        done_count,
        in_progress_count,
        pending_count,
        time,
    })
}

/// v0.9.16: 57 个 tools.update_store event → 1 个聚合 todos.chart meta block
///
/// 跟 v0.9.14 / v0.9.15 区别:
/// - usage.chart: per-turn token 成本 (连续值随时间变化)
/// - request.chart: per-turn context headroom (连续值随时间变化)
/// - todos.chart: LLM plan execution narrative (状态机信号, 跨 event 跟踪 task
///   生命周期 + churn)
///
/// 设计动机:
/// - 当前 v0.9.8 把 57 个 update_store event 单独 emit 成 57 个 raw meta block,
///   详情页被撑爆 (95% 都是 todo noise)
/// - bpm-large 实测: 57 events / 91 unique titles / 47 churn events / 166 done
///   累计 / 92 pending 累计
/// - 用户角度: 想知道 "LLM 计划了什么 → 完成了什么 → 哪些任务中途被重写"
///
/// 顶层 stats:
/// - update_count, unique_task_count, current_done/in_progress/pending
///   (末次 snapshot 状态 — 跟 v0.9.15 drift_events 显示 "新 hash 第一次出现"
///   同思路)
/// - churn_count (add + remove 事件数), churn_add_count, churn_remove_count
/// - status_total: 跨全 session 的 done/in_progress/pending 累计 (类似
///   v0.9.14 total_tokens)
/// - first_update_at, last_update_at, duration_ms
///
/// buckets[] (60 时间窗口):
/// - bucket_start / bucket_end (ms 时间戳)
/// - item_count / done_count / in_progress_count / pending_count
///
/// completed_tasks[]:
/// - 每个 unique title → 第一次 seen as "done" 的时间戳 + update_index
/// - 按 done 时间升序 (用户最关心的 "完成列表" 在前)
///
/// churn_events[]:
/// - add: 新 title 第一次出现 (NOT in prior snapshots)
/// - remove: 已知 title 在 snapshot 中消失 (was in prior, NOT in current)
/// - 每个含 timestamp + title + action ("add" | "remove")
///
/// payload.raw_events: 前 5 + 后 5 raw event (drill-down)
#[allow(clippy::too_many_lines)]
fn build_todo_chart_meta(todo_records: &[TodoRecord], index: usize) -> Option<NormalizedMessage> {
    if todo_records.is_empty() {
        return None;
    }

    let total = todo_records.len();

    // 1. 末次 snapshot 状态 (current_done/in_progress/pending)
    let last = todo_records.last().unwrap();
    let current_done = last.done_count;
    let current_in_progress = last.in_progress_count;
    let current_pending = last.pending_count;

    // 2. 跨全 session 累计 (status_total)
    let total_done: u32 = todo_records.iter().map(|r| r.done_count).sum();
    let total_in_progress: u32 = todo_records.iter().map(|r| r.in_progress_count).sum();
    let total_pending: u32 = todo_records.iter().map(|r| r.pending_count).sum();

    // 3. unique task tracking + churn detection
    let mut seen_titles: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut unique_titles: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut completed_tasks: std::collections::BTreeMap<String, (u64, u32)> =
        std::collections::BTreeMap::new(); // title → (done_time, update_index)
    let mut churn_events: Vec<serde_json::Value> = Vec::new();

    for (i, rec) in todo_records.iter().enumerate() {
        // 当前 snapshot 的所有 title
        let current_titles: std::collections::HashSet<String> =
            rec.items.iter().map(|it| it.title.clone()).collect();

        // 1) 找 add events (新 title)
        for title in &current_titles {
            if seen_titles.insert(title.clone()) {
                // 第一次见 → add
                unique_titles.insert(title.clone());
                if let Some(item) = rec.items.iter().find(|it| &it.title == title) {
                    churn_events.push(json!({
                        "time": rec.time,
                        "title": title,
                        "action": "add",
                        "update_index": i as u32,
                        "initial_status": item.status,
                    }));
                }
            }
        }

        // 2) 找 remove events (prior snapshot 有, current 没有)
        if i > 0 {
            let prior_titles: std::collections::HashSet<String> = todo_records[i - 1]
                .items
                .iter()
                .map(|it| it.title.clone())
                .collect();
            for title in &prior_titles {
                if !current_titles.contains(title) {
                    churn_events.push(json!({
                        "time": rec.time,
                        "title": title,
                        "action": "remove",
                        "update_index": i as u32,
                    }));
                }
            }
        }

        // 3) 找 done transitions (item.status == "done" 且之前不是 done)
        for item in &rec.items {
            if item.status == "done" && !completed_tasks.contains_key(&item.title) {
                completed_tasks.insert(item.title.clone(), (rec.time, i as u32));
            }
        }
    }

    let unique_task_count = unique_titles.len() as u32;
    let churn_add_count = churn_events
        .iter()
        .filter(|e| e.get("action").and_then(|v| v.as_str()) == Some("add"))
        .count() as u32;
    let churn_remove_count = churn_events
        .iter()
        .filter(|e| e.get("action").and_then(|v| v.as_str()) == Some("remove"))
        .count() as u32;
    let churn_count = churn_add_count + churn_remove_count;

    // 4. 时间 stats
    let first_update_at = todo_records.iter().map(|r| r.time).min().unwrap_or(0);
    let last_update_at = todo_records.iter().map(|r| r.time).max().unwrap_or(0);
    let duration_ms = last_update_at.saturating_sub(first_update_at);

    // 5. 60 buckets (跟 v0.9.14 / v0.9.15 同 BUCKET_TARGET)
    const BUCKET_TARGET: usize = 60;
    let bucket_count = todo_records.len().clamp(1, BUCKET_TARGET);
    let mut buckets: Vec<serde_json::Value> = Vec::with_capacity(bucket_count);
    let time_start = todo_records.first().map(|r| r.time).unwrap_or(0);
    let time_end = todo_records.last().map(|r| r.time).unwrap_or(0);
    let span = time_end.saturating_sub(time_start).max(1);
    let n = todo_records.len();
    let base_size = n / bucket_count;
    let extra_count = n % bucket_count;
    let mut start = 0usize;
    for i in 0..bucket_count {
        let size = base_size + if i < extra_count { 1 } else { 0 };
        let end = (start + size).min(n);
        if start >= n || size == 0 {
            break;
        }
        let slice = &todo_records[start..end];
        let b_item_count: u32 = slice.iter().map(|r| r.item_count).sum();
        let b_done: u32 = slice.iter().map(|r| r.done_count).sum();
        let b_in_progress: u32 = slice.iter().map(|r| r.in_progress_count).sum();
        let b_pending: u32 = slice.iter().map(|r| r.pending_count).sum();
        let bucket_start = time_start + (span * start as u64) / n as u64;
        let bucket_end = time_start + (span * end as u64) / n as u64;
        buckets.push(json!({
            "bucket_start": bucket_start,
            "bucket_end": bucket_end,
            "item_count": b_item_count,
            "done_count": b_done,
            "in_progress_count": b_in_progress,
            "pending_count": b_pending,
        }));
        start = end;
    }

    // 6. completed_tasks 按 done 时间排序 (前端直接渲染)
    let mut completed_tasks_vec: Vec<(String, u64, u32)> = completed_tasks
        .into_iter()
        .map(|(title, (done_time, update_idx))| (title, done_time, update_idx))
        .collect();
    completed_tasks_vec.sort_by_key(|(_, done_time, _)| *done_time);

    // 7. raw payload sample (drill-down)
    let raw_events: Vec<serde_json::Value> = if todo_records.len() <= 10 {
        todo_records.iter().map(raw_todo_event_value).collect()
    } else {
        let head: Vec<serde_json::Value> =
            todo_records[..5].iter().map(raw_todo_event_value).collect();
        let tail: Vec<serde_json::Value> = todo_records[todo_records.len() - 5..]
            .iter()
            .map(raw_todo_event_value)
            .collect();
        head.into_iter().chain(tail).collect()
    };

    // 8. 顶层 data 字段
    let mut data = serde_json::Map::new();
    data.insert(
        "label".to_string(),
        Value::String("todos.chart".to_string()),
    );
    data.insert("update_count".to_string(), Value::from(total as u64));
    data.insert(
        "unique_task_count".to_string(),
        Value::from(unique_task_count as u64),
    );
    data.insert("current_done".to_string(), Value::from(current_done as u64));
    data.insert(
        "current_in_progress".to_string(),
        Value::from(current_in_progress as u64),
    );
    data.insert(
        "current_pending".to_string(),
        Value::from(current_pending as u64),
    );
    data.insert("total_done".to_string(), Value::from(total_done as u64));
    data.insert(
        "total_in_progress".to_string(),
        Value::from(total_in_progress as u64),
    );
    data.insert(
        "total_pending".to_string(),
        Value::from(total_pending as u64),
    );
    data.insert("churn_count".to_string(), Value::from(churn_count as u64));
    data.insert(
        "churn_add_count".to_string(),
        Value::from(churn_add_count as u64),
    );
    data.insert(
        "churn_remove_count".to_string(),
        Value::from(churn_remove_count as u64),
    );
    data.insert("first_update_at".to_string(), Value::from(first_update_at));
    data.insert("last_update_at".to_string(), Value::from(last_update_at));
    data.insert("duration_ms".to_string(), Value::from(duration_ms));
    data.insert("buckets".to_string(), Value::Array(buckets));
    data.insert(
        "completed_tasks".to_string(),
        Value::Array(
            completed_tasks_vec
                .into_iter()
                .map(|(title, done_time, update_idx)| {
                    json!({
                        "title": title,
                        "done_time": done_time,
                        "update_index": update_idx,
                    })
                })
                .collect(),
        ),
    );
    data.insert("churn_events".to_string(), Value::Array(churn_events));
    data.insert(
        "payload".to_string(),
        json!({
            "raw_events": raw_events,
            "raw_count": todo_records.len(),
        }),
    );

    let timestamp =
        chrono::DateTime::from_timestamp_millis(first_update_at as i64).map(|dt| dt.to_rfc3339());

    Some(NormalizedMessage {
        id: format!("kimi-todo-chart-{index}"),
        role: "meta".to_string(),
        timestamp,
        blocks: vec![NormalizedBlock {
            kind: "meta".to_string(),
            data,
        }],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: "tools.update_store".to_string(),
    })
}

/// v0.9.16: 把 TodoRecord 渲染回 wire 原始 JSON shape (drill-down sample 用)
fn raw_todo_event_value(r: &TodoRecord) -> serde_json::Value {
    json!({
        "type": "tools.update_store",
        "key": "todo",
        "value": r.items.iter().map(|it| json!({
            "title": it.title,
            "status": it.status,
        })).collect::<Vec<_>>(),
        "time": r.time,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::jsonl;
    use serde_json::json;

    #[test]
    fn metadata_emits_meta_with_protocol_version() {
        let rec =
            json!({"type":"metadata","protocol_version":"1.4","created_at":1784625400276_u64});
        let n = normalize_kimi_record(&rec, 0).expect("metadata emits");
        assert_eq!(n.role, "meta");
        assert_eq!(n.raw_type, "metadata");
        assert_eq!(n.blocks[0].kind, "meta");
    }

    #[test]
    fn turn_prompt_emits_user_role() {
        let rec = json!({
            "type":"turn.prompt",
            "input":[{"type":"text","text":"看一下我的配置可以吗"}],
            "origin":{"kind":"user"},
            "time":1784625411216_u64
        });
        let n = normalize_kimi_record(&rec, 1).expect("turn.prompt emits");
        assert_eq!(n.role, "user");
        assert_eq!(n.blocks[0].kind, "text");
        assert_eq!(
            n.blocks[0].data.get("text").unwrap().as_str().unwrap(),
            "看一下我的配置可以吗"
        );
    }

    #[test]
    fn append_message_emits_role_from_message() {
        let rec = json!({
            "type":"context.append_message",
            "message":{"role":"user","content":[{"type":"text","text":"hi"}],"toolCalls":[]},
            "time":1784625411217_u64
        });
        let n = normalize_kimi_record(&rec, 2).expect("append_message emits");
        assert_eq!(n.role, "user");
        assert_eq!(n.raw_type, "context.append_message");
    }

    #[test]
    fn protocol_layer_events_return_none() {
        // v0.9.10: 真正"协议层"(无 user value) — llm.request / usage.record。
        // v0.9.13: `llm.tools_snapshot` 不再 skip — 走 build_tools_snapshot_meta
        // (24 个 tool schema + hash),验下面的 `tools_snapshot_emits_meta_with_tools_and_hash`。
        // 其余 v0.9.8 之前 skip 的事件 (turn.steer / cancel / plan_mode.* /
        // permission.record_approval_result / tools.update_store / compaction.*)
        // 现在都 emit 为 meta block。
        for ty in ["llm.request", "usage.record"] {
            let rec = json!({"type": ty, "time": 1_u64});
            assert!(
                normalize_kimi_record(&rec, 0).is_none(),
                "{} should skip",
                ty
            );
        }
    }

    #[test]
    fn tools_snapshot_emits_meta_with_tools_and_hash() {
        // v0.9.13: llm.tools_snapshot 不再 skip — 走 build_tools_snapshot_meta
        // 把 tool count + name + description + hash 提到 block 顶层。
        let rec = json!({
            "type": "llm.tools_snapshot",
            "time": 1_u64,
            "hash": "abc123",
            "tools": [
                {"name": "Bash", "description": "Run a shell command."},
                {"name": "Read", "description": "Read a file."},
            ],
        });
        let n = normalize_kimi_record(&rec, 0).expect("llm.tools_snapshot emits");
        assert_eq!(n.role, "meta");
        assert_eq!(n.raw_type, "llm.tools_snapshot");
        let block = &n.blocks[0];
        assert_eq!(block.kind, "meta");
        assert_eq!(
            block.data.get("snapshot_hash").unwrap().as_str().unwrap(),
            "abc123"
        );
        assert_eq!(block.data.get("tool_count").unwrap().as_u64().unwrap(), 2);
        let names = block
            .data
            .get("tool_names")
            .unwrap()
            .as_array()
            .expect("tool_names is array");
        assert_eq!(names.len(), 2);
        assert_eq!(names[0].as_str().unwrap(), "Bash");
        assert_eq!(names[1].as_str().unwrap(), "Read");
        // description 提到顶层 tool_descriptions (raw payload 仍保留)
        let descs = block
            .data
            .get("tool_descriptions")
            .unwrap()
            .as_object()
            .expect("tool_descriptions is map");
        assert_eq!(
            descs.get("Bash").unwrap().as_str().unwrap(),
            "Run a shell command."
        );
        assert!(block.data.get("payload").is_some(), "payload preserved");
    }

    #[test]
    fn tools_snapshot_truncates_long_descriptions() {
        // 120 字符截断 — 防止 meta block 撑爆 (LLM 看到 tool 时附的 doc 经常
        // 300-500 字符, 24 个 tool 全展开 ~6KB)。
        let long_desc = "x".repeat(300);
        let rec = json!({
            "type": "llm.tools_snapshot",
            "time": 1_u64,
            "hash": "h",
            "tools": [{"name": "Big", "description": long_desc}],
        });
        let n = normalize_kimi_record(&rec, 0).expect("emit");
        let descs = n.blocks[0]
            .data
            .get("tool_descriptions")
            .unwrap()
            .as_object()
            .unwrap();
        let truncated = descs.get("Big").unwrap().as_str().unwrap();
        // 120 chars + ellipsis char "…"
        assert!(
            truncated.chars().count() <= 121,
            "expected ≤121 chars, got {}",
            truncated.chars().count()
        );
        assert!(truncated.ends_with('…'), "should end with ellipsis");
    }

    #[test]
    fn tools_snapshot_handles_missing_tools_array() {
        // 健壮性: 没 tools 字段 → tool_count=0 + tool_names=[] 但仍然 emit
        let rec = json!({
            "type": "llm.tools_snapshot",
            "time": 1_u64,
            "hash": "h",
        });
        let n = normalize_kimi_record(&rec, 0).expect("emit");
        assert_eq!(n.role, "meta");
        assert_eq!(
            n.blocks[0]
                .data
                .get("tool_count")
                .unwrap()
                .as_u64()
                .unwrap(),
            0
        );
        assert_eq!(
            n.blocks[0]
                .data
                .get("tool_names")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            0
        );
        // hash 仍保留
        assert_eq!(
            n.blocks[0]
                .data
                .get("snapshot_hash")
                .unwrap()
                .as_str()
                .unwrap(),
            "h"
        );
    }

    #[test]
    fn normalize_session_v0913_bpm_large_tools_snapshot_has_24_tools() {
        // v0.9.13: bpm-large 真实样本 6040 行验证 — 1 条 llm.tools_snapshot, 24 个 tool
        let path = std::path::Path::new("<redacted-fixture>-v0913.jsonl");
        if !path.exists() {
            // fixture missing — 在其他 cwd 跑 cargo test 时 skip
            eprintln!("skip: {} not found", path.display());
            return;
        }
        let bytes = std::fs::read(path).expect("read fixture");
        let mut records = Vec::new();
        for line in bytes.split(|b| *b == b'\n') {
            if line.is_empty() {
                continue;
            }
            records.push(serde_json::from_slice::<serde_json::Value>(line).expect("parse jsonl"));
        }
        let out = normalize_session(records);
        let snapshot_msgs: Vec<_> = out
            .iter()
            .filter(|m| m.raw_type == "llm.tools_snapshot")
            .collect();
        assert_eq!(
            snapshot_msgs.len(),
            1,
            "expected exactly 1 llm.tools_snapshot meta block"
        );
        let block = &snapshot_msgs[0].blocks[0];
        assert_eq!(
            block.data.get("tool_count").unwrap().as_u64().unwrap(),
            24,
            "bpm-large has 24 tools"
        );
        let names = block.data.get("tool_names").unwrap().as_array().unwrap();
        let names_str: Vec<&str> = names.iter().map(|v| v.as_str().unwrap()).collect();
        // 关键 tool 都在 (代表 session 能调 subagent / task / cron)
        for expected in ["Agent", "Bash", "Read", "Edit", "TodoList", "CronCreate"] {
            assert!(
                names_str.contains(&expected),
                "expected tool {expected} in {names_str:?}"
            );
        }
        // hash 透传
        let h = block.data.get("snapshot_hash").unwrap().as_str().unwrap();
        assert_eq!(h.len(), 64, "sha256 hex = 64 chars, got {h:?}");
    }

    #[test]
    fn user_observable_events_emit_meta_block_in_streaming_path() {
        // v0.9.10: turn.steer / turn.cancel / plan_mode.enter / plan_mode.cancel
        // 在 streaming normalize_kimi_record 路径下也 emit meta block (不再 skip)。
        // v0.9.11: `plan_mode.exit` (dcwin11 platform fixture schema drift,语义同
        // plan_mode.cancel — 用户批准 plan 退出) 同样显式 emit,不再走 catch-all。
        for ty in [
            "turn.steer",
            "turn.cancel",
            "plan_mode.enter",
            "plan_mode.cancel",
            "plan_mode.exit",
        ] {
            let rec = json!({"type": ty, "time": 1_u64});
            let n =
                normalize_kimi_record(&rec, 0).unwrap_or_else(|| panic!("{} should emit meta", ty));
            assert_eq!(n.role, "meta", "{} role", ty);
            assert_eq!(n.raw_type, ty, "{} raw_type", ty);
        }
    }

    #[test]
    fn unknown_event_type_emits_meta_not_panic() {
        let rec = json!({"type":"future-event-type","time":1_u64,"data":42});
        let n = normalize_kimi_record(&rec, 0).expect("unknown emits meta");
        assert_eq!(n.role, "meta");
        assert_eq!(n.raw_type, "future-event-type");
    }

    #[test]
    fn loop_event_in_streaming_falls_back_to_meta() {
        // streaming reader 一次只能拿到一条 event — 应该 emit 为 meta
        let rec = json!({"type":"step.begin","uuid":"abc","turnId":"1","step":1,"time":1_u64});
        let n = normalize_kimi_record(&rec, 3).expect("loop event emits meta");
        assert_eq!(n.role, "meta");
        assert_eq!(n.raw_type, "step.begin");
    }

    #[test]
    fn session_collapses_step_into_assistant_message() {
        // 完整 state machine — step.begin → content.part → tool.call → tool.result → step.end
        let records = vec![
            json!({"type":"metadata","protocol_version":"1.4","created_at":1_u64}),
            json!({"type":"step.begin","uuid":"s1","turnId":"1","step":1,"time":100_u64}),
            json!({"type":"content.part","role":"assistant","part":"text","text":"hi there","time":101_u64}),
            json!({"type":"tool.call","uuid":"tc1","toolCallId":"tc1","name":"Bash","args":{"command":"ls"},"time":102_u64}),
            json!({"type":"tool.result","parentUuid":"tc1","toolCallId":"tc1","result":{"output":"file.txt"},"time":103_u64}),
            json!({"type":"step.end","time":104_u64}),
            json!({"type":"turn.prompt","input":[{"type":"text","text":"next question"}],"time":105_u64}),
        ];
        let out = normalize_session(records);
        // 期望: 1 个 step (assistant: 1 text + 1 tool_use + 1 tool_result) + 1 turn.prompt (user) = 2
        // metadata 不计入 (被 normalize_kimi_record 跳过 — 这里走 normalize_session 的 event match
        // 直接 build_meta_from_event 入 out)
        // 故: 1 metadata + 1 assistant step + 1 user turn = 3
        assert!(
            out.len() >= 2,
            "expected at least 2 messages, got {} ({:?})",
            out.len(),
            out
        );
        // assistant 角色有 tool_use + tool_result 块
        let assistant = out
            .iter()
            .find(|n| n.role == "assistant")
            .expect("assistant present");
        assert!(assistant.blocks.iter().any(|b| b.kind == "text"));
        assert!(assistant.blocks.iter().any(|b| b.kind == "tool_use"));
        assert!(assistant.blocks.iter().any(|b| b.kind == "tool_result"));
        // user 角色来自 turn.prompt
        let user = out.iter().find(|n| n.role == "user").expect("user present");
        assert_eq!(
            user.blocks[0].data.get("text").unwrap().as_str().unwrap(),
            "next question"
        );
    }

    #[test]
    fn tool_result_unpaired_falls_back_to_meta() {
        // 没看到 tool.call,直接 tool.result → emit 为 orphan meta
        let rec = json!({"type":"tool.result","parentUuid":"missing","toolCallId":"missing","result":{"output":"x"},"time":1_u64});
        // 单条路径走 normalize_kimi_record: 是 loop event → emit meta (不 panic)
        let n = normalize_kimi_record(&rec, 0).expect("tool.result emits meta");
        assert_eq!(n.role, "meta");
    }

    #[test]
    fn normalize_session_emits_compaction_events_as_meta() {
        // v0.9.8: full_compaction.begin/complete + context.apply_compaction 都是
        // meta emit 类型 — 详情页 transcript 应可见,顶部 MetaBanner 折叠显示
        // 总数 (compaction_count)。
        let records = vec![
            json!({"type":"metadata","protocol_version":"1.4","created_at":1_u64}),
            json!({
                "type":"full_compaction.begin",
                "uuid":"fc-begin-1",
                "time":1000_u64,
                "context_window_tokens":128000
            }),
            json!({
                "type":"full_compaction.complete",
                "uuid":"fc-complete-1",
                "time":1100_u64,
                "duration_ms": 100_u64,
                "summary_token_count": 512
            }),
            json!({
                "type":"context.apply_compaction",
                "time":1101_u64,
                "applied_compaction_id":"fc-complete-1"
            }),
            json!({"type":"full_compaction.begin","uuid":"fc-begin-2","time":2000_u64}),
            json!({
                "type":"full_compaction.complete",
                "uuid":"fc-complete-2",
                "time":2100_u64,
                "duration_ms": 80_u64
            }),
        ];
        let out = normalize_session(records);

        // 6 事件 → 6 meta blocks (compaction 事件独立 emit,非配对压缩)
        let compaction_metas: Vec<&NormalizedMessage> = out
            .iter()
            .filter(|n| {
                matches!(
                    n.raw_type.as_str(),
                    "full_compaction.begin"
                        | "full_compaction.complete"
                        | "context.apply_compaction"
                )
            })
            .collect();
        assert_eq!(
            compaction_metas.len(),
            5,
            "expected 5 compaction-related meta blocks, got {} ({:?})",
            compaction_metas.len(),
            out
        );

        // 每个 compaction 事件都是 role=meta,kind=meta
        for m in &compaction_metas {
            assert_eq!(m.role, "meta");
            assert_eq!(m.blocks[0].kind, "meta");
            assert!(
                m.blocks[0].data.get("label").is_some(),
                "label should be preserved on compaction meta block"
            );
        }

        // 验证 timestamp 透传 — full_compaction.begin.time=1000 → rfc3339
        let begin1 = compaction_metas
            .iter()
            .find(|m| m.raw_type == "full_compaction.begin" && m.id.contains("4"))
            .expect("first begin");
        assert!(
            begin1.timestamp.is_some(),
            "compaction events should carry rfc3339 timestamp"
        );
    }

    #[test]
    fn normalize_session_emits_tools_update_store_and_permission_approval_as_meta() {
        // v0.9.8: TodoWrite (tools.update_store{key:"todo"}) 和
        // permission.record_approval_result 同样应作为 meta block 出现在
        // 详情页 — 给用户完整的"配置/权限变更"timeline 视图。
        //
        // v0.9.16: tools.update_store 不再单独 emit 成 meta block,而是 batch
        // path 末尾聚合成 1 个 todos.chart meta (raw_type 仍 "tools.update_store",
        // 跟 build_todo_chart_meta builder 一致)。permission.record_approval_result
        // 仍 emit 成 meta block。
        let records = vec![
            json!({"type":"metadata","protocol_version":"1.4","created_at":1_u64}),
            json!({
                "type":"tools.update_store",
                "key":"todo",
                "value":[
                    {"title":"first","status":"done"},
                    {"title":"second","status":"in_progress"}
                ],
                "time":100_u64
            }),
            json!({
                "type":"permission.record_approval_result",
                "request_id":"req-1",
                "decision":"approve",
                "time":200_u64
            }),
            json!({
                "type":"config.update",
                "config":{"modelAlias":"deepseek-v4-flash","thinkingEffort":"high"},
                "time":300_u64
            }),
        ];
        let out = normalize_session(records);

        // metadata + todos.chart (聚合) + approval + config = 4 meta blocks
        let meta_blocks: Vec<&NormalizedMessage> =
            out.iter().filter(|n| n.role == "meta").collect();
        assert_eq!(
            meta_blocks.len(),
            4,
            "expected 4 meta blocks (metadata + todos.chart + approval + config), got {} ({:?})",
            meta_blocks.len(),
            out
        );

        // tools.update_store raw_type 仍透传 (builder 设 raw_type = "tools.update_store")
        let todo_meta = out
            .iter()
            .find(|m| m.raw_type == "tools.update_store")
            .expect("todo chart meta present");
        assert_eq!(todo_meta.role, "meta");
        assert_eq!(todo_meta.blocks[0].kind, "meta");
        // v0.9.16: data 顶层是 todos.chart 字段 (update_count / current_done /
        //   buckets / completed_tasks / churn_events),不再是 v0.9.8 的 payload.key
        let data = &todo_meta.blocks[0].data;
        assert_eq!(
            data.get("label").and_then(|v| v.as_str()),
            Some("todos.chart")
        );
        assert_eq!(
            data.get("update_count").unwrap().as_u64().unwrap(),
            1,
            "1 个 tools.update_store event"
        );
        assert_eq!(
            data.get("current_done").unwrap().as_u64().unwrap(),
            1,
            "1 个 done item"
        );
        assert_eq!(
            data.get("current_in_progress").unwrap().as_u64().unwrap(),
            1,
            "1 个 in_progress item"
        );
    }

    /// v0.9.12: context.apply_compaction 应该走 build_apply_compaction_meta,
    /// summary + 压缩统计提到 block 顶层。
    #[test]
    fn apply_compaction_extracts_summary_and_stats_to_block_top_level() {
        let rec = json!({
            "type": "context.apply_compaction",
            "summary": "继续这个任务前,先把当前状态完整记下来。\n当前任务:用 Dapper 重构 AsiaSupDataManager",
            "contextSummary": "The conversation so far has been compacted to free up context.",
            "tokensBefore": 59457_u64,
            "tokensAfter": 2921_u64,
            "compactedCount": 71_u64,
            "keptUserMessageCount": 2_u64,
            "time": 1785977851015_u64
        });
        let n = normalize_kimi_record(&rec, 0).expect("apply_compaction emits meta");
        assert_eq!(n.role, "meta");
        assert_eq!(n.raw_type, "context.apply_compaction");
        let d = &n.blocks[0].data;
        // summary 提到顶层
        assert!(
            d.get("summary")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .contains("Dapper"),
            "summary 文本应在顶层, not nested in payload"
        );
        // 压缩统计
        assert_eq!(d.get("tokens_before").and_then(|v| v.as_u64()), Some(59457));
        assert_eq!(d.get("tokens_after").and_then(|v| v.as_u64()), Some(2921));
        assert_eq!(d.get("compacted_count").and_then(|v| v.as_u64()), Some(71));
        assert_eq!(
            d.get("kept_user_message_count").and_then(|v| v.as_u64()),
            Some(2)
        );
        // compression_ratio = 59457/2921 ≈ 20.35
        let ratio = d
            .get("compression_ratio")
            .and_then(|v| v.as_f64())
            .expect("ratio");
        assert!(
            (ratio - 20.35).abs() < 0.1,
            "compression_ratio 应 ≈ 20.35, got {}",
            ratio
        );
        // payload 仍保留 (back-compat)
        assert!(d.get("payload").map(|v| v.is_object()).unwrap_or(false));
    }

    /// v0.9.12: tokensAfter=0 时 compression_ratio 应为 None (除 0 保护)
    #[test]
    fn apply_compaction_handles_zero_tokens_after() {
        let rec = json!({
            "type": "context.apply_compaction",
            "summary": "edge case",
            "tokensBefore": 1000_u64,
            "tokensAfter": 0_u64,
            "compactedCount": 5_u64,
            "time": 1_u64
        });
        let n = normalize_kimi_record(&rec, 0).expect("emits");
        let d = &n.blocks[0].data;
        // tokens_after 提了但 compression_ratio 不应算
        assert_eq!(d.get("tokens_after").and_then(|v| v.as_u64()), Some(0));
        assert!(
            d.get("compression_ratio").is_none(),
            "tokensAfter=0 时 compression_ratio 应 None (避免 inf)"
        );
    }

    /// v0.9.12: bpm-large fixture 22 个 apply_compaction 全部走新 builder,
    /// summary 字段必须非空 (真实 dcwin11 中文交接笔记)
    #[test]
    fn normalize_session_v0912_bpm_large_apply_compaction_has_summary() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("<redacted-fixture>.jsonl");
        if !path.exists() {
            eprintln!("skip: {} not found", path.display());
            return;
        }
        let mut records: Vec<serde_json::Value> = Vec::new();
        jsonl::for_each_line(&path, |_idx, _byte, v| {
            records.push(v.clone());
        })
        .expect("for_each_line bpm-large");
        let out = normalize_session(records);

        let apply_compactions: Vec<&NormalizedMessage> = out
            .iter()
            .filter(|n| n.raw_type == "context.apply_compaction")
            .collect();
        assert_eq!(
            apply_compactions.len(),
            22,
            "bpm-large 期望 22 个 apply_compaction, got {}",
            apply_compactions.len()
        );

        // 每个 apply_compaction 必须有 summary 顶层字段 (非空)
        let with_summary: Vec<&&NormalizedMessage> = apply_compactions
            .iter()
            .filter(|m| {
                m.blocks[0]
                    .data
                    .get("summary")
                    .and_then(|v| v.as_str())
                    .map(|s| !s.is_empty())
                    .unwrap_or(false)
            })
            .collect();
        assert!(
            with_summary.len() >= 20,
            "至少 20/22 个 apply_compaction 应有非空 summary (dcwin11 真实 schema), got {}",
            with_summary.len()
        );

        // 压缩比应在合理范围 (bpm-large 实测 ~58K → 2.5K = 23x)
        let ratios: Vec<f64> = apply_compactions
            .iter()
            .filter_map(|m| {
                m.blocks[0]
                    .data
                    .get("compression_ratio")
                    .and_then(|v| v.as_f64())
            })
            .collect();
        let avg: f64 = ratios.iter().sum::<f64>() / ratios.len() as f64;
        println!(
            "bpm-large 22 apply_compaction: avg compression_ratio = {:.1}x, {} / 22 有 ratio",
            avg,
            ratios.len()
        );
        assert!(
            (10.0..=50.0).contains(&avg),
            "bpm-large 平均压缩比应在 10-50x, got {:.2}",
            avg
        );
    }

    /// v0.9.9: regression — dcwin11 bpm-large fixture (5834 lines) 所有 step.begin
    /// /content.part/tool.call/tool.result 都包在 `context.append_loop_event`
    /// envelope 里。normalize_session 必须 unwrap,否则所有 assistant message +
    /// tool_use 全部丢失 (返回 ~173 个 meta blocks 但 0 个 assistant message)。
    ///
    /// 期望:
    /// - assistant message 数 ≈ 602 (624 nested step.begin - 22 未 flush +
    ///   1 末 step flush。23 个 step.begin 之后没 step.end,会在 EOF flush)
    /// - 大量 tool_use + tool_result block (1073 个 tool.call,1073 个 tool.result)
    /// - 大量 text + thinking block (1094 个 content.part → ~552 text + ~623 think)
    /// - user prompt ≈ 75 (19 turn.prompt + 57 context.append_message.role=user;
    ///   偶尔有 1 个 context.append_message 在 step 中被合并所以 76 而非 76)
    #[test]
    fn normalize_session_v099_bpm_large_unwraps_loop_envelopes() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("<redacted-fixture>.jsonl");
        if !path.exists() {
            eprintln!("skip: {} not found", path.display());
            return;
        }
        // 一次性 read 5834 行 wire → 跑 normalize_session
        let mut records: Vec<serde_json::Value> = Vec::new();
        jsonl::for_each_line(&path, |_idx, _byte, v| {
            records.push(v.clone());
        })
        .expect("for_each_line bpm-large");
        let out = normalize_session(records);

        // user / assistant / meta 计数
        let user_count = out.iter().filter(|n| n.role == "user").count();
        let assistant_count = out.iter().filter(|n| n.role == "assistant").count();
        let meta_count = out.iter().filter(|n| n.role == "meta").count();

        println!(
            "bpm-large normalize_session: user={} assistant={} meta={}",
            user_count, assistant_count, meta_count
        );

        // 19 turn.prompt + 57 context.append_message{role:user} + 1 turn.cancel flush = ~76 user
        // (实测 75,差 1 是某 append_message 在 step 中合并)
        assert!(
            (70..=85).contains(&user_count),
            "user prompt count 应 ≈ 75 (19 turn.prompt + 57 append_message), got {}",
            user_count
        );
        // 624 step.begin - 22 没有 step.end 配对 (EOF 时 flush) + 1 末 step flush = 602
        assert!(
            (590..=620).contains(&assistant_count),
            "assistant message count 应 ≈ 602 (dcwin11 bpm 实测), got {}",
            assistant_count
        );
        // v0.9.16: meta 数量 ~125 (1 metadata + 24 config + 4 perm.set + 1 tools.set +
        //                         20 approval + 22+22 compaction + 22 apply
        //                         + 4 plan_mode + 1 turn.cancel + 1 todos.chart 聚合)
        // (旧版 ~176 是 55 个 raw tools.update_store meta blocks + 1 missing。
        //  v0.9.16 末尾聚合为 1 个 todos.chart meta, delta = -55 + 1 = -54 → ≈ 122)
        assert!(
            (115..=140).contains(&meta_count),
            "meta block count 应 ≈ 125 (v0.9.16 聚合 tools.update_store), got {}",
            meta_count
        );

        // 累积 block kind — 必须出现 tool_use + tool_result + text + thinking
        let mut text_count = 0usize;
        let mut thinking_count = 0usize;
        let mut tool_use_count = 0usize;
        let mut tool_result_count = 0usize;
        for n in &out {
            if n.role != "assistant" {
                continue;
            }
            for b in &n.blocks {
                match b.kind.as_str() {
                    "text" => text_count += 1,
                    "thinking" => thinking_count += 1,
                    "tool_use" => tool_use_count += 1,
                    "tool_result" => tool_result_count += 1,
                    _ => {}
                }
            }
        }
        println!(
            "blocks: text={} thinking={} tool_use={} tool_result={}",
            text_count, thinking_count, tool_use_count, tool_result_count
        );

        // v0.9.8 前: text=thinking=tool_use=tool_result=0 (envelope 没 unwrap)
        assert!(
            text_count > 100,
            "text block 应 > 100 (dcwin11 bpm ~552), got {}",
            text_count
        );
        assert!(
            thinking_count > 100,
            "thinking block 应 > 100 (dcwin11 bpm ~623), got {}",
            thinking_count
        );
        assert!(
            tool_use_count > 100,
            "tool_use block 应 > 100 (dcwin11 bpm ~1073), got {}",
            tool_use_count
        );
        assert!(
            tool_result_count > 100,
            "tool_result block 应 > 100 (dcwin11 bpm ~1073), got {}",
            tool_result_count
        );
    }

    /// v0.9.9: 小规模测试 envelope unwrap 行为 — 直接构造 envelope 结构
    /// 不依赖 fixture。
    #[test]
    fn normalize_session_v099_unwraps_loop_envelope_in_memory() {
        let records = vec![
            json!({"type":"metadata","protocol_version":"1.4","created_at":1_u64}),
            json!({
                "type":"context.append_loop_event",
                "event":{
                    "type":"step.begin",
                    "uuid":"s1",
                    "turnId":"0",
                    "step":1
                },
                "time":1000_u64
            }),
            json!({
                "type":"context.append_loop_event",
                "event":{
                    "type":"content.part",
                    "role":"assistant",
                    "part":"text",
                    "text":"hello from envelope",
                    "uuid":"cp1",
                    "turnId":"0",
                    "step":1,
                    "stepUuid":"s1"
                },
                "time":1010_u64
            }),
            json!({
                "type":"context.append_loop_event",
                "event":{
                    "type":"tool.call",
                    "uuid":"tc1",
                    "name":"Read",
                    "args":{"path":"/x"},
                    "description":"read x",
                    "turnId":"0",
                    "step":1,
                    "stepUuid":"s1"
                },
                "time":1020_u64
            }),
            json!({
                "type":"context.append_loop_event",
                "event":{
                    "type":"tool.result",
                    "parentUuid":"tc1",
                    "toolCallId":"tc1",
                    "result":{"output":"file contents"},
                    "turnId":"0",
                    "step":1,
                    "stepUuid":"s1"
                },
                "time":1030_u64
            }),
            json!({
                "type":"context.append_loop_event",
                "event":{"type":"step.end","turnId":"0","step":1,"stepUuid":"s1"},
                "time":1040_u64
            }),
        ];
        let out = normalize_session(records);
        // 1 metadata (meta) + 1 step (assistant: text + tool_use + tool_result) = 2
        assert_eq!(
            out.len(),
            2,
            "expected 2 messages (1 metadata meta + 1 assistant step), got {} ({:?})",
            out.len(),
            out
        );
        // assistant 含 text + tool_use + tool_result
        let assistant = out
            .iter()
            .find(|n| n.role == "assistant")
            .expect("assistant present (envelope unwrap 应让 step.begin 触发 accumulator)");
        assert!(assistant.blocks.iter().any(|b| b.kind == "text"));
        assert!(assistant.blocks.iter().any(|b| b.kind == "tool_use"));
        assert!(assistant.blocks.iter().any(|b| b.kind == "tool_result"));
        // text 内容从 inner event 提取 (text:"hello from envelope")
        let text_block = assistant
            .blocks
            .iter()
            .find(|b| b.kind == "text")
            .expect("text block");
        assert_eq!(
            text_block.data.get("text").unwrap().as_str().unwrap(),
            "hello from envelope"
        );
        // 时间戳来自 envelope (1000~1040) → assistant.timestamp 透传 step.begin 的 envelope.time
        assert!(assistant.timestamp.is_some());
    }

    // ---------- v0.9.14: usage.record per-turn chart ----------

    #[test]
    fn parse_usage_record_extracts_4_dimensions() {
        // v0.9.14: parse_usage_record 应正确提取 inputOther / output /
        // inputCacheRead / inputCacheCreation 4 维度,加 usageScope + time
        let rec = json!({
            "type": "usage.record",
            "model": "deepseek-v4-flash",
            "usage": {
                "inputOther": 21841_u64,
                "output": 220_u64,
                "inputCacheRead": 0_u64,
                "inputCacheCreation": 0_u64,
            },
            "usageScope": "turn",
            "time": 1785915243417_u64,
        });
        let obj = rec.as_object().expect("obj");
        let u = parse_usage_record(obj).expect("parse ok");
        assert_eq!(u.model, "deepseek-v4-flash");
        assert_eq!(u.input_other, 21841);
        assert_eq!(u.output, 220);
        assert_eq!(u.input_cache_read, 0);
        assert_eq!(u.input_cache_creation, 0);
        assert_eq!(u.usage_scope, "turn");
        assert_eq!(u.time, 1785915243417);
    }

    #[test]
    fn build_usage_chart_meta_aggregates_buckets_and_stats() {
        // v0.9.14: 10 个 turn events + 2 session events → 1 个聚合 meta
        // bucket: 10 events < 60 cap → 10 buckets (1:1)
        // session_scope_events: 2 单独保留
        let records = vec![
            UsageRecord {
                model: "deepseek-v4-flash".into(),
                input_other: 100,
                output: 50,
                input_cache_read: 200,
                input_cache_creation: 0,
                usage_scope: "turn".into(),
                time: 1_000,
            },
            UsageRecord {
                model: "deepseek-v4-flash".into(),
                input_other: 200,
                output: 60,
                input_cache_read: 400,
                input_cache_creation: 0,
                usage_scope: "turn".into(),
                time: 2_000,
            },
            UsageRecord {
                model: "deepseek-v4-flash".into(),
                input_other: 0,
                output: 0,
                input_cache_read: 0,
                input_cache_creation: 0,
                usage_scope: "session".into(),
                time: 1_500,
            },
        ];
        let chart = build_usage_chart_meta(&records, 0).expect("chat emits");
        assert_eq!(chart.role, "meta");
        assert_eq!(chart.raw_type, "usage.record");
        let block = &chart.blocks[0];
        let data = &block.data;
        assert_eq!(data.get("label").unwrap().as_str().unwrap(), "usage.chart");
        // 总计: 100+200=300 input_other, 50+60=110 output, 200+400=600 cache_read
        assert_eq!(data.get("input_other").unwrap().as_u64().unwrap(), 300);
        assert_eq!(data.get("output").unwrap().as_u64().unwrap(), 110);
        assert_eq!(data.get("input_cache_read").unwrap().as_u64().unwrap(), 600);
        assert_eq!(data.get("total_tokens").unwrap().as_u64().unwrap(), 1010);
        // cache hit ratio = 600 / (300+600) = 0.6667
        let ratio = data.get("cache_hit_ratio").unwrap().as_f64().unwrap();
        assert!(
            (ratio - 0.6666).abs() < 0.001,
            "cache ratio ~0.667, got {ratio}"
        );
        // turn_count=2, session_scope_count=1
        assert_eq!(data.get("turn_count").unwrap().as_u64().unwrap(), 2);
        assert_eq!(
            data.get("session_scope_count").unwrap().as_u64().unwrap(),
            1
        );
        // buckets: 2 个 (1:1)
        let buckets = data.get("buckets").unwrap().as_array().unwrap();
        assert_eq!(buckets.len(), 2);
        assert_eq!(
            buckets[0].get("input_other").unwrap().as_u64().unwrap(),
            100
        );
        assert_eq!(
            buckets[1].get("input_other").unwrap().as_u64().unwrap(),
            200
        );
        // session_scope_events: 1 个
        let sse = data
            .get("session_scope_events")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(sse.len(), 1);
        assert_eq!(sse[0].get("time").unwrap().as_u64().unwrap(), 1_500);
        // payload.raw_events 保留所有 3 条 (≤10 → 全保留)
        let payload = data.get("payload").unwrap().as_object().unwrap();
        let raw = payload.get("raw_events").unwrap().as_array().unwrap();
        assert_eq!(raw.len(), 3);
        assert_eq!(payload.get("raw_count").unwrap().as_u64().unwrap(), 3);
    }

    #[test]
    fn build_usage_chart_meta_empty_input_returns_none() {
        // v0.9.14: 0 events → 不 emit 元块 (空 meta 无 user value)
        let records: Vec<UsageRecord> = vec![];
        let chart = build_usage_chart_meta(&records, 0);
        assert!(chart.is_none(), "no events → no chart meta");
    }

    #[test]
    fn build_usage_chart_meta_caps_buckets_at_60() {
        // v0.9.14: 200 events → 60 buckets (cap = 60),
        // 200 events/60 = 3.33 → 200 实际分 50 buckets (其余 10 个空 bucket 不 emit).
        // 这个 test 验 ≤ 60 cap + 数据正确。
        let mut records = Vec::new();
        for i in 0..200 {
            records.push(UsageRecord {
                model: "m".into(),
                input_other: 1,
                output: 0,
                input_cache_read: 0,
                input_cache_creation: 0,
                usage_scope: "turn".into(),
                time: 1_000 + i as u64,
            });
        }
        let chart = build_usage_chart_meta(&records, 0).expect("chart");
        let buckets = chart.blocks[0]
            .data
            .get("buckets")
            .unwrap()
            .as_array()
            .unwrap();
        assert!(buckets.len() <= 60, "bucket count must respect 60 cap");
        // 总 turn_count 仍 200
        assert_eq!(
            chart.blocks[0]
                .data
                .get("turn_count")
                .unwrap()
                .as_u64()
                .unwrap(),
            200
        );
        // total_input_other = 200 (每个 1)
        assert_eq!(
            chart.blocks[0]
                .data
                .get("input_other")
                .unwrap()
                .as_u64()
                .unwrap(),
            200
        );
        // 所有 bucket 内 input_other 之和 = 200
        let total: u64 = buckets
            .iter()
            .map(|b| b.get("input_other").unwrap().as_u64().unwrap())
            .sum();
        assert_eq!(total, 200, "all buckets contain total events");
    }

    #[test]
    fn build_usage_chart_meta_exactly_60_events_uses_one_bucket_per_event() {
        // v0.9.14: 60 events == BUCKET_TARGET → 1:1 对应, 60 buckets
        let mut records = Vec::new();
        for i in 0..60 {
            records.push(UsageRecord {
                model: "m".into(),
                input_other: 1,
                output: 0,
                input_cache_read: 0,
                input_cache_creation: 0,
                usage_scope: "turn".into(),
                time: 1_000 + i as u64,
            });
        }
        let chart = build_usage_chart_meta(&records, 0).expect("chart");
        let buckets = chart.blocks[0]
            .data
            .get("buckets")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(buckets.len(), 60, "60 events → 60 buckets (1:1)");
        // 每个 bucket 1 个 event
        for b in buckets {
            assert_eq!(b.get("turn_count").unwrap().as_u64().unwrap(), 1);
        }
    }

    #[test]
    fn normalize_session_v0914_bpm_large_usage_chart_has_645_events_aggregated() {
        // v0.9.14: bpm-large 真实样本 6040 行验证 — 645 个 usage.record 聚合
        // 成 1 个 usage.chart meta,顶层 stats + 60 buckets + 22 session_scope
        let path = std::path::Path::new("<redacted-fixture>-v0914.jsonl");
        if !path.exists() {
            eprintln!("skip: {} not found", path.display());
            return;
        }
        let bytes = std::fs::read(path).expect("read fixture");
        let mut records = Vec::new();
        for line in bytes.split(|b| *b == b'\n') {
            if line.is_empty() {
                continue;
            }
            records.push(serde_json::from_slice::<serde_json::Value>(line).expect("parse jsonl"));
        }
        let out = normalize_session(records);
        let chart_msgs: Vec<_> = out
            .iter()
            .filter(|m| m.raw_type == "usage.record" && m.role == "meta")
            .collect();
        assert_eq!(
            chart_msgs.len(),
            1,
            "expected exactly 1 usage.chart meta block (645 events aggregated)"
        );
        let block = &chart_msgs[0].blocks[0];
        let data = &block.data;
        // 623 turn + 22 session = 645 events
        assert_eq!(data.get("turn_count").unwrap().as_u64().unwrap(), 623);
        assert_eq!(
            data.get("session_scope_count").unwrap().as_u64().unwrap(),
            22
        );
        // 60 buckets (cap)
        let buckets = data.get("buckets").unwrap().as_array().unwrap();
        assert_eq!(buckets.len(), 60, "645 events → 60 buckets");
        // total_tokens = 35_462_012 (验证 dcwin11 真实数据)
        assert_eq!(
            data.get("total_tokens").unwrap().as_u64().unwrap(),
            35_462_012,
            "bpm-large total tokens"
        );
        // cache hit ratio ~0.912
        let ratio = data.get("cache_hit_ratio").unwrap().as_f64().unwrap();
        assert!(
            (ratio - 0.912).abs() < 0.005,
            "cache hit ratio ~0.912, got {ratio}"
        );
        // 22 session_scope_events
        let sse = data
            .get("session_scope_events")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(sse.len(), 22);
        // payload.raw_count = 645
        let payload = data.get("payload").unwrap().as_object().unwrap();
        assert_eq!(payload.get("raw_count").unwrap().as_u64().unwrap(), 645);
    }

    // ──────────────────────────────────────────────────────────────────────
    // v0.9.15: llm.request → request.chart 聚合
    // ──────────────────────────────────────────────────────────────────────

    #[test]
    fn parse_request_record_extracts_fields() {
        let rec = json!({
            "type": "llm.request",
            "kind": "loop",
            "provider": "openai",
            "model": "deepseek-v4-flash",
            "maxTokens": 131072_u64,
            "messageCount": 42_u64,
            "turnStep": "5.12",
            "toolsHash": "22f4bc8fddf81d51bf724b00006c942c622f5b650473fc7d2872f130afe70365",
            "systemPromptHash": "b0e88aeb550f628d24dd6207c17f87a4f2a612f8d0ffc23b6f28404cb580c503",
            "systemPrompt": "You are Kimi...",  // inline → true
            "time": 1785915236910_u64
        });
        let obj = rec.as_object().unwrap();
        let r = parse_request_record(obj).expect("parse");
        assert_eq!(r.kind, "loop");
        assert_eq!(r.provider, "openai");
        assert_eq!(r.model, "deepseek-v4-flash");
        assert_eq!(r.max_tokens, 131072);
        assert_eq!(r.message_count, 42);
        assert_eq!(r.turn_index, 5);
        assert_eq!(r.step_index, 12);
        assert!(r.system_prompt_inline, "inline system_prompt");
        assert!(r.tools_hash.starts_with("22f4bc8f"));
        assert!(r.system_prompt_hash.starts_with("b0e88aeb"));
        assert_eq!(r.time, 1785915236910);
    }

    #[test]
    fn parse_request_record_handles_compaction_kind_and_no_inline() {
        let rec = json!({
            "type": "llm.request",
            "kind": "compaction",
            "provider": "openai",
            "model": "deepseek-v4-flash",
            "maxTokens": 80000_u64,
            "messageCount": 30_u64,
            "turnStep": "3.1",
            "toolsHash": "abc",
            "systemPromptHash": "def",
            "time": 1000_u64
        });
        let r = parse_request_record(rec.as_object().unwrap()).expect("parse");
        assert_eq!(r.kind, "compaction");
        assert!(!r.system_prompt_inline, "no inline text");
    }

    #[test]
    fn build_request_chart_meta_empty_input_returns_none() {
        let records: Vec<RequestRecord> = Vec::new();
        let chart = build_request_chart_meta(&records, 0);
        assert!(chart.is_none(), "empty input → no chart meta");
    }

    #[test]
    fn build_request_chart_meta_aggregates_buckets_and_stats() {
        // 5 个 synthetic request: 4 loop + 1 compaction, 3 个独立 system_prompt_hash
        let mut records = Vec::new();
        let base_time: u64 = 1785915236910;
        let tools_hash = "22f4bc8fddf81d51bf724b00006c942c622f5b650473fc7d2872f130afe70365";
        let sph_a = "hashA_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
        let sph_b = "hashB_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
        let sph_c = "hashC_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
        // req 0: maxTokens 100k, hashA
        records.push(RequestRecord {
            model: "deepseek-v4-flash".into(),
            provider: "openai".into(),
            kind: "loop".into(),
            max_tokens: 100_000,
            message_count: 1,
            turn_index: 0,
            step_index: 1,
            tools_hash: tools_hash.into(),
            system_prompt_hash: sph_a.into(),
            system_prompt_inline: true,
            time: base_time,
        });
        // req 1: maxTokens 90k, hashB (drift)
        records.push(RequestRecord {
            model: "deepseek-v4-flash".into(),
            provider: "openai".into(),
            kind: "loop".into(),
            max_tokens: 90_000,
            message_count: 2,
            turn_index: 0,
            step_index: 2,
            tools_hash: tools_hash.into(),
            system_prompt_hash: sph_b.into(),
            system_prompt_inline: false,
            time: base_time + 1000,
        });
        // req 2: maxTokens 80k, hashC (drift)
        records.push(RequestRecord {
            model: "deepseek-v4-flash".into(),
            provider: "openai".into(),
            kind: "compaction".into(),
            max_tokens: 80_000,
            message_count: 3,
            turn_index: 0,
            step_index: 3,
            tools_hash: tools_hash.into(),
            system_prompt_hash: sph_c.into(),
            system_prompt_inline: false,
            time: base_time + 2000,
        });
        // req 3: maxTokens 70k, hashC (重复 → 不进 drift_events)
        records.push(RequestRecord {
            model: "deepseek-v4-flash".into(),
            provider: "openai".into(),
            kind: "loop".into(),
            max_tokens: 70_000,
            message_count: 4,
            turn_index: 1,
            step_index: 1,
            tools_hash: tools_hash.into(),
            system_prompt_hash: sph_c.into(),
            system_prompt_inline: false,
            time: base_time + 3000,
        });
        // req 4: maxTokens 60k, hashC
        records.push(RequestRecord {
            model: "deepseek-v4-flash".into(),
            provider: "openai".into(),
            kind: "loop".into(),
            max_tokens: 60_000,
            message_count: 5,
            turn_index: 1,
            step_index: 2,
            tools_hash: tools_hash.into(),
            system_prompt_hash: sph_c.into(),
            system_prompt_inline: false,
            time: base_time + 4000,
        });

        let chart = build_request_chart_meta(&records, 0).expect("chart emits");
        let data = &chart.blocks[0].data;
        assert_eq!(
            data.get("label").unwrap().as_str().unwrap(),
            "request.chart"
        );
        // kind 分流: 4 loop + 1 compaction
        assert_eq!(data.get("kind_loop").unwrap().as_u64().unwrap(), 4);
        assert_eq!(data.get("kind_compaction").unwrap().as_u64().unwrap(), 1);
        assert_eq!(data.get("request_count").unwrap().as_u64().unwrap(), 5);
        // maxTokens 范围
        assert_eq!(
            data.get("max_tokens_min").unwrap().as_u64().unwrap(),
            60_000
        );
        assert_eq!(
            data.get("max_tokens_max").unwrap().as_u64().unwrap(),
            100_000
        );
        assert_eq!(
            data.get("max_tokens_avg").unwrap().as_u64().unwrap(),
            80_000
        );
        // message_count range
        assert_eq!(data.get("message_count_min").unwrap().as_u64().unwrap(), 1);
        assert_eq!(data.get("message_count_max").unwrap().as_u64().unwrap(), 5);
        // turn_index range
        assert_eq!(data.get("turn_index_min").unwrap().as_u64().unwrap(), 0);
        assert_eq!(data.get("turn_index_max").unwrap().as_u64().unwrap(), 1);
        // tools_hash_drift_count: 全 5 个 hash 一致 → 0 drift
        assert_eq!(
            data.get("tools_hash_drift_count")
                .unwrap()
                .as_u64()
                .unwrap(),
            0
        );
        assert_eq!(
            data.get("tools_hash_baseline").unwrap().as_str().unwrap(),
            tools_hash
        );
        // system_prompt_hash_distinct: 3
        assert_eq!(
            data.get("system_prompt_hash_distinct")
                .unwrap()
                .as_u64()
                .unwrap(),
            3
        );
        // 5 events → 5 buckets (1:1 对应, cap 60 不触发)
        let buckets = data.get("buckets").unwrap().as_array().unwrap();
        assert_eq!(buckets.len(), 5);
        // system_prompt_drift_events: 3 个 (每个 hash 第一次出现)
        let drift_events = data
            .get("system_prompt_drift_events")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(drift_events.len(), 3);
        // 第一个 drift event: hashA, system_prompt_inline = true
        assert_eq!(
            drift_events[0].get("hash").unwrap().as_str().unwrap(),
            sph_a
        );
        assert!(drift_events[0]
            .get("system_prompt_inline")
            .unwrap()
            .as_bool()
            .unwrap());
        // payload.raw_count
        let payload = data.get("payload").unwrap().as_object().unwrap();
        assert_eq!(payload.get("raw_count").unwrap().as_u64().unwrap(), 5);
    }

    #[test]
    fn build_request_chart_meta_detects_tools_hash_drift() {
        // 4 events: 3 个用 hashA, 1 个用 hashB → drift_count = 1
        let records = vec![
            RequestRecord {
                model: "m".into(),
                provider: "p".into(),
                kind: "loop".into(),
                max_tokens: 100_000,
                message_count: 1,
                turn_index: 0,
                step_index: 1,
                tools_hash: "hashA".into(),
                system_prompt_hash: "sph".into(),
                system_prompt_inline: false,
                time: 1000,
            },
            RequestRecord {
                model: "m".into(),
                provider: "p".into(),
                kind: "loop".into(),
                max_tokens: 90_000,
                message_count: 2,
                turn_index: 0,
                step_index: 2,
                tools_hash: "hashA".into(),
                system_prompt_hash: "sph".into(),
                system_prompt_inline: false,
                time: 2000,
            },
            RequestRecord {
                model: "m".into(),
                provider: "p".into(),
                kind: "loop".into(),
                max_tokens: 80_000,
                message_count: 3,
                turn_index: 1,
                step_index: 1,
                tools_hash: "hashB".into(), // ← drift
                system_prompt_hash: "sph".into(),
                system_prompt_inline: false,
                time: 3000,
            },
            RequestRecord {
                model: "m".into(),
                provider: "p".into(),
                kind: "loop".into(),
                max_tokens: 70_000,
                message_count: 4,
                turn_index: 1,
                step_index: 2,
                tools_hash: "hashA".into(),
                system_prompt_hash: "sph".into(),
                system_prompt_inline: false,
                time: 4000,
            },
        ];
        let chart = build_request_chart_meta(&records, 0).expect("chart");
        let data = &chart.blocks[0].data;
        assert_eq!(
            data.get("tools_hash_baseline").unwrap().as_str().unwrap(),
            "hashA"
        );
        assert_eq!(
            data.get("tools_hash_drift_count")
                .unwrap()
                .as_u64()
                .unwrap(),
            1
        );
    }

    #[test]
    fn normalize_session_v0915_bpm_large_request_chart_has_648_events_aggregated() {
        // v0.9.15: bpm-large 真实样本验证 — 648 个 llm.request 聚合成 1 个
        // request.chart meta,顶层 stats + 60 buckets + drift detection + 23
        // 独立 system_prompt_hash
        let path = std::path::Path::new("<redacted-fixture>-v0914.jsonl");
        if !path.exists() {
            eprintln!("skip: {} not found", path.display());
            return;
        }
        let bytes = std::fs::read(path).expect("read fixture");
        let mut records = Vec::new();
        for line in bytes.split(|b| *b == b'\n') {
            if line.is_empty() {
                continue;
            }
            records.push(serde_json::from_slice::<serde_json::Value>(line).expect("parse jsonl"));
        }
        let out = normalize_session(records);
        let chart_msgs: Vec<_> = out
            .iter()
            .filter(|m| m.raw_type == "llm.request" && m.role == "meta")
            .collect();
        assert_eq!(
            chart_msgs.len(),
            1,
            "expected exactly 1 request.chart meta block (648 events aggregated)"
        );
        let data = &chart_msgs[0].blocks[0].data;
        // 648 events total
        assert_eq!(data.get("request_count").unwrap().as_u64().unwrap(), 648);
        // 625 loop + 23 compaction
        assert_eq!(data.get("kind_loop").unwrap().as_u64().unwrap(), 625);
        assert_eq!(data.get("kind_compaction").unwrap().as_u64().unwrap(), 23);
        // maxTokens 范围 50451 → 131072
        assert_eq!(
            data.get("max_tokens_min").unwrap().as_u64().unwrap(),
            50_451
        );
        assert_eq!(
            data.get("max_tokens_max").unwrap().as_u64().unwrap(),
            131_072
        );
        // 60 buckets (cap)
        let buckets = data.get("buckets").unwrap().as_array().unwrap();
        assert_eq!(buckets.len(), 60, "648 events → 60 buckets (cap)");
        // tools_hash 全程稳定 (跟 v0.9.13 snapshot 一致) → 0 drift
        assert_eq!(
            data.get("tools_hash_drift_count")
                .unwrap()
                .as_u64()
                .unwrap(),
            0,
            "bpm-large tools_hash 应当全程一致"
        );
        // 23 独立 system_prompt_hash (config drift 信号)
        assert_eq!(
            data.get("system_prompt_hash_distinct")
                .unwrap()
                .as_u64()
                .unwrap(),
            23,
            "bpm-large 23 个独立 system_prompt_hash"
        );
        // system_prompt_drift_events 长度 = 23 (每个 hash 第一次出现)
        let drift_events = data
            .get("system_prompt_drift_events")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(drift_events.len(), 23);
        // model / provider
        assert_eq!(
            data.get("model").unwrap().as_str().unwrap(),
            "deepseek-v4-flash"
        );
        assert_eq!(data.get("provider").unwrap().as_str().unwrap(), "openai");
        // message_count range 1 → 128
        assert_eq!(data.get("message_count_min").unwrap().as_u64().unwrap(), 1);
        assert_eq!(
            data.get("message_count_max").unwrap().as_u64().unwrap(),
            128
        );
        // payload.raw_count = 648
        let payload = data.get("payload").unwrap().as_object().unwrap();
        assert_eq!(payload.get("raw_count").unwrap().as_u64().unwrap(), 648);
    }

    // ──────────────────────────────────────────────────────────────────────
    // v0.9.16: tools.update_store → todos.chart 聚合
    // ──────────────────────────────────────────────────────────────────────

    #[test]
    fn parse_todo_record_extracts_items_and_status_counts() {
        // v0.9.16: 1 个 event 4 items (2 done, 1 in_progress, 1 pending)
        let rec = json!({
            "type": "tools.update_store",
            "key": "todo",
            "value": [
                {"title": "task A", "status": "done"},
                {"title": "task B", "status": "done"},
                {"title": "task C", "status": "in_progress"},
                {"title": "task D", "status": "pending"},
            ],
            "time": 1785915308477_u64
        });
        let r = parse_todo_record(rec.as_object().unwrap()).expect("parse");
        assert_eq!(r.items.len(), 4);
        assert_eq!(r.item_count, 4);
        assert_eq!(r.done_count, 2);
        assert_eq!(r.in_progress_count, 1);
        assert_eq!(r.pending_count, 1);
        assert_eq!(r.time, 1785915308477);
        assert_eq!(r.items[0].title, "task A");
        assert_eq!(r.items[2].status, "in_progress");
    }

    #[test]
    fn parse_todo_record_skips_non_todo_keys() {
        // v0.9.16: 如果 key 不是 "todo" (e.g. "memory"),返回 None
        let rec = json!({
            "type": "tools.update_store",
            "key": "memory",
            "value": [{"content": "some data"}],
            "time": 1000_u64
        });
        assert!(parse_todo_record(rec.as_object().unwrap()).is_none());
    }

    #[test]
    fn build_todo_chart_meta_empty_input_returns_none() {
        let records: Vec<TodoRecord> = Vec::new();
        let chart = build_todo_chart_meta(&records, 0);
        assert!(chart.is_none(), "empty input → no chart meta");
    }

    #[test]
    fn build_todo_chart_meta_aggregates_buckets_and_churn() {
        // v0.9.16: 5 个 synthetic events — 跨 event 改动 title 跟 status
        // 验: 60 buckets, unique task count, churn events (add / remove)
        // 验: completed_tasks 按 done 时间排序
        let base_time: u64 = 1785915308477;
        let mut records = Vec::new();

        // event 0: 3 个任务 (1 done, 1 in_progress, 1 pending)
        records.push(TodoRecord {
            items: vec![
                TodoItem {
                    title: "alpha".into(),
                    status: "done".into(),
                },
                TodoItem {
                    title: "beta".into(),
                    status: "in_progress".into(),
                },
                TodoItem {
                    title: "gamma".into(),
                    status: "pending".into(),
                },
            ],
            item_count: 3,
            done_count: 1,
            in_progress_count: 1,
            pending_count: 1,
            time: base_time,
        });
        // event 1: 4 个任务 (alpha done, beta done, gamma in_progress, delta new)
        records.push(TodoRecord {
            items: vec![
                TodoItem {
                    title: "alpha".into(),
                    status: "done".into(),
                },
                TodoItem {
                    title: "beta".into(),
                    status: "done".into(),
                },
                TodoItem {
                    title: "gamma".into(),
                    status: "in_progress".into(),
                },
                TodoItem {
                    title: "delta".into(),
                    status: "pending".into(),
                },
            ],
            item_count: 4,
            done_count: 2,
            in_progress_count: 1,
            pending_count: 1,
            time: base_time + 1000,
        });
        // event 2: 3 个任务 (alpha done, beta done, gamma done) — delta removed
        records.push(TodoRecord {
            items: vec![
                TodoItem {
                    title: "alpha".into(),
                    status: "done".into(),
                },
                TodoItem {
                    title: "beta".into(),
                    status: "done".into(),
                },
                TodoItem {
                    title: "gamma".into(),
                    status: "done".into(),
                },
            ],
            item_count: 3,
            done_count: 3,
            in_progress_count: 0,
            pending_count: 0,
            time: base_time + 2000,
        });
        // event 3: 4 个 — 新加 epsilon
        records.push(TodoRecord {
            items: vec![
                TodoItem {
                    title: "alpha".into(),
                    status: "done".into(),
                },
                TodoItem {
                    title: "beta".into(),
                    status: "done".into(),
                },
                TodoItem {
                    title: "gamma".into(),
                    status: "done".into(),
                },
                TodoItem {
                    title: "epsilon".into(),
                    status: "pending".into(),
                },
            ],
            item_count: 4,
            done_count: 3,
            in_progress_count: 0,
            pending_count: 1,
            time: base_time + 3000,
        });
        // event 4: 4 个 — final
        records.push(TodoRecord {
            items: vec![
                TodoItem {
                    title: "alpha".into(),
                    status: "done".into(),
                },
                TodoItem {
                    title: "beta".into(),
                    status: "done".into(),
                },
                TodoItem {
                    title: "gamma".into(),
                    status: "done".into(),
                },
                TodoItem {
                    title: "epsilon".into(),
                    status: "in_progress".into(),
                },
            ],
            item_count: 4,
            done_count: 3,
            in_progress_count: 1,
            pending_count: 0,
            time: base_time + 4000,
        });

        let chart = build_todo_chart_meta(&records, 0).expect("chart emits");
        let data = &chart.blocks[0].data;

        // 顶层 stats
        assert_eq!(data.get("update_count").unwrap().as_u64().unwrap(), 5);
        assert_eq!(
            data.get("unique_task_count").unwrap().as_u64().unwrap(),
            5,
            "alpha + beta + gamma + delta + epsilon = 5 unique"
        );
        // 末次 snapshot: 3 done + 1 in_progress + 0 pending
        assert_eq!(data.get("current_done").unwrap().as_u64().unwrap(), 3);
        assert_eq!(
            data.get("current_in_progress").unwrap().as_u64().unwrap(),
            1
        );
        assert_eq!(data.get("current_pending").unwrap().as_u64().unwrap(), 0);
        // 累计: 1+2+3+3+3 = 12 done, 1+1+0+0+1 = 3 in_progress, 1+1+0+1+0 = 3 pending
        assert_eq!(data.get("total_done").unwrap().as_u64().unwrap(), 12);
        assert_eq!(data.get("total_in_progress").unwrap().as_u64().unwrap(), 3);
        assert_eq!(data.get("total_pending").unwrap().as_u64().unwrap(), 3);

        // churn events: 4 add (alpha, beta, gamma, delta, epsilon = 5 add) + 1 remove (delta)
        let churn_events = data.get("churn_events").unwrap().as_array().unwrap();
        assert_eq!(
            churn_events.len(),
            6,
            "5 add (alpha, beta, gamma, delta, epsilon) + 1 remove (delta)"
        );
        assert_eq!(data.get("churn_add_count").unwrap().as_u64().unwrap(), 5);
        assert_eq!(data.get("churn_remove_count").unwrap().as_u64().unwrap(), 1);
        assert_eq!(data.get("churn_count").unwrap().as_u64().unwrap(), 6);

        // completed_tasks: 3 (alpha, beta, gamma) — epsilon 是 in_progress 不算 done
        let completed = data.get("completed_tasks").unwrap().as_array().unwrap();
        assert_eq!(completed.len(), 3);
        // 排序: 按 done_time 升序 — alpha (event 0), beta (event 1), gamma (event 2)
        assert_eq!(
            completed[0].get("title").unwrap().as_str().unwrap(),
            "alpha"
        );
        assert_eq!(completed[1].get("title").unwrap().as_str().unwrap(), "beta");
        assert_eq!(
            completed[2].get("title").unwrap().as_str().unwrap(),
            "gamma"
        );

        // 时间 stats
        assert_eq!(
            data.get("first_update_at").unwrap().as_u64().unwrap(),
            base_time
        );
        assert_eq!(
            data.get("last_update_at").unwrap().as_u64().unwrap(),
            base_time + 4000
        );
        assert_eq!(data.get("duration_ms").unwrap().as_u64().unwrap(), 4000);

        // 60 buckets (5 events < 60 → 5 buckets)
        let buckets = data.get("buckets").unwrap().as_array().unwrap();
        assert_eq!(buckets.len(), 5, "5 events → 5 buckets (≤60 → 用 N)");

        // raw_count = 5
        let payload = data.get("payload").unwrap().as_object().unwrap();
        assert_eq!(payload.get("raw_count").unwrap().as_u64().unwrap(), 5);
    }

    #[test]
    fn normalize_session_v0916_bpm_large_todo_chart_has_57_events_aggregated() {
        // v0.9.16: bpm-large 真实样本 — 57 个 tools.update_store event 聚合成
        // 1 个 todos.chart meta (91 unique tasks + 47 churn events)
        let path = std::path::Path::new("<redacted-fixture>-v0916.jsonl");
        if !path.exists() {
            eprintln!("skip: {} not found", path.display());
            return;
        }
        let bytes = std::fs::read(path).expect("read fixture");
        let mut records = Vec::new();
        for line in bytes.split(|b| *b == b'\n') {
            if line.is_empty() {
                continue;
            }
            records.push(serde_json::from_slice::<serde_json::Value>(line).expect("parse jsonl"));
        }
        let out = normalize_session(records);
        let chart_msgs: Vec<_> = out
            .iter()
            .filter(|m| m.raw_type == "tools.update_store" && m.role == "meta")
            .collect();
        assert_eq!(
            chart_msgs.len(),
            1,
            "expected exactly 1 todos.chart meta block (57 events aggregated)"
        );
        let data = &chart_msgs[0].blocks[0].data;
        // 57 events total
        assert_eq!(data.get("update_count").unwrap().as_u64().unwrap(), 57);
        // 91 unique tasks (跨 57 条 event 出现的独立 title 数)
        assert_eq!(
            data.get("unique_task_count").unwrap().as_u64().unwrap(),
            91,
            "bpm-large 91 个独立 todo title"
        );
        // 末次 snapshot: 23 done / 1 in_progress / 4 pending
        assert_eq!(data.get("current_done").unwrap().as_u64().unwrap(), 23);
        assert_eq!(
            data.get("current_in_progress").unwrap().as_u64().unwrap(),
            1
        );
        assert_eq!(data.get("current_pending").unwrap().as_u64().unwrap(), 4);
        // 累计: 166 done / 40 in_progress / 92 pending
        assert_eq!(data.get("total_done").unwrap().as_u64().unwrap(), 166);
        assert_eq!(data.get("total_in_progress").unwrap().as_u64().unwrap(), 40);
        assert_eq!(data.get("total_pending").unwrap().as_u64().unwrap(), 92);
        // 47 churn events (add + remove)
        assert_eq!(
            data.get("churn_count").unwrap().as_u64().unwrap(),
            47,
            "bpm-large 47 churn events (add + remove)"
        );
        // 60 buckets (cap)
        let buckets = data.get("buckets").unwrap().as_array().unwrap();
        assert_eq!(buckets.len(), 60, "57 events → 60 buckets (cap)");
        // completed_tasks 长度 = 28 (每个 unique 完成 title 一次 done)
        let completed = data.get("completed_tasks").unwrap().as_array().unwrap();
        assert_eq!(completed.len(), 28);
        // churn_events 长度 = 47
        let churn_events = data.get("churn_events").unwrap().as_array().unwrap();
        assert_eq!(churn_events.len(), 47);
        // payload.raw_count = 57
        let payload = data.get("payload").unwrap().as_object().unwrap();
        assert_eq!(payload.get("raw_count").unwrap().as_u64().unwrap(), 57);
    }
}
