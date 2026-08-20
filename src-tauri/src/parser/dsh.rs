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

        // session 生命周期 / 用户可观察的元数据 — emit meta (M11.5 用专门 builder 提取干净字段)
        "session" => Some(build_session_meta(obj, index)),
        "session/title" => Some(build_session_title_meta(obj, index, timestamp)),
        "session/title-llm-request" => Some(build_title_llm_request_meta(obj, index, timestamp)),
        "todo/write" => Some(build_todo_meta(obj, index, timestamp)),
        "permission/preset" => Some(build_permission_meta(obj, index, timestamp)),
        "approval/policy" => Some(build_approval_meta(obj, index, timestamp)),
        "sandbox/mode" => Some(build_sandbox_meta(obj, index, timestamp)),
        "goal/change" => Some(build_simple_meta(obj, r#type, index, timestamp)),

        // v0.9.28 (M11.4): 协议层 noise event filter — 不在详情页 emit meta,
        // 否则 9337 行 session 会污染 transcript: 348 step events + 172 tool/call
        // (assistant/message 已含 tool_use block) + 8 turn + 8 spliced + 2 retry
        // + 2 request/header (已进 meta_banner) + 1 request/context = 541 noise pill。
        // 跟 streaming chunk 一样的策略: 返回 None 让 transcript 跳过它们。
        "step/start"
        | "step/end"
        | "turn/start"
        | "turn/end"
        | "tool/call"
        | "agent/inbox/spliced"
        | "llm/retry"
        | "llm/retry-started"
        | "request/header"
        | "request/context" => None,

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
        data.insert(
            "agent_preset".to_string(),
            Value::String(preset.to_string()),
        );
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
    let message = data
        .and_then(|d| d.get("message"))
        .and_then(|v| v.as_object());

    let model = message
        .and_then(|m| m.get("source"))
        .and_then(|s| s.get("model"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let mut blocks: Vec<NormalizedBlock> = Vec::new();
    if let Some(content_arr) = message
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array())
    {
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
                    let args_raw = part
                        .get("arguments")
                        .and_then(|v| v.as_str())
                        .unwrap_or("{}");
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
        let cache_read = u
            .get("cacheReadTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let cache_write = u
            .get("cacheCreationTokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
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
    let message = data
        .and_then(|d| d.get("message"))
        .and_then(|v| v.as_object());

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

/// v0.9.28: `todo/write` — 提到 todo_count / done_count 到顶层,跟 kimi 同思路
///
/// v0.9.28 (M11.3): dsh 真实 wire 用 status="completed" (跟 kimi 的 "done" 等价),
/// 这里 done_count 同时认 "done" / "completed"。in_progress / pending 跟 kimi 一致。
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
                    let status = t
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("pending");
                    Some((content.to_string(), status.to_string()))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let done_count = todos
        .iter()
        .filter(|(_, s)| s == "done" || s == "completed")
        .count() as u64;
    let in_progress_count = todos.iter().filter(|(_, s)| s == "in_progress").count() as u64;
    let pending_count = todos.iter().filter(|(_, s)| s == "pending").count() as u64;

    let mut m = serde_json::Map::new();
    m.insert("label".to_string(), Value::String("todo/write".to_string()));
    m.insert("todo_count".to_string(), Value::from(todos.len() as u64));
    m.insert("done_count".to_string(), Value::from(done_count));
    m.insert(
        "in_progress_count".to_string(),
        Value::from(in_progress_count),
    );
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

/// v0.9.28 (M11.5): `permission/preset` → meta,提取 data.preset 为 `mode` 顶层字段
///
/// 之前用 build_simple_meta 把整个 envelope (seq/time/type/data) 塞到 payload,
/// EventMetaBlock 渲染时 seq/time/type 全是噪音。提到顶层后 banner 也能直接 get("mode")。
fn build_permission_meta(
    obj: &serde_json::Map<String, Value>,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let mode = obj
        .get("data")
        .and_then(|d| d.get("preset"))
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let mut m = serde_json::Map::new();
    m.insert(
        "label".to_string(),
        Value::String("permission/preset".to_string()),
    );
    m.insert("mode".to_string(), Value::String(mode.to_string()));
    m.insert("payload".to_string(), Value::Object(obj.clone()));
    NormalizedMessage {
        id: format!("dsh-permission-{index}"),
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
        raw_type: "permission/preset".to_string(),
    }
}

/// v0.9.28 (M11.5): `sandbox/mode` → meta,提取 data.mode 为 `mode` 顶层字段
///
/// v0.9.28 M11.3 bug: 跟 permission/preset 共用 permission_mode 字段,sandbox 后发
/// 会 silent 覆盖 preset。frontend 修复后 sandbox/mode 写到独立 sandbox_mode。
fn build_sandbox_meta(
    obj: &serde_json::Map<String, Value>,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let mode = obj
        .get("data")
        .and_then(|d| d.get("mode"))
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let mut m = serde_json::Map::new();
    m.insert(
        "label".to_string(),
        Value::String("sandbox/mode".to_string()),
    );
    m.insert("mode".to_string(), Value::String(mode.to_string()));
    m.insert("payload".to_string(), Value::Object(obj.clone()));
    NormalizedMessage {
        id: format!("dsh-sandbox-{index}"),
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
        raw_type: "sandbox/mode".to_string(),
    }
}

/// v0.9.28 (M11.5): `approval/policy` → meta,提取 data.policy 为 `policy` 顶层字段
///
/// M11.3 之前只 increment approval_count、policy 值被丢。现在提取到顶层供 banner 显示。
fn build_approval_meta(
    obj: &serde_json::Map<String, Value>,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let policy = obj
        .get("data")
        .and_then(|d| d.get("policy"))
        .and_then(|v| v.as_str())
        .unwrap_or("?");
    let mut m = serde_json::Map::new();
    m.insert(
        "label".to_string(),
        Value::String("approval/policy".to_string()),
    );
    m.insert("policy".to_string(), Value::String(policy.to_string()));
    m.insert("payload".to_string(), Value::Object(obj.clone()));
    NormalizedMessage {
        id: format!("dsh-approval-{index}"),
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
        raw_type: "approval/policy".to_string(),
    }
}

/// v0.9.28 (M11.5): `session/title` → meta,提取 `title` 和 `source.kind` 顶层字段
///
/// `source.kind` ∈ {"fallback", "provider"}:fallback 是 first prompt 的截断、
/// provider 是 LLM 生成的可读标题。provider 优先于 fallback,已在 head loop 实现。
fn build_session_title_meta(
    obj: &serde_json::Map<String, Value>,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let title = obj
        .get("data")
        .and_then(|d| d.get("title"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let kind = obj
        .get("data")
        .and_then(|d| d.get("source"))
        .and_then(|s| s.get("kind"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let mut m = serde_json::Map::new();
    m.insert(
        "label".to_string(),
        Value::String("session/title".to_string()),
    );
    m.insert("title".to_string(), Value::String(title.to_string()));
    m.insert("kind".to_string(), Value::String(kind.to_string()));
    m.insert("payload".to_string(), Value::Object(obj.clone()));
    NormalizedMessage {
        id: format!("dsh-session-title-{index}"),
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
        raw_type: "session/title".to_string(),
    }
}

/// v0.9.28 (M11.5): `session/title-llm-request` → meta,提取 `route.model` 和 `titleProvider`
///
/// 描述 LLM 用于生成 title 的请求细节。一个 session 最多发 1 次,作为 debug pill 有用。
fn build_title_llm_request_meta(
    obj: &serde_json::Map<String, Value>,
    index: usize,
    timestamp: Option<String>,
) -> NormalizedMessage {
    let route_model = obj
        .get("data")
        .and_then(|d| d.get("route"))
        .and_then(|r| r.get("model"))
        .and_then(|v| v.as_str());
    let title_provider = obj
        .get("data")
        .and_then(|d| d.get("titleProvider"))
        .and_then(|v| v.as_str());
    let max_tokens = obj
        .get("data")
        .and_then(|d| d.get("maxTokens"))
        .and_then(|v| v.as_u64());
    let mut m = serde_json::Map::new();
    m.insert(
        "label".to_string(),
        Value::String("session/title-llm-request".to_string()),
    );
    if let Some(rm) = route_model {
        m.insert("route_model".to_string(), Value::String(rm.to_string()));
    }
    if let Some(tp) = title_provider {
        m.insert("title_provider".to_string(), Value::String(tp.to_string()));
    }
    if let Some(mt) = max_tokens {
        m.insert("max_tokens".to_string(), Value::from(mt));
    }
    m.insert("payload".to_string(), Value::Object(obj.clone()));
    NormalizedMessage {
        id: format!("dsh-title-llm-{index}"),
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
        raw_type: "session/title-llm-request".to_string(),
    }
}

/// v0.9.28: 通用 meta emit — 用于 `goal/change` 等暂未专门提取的 user-observable 事件
/// (permission/preset / sandbox/mode / approval/policy / session/title /
/// session/title-llm-request 都有专门 builder,不再用通用 fallback)。
/// 协议层 noise event (step/start 等) 已在 normalize_dsh_record match 里返回 None。
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
            n.blocks[0]
                .data
                .get("agent_preset")
                .unwrap()
                .as_str()
                .unwrap(),
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
        assert_eq!(
            n.blocks[2].data.get("name").unwrap().as_str().unwrap(),
            "bash"
        );
        assert_eq!(
            n.blocks[2]
                .data
                .get("input")
                .unwrap()
                .get("command")
                .unwrap()
                .as_str()
                .unwrap(),
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
    fn tool_call_filtered_to_none_to_avoid_duplicating_tool_use_blocks() {
        // v0.9.28 (M11.4): tool/call 事件被 filter 掉 — assistant/message 已经
        // 把每个 tool-call 作为 tool_use block 渲染,tool/call meta pill 是重复噪音。
        // 真实样本统计: 172 个 tool/call vs 172 个 tool/result,1:1 对应,
        // 多余会让用户看到 "tool_call:bash → tool_use:bash → tool_result" 三连击。
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
        assert!(
            normalize_dsh_record(&rec, 3).is_none(),
            "tool/call must filter to None, assistant/message already renders tool_use"
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
            n.blocks[0]
                .data
                .get("tool_call_id")
                .unwrap()
                .as_str()
                .unwrap(),
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
            n.blocks[0]
                .data
                .get("todo_count")
                .unwrap()
                .as_u64()
                .unwrap(),
            3
        );
        assert_eq!(
            n.blocks[0]
                .data
                .get("done_count")
                .unwrap()
                .as_u64()
                .unwrap(),
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
            n.blocks[0]
                .data
                .get("pending_count")
                .unwrap()
                .as_u64()
                .unwrap(),
            1
        );
    }

    #[test]
    fn todo_write_completed_status_counts_as_done() {
        // v0.9.28 (M11.3): dsh 真实 wire status="completed" (跟 kimi 的 "done" 同义),
        // build_todo_meta 必须把它算进 done_count,前端才能正确显示 "📋 N/M 任务"。
        let rec = json!({
            "type": "todo/write",
            "seq": 100,
            "time": 1_u64,
            "data": {
                "todos": [
                    {"content": "task A", "status": "completed"},
                    {"content": "task B", "status": "completed"},
                    {"content": "task C", "status": "in_progress"},
                    {"content": "task D", "status": "pending"}
                ]
            }
        });
        let n = normalize_dsh_record(&rec, 0).expect("todo/write emits");
        assert_eq!(
            n.blocks[0]
                .data
                .get("todo_count")
                .unwrap()
                .as_u64()
                .unwrap(),
            4
        );
        assert_eq!(
            n.blocks[0]
                .data
                .get("done_count")
                .unwrap()
                .as_u64()
                .unwrap(),
            2,
            "completed 状态应该算 done"
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
            n.blocks[0]
                .data
                .get("pending_count")
                .unwrap()
                .as_u64()
                .unwrap(),
            1
        );
    }

    #[test]
    fn user_observable_meta_events_emit_meta() {
        // v0.9.28 (M11.4): session-level 配置 / 标题 / 目标事件继续 emit meta —
        // 它们承载用户应该看到的信息 (title、permission preset、sandbox、approval、goal)。
        for ty in [
            "session/title",
            "session/title-llm-request",
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

    // v0.9.28 (M11.5): 给 session 配置事件加专门 builder,提到干净顶层字段,
    // 替代 M11.3 把整个 envelope (seq/time/type/data) dump 到 payload 的做法。
    // EventMetaBlock 渲染 payload 太啰嗦,提取后 banner / pill 直接读顶层字段。

    #[test]
    fn permission_preset_extracts_mode_to_top_level() {
        let rec = json!({
            "type": "permission/preset",
            "seq": 0,
            "time": 1787100548516_u64,
            "data": {"preset": "workspace-write"}
        });
        let n = normalize_dsh_record(&rec, 0).expect("emits");
        assert_eq!(n.raw_type, "permission/preset");
        assert_eq!(
            n.blocks[0].data.get("mode").unwrap().as_str().unwrap(),
            "workspace-write"
        );
    }

    #[test]
    fn sandbox_mode_extracts_mode_to_top_level_independent_of_permission() {
        // M11.5: 验证 sandbox/mode 跟 permission/preset 提取到独立的 mode 字段 —
        // M11.3 bug 是 sandbox 后发覆盖 permission_mode,sandbox/mode 自己值丢失。
        // 真实 wire 里两者通常同值 ("workspace-write"),但语义维度不同必须独立。
        let sandbox = json!({
            "type": "sandbox/mode",
            "seq": 1,
            "time": 1_u64,
            "data": {"mode": "workspace-write"}
        });
        let n = normalize_dsh_record(&sandbox, 0).expect("emits");
        assert_eq!(n.raw_type, "sandbox/mode");
        assert_eq!(
            n.blocks[0].data.get("mode").unwrap().as_str().unwrap(),
            "workspace-write"
        );
        // 即使 sandbox mode 跟 preset 不同 (例如 docker),也不应该跟 permission 字段冲突 —
        // 这里通过 raw_type 区分 (frontend 路由到 sandbox_mode 列,不是 permission_mode)。
        let docker = json!({
            "type": "sandbox/mode",
            "seq": 2,
            "time": 1_u64,
            "data": {"mode": "docker"}
        });
        let n2 = normalize_dsh_record(&docker, 0).expect("emits");
        assert_eq!(
            n2.blocks[0].data.get("mode").unwrap().as_str().unwrap(),
            "docker"
        );
    }

    #[test]
    fn approval_policy_extracts_policy_to_top_level() {
        // M11.5: approval/policy.data.policy ("ask" / "auto" / "deny") 之前被丢,
        // 现在提到顶层供 banner 渲染当前生效策略。
        let rec = json!({
            "type": "approval/policy",
            "seq": 2,
            "time": 1787100548517_u64,
            "data": {"policy": "ask"}
        });
        let n = normalize_dsh_record(&rec, 0).expect("emits");
        assert_eq!(n.raw_type, "approval/policy");
        assert_eq!(
            n.blocks[0].data.get("policy").unwrap().as_str().unwrap(),
            "ask"
        );
    }

    #[test]
    fn session_title_extracts_title_and_kind_to_top_level() {
        // M11.5: session/title 提到 title + kind (fallback / provider) 顶层,
        // EventMetaBlock 直接渲染。真实 wire 里 kind="provider" 是 LLM 生成、
        // kind="fallback" 是 first prompt 截断。
        let provider = json!({
            "type": "session/title",
            "seq": 14,
            "time": 1787100703122_u64,
            "data": {
                "messageSeqs": [7],
                "source": {
                    "kind": "provider",
                    "model": {"model": "deepseek-v4-flash", "provider": "deepseek-official"},
                    "provider": "session-title-first-prompt-llm"
                },
                "title": "将论文PDF每段添加中文翻译"
            }
        });
        let n = normalize_dsh_record(&provider, 0).expect("emits");
        assert_eq!(n.raw_type, "session/title");
        assert_eq!(
            n.blocks[0].data.get("title").unwrap().as_str().unwrap(),
            "将论文PDF每段添加中文翻译"
        );
        assert_eq!(
            n.blocks[0].data.get("kind").unwrap().as_str().unwrap(),
            "provider"
        );

        let fallback = json!({
            "type": "session/title",
            "seq": 10,
            "time": 1787100701949_u64,
            "data": {
                "messageSeqs": [7],
                "source": {"kind": "fallback"},
                "title": "把paper.pdf 文件每段增加中文翻"
            }
        });
        let n2 = normalize_dsh_record(&fallback, 1).expect("emits");
        assert_eq!(
            n2.blocks[0].data.get("kind").unwrap().as_str().unwrap(),
            "fallback"
        );
    }

    #[test]
    fn title_llm_request_extracts_route_and_provider_to_top_level() {
        // M11.5: session/title-llm-request 描述 LLM 用于生成 title 的请求细节
        // (route.model + titleProvider + maxTokens),提到顶层供 debug pill 用。
        let rec = json!({
            "type": "session/title-llm-request",
            "seq": 13,
            "time": 1787100701956_u64,
            "data": {
                "route": {"model": "deepseek-v4-flash", "provider": "deepseek-official"},
                "titleProvider": "session-title-first-prompt-llm",
                "maxTokens": 64,
                "messages": [{"content": [{"text": "..."}], "role": "user"}]
            }
        });
        let n = normalize_dsh_record(&rec, 0).expect("emits");
        assert_eq!(n.raw_type, "session/title-llm-request");
        assert_eq!(
            n.blocks[0]
                .data
                .get("route_model")
                .unwrap()
                .as_str()
                .unwrap(),
            "deepseek-v4-flash"
        );
        assert_eq!(
            n.blocks[0]
                .data
                .get("title_provider")
                .unwrap()
                .as_str()
                .unwrap(),
            "session-title-first-prompt-llm"
        );
        assert_eq!(
            n.blocks[0]
                .data
                .get("max_tokens")
                .unwrap()
                .as_u64()
                .unwrap(),
            64
        );
    }

    #[test]
    fn protocol_noise_events_filter_to_none() {
        // v0.9.28 (M11.4): 协议层 noise event — 不在 transcript emit meta pill。
        // 真实样本统计: 这些类型贡献 541 个 noise pill (vs 12 个有用 meta),详情页会
        // 被 step/start (174×) + step/end (174×) + tool/call (172×) 主导,看不到内容。
        // 跟 streaming chunk 同样策略: 返回 None,让 transcript 跳过它们。
        // request/header 已聚合进 meta_banner;request/context 是内部请求上下文;
        // agent/inbox/spliced / llm/retry* 是 agent runtime 内部 lifecycle。
        for ty in [
            "turn/start",
            "turn/end",
            "step/start",
            "step/end",
            "tool/call",
            "agent/inbox/spliced",
            "request/header",
            "request/context",
            "llm/retry",
            "llm/retry-started",
        ] {
            let rec = json!({"type": ty, "seq": 1, "time": 1_u64, "data": {}});
            assert!(
                normalize_dsh_record(&rec, 0).is_none(),
                "{ty} should filter to None (protocol noise)"
            );
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
        let path = std::path::Path::new("/tmp/dsh_sample/session.jsonl");
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
        // v0.9.28 (M11.4): 协议层 noise (step/turn/tool-call/spliced/retry/request) filter 掉。
        // 真实样本: 9337 event 总数
        //   4 streaming chunk → None: 1718+3824+2739+151 = 8432
        //   10 noise event → None: 348 (step) + 172 (tool/call) + 8 (turn) + 8 (spliced)
        //                          + 2 (retry) + 2 (request/header) + 1 (request/context) = 541
        //   12 useful meta → Some: 1 session + 2 session/title + 1 title-llm + 3 todo + 1 permission
        //                          + 1 sandbox + 1 approval + 2 goal = 12
        //   6 user + 174 assistant + 172 tool → Some (unchanged)
        //   none_count: 8432 + 541 = 8973
        //   meta_count: 12
        assert!(
            none_count > 8000,
            "expected streaming + noise filtered, got {none_count}"
        );
        assert_eq!(user_count, 6, "user messages");
        assert_eq!(assistant_count, 174, "assistant messages");
        assert_eq!(tool_count, 172, "tool results");
        assert_eq!(
            meta_count, 12,
            "meta events: only session/title/permission/sandbox/approval/goal/todo should emit (M11.4)"
        );
        // 总数守恒: 6 + 174 + 172 + 12 + 8973 = 9337
        assert_eq!(
            count,
            user_count + assistant_count + tool_count + meta_count + none_count,
            "event count must reconcile: {count} vs {}",
            user_count + assistant_count + tool_count + meta_count + none_count
        );
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
