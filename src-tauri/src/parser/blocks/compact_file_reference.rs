//! compact_file_reference block handler (v0.8.4)
//!
//! `{ type: "compact_file_reference", filename, displayPath }`

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// compact-file-reference: compact 触发的源文件引用 (v0.8.4 item 4)
pub struct CompactFileReferenceHandler;

impl BlockHandler for CompactFileReferenceHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("compact_file_reference")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let mut data = serde_json::Map::new();
        if let Some(f) = item.get("filename").and_then(|v| v.as_str()) {
            data.insert("filename".to_string(), Value::String(f.to_string()));
        }
        if let Some(d) = item.get("displayPath").and_then(|v| v.as_str()) {
            data.insert("displayPath".to_string(), Value::String(d.to_string()));
        }
        Ok(NormalizedBlock {
            kind: "compact_file_reference".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "compact_file_reference"
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn compact_file_reference_basic() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "compact_file_reference",
                "filename": "/Users/foo/README.md",
                "displayPath": "README.md"
            }))
            .unwrap();
        assert_eq!(n.kind, "compact_file_reference");
        assert_eq!(
            n.data.get("filename").and_then(|v| v.as_str()),
            Some("/Users/foo/README.md")
        );
        assert_eq!(
            n.data.get("displayPath").and_then(|v| v.as_str()),
            Some("README.md")
        );
    }
}
