//! v0.3.0 PR3: Meta block handler (catch-all)
//!
//! 兜底 + 未知 type 包装。**必须放 registry 最后**。

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// meta block: 兜底 + 未知 type 包装
///
/// 输出 shape(serde flatten 后):
/// `{ kind: "meta", label: "原始 type 字符串", payload: 整个 obj }`
///
/// 前端依赖:
/// - `b.label` (string) 用于 pill 显示
/// - `b.payload` (object) 用于 UnknownBlockCard 字段表
pub struct MetaBlockHandler;

impl BlockHandler for MetaBlockHandler {
    fn matches(&self, _item: &Value) -> bool {
        // 兜底:永远匹配
        true
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let type_str = item
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let mut data = serde_json::Map::new();
        data.insert("label".to_string(), Value::String(type_str));
        data.insert("payload".to_string(), item.clone());
        Ok(NormalizedBlock {
            kind: "meta".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "meta"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn meta_block_handler_catches_unknown() {
        let r = default_registry();
        let n = r
            .normalize(&json!({"type": "future-block-type", "foo": "bar"}))
            .unwrap();
        assert_eq!(n.kind, "meta");
        assert_eq!(
            n.data.get("label").and_then(|v| v.as_str()),
            Some("future-block-type")
        );
        assert_eq!(
            n.data
                .get("payload")
                .and_then(|v| v.get("foo"))
                .and_then(|v| v.as_str()),
            Some("bar")
        );
    }

    #[test]
    fn meta_block_handler_handles_missing_type() {
        let r = default_registry();
        let n = r.normalize(&json!({"foo": "bar"})).unwrap();
        assert_eq!(n.kind, "meta");
        assert_eq!(
            n.data.get("label").and_then(|v| v.as_str()),
            Some("unknown")
        );
    }

    #[test]
    fn meta_block_handler_always_matches() {
        let h = MetaBlockHandler;
        assert!(h.matches(&json!({})));
        assert!(h.matches(&json!({"type": "anything"})));
    }
}
