//! v0.9.28: DeepSeek Harness (dsh) wire format 归一化
//!
//! dsh 在 `~/.dsh/sessions/<project>/session-<uuid>/session.jsonl.zstd` 落地
//! 每个 session。每条 wire event 是 envelope 形:
//!
//! ```json
//! { "type": "assistant/message", "seq": 101, "time": 1787100704297,
//!   "data": { "turn": 1, "step": 1,
//!     "message": { "role": "assistant",
//!       "content": [
//!         {"type":"reasoning","text":"..."},
//!         {"type":"text","text":"..."},
//!         {"type":"tool-call","id":"call_00_...","name":"bash",
//!          "arguments":"{\"command\":\"...\"}"}
//!       ],
//!       "source": {"kind":"model","provider":"deepseek-official","model":"deepseek-v4-flash"},
//!       "id": "897830c5-..."
//!     },
//!     "usage": {"inputTokens":12102,"outputTokens":121,"cacheReadTokens":0,"reasoningTokens":44}
//!   }
//! }
//! ```
//!
//! 关键设计决策:
//! - 单条 record 归一化(无 state machine) — dsh wire 上 `assistant/message`
//!   已经是 pre-collapsed 形式(per-turn aggregate),streaming 路径 readout
//!   不需要跨 event 拼装。
//! - 4 種 streaming chunk(`assistant/chunk` / `reasoning-chunks` / `text-chunks`
//!   / `tool-call-chunks`)返回 None — 它们是 LLM 流式 append,被 `assistant/message`
//!   终态聚合覆盖;详情页只展示终态消息,避免双计。
//! - 历史会话必带 streaming chunks(实际占比 ~95% 如 9337 行 session),所以
//!   filter 行为至关重要。

use serde_json::{json, Value};

use super::claude::{NormalizedBlock, NormalizedMessage, TokenUsageOut};

