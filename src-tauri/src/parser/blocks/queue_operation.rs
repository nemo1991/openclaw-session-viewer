//! queue-operation envelope handler (v0.8.4)
//!
//! 与其他 block 不同: queue-operation 是 **top-level** envelope
//! `{ type: "queue-operation", operation: "enqueue"|"remove", timestamp, sessionId, content? }`
//! 不在 `attachment` 里。
//!
//! Dispatch: 由 parser/claude.rs 的 normalize() 顶层 match 调 build_queue_operation_block()。
//! 这里只暴露 builder 函数, 不注册到 BlockRegistry。

use serde_json::Value;

use crate::parser::claude::NormalizedBlock;

/// 把一个 top-level queue-operation record 转成 NormalizedBlock (v0.8.4 item 4)
pub fn build_queue_operation_block(item: &Value) -> Option<NormalizedBlock> {
    if item.get("type").and_then(|v| v.as_str()) != Some("queue-operation") {
        return None;
    }
    let mut data = serde_json::Map::new();
    if let Some(op) = item.get("operation").and_then(|v| v.as_str()) {
        data.insert("operation".to_string(), Value::String(op.to_string()));
    }
    if let Some(ts) = item.get("timestamp").and_then(|v| v.as_str()) {
        data.insert("timestamp".to_string(), Value::String(ts.to_string()));
    }
    Some(NormalizedBlock {
        kind: "queue_operation".to_string(),
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn queue_operation_enqueue() {
        let item = json!({
            "type": "queue-operation",
            "operation": "enqueue",
            "timestamp": "2026-06-19T13:07:49.378Z",
            "sessionId": "abc",
            "content": "<task-notification>...</task-notification>"
        });
        let b = build_queue_operation_block(&item).unwrap();
        assert_eq!(b.kind, "queue_operation");
        assert_eq!(
            b.data.get("operation").and_then(|v| v.as_str()),
            Some("enqueue")
        );
    }

    #[test]
    fn queue_operation_remove() {
        let item = json!({
            "type": "queue-operation",
            "operation": "remove",
            "timestamp": "2026-06-19T13:07:57.111Z"
        });
        let b = build_queue_operation_block(&item).unwrap();
        assert_eq!(b.kind, "queue_operation");
        assert_eq!(
            b.data.get("operation").and_then(|v| v.as_str()),
            Some("remove")
        );
    }

    #[test]
    fn queue_operation_wrong_type_returns_none() {
        let item = json!({"type": "other", "operation": "enqueue"});
        assert!(build_queue_operation_block(&item).is_none());
    }
}
