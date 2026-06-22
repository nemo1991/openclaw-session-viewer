//! OpenClaw 记录归一化

use serde_json::Value;

use super::claude::{normalize, NormalizedBlock, NormalizedMessage};

/// 归一化 OpenClaw JSON 记录(header 返回 None)
pub fn normalize_entry(record: &Value, index: usize) -> Option<NormalizedMessage> {
    let obj = record.as_object()?;
    let r#type = obj.get("type")?.as_str()?;

    if r#type == "session" {
        return None; // header, 不渲染
    }

    // 把 OpenClaw 记录转成 Claude 形态再复用 normalize()
    let mut transformed = obj.clone();
    transformed.insert("type".to_string(), Value::String("message".to_string()));

    // OpenClaw message 格式:
    // { type: "message", id, parentId, timestamp, message: { role, content } }
    // Claude 格式需要:
    // { type: "user"|"assistant", uuid, timestamp, message: { role, content, model, stop_reason, usage } }
    if r#type == "message" {
        let original_role = obj
            .get("message")
            .and_then(|m| m.get("role"))
            .and_then(|v| v.as_str())
            .unwrap_or("user")
            .to_string();

        if let Some(message) = obj.get("message") {
            // Claude 格式把 tool result 作为 user 消息
            let claude_type = match original_role.as_str() {
                "assistant" => "assistant",
                _ => "user",
            };
            transformed.insert("type".to_string(), Value::String(claude_type.to_string()));

            if let Some(id) = obj.get("id") {
                transformed.insert("uuid".to_string(), id.clone());
            }
            if let Some(parent) = obj.get("parentId") {
                if !parent.is_null() {
                    transformed.insert("parentUuid".to_string(), parent.clone());
                } else {
                    transformed.insert("parentUuid".to_string(), Value::Null);
                }
            }
        }

        // 调用 normalize 后,如果是 OpenClaw 工具结果,把 role 改回 "tool"
        if let Some(mut msg) = normalize(&Value::Object(transformed), index) {
            if original_role == "tool" {
                msg.role = "tool".to_string();
            }
            return Some(msg);
        }
        return None;
    } else {
        // 其他类型( model_change / compaction / label 等)转成 meta 块
        let id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("idx-{}", index));
        let timestamp = obj
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let parent_id: Option<String> = obj
            .get("parentId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let mut data = serde_json::Map::new();
        data.insert("label".to_string(), Value::String(r#type.to_string()));
        data.insert("payload".to_string(), Value::Object(obj.clone()));

        return Some(NormalizedMessage {
            id,
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
            parent_uuid: parent_id,
            raw_type: r#type.to_string(),
        });
    }

    normalize(&Value::Object(transformed), index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_header_returns_none() {
        let v = json!({
            "type": "session",
            "version": 1,
            "id": "s1",
            "cwd": "/tmp",
            "timestamp": "2026-06-20T00:00:00Z"
        });
        assert!(normalize_entry(&v, 0).is_none());
    }

    #[test]
    fn test_message_user() {
        let v = json!({
            "type": "message",
            "id": "m1",
            "parentId": null,
            "timestamp": "2026-06-20T00:00:00Z",
            "message": { "role": "user", "content": "Hi" }
        });
        let n = normalize_entry(&v, 0).unwrap();
        assert_eq!(n.role, "user");
        assert_eq!(n.blocks[0].kind, "text");
        assert_eq!(n.parent_uuid, None);
    }

    #[test]
    fn test_message_assistant_tool_call() {
        let v = json!({
            "type": "message",
            "id": "m2",
            "parentId": "m1",
            "timestamp": "2026-06-20T00:00:01Z",
            "message": {
                "role": "assistant",
                "content": [
                    { "type": "text", "text": "Reading" },
                    {
                        "type": "toolUse",
                        "id": "tu1",
                        "name": "Read",
                        "input": { "path": "/tmp" }
                    }
                ]
            }
        });
        let n = normalize_entry(&v, 1).unwrap();
        assert_eq!(n.role, "assistant");
        assert_eq!(n.parent_uuid.as_deref(), Some("m1"));
        assert_eq!(n.blocks.len(), 2);
        assert_eq!(n.blocks[0].kind, "text");
        assert_eq!(n.blocks[1].kind, "tool_use");
    }

    #[test]
    fn test_message_tool_result() {
        let v = json!({
            "type": "message",
            "id": "m3",
            "parentId": "m2",
            "timestamp": "2026-06-20T00:00:02Z",
            "message": {
                "role": "tool",
                "content": [
                    {
                        "type": "tool_result",
                        "toolCallId": "tu1",
                        "content": "OK",
                        "is_error": false
                    }
                ]
            }
        });
        let n = normalize_entry(&v, 2).unwrap();
        assert_eq!(n.role, "tool");
        assert_eq!(n.blocks[0].kind, "tool_result");
    }

    #[test]
    fn test_model_change_meta() {
        let v = json!({
            "type": "model_change",
            "id": "mc1",
            "parentId": "m1",
            "timestamp": "2026-06-20T00:00:00Z",
            "provider": "anthropic",
            "modelId": "claude-sonnet-4-6"
        });
        let n = normalize_entry(&v, 0).unwrap();
        assert_eq!(n.role, "meta");
        assert_eq!(n.raw_type, "model_change");
    }

    #[test]
    fn test_compaction_meta() {
        let v = json!({
            "type": "compaction",
            "id": "c1",
            "parentId": "m5",
            "timestamp": "2026-06-20T00:01:00Z",
            "summary": "Compressing earlier work",
            "firstKeptEntryId": "m6",
            "tokensBefore": 100000
        });
        let n = normalize_entry(&v, 0).unwrap();
        assert_eq!(n.role, "meta");
        assert_eq!(n.raw_type, "compaction");
    }
}
