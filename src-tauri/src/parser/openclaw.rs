//! OpenClaw 记录归一化
//!
//! v0.3.0 PR4: 不再伪装成 Claude 形态,直接解析 OpenClaw 记录:
//! - `message` type 保留 role/id/timestamp/parentId,content 走 BlockRegistry
//! - 非消息 type (model_change/compaction/label 等)直接生成 meta block
//!
//! 消除前后端不对称:前端 normalize.ts 也是独立处理 OpenClaw type。

use serde_json::Value;

use super::claude::{self, NormalizedBlock, NormalizedMessage};

/// 归一化 OpenClaw JSON 记录(header 返回 None)
pub fn normalize_entry(record: &Value, index: usize) -> Option<NormalizedMessage> {
    let obj = record.as_object()?;
    let r#type = obj.get("type")?.as_str()?;

    if r#type == "session" {
        return None; // header, 不渲染
    }

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

    if r#type == "message" {
        let original_role = obj
            .get("message")
            .and_then(|m| m.get("role"))
            .and_then(|v| v.as_str())
            .unwrap_or("user");

        let blocks = obj
            .get("message")
            .and_then(|m| m.get("content"))
            .map(claude::normalize_content)
            .unwrap_or_default();

        Some(NormalizedMessage {
            id,
            role: original_role.to_string(),
            timestamp,
            blocks,
            model: None,
            stop_reason: None,
            token_usage: None,
            is_sidechain: None,
            subagent_id: None,
            parent_uuid: parent_id,
            raw_type: "message".to_string(),
        })
    } else {
        // 其他类型( model_change / compaction / label 等)转成 meta 块
        let mut data = serde_json::Map::new();
        data.insert("label".to_string(), Value::String(r#type.to_string()));
        data.insert("payload".to_string(), Value::Object(obj.clone()));

        Some(NormalizedMessage {
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
        })
    }
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
        assert_eq!(n.raw_type, "message");
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
    fn test_message_tool_call_pi_agent() {
        // pi-coding-agent 的 toolCall type + arguments
        let v = json!({
            "type": "message",
            "id": "m4",
            "parentId": null,
            "timestamp": "2026-06-20T00:00:03Z",
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "id": "call_abc",
                        "name": "read",
                        "arguments": { "path": "/tmp/x.md" }
                    }
                ]
            }
        });
        let n = normalize_entry(&v, 3).unwrap();
        assert_eq!(n.role, "assistant");
        assert_eq!(n.blocks.len(), 1);
        let b = &n.blocks[0];
        assert_eq!(b.kind, "tool_use");
        assert_eq!(b.data.get("id").and_then(|v| v.as_str()), Some("call_abc"));
        assert_eq!(
            b.data
                .get("input")
                .and_then(|v| v.get("path"))
                .and_then(|v| v.as_str()),
            Some("/tmp/x.md")
        );
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
        assert_eq!(
            n.blocks[0].data.get("label").and_then(|v| v.as_str()),
            Some("model_change")
        );
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
