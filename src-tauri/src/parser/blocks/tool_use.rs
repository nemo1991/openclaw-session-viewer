//! v0.3.0 PR3: ToolUse block handler
//!
//! `{ type: "tool_use" | "toolUse" | "tool_call" | "function_call" | "toolCall", id, name, input|arguments }`
//!
//! v0.8.4: 抽 `TOOL_USE_ALIASES` 顶层 const,让 `parser/meta_extras.rs::build_meta_full`
//! 复用 — 之前 `build_meta_full` 硬编码 `"tool_use"` 导致 OpenClaw `toolCall` / `function_call`
//! 等 alias 抓不到,tool_usage_json 漏算。

use serde_json::Value;

use super::{BlockError, BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// v0.8.4: tool_use block 的所有 type alias 列表。
///
/// 给 `BlockHandler::matches` 和 `build_meta_full` 共享 — 任何新加 alias
/// 必须**同时**更新两边,避免脱节。
pub const TOOL_USE_ALIASES: &[&str] = &[
    "tool_use",
    "toolUse",
    "tool_call",
    "function_call",
    "toolCall",
];

/// tool_use block: 5 个 alias (tool_use/toolUse/tool_call/function_call/toolCall)
///
/// 注意 pi-coding-agent 的 toolCall 用 `arguments` 而不是 `input`,这里统一重命名。
pub struct ToolUseBlockHandler;

impl BlockHandler for ToolUseBlockHandler {
    fn matches(&self, item: &Value) -> bool {
        let t = item.get("type").and_then(|v| v.as_str());
        matches!(t, Some(s) if TOOL_USE_ALIASES.contains(&s))
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| BlockError::Invalid("tool_use block missing 'id'".into()))?
            .to_string();
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| BlockError::Invalid("tool_use block missing 'name'".into()))?
            .to_string();
        // 字段翻译:`input` (Claude 标准) / `arguments` (pi-coding-agent)
        let input = item
            .get("input")
            .or_else(|| item.get("arguments"))
            .cloned()
            .unwrap_or(Value::Null);

        let mut data = serde_json::Map::new();
        data.insert("id".to_string(), Value::String(id));
        data.insert("name".to_string(), Value::String(name));
        data.insert("input".to_string(), input);
        Ok(NormalizedBlock {
            kind: "tool_use".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "tool_use"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn tool_use_block_handler_arguments_to_input() {
        // pi-coding-agent toolCall + arguments
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "toolCall",
                "id": "call_abc",
                "name": "read",
                "arguments": {"path": "/tmp/x"}
            }))
            .unwrap();
        assert_eq!(n.kind, "tool_use");
        assert_eq!(n.data.get("id").and_then(|v| v.as_str()), Some("call_abc"));
        assert_eq!(n.data.get("name").and_then(|v| v.as_str()), Some("read"));
        assert_eq!(
            n.data
                .get("input")
                .and_then(|v| v.get("path"))
                .and_then(|v| v.as_str()),
            Some("/tmp/x")
        );
    }

    #[test]
    fn tool_use_block_handler_claude_native() {
        // Claude 标准 tool_use + input
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "tool_use",
                "id": "toolu_abc",
                "name": "Bash",
                "input": {"cmd": "ls"}
            }))
            .unwrap();
        assert_eq!(n.kind, "tool_use");
        assert_eq!(
            n.data
                .get("input")
                .and_then(|v| v.get("cmd"))
                .and_then(|v| v.as_str()),
            Some("ls")
        );
    }

    #[test]
    fn tool_use_block_handler_all_aliases() {
        for alias in &[
            "tool_use",
            "toolUse",
            "tool_call",
            "function_call",
            "toolCall",
        ] {
            let r = default_registry();
            let n = r
                .normalize(&json!({
                    "type": alias,
                    "id": "id1",
                    "name": "test",
                    "input": {}
                }))
                .unwrap();
            assert_eq!(
                n.kind, "tool_use",
                "alias {alias} should produce kind=tool_use"
            );
            assert_eq!(n.data.get("id").and_then(|v| v.as_str()), Some("id1"));
        }
    }

    #[test]
    fn tool_use_block_handler_rejects_missing_fields() {
        let h = ToolUseBlockHandler;
        assert!(h.normalize(&json!({"type": "tool_use"})).is_err());
        assert!(h
            .normalize(&json!({"type": "tool_use", "id": "x"}))
            .is_err());
    }

    #[test]
    fn tool_use_aliases_const_includes_5_aliases() {
        // v0.8.4: TOOL_USE_ALIASES 必须包含 5 个 alias,跟 matches() 共享
        assert_eq!(TOOL_USE_ALIASES.len(), 5);
        for a in &[
            "tool_use",
            "toolUse",
            "tool_call",
            "function_call",
            "toolCall",
        ] {
            assert!(TOOL_USE_ALIASES.contains(a), "missing alias {a}");
        }
    }
}
