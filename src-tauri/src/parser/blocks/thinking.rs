//! v0.3.0 PR2: Thinking block handler
//!
//! `{ type: "thinking" | "redacted_thinking", thinking: "...", signature?: "..." }`

use serde_json::Value;

use super::{BlockError, BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// thinking block: `{ type: "thinking" | "redacted_thinking", thinking: "...", signature?: "..." }`
pub struct ThinkingBlockHandler;

impl BlockHandler for ThinkingBlockHandler {
    fn matches(&self, item: &Value) -> bool {
        matches!(
            item.get("type").and_then(|v| v.as_str()),
            Some("thinking" | "redacted_thinking")
        )
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let text = item
            .get("thinking")
            .and_then(|v| v.as_str())
            .ok_or_else(|| BlockError::Invalid("thinking block missing 'thinking' field".into()))?
            .to_string();
        let mut data = serde_json::Map::new();
        data.insert("thinking".to_string(), Value::String(text));
        if let Some(sig) = item.get("signature").and_then(|v| v.as_str()) {
            data.insert("signature".to_string(), Value::String(sig.to_string()));
        }
        Ok(NormalizedBlock {
            kind: "thinking".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "thinking"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn thinking_block_handler_basic() {
        let r = default_registry();
        let n = r
            .normalize(&json!({"type": "thinking", "thinking": "Let me think..."}))
            .unwrap();
        assert_eq!(n.kind, "thinking");
        assert_eq!(
            n.data.get("thinking").and_then(|v| v.as_str()),
            Some("Let me think...")
        );
    }

    #[test]
    fn thinking_block_handler_with_signature() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "thinking",
                "thinking": "hmm",
                "signature": "sig123"
            }))
            .unwrap();
        assert_eq!(n.kind, "thinking");
        assert_eq!(
            n.data.get("signature").and_then(|v| v.as_str()),
            Some("sig123")
        );
    }

    #[test]
    fn thinking_block_handler_redacted() {
        let r = default_registry();
        let n = r
            .normalize(&json!({"type": "redacted_thinking", "thinking": "secret"}))
            .unwrap();
        assert_eq!(n.kind, "thinking");
        assert_eq!(
            n.data.get("thinking").and_then(|v| v.as_str()),
            Some("secret")
        );
    }

    #[test]
    fn thinking_block_handler_rejects_missing_thinking_field() {
        let h = ThinkingBlockHandler;
        let result = h.normalize(&json!({"type": "thinking"}));
        assert!(result.is_err());
    }
}
