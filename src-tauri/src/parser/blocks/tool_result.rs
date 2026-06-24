//! v0.3.0 PR3: ToolResult block handler
//!
//! `{ type: "tool_result" | "toolResult", tool_use_id | toolCallId, content, is_error? }`

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// tool_result block: `{ type: "tool_result" | "toolResult", tool_use_id | toolCallId, content, is_error? }`
pub struct ToolResultBlockHandler;

impl BlockHandler for ToolResultBlockHandler {
    fn matches(&self, item: &Value) -> bool {
        matches!(
            item.get("type").and_then(|v| v.as_str()),
            Some("tool_result" | "toolResult")
        )
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        // tool_use_id (Claude) / toolCallId (pi-agent)
        let tool_use_id = item
            .get("tool_use_id")
            .or_else(|| item.get("toolCallId"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let content = item.get("content").cloned().unwrap_or(Value::Null);
        let is_error = item
            .get("is_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let mut data = serde_json::Map::new();
        data.insert("tool_use_id".to_string(), Value::String(tool_use_id));
        data.insert("content".to_string(), content);
        data.insert("is_error".to_string(), Value::Bool(is_error));
        Ok(NormalizedBlock {
            kind: "tool_result".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "tool_result"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn tool_result_block_handler_string_content() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "tool_result",
                "tool_use_id": "toolu_abc",
                "content": "OK",
                "is_error": false
            }))
            .unwrap();
        assert_eq!(n.kind, "tool_result");
        assert_eq!(n.data.get("content").and_then(|v| v.as_str()), Some("OK"));
        assert_eq!(
            n.data.get("tool_use_id").and_then(|v| v.as_str()),
            Some("toolu_abc")
        );
    }

    #[test]
    fn tool_result_block_handler_callid_alias() {
        // pi-coding-agent 用 toolCallId
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "toolResult",
                "toolCallId": "call_xyz",
                "content": [{"type": "text", "text": "stdout"}]
            }))
            .unwrap();
        assert_eq!(n.kind, "tool_result");
        assert_eq!(
            n.data.get("tool_use_id").and_then(|v| v.as_str()),
            Some("call_xyz")
        );
    }

    #[test]
    fn tool_result_block_handler_all_aliases() {
        for alias in &["tool_result", "toolResult"] {
            let r = default_registry();
            let n = r
                .normalize(&json!({
                    "type": alias,
                    "tool_use_id": "tu1",
                    "content": null
                }))
                .unwrap();
            assert_eq!(
                n.kind, "tool_result",
                "alias {alias} should produce kind=tool_result"
            );
        }
    }

    #[test]
    fn tool_result_block_handler_defaults() {
        let h = ToolResultBlockHandler;
        let n = h.normalize(&json!({"type": "tool_result"})).unwrap();
        assert_eq!(n.kind, "tool_result");
        assert_eq!(n.data.get("tool_use_id").and_then(|v| v.as_str()), Some(""));
        assert_eq!(
            n.data.get("is_error").and_then(|v| v.as_bool()),
            Some(false)
        );
    }
}
