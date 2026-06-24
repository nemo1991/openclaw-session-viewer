//! v0.3.0: Block handler registry
//!
//! 把 `normalize_content_block` 的 match 拆成 BlockHandler trait + 独立 handler
//! + 可注册 registry。新增 type 只需要写一个 handler + register,不动核心逻辑。
//!
//! ## 添加新 block type
//!
//! 1. 在本目录新建一个文件 (e.g. `my_block.rs`):
//!    ```ignore
//!    use super::{BlockHandler, BlockResult};
//!    use serde_json::Value;
//!
//!    pub struct MyBlockHandler;
//!    impl BlockHandler for MyBlockHandler {
//!        fn matches(&self, item: &Value) -> bool {
//!            item.get("type").and_then(|v| v.as_str()) == Some("myType")
//!        }
//!        fn normalize(&self, item: &Value) -> BlockResult { ... }
//!        fn name(&self) -> &'static str { "my_block" }
//!    }
//!    ```
//! 2. 在 `default_registry()` 里加 `.register(MyBlockHandler)`
//! 3. 加单测:handler 输出 shape 必须稳定(serde flatten 兼容性)
//!
//! **注意**: MetaBlockHandler 必须放最后,作为兜底。
//!
//! ## 已知 type 列表
//!
//! | type(s)                          | normalized kind | handler               |
//! |----------------------------------|-----------------|-----------------------|
//! | `text`                           | text            | TextBlockHandler      |
//! | `thinking` / `redacted_thinking` | thinking        | ThinkingBlockHandler  |
//! | `tool_use` / `toolUse` / `tool_call` / `function_call` / `toolCall` | tool_use | ToolUseBlockHandler |
//! | `tool_result` / `toolResult`     | tool_result     | ToolResultBlockHandler|
//! | `image`                          | image           | ImageBlockHandler     |
//! | (其它)                           | meta            | MetaBlockHandler      |

pub mod text;
pub mod thinking;

pub use text::TextBlockHandler;
pub use thinking::ThinkingBlockHandler;

use serde_json::Value;

use crate::parser::claude::NormalizedBlock;

#[derive(Debug)]
pub enum BlockError {
    /// 没有 handler 匹配(理论上不应该发生,因为有 MetaBlockHandler 兜底)
    #[allow(dead_code)]
    NoHandler,
    /// handler 内部解析失败(消息文本暂未消费,仅供 debug)
    #[allow(dead_code)]
    Invalid(String),
}

pub type BlockResult = Result<NormalizedBlock, BlockError>;

/// 单个 block type 的处理器
///
/// 实现要点:
/// - `matches()` 必须纯函数 + 无副作用(供 registry 顺序查找用)
/// - `normalize()` 输出形状必须**稳定**,因为 `#[serde(flatten)] data: Map`
///   会把字段直接铺到顶层;前端 `block.label ?? block.kind` 会依赖这些字段
pub trait BlockHandler: Send + Sync {
    /// 是否能处理这个 item(纯 type 字符串匹配)
    fn matches(&self, item: &Value) -> bool;

    /// 转成 NormalizedBlock;失败返回 Invalid(不静默吞)
    fn normalize(&self, item: &Value) -> BlockResult;

    /// 人类可读名字(日志 / 调试)
    #[allow(dead_code)]
    fn name(&self) -> &'static str;
}

/// handler 注册表
///
/// 内部 Vec + 线性查找;block 数量小(<10),性能可忽略。
/// 如果未来 block 数量爆炸,可以改成 HashMap<String, Box<dyn BlockHandler>>。
pub struct BlockRegistry {
    handlers: Vec<Box<dyn BlockHandler>>,
}

impl BlockRegistry {
    pub fn new() -> Self {
        Self { handlers: vec![] }
    }

    /// 链式注册;MetaBlockHandler **必须**最后调
    pub fn register<H: BlockHandler + 'static>(mut self, h: H) -> Self {
        self.handlers.push(Box::new(h));
        self
    }

    /// 找第一个 matches 的 handler 处理 item
    pub fn normalize(&self, item: &Value) -> BlockResult {
        for h in &self.handlers {
            if h.matches(item) {
                return h.normalize(item);
            }
        }
        // 兜底:理论上不该到这里(MetaBlockHandler 应该 matches 所有)
        Err(BlockError::NoHandler)
    }
}

impl Default for BlockRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// 内嵌 handler 实现(PR 1 阶段;PR 2/3 会拆成独立文件)
// ============================================================================

