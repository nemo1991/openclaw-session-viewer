//! Plan mode block handler
//!
//! `{ type: "plan_mode", isSubAgent, planExists, planFilePath, reminderType, ... }`

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// plan_mode: 计划模式元信息
pub struct PlanModeHandler;

impl BlockHandler for PlanModeHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("plan_mode")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let mut data = serde_json::Map::new();
        if let Some(sub) = item.get("isSubAgent").and_then(|v| v.as_bool()) {
            data.insert("isSubAgent".to_string(), Value::Bool(sub));
        }
        if let Some(exists) = item.get("planExists").and_then(|v| v.as_bool()) {
            data.insert("planExists".to_string(), Value::Bool(exists));
        }
        if let Some(path) = item.get("planFilePath").and_then(|v| v.as_str()) {
            data.insert("planFilePath".to_string(), Value::String(path.to_string()));
        }
        if let Some(rt) = item.get("reminderType").and_then(|v| v.as_str()) {
            data.insert("reminderType".to_string(), Value::String(rt.to_string()));
        }
        Ok(NormalizedBlock {
            kind: "plan_mode".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "plan_mode"
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn plan_mode_basic() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "plan_mode",
                "isSubAgent": false,
                "planExists": true,
                "planFilePath": "/tmp/plan.md",
                "reminderType": "full"
            }))
            .unwrap();
        assert_eq!(n.kind, "plan_mode");
        assert_eq!(
            n.data.get("isSubAgent").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            n.data.get("planExists").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            n.data.get("planFilePath").and_then(|v| v.as_str()),
            Some("/tmp/plan.md")
        );
        assert_eq!(
            n.data.get("reminderType").and_then(|v| v.as_str()),
            Some("full")
        );
    }

    #[test]
    fn plan_mode_minimal() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "plan_mode",
                "isSubAgent": true,
                "planExists": false
            }))
            .unwrap();
        assert_eq!(n.kind, "plan_mode");
        assert_eq!(
            n.data.get("isSubAgent").and_then(|v| v.as_bool()),
            Some(true)
        );
    }
}
