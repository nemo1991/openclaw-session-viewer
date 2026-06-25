//! Agent name block handler
//!
//! `{ type: "agent-name", agentName, sessionId, ... }`

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// agent-name: 当前 agent 标识(用户配置或自动派生)
pub struct AgentNameHandler;

impl BlockHandler for AgentNameHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("agent-name")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let mut data = serde_json::Map::new();
        if let Some(name) = item.get("agentName").and_then(|v| v.as_str()) {
            data.insert("agentName".to_string(), Value::String(name.to_string()));
        }
        if let Some(sid) = item.get("sessionId").and_then(|v| v.as_str()) {
            data.insert("sessionId".to_string(), Value::String(sid.to_string()));
        }
        Ok(NormalizedBlock {
            kind: "agent_name".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "agent_name"
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn agent_name_basic() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "agent-name",
                "agentName": "cross-platform-session-viewer",
                "sessionId": "abc"
            }))
            .unwrap();
        assert_eq!(n.kind, "agent_name");
        assert_eq!(
            n.data.get("agentName").and_then(|v| v.as_str()),
            Some("cross-platform-session-viewer")
        );
    }

    #[test]
    fn agent_name_minimal() {
        let r = default_registry();
        let n = r
            .normalize(&json!({"type": "agent-name", "agentName": "x"}))
            .unwrap();
        assert_eq!(n.kind, "agent_name");
    }
}