/// v0.9.28: 单条 dsh wire event 归一化 — streaming 路径 entry point。
///
/// 返回 `None` 表示该 event 是 streaming chunk / 协议层,详情页不展示。
pub fn normalize_dsh_record(record: &Value, index: usize) -> Option<NormalizedMessage> {
    let obj = record.as_object()?;
    let r#type = obj.get("type")?.as_str()?;
    let timestamp = extract_dsh_time(obj);

    match r#type {
        // 终态消息 — 实际展示
        "user/message" => Some(build_user_message(obj, index, timestamp)),
        "assistant/message" => Some(build_assistant_message(obj, index, timestamp)),
        "tool/result" => Some(build_tool_result(obj, index, timestamp)),

        // session 生命周期 / 元数据 — emit meta
        "session" => Some(build_session_meta(obj, index)),
        "session/title" => Some(build_simple_meta(obj, r#type, index, timestamp)),
        "session/title-llm-request" => Some(build_simple_meta(obj, r#type, index, timestamp)),
        "turn/start" | "turn/end" => Some(build_simple_meta(obj, r#type, index, timestamp)),
        "step/start" | "step/end" => Some(build_simple_meta(obj, r#type, index, timestamp)),
        "tool/call" => Some(build_tool_call_meta(obj, index, timestamp)),

        // 用户可观察的工具 / 计划层 event
        "agent/inbox/spliced" => Some(build_simple_meta(obj, r#type, index, timestamp)),
        "todo/write" => Some(build_todo_meta(obj, index, timestamp)),
        "request/header" => Some(build_simple_meta(obj, r#type, index, timestamp)),
        "request/context" => Some(build_simple_meta(obj, r#type, index, timestamp)),
        "llm/retry" => Some(build_simple_meta(obj, r#type, index, timestamp)),
        "llm/retry-started" => Some(build_simple_meta(obj, r#type, index, timestamp)),
        "permission/preset" => Some(build_simple_meta(obj, r#type, index, timestamp)),
        "approval/policy" => Some(build_simple_meta(obj, r#type, index, timestamp)),
        "sandbox/mode" => Some(build_simple_meta(obj, r#type, index, timestamp)),
        "goal/change" => Some(build_simple_meta(obj, r#type, index, timestamp)),

        // 流式 chunk — 永远 None,详情页不展示
        "assistant/chunk" | "reasoning-chunks" | "text-chunks" | "tool-call-chunks" => None,

        // 未知 event type — emit meta,不 panic
        _ => Some(build_simple_meta(obj, r#type, index, timestamp)),
    }
}

/// v0.9.28: dsh time 字段 — 顶层 `time` (u64 ms) → RFC 3339
fn extract_dsh_time(obj: &serde_json::Map<String, Value>) -> Option<String> {
    obj.get("time")
        .and_then(|v| v.as_i64())
        .and_then(|ms| chrono::DateTime::from_timestamp_millis(ms).map(|dt| dt.to_rfc3339()))
}

/// v0.9.28: `session` event — 顶层 meta,带 agentPreset / cwd / id
///
/// 顶层没有 `time` 字段(其他 event 都有),所以 timestamp 走 None。
fn build_session_meta(obj: &serde_json::Map<String, Value>, index: usize) -> NormalizedMessage {
    let mut data = serde_json::Map::new();
    data.insert(
        "label".to_string(),
        Value::String("session.header".to_string()),
    );
    if let Some(preset) = obj.get("agentPreset").and_then(|v| v.as_str()) {
        data.insert("agent_preset".to_string(), Value::String(preset.to_string()));
    }
    if let Some(cwd) = obj.get("cwd").and_then(|v| v.as_str()) {
        data.insert("cwd".to_string(), Value::String(cwd.to_string()));
    }
    if let Some(id) = obj.get("id").and_then(|v| v.as_str()) {
        data.insert("session_id".to_string(), Value::String(id.to_string()));
    }
    if let Some(depth) = obj.get("delegationDepth").and_then(|v| v.as_u64()) {
        data.insert("delegation_depth".to_string(), Value::from(depth));
    }
    if let Some(created) = obj.get("createdAt").and_then(|v| v.as_i64()) {
        data.insert("created_at".to_string(), Value::from(created));
    }
    data.insert("payload".to_string(), Value::Object(obj.clone()));
    NormalizedMessage {
        id: format!("dsh-session-{index}"),
        role: "meta".to_string(),
        timestamp: None,
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
        raw_type: "session".to_string(),
    }
}

/// v0.9.28: `user/message` → role=user;data.content[].text → text block
///
/// 真实 wire (跟 assistant/message 不同!): user envelope 直接把 content 放在
/// `data.content` (而非 `data.message.content`)。`data.id` 是 message id。
fn build_user_message(
    obj: &serde_json::Map<String, Value>,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let data = obj.get("data").and_then(|v| v.as_object());

    let mut blocks: Vec<NormalizedBlock> = Vec::new();
    if let Some(content_arr) = data
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_array())
    {
        for part in content_arr {
            if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                let mut m = serde_json::Map::new();
                m.insert("text".to_string(), Value::String(text.to_string()));
                blocks.push(NormalizedBlock {
                    kind: "text".to_string(),
                    data: m,
                });
            }
        }
    }

    let id = data
        .and_then(|d| d.get("id"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| format!("dsh-user-{index}"));
    NormalizedMessage {
        id,
        role: "user".to_string(),
        timestamp,
        blocks,
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: "user/message".to_string(),
    }
}

/// v0.9.28: `assistant/message` → role=assistant;content[].type=reasoning | text | tool-call
fn build_assistant_message(
    obj: &serde_json::Map<String, Value>,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let data = obj.get("data").and_then(|v| v.as_object());
    let message = data.and_then(|d| d.get("message")).and_then(|v| v.as_object());

    let model = message
        .and_then(|m| m.get("source"))
        .and_then(|s| s.get("model"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let mut blocks: Vec<NormalizedBlock> = Vec::new();
    if let Some(content_arr) = message.and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
        for part in content_arr {
            let part_type = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
            match part_type {
                "reasoning" => {
                    let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let mut m = serde_json::Map::new();
                    m.insert("thinking".to_string(), Value::String(text.to_string()));
                    blocks.push(NormalizedBlock {
                        kind: "thinking".to_string(),
                        data: m,
                    });
                }
                "text" => {
                    let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let mut m = serde_json::Map::new();
                    m.insert("text".to_string(), Value::String(text.to_string()));
                    blocks.push(NormalizedBlock {
                        kind: "text".to_string(),
                        data: m,
                    });
                }
                "tool-call" => {
                    let name = part.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                    let id = part.get("id").and_then(|v| v.as_str()).map(String::from);
                    let args_raw = part.get("arguments").and_then(|v| v.as_str()).unwrap_or("{}");
                    let input = serde_json::from_str::<Value>(args_raw)
                        .unwrap_or_else(|_| Value::String(args_raw.to_string()));
                    let mut m = serde_json::Map::new();
                    m.insert("name".to_string(), Value::String(name.to_string()));
                    m.insert("input".to_string(), input);
                    if let Some(cid) = id {
                        m.insert("tool_call_id".to_string(), Value::String(cid));
                    }
                    blocks.push(NormalizedBlock {
                        kind: "tool_use".to_string(),
                        data: m,
                    });
                }
                _ => {
                    // 未知 part type — 透传 raw payload
                    let mut m = serde_json::Map::new();
                    m.insert("content".to_string(), part.clone());
                    blocks.push(NormalizedBlock {
                        kind: "text".to_string(),
                        data: m,
                    });
                }
            }
        }
    }

    let token_usage = data.and_then(|d| d.get("usage")).and_then(|u| {
        let input = u.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let output = u.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_read = u.get("cacheReadTokens").and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_write = u.get("cacheCreationTokens").and_then(|v| v.as_u64()).unwrap_or(0);
        if input + output + cache_read + cache_write == 0 {
            return None;
        }
        Some(TokenUsageOut {
            input,
            output,
            cache_read,
            cache_write,
        })
    });

    NormalizedMessage {
        id: message
            .and_then(|m| m.get("id"))
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| format!("dsh-assistant-{index}")),
        role: "assistant".to_string(),
        timestamp,
        blocks,
        model,
        stop_reason: None,
        token_usage,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: "assistant/message".to_string(),
    }
}

/// v0.9.28: `tool/result` → role=tool;data.message.content[0].isError → is_error flag
fn build_tool_result(
    obj: &serde_json::Map<String, Value>,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let data = obj.get("data").and_then(|v| v.as_object());
    let message = data.and_then(|d| d.get("message")).and_then(|v| v.as_object());

    let call_id = message
        .and_then(|m| m.get("source"))
        .and_then(|s| s.get("callId"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let first_part = message
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first());

    let is_error = first_part
        .and_then(|p| p.get("isError"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let inner_content = first_part.and_then(|p| p.get("content")).cloned();
    let inner_text = inner_content
        .as_ref()
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find_map(|p| p.get("text").and_then(|t| t.as_str()).map(String::from))
        });

    let mut m = serde_json::Map::new();
    if let Some(text) = inner_text {
        m.insert("content".to_string(), Value::String(text));
    } else if let Some(c) = inner_content {
        m.insert("content".to_string(), c);
    }
    m.insert("is_error".to_string(), Value::Bool(is_error));
    if let Some(cid) = call_id {
        m.insert("tool_call_id".to_string(), Value::String(cid));
    }

    NormalizedMessage {
        id: message
            .and_then(|m| m.get("id"))
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| format!("dsh-tool-result-{index}")),
        role: "tool".to_string(),
        timestamp,
        blocks: vec![NormalizedBlock {
            kind: "tool_result".to_string(),
            data: m,
        }],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: "tool/result".to_string(),
    }
}

/// v0.9.28: `tool/call` → meta,带 callId + name
fn build_tool_call_meta(
    obj: &serde_json::Map<String, Value>,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let data = obj.get("data").and_then(|v| v.as_object());
    let mut m = serde_json::Map::new();
    m.insert(
        "label".to_string(),
        Value::String("tool/call".to_string()),
    );
    if let Some(call_id) = data.and_then(|d| d.get("callId")).and_then(|v| v.as_str()) {
        m.insert(
            "call_id".to_string(),
            Value::String(call_id.to_string()),
        );
    }
    if let Some(name) = data.and_then(|d| d.get("name")).and_then(|v| v.as_str()) {
        m.insert("name".to_string(), Value::String(name.to_string()));
    }
    if let Some(args) = data.and_then(|d| d.get("arguments")) {
        m.insert("arguments".to_string(), args.clone());
    }
    m.insert("payload".to_string(), Value::Object(obj.clone()));

    NormalizedMessage {
        id: format!("dsh-tool-call-{index}"),
        role: "meta".to_string(),
        timestamp,
        blocks: vec![NormalizedBlock {
            kind: "meta".to_string(),
            data: m,
        }],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: "tool/call".to_string(),
    }
}

/// v0.9.28: `todo/write` — 提到 todo_count / done_count 到顶层,跟 kimi 同思路
fn build_todo_meta(
    obj: &serde_json::Map<String, Value>,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let data = obj.get("data").and_then(|v| v.as_object());
    let todos = data
        .and_then(|d| d.get("todos"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let content = t.get("content").and_then(|v| v.as_str())?;
                    let status = t.get("status").and_then(|v| v.as_str()).unwrap_or("pending");
                    Some((content.to_string(), status.to_string()))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let done_count = todos.iter().filter(|(_, s)| s == "done").count() as u64;
    let in_progress_count = todos.iter().filter(|(_, s)| s == "in_progress").count() as u64;
    let pending_count = todos.iter().filter(|(_, s)| s == "pending").count() as u64;

    let mut m = serde_json::Map::new();
    m.insert("label".to_string(), Value::String("todo/write".to_string()));
    m.insert("todo_count".to_string(), Value::from(todos.len() as u64));
    m.insert("done_count".to_string(), Value::from(done_count));
    m.insert("in_progress_count".to_string(), Value::from(in_progress_count));
    m.insert("pending_count".to_string(), Value::from(pending_count));
    m.insert(
        "todos".to_string(),
        Value::Array(
            todos
                .into_iter()
                .map(|(c, s)| json!({"content": c, "status": s}))
                .collect(),
        ),
    );
    m.insert("payload".to_string(), Value::Object(obj.clone()));

    NormalizedMessage {
        id: format!("dsh-todo-{index}"),
        role: "meta".to_string(),
        timestamp,
        blocks: vec![NormalizedBlock {
            kind: "meta".to_string(),
            data: m,
        }],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain: None,
        subagent_id: None,
        parent_uuid: None,
        raw_type: "todo/write".to_string(),
    }
}

/// v0.9.28: 通用 meta emit — 用于 lifecycle / 配置 / 协议层 event
fn build_simple_meta(
    obj: &serde_json::Map<String, Value>,
    type_label: &str,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let mut data = serde_json::Map::new();
    data.insert("label".to_string(), Value::String(type_label.to_string()));
    data.insert("payload".to_string(), Value::Object(obj.clone()));
    NormalizedMessage {
        id: format!("dsh-{type_label}-{index}"),
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_event_emits_meta_with_agent_preset() {
        let rec = json!({
            "type": "session",
            "version": 0,
            "id": "session-abc",
            "createdAt": 1787100548509_u64,
            "cwd": "$WORKSPACE/doc",
            "delegationDepth": 0,
            "agentPreset": "cordis"
        });
        let n = normalize_dsh_record(&rec, 0).expect("session emits");
        assert_eq!(n.role, "meta");
        assert_eq!(n.raw_type, "session");
        assert_eq!(
            n.blocks[0].data.get("agent_preset").unwrap().as_str().unwrap(),
            "cordis"
        );
        assert_eq!(
            n.blocks[0].data.get("cwd").unwrap().as_str().unwrap(),
            "$WORKSPACE/doc"
        );
    }

    #[test]
    fn user_message_emits_user_role_with_text_blocks() {
        let rec = json!({
            "type": "user/message",
            "seq": 7,
            "time": 1787100701944_u64,
            "data": {
                "content": [{"type":"text","text":"把paper.pdf 文件每段增加中文翻译"}],
                "source": {"kind":"user"},
                "role": "user",
                "id": "4d557510-b2f5-4595-893f-4cc2ea37bb68"
            }
        });
        let n = normalize_dsh_record(&rec, 1).expect("user/message emits");
        assert_eq!(n.role, "user");
        assert_eq!(n.blocks[0].kind, "text");
        assert_eq!(
            n.blocks[0].data.get("text").unwrap().as_str().unwrap(),
            "把paper.pdf 文件每段增加中文翻译"
        );
    }

    #[test]
    fn assistant_message_with_reasoning_and_text_and_tool_call() {
        let rec = json!({
            "type": "assistant/message",
            "seq": 101,
            "time": 1787100704297_u64,
            "data": {
                "turn": 1, "step": 1,
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type":"reasoning","text":"The user wants me to translate..."},
                        {"type":"text","text":"Let me look at the file first."},
                        {"type":"tool-call","id":"call_00_abc","name":"bash",
                         "arguments":"{\"command\":\"ls\"}"}
                    ],
                    "source": {"kind":"model","provider":"deepseek-official","model":"deepseek-v4-flash"},
                    "id": "897830c5-d50c-40ef-89f9-1a1601c2d333"
                },
                "usage": {"inputTokens":12102,"outputTokens":121,"cacheReadTokens":0,"reasoningTokens":44}
            }
        });
        let n = normalize_dsh_record(&rec, 2).expect("assistant/message emits");
        assert_eq!(n.role, "assistant");
        assert_eq!(n.blocks.len(), 3);
        assert_eq!(n.blocks[0].kind, "thinking");
        assert_eq!(n.blocks[1].kind, "text");
        assert_eq!(n.blocks[2].kind, "tool_use");
        assert_eq!(n.blocks[2].data.get("name").unwrap().as_str().unwrap(), "bash");
        assert_eq!(
            n.blocks[2].data.get("input").unwrap().get("command").unwrap().as_str().unwrap(),
            "ls"
        );
        assert_eq!(n.model.as_deref(), Some("deepseek-v4-flash"));
        let usage = n.token_usage.as_ref().expect("token_usage present");
        assert_eq!(usage.input, 12102);
        assert_eq!(usage.output, 121);
        assert_eq!(usage.cache_read, 0);
        assert_eq!(usage.cache_write, 0);
    }

    #[test]
    fn tool_call_emits_meta_with_call_id() {
        let rec = json!({
            "type": "tool/call",
            "seq": 102,
            "time": 1787100704300_u64,
            "data": {
                "turn": 1, "step": 1,
                "callId": "call_00_abc",
                "name": "bash",
                "arguments": "{\"command\":\"ls\"}"
            }
        });
        let n = normalize_dsh_record(&rec, 3).expect("tool/call emits");
        assert_eq!(n.role, "meta");
        assert_eq!(n.raw_type, "tool/call");
        assert_eq!(
            n.blocks[0].data.get("call_id").unwrap().as_str().unwrap(),
            "call_00_abc"
        );
    }

    #[test]
    fn tool_result_emits_tool_role_with_is_error_flag() {
        let rec = json!({
            "type": "tool/result",
            "seq": 103,
            "time": 1787100704358_u64,
            "data": {
                "turn": 1, "step": 1,
                "message": {
                    "source": {"kind":"tool","callId":"call_00_abc"},
                    "content": [{
                        "type":"tool-result",
                        "toolCallId":"call_00_abc",
                        "content": [{"type":"text","text":"file.txt"}],
                        "isError": false
                    }],
                    "role": "user",
                    "id": "a4742a0f-8ae4-4da4-85e0-ee5de5e5511a"
                }
            }
        });
        let n = normalize_dsh_record(&rec, 4).expect("tool/result emits");
        assert_eq!(n.role, "tool");
        assert_eq!(n.blocks[0].kind, "tool_result");
        assert_eq!(
            n.blocks[0].data.get("is_error").unwrap().as_bool().unwrap(),
            false
        );
        assert_eq!(
            n.blocks[0].data.get("content").unwrap().as_str().unwrap(),
            "file.txt"
        );
        assert_eq!(
            n.blocks[0].data.get("tool_call_id").unwrap().as_str().unwrap(),
            "call_00_abc"
        );
    }

    #[test]
    fn tool_result_with_error_flag() {
        let rec = json!({
            "type": "tool/result",
            "seq": 5,
            "time": 1_u64,
            "data": {
                "message": {
                    "content": [{"type":"tool-result","content":[{"type":"text","text":"ENOENT"}],"isError": true}]
                }
            }
        });
        let n = normalize_dsh_record(&rec, 0).expect("emits");
        assert_eq!(n.role, "tool");
        assert_eq!(
            n.blocks[0].data.get("is_error").unwrap().as_bool().unwrap(),
            true
        );
    }

    #[test]
    fn streaming_chunks_return_none() {
        // v0.9.28: 4 種 streaming chunk 全 filter 掉 (避免双计,与 assistant/message 终态冲突)
        for ty in [
            "assistant/chunk",
            "reasoning-chunks",
            "text-chunks",
            "tool-call-chunks",
        ] {
            let rec = json!({"type": ty, "seq": 1, "time": 1_u64, "data": {}});
            assert!(
                normalize_dsh_record(&rec, 0).is_none(),
                "{ty} should be filtered"
            );
        }
    }

    #[test]
    fn todo_write_emits_meta_with_count_breakdown() {
        let rec = json!({
            "type": "todo/write",
            "seq": 4060,
            "time": 1787100805511_u64,
            "data": {
                "todos": [
                    {"content": "task A", "status": "done"},
                    {"content": "task B", "status": "in_progress"},
                    {"content": "task C", "status": "pending"}
                ]
            }
        });
        let n = normalize_dsh_record(&rec, 0).expect("todo/write emits");
        assert_eq!(n.role, "meta");
        assert_eq!(n.raw_type, "todo/write");
        assert_eq!(
            n.blocks[0].data.get("todo_count").unwrap().as_u64().unwrap(),
            3
        );
        assert_eq!(
            n.blocks[0].data.get("done_count").unwrap().as_u64().unwrap(),
            1
        );
        assert_eq!(
            n.blocks[0]
                .data
                .get("in_progress_count")
                .unwrap()
                .as_u64()
                .unwrap(),
            1
        );
        assert_eq!(
            n.blocks[0].data.get("pending_count").unwrap().as_u64().unwrap(),
            1
        );
    }

    #[test]
    fn lifecycle_events_emit_meta() {
        for ty in [
            "turn/start",
            "turn/end",
            "step/start",
            "step/end",
            "session/title",
            "session/title-llm-request",
            "agent/inbox/spliced",
            "request/header",
            "request/context",
            "llm/retry",
            "llm/retry-started",
            "permission/preset",
            "approval/policy",
            "sandbox/mode",
            "goal/change",
        ] {
            let rec = json!({"type": ty, "seq": 1, "time": 1_u64, "data": {}});
            let n = normalize_dsh_record(&rec, 0).unwrap_or_else(|| panic!("{ty} should emit"));
            assert_eq!(n.role, "meta", "{ty} role");
            assert_eq!(n.raw_type, ty, "{ty} raw_type");
        }
    }

    #[test]
    fn unknown_event_type_emits_meta_not_panic() {
        let rec = json!({"type": "future-dsh-event", "seq": 1, "time": 1_u64, "data": {}});
        let n = normalize_dsh_record(&rec, 0).expect("unknown emits");
        assert_eq!(n.role, "meta");
        assert_eq!(n.raw_type, "future-dsh-event");
    }

    #[test]
    fn real_dsh_session_round_trips_through_lines() {
        // v0.9.28: 端到端稳定性 — 真实 9337 行 session 跑过 streaming 路径不 panic
        let path = std::path::Path::new(
            "/tmp/dsh_sample/session.jsonl",
        );
        if !path.exists() {
            eprintln!("skip: real dsh fixture not found at {}", path.display());
            return;
        }
        let mut count = 0usize;
        let mut user_count = 0usize;
        let mut assistant_count = 0usize;
        let mut tool_count = 0usize;
        let mut meta_count = 0usize;
        let mut none_count = 0usize;
        let bytes = std::fs::read(path).expect("read fixture");
        for line in bytes.split(|b| *b == b'\n') {
            if line.is_empty() {
                continue;
            }
            let v: Value = serde_json::from_slice(line).expect("parse");
            count += 1;
            match normalize_dsh_record(&v, count) {
                Some(n) => match n.role.as_str() {
                    "user" => user_count += 1,
                    "assistant" => assistant_count += 1,
                    "tool" => tool_count += 1,
                    "meta" => meta_count += 1,
                    _ => {}
                },
                None => none_count += 1,
            }
        }
        // 9337 总 event: 4 種 streaming chunk 占 ~95% → None
        // 真实分布: 6 user + 174 assistant + 172 tool + 14+ meta + 0 None 之外
        // 实际 None 是 1718+3824+2739+151 = 8432
        assert!(none_count > 5000, "expected many streaming chunks filtered, got {none_count}");
        assert_eq!(user_count, 6, "user messages");
        assert!(assistant_count >= 100, "assistant messages, got {assistant_count}");
        assert!(tool_count >= 100, "tool results, got {tool_count}");
        assert!(meta_count >= 10, "meta events, got {meta_count}");
    }

    #[test]
    fn missing_data_field_returns_none() {
        // wire 损坏 / schema 漂移 — type 存在但 data 不在 → safe 的 None
        let rec = json!({"type": "assistant/message", "seq": 1, "time": 1_u64});
        assert!(normalize_dsh_record(&rec, 0).is_some()); // 现在是空 blocks 但仍 emit
    }

    #[test]
    fn time_ms_converts_to_rfc3339() {
        let rec = json!({
            "type": "user/message",
            "seq": 1,
            "time": 1787100701944_u64,
            "data": {"content":[{"type":"text","text":"hi"}],"role":"user"}
        });
        let n = normalize_dsh_record(&rec, 0).expect("emits");
        let ts = n.timestamp.expect("timestamp present");
        assert!(ts.starts_with("2026-08-19"), "got {ts}");
    }
}
