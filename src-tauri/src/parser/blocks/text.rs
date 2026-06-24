//! v0.3.0 PR2: Text block handler
//!
//! `{ type: "text", text: "..." }`

use serde_json::Value;

use super::{BlockError, BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// text block: `{ type: "text", text: "..." }`
pub struct TextBlockHandler;

impl BlockHandler for TextBlockHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("text")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let text = item
            .get("text")
            .and_then(|v| v.as_str())
            .ok_or_else(|| BlockError::Invalid("text block missing 'text' field".into()))?
            .to_string();
        let mut data = serde_json::Map::new();
        data.insert("text".to_string(), Value::String(text));
        Ok(NormalizedBlock {
            kind: "text".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "text"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn text_block_handler_basic() {
        let r = default_registry();
        let n = r
            .normalize(&json!({"type": "text", "text": "hello"}))
            .unwrap();
        assert_eq!(n.kind, "text");
        assert_eq!(n.data.get("text").and_then(|v| v.as_str()), Some("hello"));
    }

    #[test]
    fn text_block_handler_with_empty_text() {
        let r = default_registry();
        let n = r.normalize(&json!({"type": "text", "text": ""})).unwrap();
        assert_eq!(n.kind, "text");
        assert_eq!(n.data.get("text").and_then(|v| v.as_str()), Some(""));
    }

    #[test]
    fn text_block_handler_rejects_missing_text_field() {
        let h = TextBlockHandler;
        let result = h.normalize(&json!({"type": "text"}));
        assert!(result.is_err());
    }
}
