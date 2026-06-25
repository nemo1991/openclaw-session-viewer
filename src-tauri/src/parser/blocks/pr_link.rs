//! PR link block handler
//!
//! `{ type: "pr-link", prNumber, prRepository, prUrl, sessionId, timestamp, ... }`

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// pr-link: 关联 PR 元数据(用户在某条会话中创建 PR 时记录)
pub struct PrLinkHandler;

impl BlockHandler for PrLinkHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("pr-link")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let mut data = serde_json::Map::new();
        if let Some(n) = item.get("prNumber").and_then(|v| v.as_u64()) {
            data.insert(
                "prNumber".to_string(),
                Value::Number(serde_json::Number::from(n)),
            );
        }
        if let Some(repo) = item.get("prRepository").and_then(|v| v.as_str()) {
            data.insert("prRepository".to_string(), Value::String(repo.to_string()));
        }
        if let Some(url) = item.get("prUrl").and_then(|v| v.as_str()) {
            data.insert("prUrl".to_string(), Value::String(url.to_string()));
        }
        if let Some(sid) = item.get("sessionId").and_then(|v| v.as_str()) {
            data.insert("sessionId".to_string(), Value::String(sid.to_string()));
        }
        if let Some(ts) = item.get("timestamp").and_then(|v| v.as_str()) {
            data.insert("timestamp".to_string(), Value::String(ts.to_string()));
        }
        Ok(NormalizedBlock {
            kind: "pr_link".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "pr_link"
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn pr_link_basic() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "pr-link",
                "prNumber": 1,
                "prRepository": "nemo1991/openclaw-session-viewer",
                "prUrl": "https://github.com/nemo1991/openclaw-session-viewer/pull/1",
                "sessionId": "abc",
                "timestamp": "2026-06-25T00:54:48.539Z"
            }))
            .unwrap();
        assert_eq!(n.kind, "pr_link");
        assert_eq!(n.data.get("prNumber").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(
            n.data.get("prRepository").and_then(|v| v.as_str()),
            Some("nemo1991/openclaw-session-viewer")
        );
        assert_eq!(
            n.data.get("prUrl").and_then(|v| v.as_str()),
            Some("https://github.com/nemo1991/openclaw-session-viewer/pull/1")
        );
    }

    #[test]
    fn pr_link_minimal() {
        let r = default_registry();
        let n = r
            .normalize(&json!({"type": "pr-link", "prNumber": 42}))
            .unwrap();
        assert_eq!(n.kind, "pr_link");
        assert_eq!(n.data.get("prNumber").and_then(|v| v.as_u64()), Some(42));
    }
}
