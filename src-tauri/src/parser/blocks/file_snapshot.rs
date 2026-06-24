//! File history snapshot block handler
//!
//! `{ type: "file_history_snapshot", messageId, trackedFileBackups, ... }`

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// file_history_snapshot: 文件历史快照
pub struct FileSnapshotHandler;

impl BlockHandler for FileSnapshotHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("file_history_snapshot")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let mut data = serde_json::Map::new();
        if let Some(mid) = item.get("messageId").and_then(|v| v.as_str()) {
            data.insert("messageId".to_string(), Value::String(mid.to_string()));
        }
        if let Some(backups) = item.get("trackedFileBackups") {
            let count = backups.as_object().map(|o| o.len()).unwrap_or(0);
            data.insert(
                "fileCount".to_string(),
                Value::Number(serde_json::Number::from(count as u64)),
            );
            data.insert("trackedFileBackups".to_string(), backups.clone());
        }
        Ok(NormalizedBlock {
            kind: "file_snapshot".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "file_snapshot"
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn file_snapshot_basic() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "file_history_snapshot",
                "messageId": "m1",
                "trackedFileBackups": {}
            }))
            .unwrap();
        assert_eq!(n.kind, "file_snapshot");
        assert_eq!(n.data.get("messageId").and_then(|v| v.as_str()), Some("m1"));
        assert_eq!(n.data.get("fileCount").and_then(|v| v.as_u64()), Some(0));
    }

    #[test]
    fn file_snapshot_with_files() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "file_history_snapshot",
                "messageId": "m2",
                "trackedFileBackups": {
                    "src/main.rs": {"snapshot": "..."}
                }
            }))
            .unwrap();
        assert_eq!(n.kind, "file_snapshot");
        assert_eq!(n.data.get("fileCount").and_then(|v| v.as_u64()), Some(1));
    }
}