/// tool_use block: 5 个 alias (tool_use/toolUse/tool_call/function_call/toolCall)
/// 注意 pi-coding-agent 的 toolCall 用 `arguments` 而不是 `input`,这里统一重命名。
pub struct ToolUseBlockHandler;

impl BlockHandler for ToolUseBlockHandler {
    fn matches(&self, item: &Value) -> bool {
        matches!(
            item.get("type").and_then(|v| v.as_str()),
            Some("tool_use" | "toolUse" | "tool_call" | "function_call" | "toolCall")
        )
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

/// tool_result block: `{ type: "tool_result" | "toolResult", tool_use_id | toolCallId, content, is_error? }`
pub struct ToolResultBlockHandler;

impl BlockHandler for ToolResultBlockHandler {
    fn matches(&self, item: &Value) -> bool {
        matches!(
            item.get("type").and_then(|v| v.as_str()),
            Some("tool_result" | "toolResult")
        )
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        // tool_use_id (Claude) / toolCallId (pi-agent)
        let tool_use_id = item
            .get("tool_use_id")
            .or_else(|| item.get("toolCallId"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let content = item.get("content").cloned().unwrap_or(Value::Null);
        let is_error = item
            .get("is_error")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let mut data = serde_json::Map::new();
        data.insert("tool_use_id".to_string(), Value::String(tool_use_id));
        data.insert("content".to_string(), content);
        data.insert("is_error".to_string(), Value::Bool(is_error));
        Ok(NormalizedBlock {
            kind: "tool_result".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str {
        "tool_result"
    }
}

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

/// 全局默认 registry
///
/// 注册顺序很关键:MetaBlockHandler 必须放最后(永远匹配,否则会"吞掉"其它 type)。
pub fn default_registry() -> BlockRegistry {
    BlockRegistry::new()
        .register(TextBlockHandler)
        .register(ThinkingBlockHandler)
        .register(ToolUseBlockHandler)
        .register(ToolResultBlockHandler)
        .register(ImageBlockHandler)
        .register(MetaBlockHandler) // 必须最后
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reg() -> BlockRegistry {
        default_registry()
    }

    #[test]
    fn tool_use_block_handler_arguments_to_input() {
        // pi-coding-agent toolCall + arguments
        let r = reg();
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
        let r = reg();
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
    fn tool_result_block_handler_string_content() {
        let r = reg();
        let n = r
            .normalize(&json!({
                "type": "tool_result",
                "tool_use_id": "toolu_abc",
                "content": "OK",
                "is_error": false
            }))
            .unwrap();
        assert_eq!(n.kind, "tool_result");
        assert_eq!(n.data.get("content").and_then(|v| v.as_str()), Some("OK"));
    }

    #[test]
    fn tool_result_block_handler_callid_alias() {
        // pi-coding-agent 用 toolCallId
        let r = reg();
        let n = r
            .normalize(&json!({
                "type": "toolResult",
                "toolCallId": "call_xyz",
                "content": [{"type": "text", "text": "stdout"}]
            }))
            .unwrap();
        assert_eq!(n.kind, "tool_result");
        assert_eq!(
            n.data.get("tool_use_id").and_then(|v| v.as_str()),
            Some("call_xyz")
        );
    }

    #[test]
    fn image_block_handler_basic() {
        let r = reg();
        let n = r
            .normalize(&json!({"type": "image", "mediaType": "image/jpeg", "data": "base64..."}))
            .unwrap();
        assert_eq!(n.kind, "image");
        assert_eq!(
            n.data.get("mediaType").and_then(|v| v.as_str()),
            Some("image/jpeg")
        );
    }

    #[test]
    fn meta_block_handler_catches_unknown() {
        let r = reg();
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
        // 极端兜底:type 字段都没有
        let r = reg();
        let n = r.normalize(&json!({"foo": "bar"})).unwrap();
        assert_eq!(n.kind, "meta");
        assert_eq!(
            n.data.get("label").and_then(|v| v.as_str()),
            Some("unknown")
        );
    }

    #[test]
    fn registry_order_does_not_matter_for_known_types() {
        // MetaBlockHandler 在最后但不会误匹配已知 type(因为前面的 handler 先 matches)
        let r = reg();
        assert_eq!(
            r.normalize(&json!({"type": "text", "text": "x"}))
                .unwrap()
                .kind,
            "text"
        );
        assert_eq!(
            r.normalize(&json!({"type": "thinking", "thinking": "x"}))
                .unwrap()
                .kind,
            "thinking"
        );
    }
}
