//! Claude 记录归一化
//!
//! 与前端 packages/shared/src/normalize.ts 的 normalizeClaudeRecord 保持同步
//!
//! v0.3.0: block-level normalize 改为走 `blocks::default_registry()`。
//! 本文件保留顶层 type 归一化逻辑(`normalize()`)。

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedBlock {
    /// "text" | "thinking" | "tool_use" | "tool_result" | "image" | "meta"
    pub kind: String,
    #[serde(flatten)]
    pub data: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedMessage {
    pub id: String,
    /// "user" | "assistant" | "tool" | "system" | "meta"
    pub role: String,
    pub timestamp: Option<String>,
    pub blocks: Vec<NormalizedBlock>,
    pub model: Option<String>,
    pub stop_reason: Option<String>,
    #[serde(rename = "tokenUsage")]
    pub token_usage: Option<TokenUsageOut>,
    pub is_sidechain: Option<bool>,
    pub subagent_id: Option<String>,
    pub parent_uuid: Option<String>,
    /// 原始 type 字段
    pub raw_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageOut {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
}

/// 归一化 Claude JSON 记录
pub fn normalize(record: &Value, index: usize) -> Option<NormalizedMessage> {
    let obj = record.as_object()?;
    let r#type = obj.get("type")?.as_str()?.to_string();
    let id = obj
        .get("uuid")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("idx-{}", index));
    let timestamp = obj
        .get("timestamp")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let parent_uuid = obj
        .get("parentUuid")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let is_sidechain = obj.get("isSidechain").and_then(|v| v.as_bool());

    // v0.6.0: subagentId 归一化
    //
    // 数据源: 子 session (`<main>/subagents/agent-<id>.jsonl`) 的 envelope 顶层有
    //   { "isSidechain": true, "agentId": "a1d924c..." }
    // 主 session envelope 顶层没 agentId 字段,且 isSidechain 始终 false。
    //
    // ⚠️ 关键安全: **只在 isSidechain=true 时信任 agentId**。
    //   主 session 即使 envelope 写了 agentId(实测没有)也不填,避免子代理消息被误标
    //   到主 session timeline 上。
    let subagent_id = if is_sidechain == Some(true) {
        obj.get("agentId")
            .and_then(|v| v.as_str())
            .map(String::from)
    } else {
        None
    };

    let mut msg = NormalizedMessage {
        id,
        role: "meta".to_string(),
        timestamp,
        blocks: vec![],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain,
        subagent_id,
        parent_uuid,
        raw_type: r#type.clone(),
    };

    match r#type.as_str() {
        "user" => {
            msg.role = "user".to_string();
            if let Some(message) = obj.get("message") {
                if let Some(content) = message.get("content") {
                    msg.blocks = normalize_content(content);
                }
            }
        }
        "assistant" => {
            msg.role = "assistant".to_string();
            if let Some(message) = obj.get("message") {
                msg.model = message
                    .get("model")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                msg.stop_reason = message
                    .get("stop_reason")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                if let Some(content) = message.get("content") {
                    msg.blocks = normalize_content(content);
                }
                if let Some(usage) = message.get("usage") {
                    msg.token_usage = Some(TokenUsageOut {
                        input: usage
                            .get("input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        output: usage
                            .get("output_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        cache_read: usage
                            .get("cache_read_input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                        cache_write: usage
                            .get("cache_creation_input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0),
                    });
                }
            }
        }
        "system" => {
            msg.role = "system".to_string();
            let content = obj
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            msg.blocks.push(NormalizedBlock {
                kind: "text".to_string(),
                data: serde_json::Map::from_iter([("text".to_string(), Value::String(content))]),
            });
        }
        "attachment" => {
            if let Some(att) = obj.get("attachment") {
                let label = att
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("attachment")
                    .to_string();
                let mut data = serde_json::Map::new();
                data.insert("label".to_string(), Value::String(label));
                data.insert("payload".to_string(), att.clone());
                msg.blocks.push(NormalizedBlock {
                    kind: "meta".to_string(),
                    data,
                });
            }
        }
        "mode" => {
            let mode = obj
                .get("mode")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut data = serde_json::Map::new();
            data.insert(
                "label".to_string(),
                Value::String(format!("mode: {}", mode)),
            );
            msg.blocks.push(NormalizedBlock {
                kind: "meta".to_string(),
                data,
            });
        }
        "permission-mode" => {
            let mode = obj
                .get("permissionMode")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut data = serde_json::Map::new();
            data.insert(
                "label".to_string(),
                Value::String(format!("permission: {}", mode)),
            );
            msg.blocks.push(NormalizedBlock {
                kind: "meta".to_string(),
                data,
            });
        }
        "ai-title" | "custom-title" => {
            let title = obj
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let mut data = serde_json::Map::new();
            data.insert("label".to_string(), Value::String("title".to_string()));
            data.insert("payload".to_string(), Value::String(title));
            msg.blocks.push(NormalizedBlock {
                kind: "meta".to_string(),
                data,
            });
        }
        "last-prompt" => {
            // v0.6.0: 真实数据字段是 `lastPrompt` (camelCase), 兼容老版本 `prompt`
            let prompt = obj
                .get("lastPrompt")
                .or_else(|| obj.get("prompt"))
                .cloned()
                .unwrap_or(Value::Null);
            let leaf_uuid = obj
                .get("leafUuid")
                .and_then(|v| v.as_str())
                .map(String::from);
            let mut data = serde_json::Map::new();
            data.insert(
                "label".to_string(),
                Value::String("last-prompt".to_string()),
            );
            // v0.6.0: payload 结构改成 { prompt, leafUuid? } 跟前端 normalize.ts 对齐
            // (之前是裸 string, UI 拿不到 leafUuid 无法跳转)
            let mut payload = serde_json::Map::new();
            if !prompt.is_null() {
                payload.insert("prompt".to_string(), prompt);
            }
            if let Some(lu) = leaf_uuid {
                payload.insert("leafUuid".to_string(), Value::String(lu));
            }
            data.insert("payload".to_string(), Value::Object(payload));
            msg.blocks.push(NormalizedBlock {
                kind: "meta".to_string(),
                data,
            });
        }
        "file-history-snapshot" => {
            let snapshot = obj.get("snapshot").cloned().unwrap_or(Value::Null);
            let mut data = serde_json::Map::new();
            data.insert(
                "label".to_string(),
                Value::String("file-history-snapshot".to_string()),
            );
            data.insert("payload".to_string(), snapshot);
            msg.blocks.push(NormalizedBlock {
                kind: "meta".to_string(),
                data,
            });
        }
        "task_reminder" => {
            let mut data = serde_json::Map::new();
            data.insert(
                "label".to_string(),
                Value::String("task-reminder".to_string()),
            );
            data.insert("payload".to_string(), Value::Object(obj.clone()));
            msg.blocks.push(NormalizedBlock {
                kind: "meta".to_string(),
                data,
            });
        }
        _ => {
            // 未知 type,原样塞到 meta
            let mut data = serde_json::Map::new();
            data.insert("label".to_string(), Value::String(r#type.clone()));
            data.insert("payload".to_string(), Value::Object(obj.clone()));
            msg.blocks.push(NormalizedBlock {
                kind: "meta".to_string(),
                data,
            });
        }
    }

    Some(msg)
}

/// 归一化 content(字符串或数组)。公开给 openclaw.rs 直接调用。
pub(crate) fn normalize_content(content: &Value) -> Vec<NormalizedBlock> {
    let mut out = Vec::new();
    match content {
        Value::String(s) => {
            log::trace!("normalize_content: string len={}", s.len());
            let mut data = serde_json::Map::new();
            data.insert("text".to_string(), Value::String(s.clone()));
            out.push(NormalizedBlock {
                kind: "text".to_string(),
                data,
            });
        }
        Value::Array(arr) => {
            log::trace!("normalize_content: array len={}", arr.len());
            for item in arr {
                if let Some(b) = normalize_content_block(item) {
                    out.push(b);
                }
            }
        }
        other => {
            // v0.2.6 调查:Windows 上 liushuyou/91d1796e 报 [object Object],
            // 可能是 content 是单个对象(不是数组)且类型不在已知列表里。
            log::warn!(
                "normalize_content: 未知 content 形态 {:?} - {:#?}",
                match other {
                    Value::Null => "null",
                    Value::Bool(_) => "bool",
                    Value::Number(_) => "number",
                    Value::Object(_) => "object",
                    Value::String(_) => "string",
                    Value::Array(_) => "array",
                },
                other
            );
        }
    }
    out
}

/// v0.3.0: block 归一化委托给 BlockRegistry
///
/// 行为应当与之前的 inline match 等价(53 个测试全过)。
/// 真正的 handler 实现拆到 `parser/blocks/` 目录。
fn normalize_content_block(item: &Value) -> Option<NormalizedBlock> {
    crate::parser::blocks::default_registry()
        .normalize(item)
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_normalize_user_text() {
        let v = json!({
            "type": "user",
            "uuid": "u1",
            "timestamp": "2026-06-20T00:00:00Z",
            "message": { "role": "user", "content": "Hello" }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.role, "user");
        assert_eq!(n.id, "u1");
        assert_eq!(n.timestamp.as_deref(), Some("2026-06-20T00:00:00Z"));
        assert_eq!(n.blocks.len(), 1);
        assert_eq!(n.blocks[0].kind, "text");
    }

    #[test]
    fn test_normalize_user_blocks() {
        let v = json!({
            "type": "user",
            "uuid": "u2",
            "message": {
                "role": "user",
                "content": [
                    { "type": "text", "text": "first" },
                    { "type": "text", "text": "second" }
                ]
            }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.blocks.len(), 2);
        assert_eq!(n.blocks[0].kind, "text");
        assert_eq!(n.blocks[1].kind, "text");
    }

    #[test]
    fn test_normalize_assistant_with_tool_use() {
        let v = json!({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "Let me check." },
                    {
                        "type": "tool_use",
                        "id": "tu1",
                        "name": "Read",
                        "input": { "file_path": "/tmp/a.ts" }
                    }
                ],
                "model": "claude-sonnet-4-6",
                "stop_reason": "tool_use",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "cache_read_input_tokens": 20
                }
            }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.role, "assistant");
        assert_eq!(n.model.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(n.stop_reason.as_deref(), Some("tool_use"));
        assert_eq!(n.token_usage.as_ref().unwrap().input, 100);
        assert_eq!(n.token_usage.as_ref().unwrap().cache_read, 20);
        assert_eq!(n.blocks.len(), 2);
        assert_eq!(n.blocks[0].kind, "text");
        assert_eq!(n.blocks[1].kind, "tool_use");
    }

    #[test]
    fn test_normalize_assistant_thinking() {
        let v = json!({
            "type": "assistant",
            "uuid": "a2",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "thinking", "thinking": "Let me think...", "signature": "sig1" },
                    { "type": "text", "text": "Answer" }
                ],
                "model": "claude-opus-4-8",
                "stop_reason": "end_turn",
                "usage": { "input_tokens": 1, "output_tokens": 1 }
            }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.blocks[0].kind, "thinking");
        assert_eq!(n.blocks[1].kind, "text");
    }

    #[test]
    fn test_normalize_meta_records() {
        let cases = [
            ("mode", json!({ "type": "mode", "mode": "plan" })),
            (
                "permission-mode",
                json!({ "type": "permission-mode", "permissionMode": "acceptEdits" }),
            ),
            (
                "custom-title",
                json!({ "type": "custom-title", "title": "My session" }),
            ),
            (
                "ai-title",
                json!({ "type": "ai-title", "title": "AI title" }),
            ),
            (
                "task_reminder",
                json!({ "type": "task_reminder", "itemCount": 3 }),
            ),
            (
                "file-history-snapshot",
                json!({
                    "type": "file-history-snapshot",
                    "messageId": "m1",
                    "snapshot": { "trackedFileBackups": {} }
                }),
            ),
        ];
        for (label, v) in cases {
            let n = normalize(&v, 0).unwrap_or_else(|| panic!("{label}"));
            assert_eq!(n.role, "meta", "role mismatch for {label}");
            assert_eq!(n.blocks[0].kind, "meta");
            assert!(!n.blocks[0].data.is_empty(), "{label} should have label");
        }
    }

    #[test]
    fn test_normalize_attachment() {
        let v = json!({
            "type": "attachment",
            "attachment": {
                "type": "agent_listing_delta",
                "addedTypes": ["Explore"]
            }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.role, "meta");
        assert_eq!(n.blocks[0].kind, "meta");
        assert_eq!(
            n.blocks[0].data.get("label").and_then(|v| v.as_str()),
            Some("agent_listing_delta")
        );
    }

    #[test]
    fn test_normalize_tool_result() {
        let v = json!({
            "type": "user",
            "uuid": "u3",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "tu1",
                        "content": "the result",
                        "is_error": false
                    }
                ]
            }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.blocks.len(), 1);
        assert_eq!(n.blocks[0].kind, "tool_result");
    }

    #[test]
    fn test_normalize_unknown_type() {
        let v = json!({ "type": "weird-future-type", "data": 42 });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.role, "meta");
        assert_eq!(n.raw_type, "weird-future-type");
    }

    /// v0.2.6: pi-coding-agent 用 `toolCall` type + `arguments` 字段(不是
    /// Claude 的 `tool_use` + `input`)。归一化后应当映射到 kind=tool_use
    /// 且 `arguments` 重命名为 `input`。
    #[test]
    fn test_normalize_tool_call_alias() {
        let v = json!({
            "type": "assistant",
            "uuid": "a1",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "id": "call_abc",
                        "name": "read",
                        "arguments": { "path": "/tmp/x.md" }
                    }
                ],
                "model": "claude-sonnet-4-6",
                "stop_reason": "tool_use",
                "usage": { "input_tokens": 1, "output_tokens": 1 }
            }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.blocks.len(), 1);
        let b = &n.blocks[0];
        assert_eq!(b.kind, "tool_use");
        assert_eq!(b.data.get("id").and_then(|v| v.as_str()), Some("call_abc"));
        assert_eq!(b.data.get("name").and_then(|v| v.as_str()), Some("read"));
        // arguments → input 重命名
        assert_eq!(
            b.data
                .get("input")
                .and_then(|v| v.get("path"))
                .and_then(|v| v.as_str()),
            Some("/tmp/x.md")
        );
        // 原始 arguments 字段已移除
        assert!(b.data.get("arguments").is_none());
    }

    #[test]
    fn test_normalize_missing_uuid_uses_index() {
        let v = json!({ "type": "user", "message": { "role": "user", "content": "x" } });
        let n = normalize(&v, 42).unwrap();
        assert_eq!(n.id, "idx-42");
    }

    // v0.6.0: subagentId 归一化 — 3 case

    #[test]
    fn test_subagent_id_filled_only_when_is_sidechain_true() {
        // isSidechain=true 且 envelope 有 agentId → 填入
        let v = json!({
            "type": "user",
            "isSidechain": true,
            "agentId": "a1d924c184a57a7da",
            "message": { "role": "user", "content": "..." }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.subagent_id.as_deref(), Some("a1d924c184a57a7da"));
        assert_eq!(n.is_sidechain, Some(true));
    }

    #[test]
    fn test_subagent_id_ignored_when_is_sidechain_false() {
        // isSidechain=false (主 session) 即便 envelope 写 agentId 也不填 —
        // 避免子代理消息被误标到主 session timeline。
        let v = json!({
            "type": "user",
            "isSidechain": false,
            "agentId": "should_be_ignored",
            "message": { "role": "user", "content": "..." }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.subagent_id, None);
        assert_eq!(n.is_sidechain, Some(false));
    }

    #[test]
    fn test_subagent_id_none_when_is_sidechain_true_but_no_agent_id() {
        // isSidechain=true 但 envelope 缺 agentId(老 Claude / 边界 case) → None
        let v = json!({
            "type": "user",
            "isSidechain": true,
            "message": { "role": "user", "content": "..." }
        });
        let n = normalize(&v, 0).unwrap();
        assert_eq!(n.subagent_id, None);
    }
}
