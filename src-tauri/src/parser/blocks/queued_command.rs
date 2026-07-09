//! queued_command block handler (v0.8.4)
//!
//! `{ type: "queued_command", prompt, commandMode }`
//!
//! prompt 可能是 <task-notification> XML 等结构化文本; 截到 100 字符做 preview。

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

const QUEUED_COMMAND_PREVIEW_CHARS: usize = 100;

/// queued-command: 用户排队的命令(task-notification 等) (v0.8.4 item 4)
pub struct QueuedCommandHandler;

impl BlockHandler for QueuedCommandHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("queued_command")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let mut data = serde_json::Map::new();
        if let Some(p) = item.get("prompt").and_then(|v| v.as_str()) {
            let preview: String = p.chars().take(QUEUED_COMMAND_PREVIEW_CHARS).collect();
            data.insert("promptPreview".to_string(), Value::String(preview));
        }
        if let Some(m) = item.get("commandMode").and_then(|v| v.as_str()) {
            data.insert("commandMode".to_string(), Value::String(m.to_string()));
        }
        Ok(NormalizedBlock {
            kind: "queued_command".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "queued_command"
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn queued_command_basic() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "queued_command",
                "prompt": "<task-notification>\n<task-id>abc</task-id>\n</task-notification>",
                "commandMode": "task-notification"
            }))
            .unwrap();
        assert_eq!(n.kind, "queued_command");
        assert_eq!(
            n.data.get("commandMode").and_then(|v| v.as_str()),
            Some("task-notification")
        );
        let preview = n
            .data
            .get("promptPreview")
            .and_then(|v| v.as_str())
            .unwrap();
        assert!(preview.starts_with("<task-notification>"));
    }

    #[test]
    fn queued_command_truncates_long_prompt() {
        let r = default_registry();
        let long_prompt = "x".repeat(500);
        let n = r
            .normalize(&json!({
                "type": "queued_command",
                "prompt": long_prompt,
                "commandMode": "task-notification"
            }))
            .unwrap();
        let preview = n
            .data
            .get("promptPreview")
            .and_then(|v| v.as_str())
            .unwrap();
        assert_eq!(preview.len(), 100);
    }
}
