//! Claude 记录归一化
//!
//! 与前端 packages/shared/src/normalize.ts 的 normalizeClaudeRecord 保持同步

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

    let mut msg = NormalizedMessage {
        id,
        role: "meta".to_string(),
        timestamp,
        blocks: vec![],
        model: None,
        stop_reason: None,
        token_usage: None,
        is_sidechain,
        subagent_id: None,
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
            let prompt = obj.get("prompt").cloned().unwrap_or(Value::Null);
            let mut data = serde_json::Map::new();
            data.insert(
                "label".to_string(),
                Value::String("last-prompt".to_string()),
            );
            data.insert("payload".to_string(), prompt);
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

fn normalize_content(content: &Value) -> Vec<NormalizedBlock> {
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

fn normalize_content_block(item: &Value) -> Option<NormalizedBlock> {
    let obj = item.as_object()?;
    let r#type = obj.get("type")?.as_str()?;
    let mut data = serde_json::Map::new();
    for (k, v) in obj {
        data.insert(k.clone(), v.clone());
    }
    let kind = match r#type {
        "text" => "text".to_string(),
        "thinking" | "redacted_thinking" => "thinking".to_string(),
        "tool_use" | "toolUse" | "tool_call" | "function_call" => "tool_use".to_string(),
        "tool_result" | "toolResult" => "tool_result".to_string(),
        "image" => "image".to_string(),
        _ => {
            // v0.2.6 调查:未知 content block type
            log::warn!(
                "normalize_content_block: 未知 block type={:?}, 完整对象: {:#?}",
                r#type,
                obj
            );
            "meta".to_string()
        }
    };
    Some(NormalizedBlock { kind, data })
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

    #[test]
    fn test_normalize_missing_uuid_uses_index() {
        let v = json!({ "type": "user", "message": { "role": "user", "content": "x" } });
        let n = normalize(&v, 42).unwrap();
        assert_eq!(n.id, "idx-42");
    }
}
