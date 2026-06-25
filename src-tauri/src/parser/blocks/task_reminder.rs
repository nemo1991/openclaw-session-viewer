//! Task reminder block handler
//!
//! `{ type: "task_reminder", content: [TaskItem], itemCount, ... }`
//!
//! 每个 TaskItem: { id, subject, activeForm, description, status, blockedBy, blocks }

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// task_reminder: 当前任务列表快照(用于提醒 agent 还在 pending 哪些 task)
pub struct TaskReminderHandler;

impl BlockHandler for TaskReminderHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("task_reminder")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let mut data = serde_json::Map::new();
        if let Some(content) = item.get("content").and_then(|v| v.as_array()) {
            data.insert("content".to_string(), Value::Array(content.clone()));
            // 派生汇总字段,便于前端快速显示
            let pending = content
                .iter()
                .filter(|c| c.get("status").and_then(|v| v.as_str()) == Some("pending"))
                .count();
            let in_progress = content
                .iter()
                .filter(|c| c.get("status").and_then(|v| v.as_str()) == Some("in_progress"))
                .count();
            let completed = content
                .iter()
                .filter(|c| c.get("status").and_then(|v| v.as_str()) == Some("completed"))
                .count();
            data.insert(
                "pendingCount".to_string(),
                Value::Number(serde_json::Number::from(pending as u64)),
            );
            data.insert(
                "inProgressCount".to_string(),
                Value::Number(serde_json::Number::from(in_progress as u64)),
            );
            data.insert(
                "completedCount".to_string(),
                Value::Number(serde_json::Number::from(completed as u64)),
            );
        }
        if let Some(count) = item.get("itemCount").and_then(|v| v.as_u64()) {
            data.insert(
                "itemCount".to_string(),
                Value::Number(serde_json::Number::from(count)),
            );
        }
        Ok(NormalizedBlock {
            kind: "task_reminder".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "task_reminder"
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn task_reminder_basic() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "task_reminder",
                "itemCount": 3,
                "content": [
                    {"id": "1", "subject": "a", "status": "pending", "activeForm": "a", "description": "d", "blockedBy": [], "blocks": []},
                    {"id": "2", "subject": "b", "status": "in_progress", "activeForm": "b", "description": "d", "blockedBy": [], "blocks": []},
                    {"id": "3", "subject": "c", "status": "completed", "activeForm": "c", "description": "d", "blockedBy": [], "blocks": []}
                ]
            }))
            .unwrap();
        assert_eq!(n.kind, "task_reminder");
        assert_eq!(n.data.get("pendingCount").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(
            n.data.get("inProgressCount").and_then(|v| v.as_u64()),
            Some(1)
        );
        assert_eq!(
            n.data.get("completedCount").and_then(|v| v.as_u64()),
            Some(1)
        );
        assert_eq!(n.data.get("itemCount").and_then(|v| v.as_u64()), Some(3));
        assert!(
            n.data
                .get("content")
                .and_then(|v| v.as_array())
                .map(|a| a.len())
                == Some(3)
        );
    }

    #[test]
    fn task_reminder_minimal() {
        let r = default_registry();
        let n = r
            .normalize(&json!({"type": "task_reminder", "content": []}))
            .unwrap();
        assert_eq!(n.kind, "task_reminder");
        assert_eq!(n.data.get("pendingCount").and_then(|v| v.as_u64()), Some(0));
    }
}
