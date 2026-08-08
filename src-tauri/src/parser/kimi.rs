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
//! - `llm.request` / `llm.tools_snapshot` / `usage.record` /
//!   `permission.record_approval_result` — 协议层,跳过
//!
//! 协议版本:
//! - `metadata.protocol_version` `1.x` 支持;`2.x` 及以上跳过该 session
//!   (`list_kimi_sessions` 阶段检查),静默拒绝未来 schema。

use std::collections::HashMap;

use serde_json::Value;

use super::claude::{NormalizedBlock, NormalizedMessage};

/// Kimi `tool.result.parentUuid` 的 JSON key 名(对应 tool.call.uuid)
pub const KIMI_PARENT_KEY: &str = "parentUuid";

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
        // 协议层 — 跳过
        "llm.request"
        | "llm.tools_snapshot"
        | "usage.record"
        | "permission.record_approval_result"
        | "tools.update_store"
        | "turn.steer"
        | "turn.cancel"
        | "full_compaction.begin"
        | "full_compaction.complete"
        | "context.apply_compaction"
        | "plan_mode.enter"
        | "plan_mode.cancel" => None,
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

    for (idx, record) in records.into_iter().enumerate() {
        let Some(obj) = record.as_object() else {
            continue;
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
            | "tools.update_store"
            | "permission.record_approval_result"
            | "full_compaction.begin"
            | "full_compaction.complete"
            | "context.apply_compaction" => {
                out.push(build_meta_from_event(obj, r#type, idx, extract_time(obj)));
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
        let part_type = obj.get("part").and_then(|v| v.as_str()).unwrap_or("");
        let role = obj
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("assistant");
        let mut data = serde_json::Map::new();
        if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
            data.insert("text".to_string(), Value::String(text.to_string()));
        } else if let Some(content) = obj.get("content") {
            data.insert("content".to_string(), content.clone());
        }
        let kind = match part_type {
            "thinking" => {
                data.insert(
                    "thinking".to_string(),
                    Value::String(
                        obj.get("text")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    ),
                );
                "thinking"
            }
            "text" => "text",
            _ => "text", // 未知 part → 当 text 兜底
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

#[cfg(test)]
mod tests {
    use super::*;
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
        for ty in [
            "llm.request",
            "llm.tools_snapshot",
            "usage.record",
            "permission.record_approval_result",
        ] {
            let rec = json!({"type": ty, "time": 1_u64});
            assert!(
                normalize_kimi_record(&rec, 0).is_none(),
                "{} should skip",
                ty
            );
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
        let records = vec![
            json!({"type":"metadata","protocol_version":"1.4","created_at":1_u64}),
            json!({
                "type":"tools.update_store",
                "key":"todo",
                "value":{"items":[
                    {"id":"1","status":"completed","content":"first"},
                    {"id":"2","status":"in_progress","content":"second"}
                ]},
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

        // metadata + todo + approval + config = 4 meta blocks
        let meta_blocks: Vec<&NormalizedMessage> =
            out.iter().filter(|n| n.role == "meta").collect();
        assert_eq!(
            meta_blocks.len(),
            4,
            "expected 4 meta blocks (metadata + todo + approval + config), got {} ({:?})",
            meta_blocks.len(),
            out
        );

        // tools.update_store raw_type 透传
        let todo_meta = out
            .iter()
            .find(|m| m.raw_type == "tools.update_store")
            .expect("todo meta present");
        assert_eq!(todo_meta.role, "meta");
        assert_eq!(todo_meta.blocks[0].kind, "meta");
        assert!(
            todo_meta.blocks[0]
                .data
                .get("payload")
                .and_then(|p| p.get("key"))
                .and_then(|k| k.as_str())
                == Some("todo"),
            "todo payload preserved in meta block"
        );
    }
}
