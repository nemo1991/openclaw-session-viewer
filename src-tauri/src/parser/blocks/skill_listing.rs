//! Skill listing block handler
//!
//! `{ type: "skill_listing", names, skillCount, content, isInitial, ... }`

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// skill_listing: 可用 skill 列表
pub struct SkillListingHandler;

impl BlockHandler for SkillListingHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("skill_listing")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let mut data = serde_json::Map::new();
        if let Some(names) = item.get("names").and_then(|v| v.as_array()) {
            data.insert("names".to_string(), Value::Array(names.clone()));
        }
        if let Some(count) = item.get("skillCount").and_then(|v| v.as_u64()) {
            data.insert(
                "skillCount".to_string(),
                Value::Number(serde_json::Number::from(count)),
            );
        }
        if let Some(initial) = item.get("isInitial").and_then(|v| v.as_bool()) {
            data.insert("isInitial".to_string(), Value::Bool(initial));
        }
        // 只存 skill 名字列表，不存完整的 content 描述（太大）
        Ok(NormalizedBlock {
            kind: "skill_listing".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "skill_listing"
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn skill_listing_basic() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "skill_listing",
                "names": ["drawio", "deep-research", "verify"],
                "skillCount": 3,
                "isInitial": true
            }))
            .unwrap();
        assert_eq!(n.kind, "skill_listing");
        assert_eq!(
            n.data
                .get("names")
                .and_then(|v| v.as_array())
                .map(|a| a.len()),
            Some(3)
        );
        assert_eq!(n.data.get("skillCount").and_then(|v| v.as_u64()), Some(3));
    }

    #[test]
    fn skill_listing_minimal() {
        let r = default_registry();
        let n = r
            .normalize(&json!({"type": "skill_listing", "names": []}))
            .unwrap();
        assert_eq!(n.kind, "skill_listing");
    }
}
