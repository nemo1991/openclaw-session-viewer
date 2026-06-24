//! Agent listing delta block handler
//!
//! `{ type: "agent_listing_delta", addedTypes, removedTypes, addedLines, ... }`

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// agent_listing_delta: 多 agent 模式的 agent 类型变更
pub struct AgentListingHandler;

impl BlockHandler for AgentListingHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("agent_listing_delta")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let mut data = serde_json::Map::new();
        if let Some(added) = item.get("addedTypes").and_then(|v| v.as_array()) {
            data.insert("addedTypes".to_string(), Value::Array(added.clone()));
        }
        if let Some(removed) = item.get("removedTypes").and_then(|v| v.as_array()) {
            data.insert("removedTypes".to_string(), Value::Array(removed.clone()));
        }
        if let Some(initial) = item.get("isInitial").and_then(|v| v.as_bool()) {
            data.insert("isInitial".to_string(), Value::Bool(initial));
        }
        if let Some(lines) = item.get("addedLines").and_then(|v| v.as_array()) {
            data.insert("addedLines".to_string(), Value::Array(lines.clone()));
        }
        Ok(NormalizedBlock {
            kind: "agent_listing".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "agent_listing"
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn agent_listing_basic() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "agent_listing_delta",
                "addedTypes": ["claude", "Explore"],
                "removedTypes": [],
                "isInitial": true
            }))
            .unwrap();
        assert_eq!(n.kind, "agent_listing");
        assert_eq!(
            n.data
                .get("addedTypes")
                .and_then(|v| v.as_array())
                .map(|a| a.len()),
            Some(2)
        );
        assert_eq!(
            n.data.get("isInitial").and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn agent_listing_with_lines() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "agent_listing_delta",
                "addedTypes": ["claude"],
                "addedLines": ["- claude: general agent"]
            }))
            .unwrap();
        assert_eq!(n.kind, "agent_listing");
        assert!(n.data.get("addedLines").is_some());
    }
}
