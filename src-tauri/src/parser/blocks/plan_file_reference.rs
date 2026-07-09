//! plan_file_reference block handler (v0.8.4)
//!
//! `{ type: "plan_file_reference", planFilePath, planContent }`
//!
//! planContent 可能非常大(完整 markdown), 截到 500 字符做 preview, 完整路径保留。

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

const PLAN_CONTENT_PREVIEW_CHARS: usize = 500;

/// plan-file-reference: 用户当前会话关联的 plan 文件 (v0.8.4 item 4)
pub struct PlanFileReferenceHandler;

impl BlockHandler for PlanFileReferenceHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("plan_file_reference")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let mut data = serde_json::Map::new();
        if let Some(p) = item.get("planFilePath").and_then(|v| v.as_str()) {
            data.insert("planFilePath".to_string(), Value::String(p.to_string()));
        }
        if let Some(c) = item.get("planContent").and_then(|v| v.as_str()) {
            let preview: String = c.chars().take(PLAN_CONTENT_PREVIEW_CHARS).collect();
            data.insert("planContentPreview".to_string(), Value::String(preview));
        }
        Ok(NormalizedBlock {
            kind: "plan_file_reference".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "plan_file_reference"
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn plan_file_reference_basic() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "plan_file_reference",
                "planFilePath": "/tmp/plan.md",
                "planContent": "long content..."
            }))
            .unwrap();
        assert_eq!(n.kind, "plan_file_reference");
        assert_eq!(
            n.data.get("planFilePath").and_then(|v| v.as_str()),
            Some("/tmp/plan.md")
        );
        assert_eq!(
            n.data.get("planContentPreview").and_then(|v| v.as_str()),
            Some("long content...")
        );
    }

    #[test]
    fn plan_file_reference_truncates_content() {
        let r = default_registry();
        let big = "x".repeat(2000);
        let n = r
            .normalize(&json!({
                "type": "plan_file_reference",
                "planFilePath": "/tmp/plan.md",
                "planContent": big
            }))
            .unwrap();
        let preview = n
            .data
            .get("planContentPreview")
            .and_then(|v| v.as_str())
            .unwrap();
        assert_eq!(preview.len(), 500);
    }
}
