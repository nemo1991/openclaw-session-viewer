//! v0.3.0 PR3: Image block handler
//!
//! `{ type: "image", mediaType?, data? }`

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// image block: `{ type: "image", mediaType?, data? }`
pub struct ImageBlockHandler;

impl BlockHandler for ImageBlockHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("image")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let media_type = item
            .get("mediaType")
            .or_else(|| item.get("media_type"))
            .and_then(|v| v.as_str())
            .unwrap_or("image/png")
            .to_string();
        let mut data = serde_json::Map::new();
        data.insert("mediaType".to_string(), Value::String(media_type));
        if let Some(d) = item.get("data") {
            data.insert("data".to_string(), d.clone());
        }
        Ok(NormalizedBlock {
            kind: "image".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "image"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn image_block_handler_basic() {
        let r = default_registry();
        let n = r
            .normalize(&json!({"type": "image", "mediaType": "image/jpeg", "data": "base64..."}))
            .unwrap();
        assert_eq!(n.kind, "image");
        assert_eq!(
            n.data.get("mediaType").and_then(|v| v.as_str()),
            Some("image/jpeg")
        );
        assert_eq!(
            n.data.get("data").and_then(|v| v.as_str()),
            Some("base64...")
        );
    }

    #[test]
    fn image_block_handler_no_data() {
        let r = default_registry();
        let n = r
            .normalize(&json!({"type": "image", "mediaType": "image/png"}))
            .unwrap();
        assert_eq!(n.kind, "image");
        assert!(n.data.get("data").is_none());
    }

    #[test]
    fn image_block_handler_default_media_type() {
        let r = default_registry();
        let n = r
            .normalize(&json!({"type": "image", "data": "abc"}))
            .unwrap();
        assert_eq!(
            n.data.get("mediaType").and_then(|v| v.as_str()),
            Some("image/png")
        );
    }

    #[test]
    fn image_block_handler_multimodal_dispatch() {
        // 图片可能是多模态内容块的一部分,source 格式
        // 目前 handler 只提取 mediaType/data,不保留 source;这个测试记录现状
        let n = ImageBlockHandler
            .normalize(
                &json!({"type": "image", "source": {"media_type": "image/jpeg", "data": "xyz"}}),
            )
            .unwrap();
        assert_eq!(n.kind, "image");
    }
}
