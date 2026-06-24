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
//! | type(s)                          | normalized kind | file                 |
//! |----------------------------------|-----------------|----------------------|
//! | `text`                           | text            | `text.rs`            |
//! | `thinking` / `redacted_thinking` | thinking        | `thinking.rs`         |
//! | `tool_use` / `toolUse` / `tool_call` / `function_call` / `toolCall` | tool_use | `tool_use.rs` |
//! | `tool_result` / `toolResult`     | tool_result     | `tool_result.rs`     |
//! | `image`                          | image           | `image.rs`           |
//! | (其它)                           | meta            | `meta.rs`            |

pub mod image;
pub mod meta;
pub mod text;
pub mod thinking;
pub mod tool_result;
pub mod tool_use;

pub use image::ImageBlockHandler;
pub use meta::MetaBlockHandler;
pub use text::TextBlockHandler;
pub use thinking::ThinkingBlockHandler;
pub use tool_result::ToolResultBlockHandler;
pub use tool_use::ToolUseBlockHandler;

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
