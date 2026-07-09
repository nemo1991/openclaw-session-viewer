//! attached_file block handler (v0.8.4)
//!
//! `{ type: "file", filename, displayPath, content: { ... } }`
//!
//! content 通常包含 Read 工具结果全文(可达数 KB-数 MB), 不解析进 data,
//! 只取 filename + displayPath; 计数由 build_meta_full 单独算。

use serde_json::Value;

use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

/// attached-file (attachment.type=="file"): 文件读取结果引用 (v0.8.4 item 4)
pub struct AttachedFileHandler;

impl BlockHandler for AttachedFileHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("file")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let mut data = serde_json::Map::new();
        if let Some(f) = item.get("filename").and_then(|v| v.as_str()) {
            data.insert("filename".to_string(), Value::String(f.to_string()));
        }
        if let Some(d) = item.get("displayPath").and_then(|v| v.as_str()) {
            data.insert("displayPath".to_string(), Value::String(d.to_string()));
        }
        // 推断 contentType: Read 工具结果会有 .file.filePath, 视为 source code;
        // 其他 image 类型由 ImageBlockHandler 处理, 这里只接管 file 类型
        let content_type = if item.get("content").is_some() {
            "source"
        } else {
            "unknown"
        };
        data.insert(
            "contentType".to_string(),
            Value::String(content_type.to_string()),
        );
        Ok(NormalizedBlock {
            kind: "attached_file".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "attached_file"
    }
}

#[cfg(test)]
mod tests {
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn attached_file_with_content() {
        let r = default_registry();
        let n = r
            .normalize(&json!({
                "type": "file",
                "filename": "/Users/foo/src/x.ts",
                "displayPath": "src/x.ts",
                "content": {"type": "text", "file": {"filePath": "x.ts", "content": "..."}}
            }))
            .unwrap();
        assert_eq!(n.kind, "attached_file");
        assert_eq!(
            n.data.get("filename").and_then(|v| v.as_str()),
            Some("/Users/foo/src/x.ts")
        );
        assert_eq!(
            n.data.get("contentType").and_then(|v| v.as_str()),
            Some("source")
        );
        // content 字段不应进入 data
        assert!(n.data.get("content").is_none());
    }
}
