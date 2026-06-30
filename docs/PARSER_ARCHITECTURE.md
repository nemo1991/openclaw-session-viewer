# Parser 架构

本文档描述 OpenClaw / Claude Code JSONL → 前端 `NormalizedBlock` 的归一化层。
重点是 v0.3.0 引入的 **BlockRegistry 模式**、v0.3.0 OpenClaw 去 wrapper、v0.3.0+ 未知 block 兜底。

> 总体架构、Tauri 进程边界、性能基准见 [ARCHITECTURE.md](ARCHITECTURE.md)。
> OpenClaw schema 细节见 [OPENCLAW_SESSION_FORMAT.md](OPENCLAW_SESSION_FORMAT.md)。

---

## 设计目标

1. **开闭原则** — 加新 block type 不需要改核心 `match` 逻辑
2. **多 schema 兼容** — Claude snake_case (`tool_use`)、OpenClaw camelCase (`toolUse`)、pi-coding-agent (`toolCall`) 全部识别
3. **未知 type 不崩溃** — 任何 `type` 字符串都有兜底渲染(`UnknownBlockCard`)
4. **可独立测试** — handler 是纯 trait 实现,每个 handler 自己带单测,无需 mock
5. **前后端归一化路径对称** — OpenClaw 不再伪造成 Claude,两路直接走同一套 BlockRegistry

---

## 三层归一化

```
┌────────────────────────────────────────────────────────────┐
│  Layer 1: Record 级 (claude.rs / openclaw.rs)             │
│  把 JSONL 一行 (record) → NormalizedMessage {            │
│      role, id, timestamp, blocks: Vec<NormalizedBlock>   │
│  }                                                        │
│  • claude.rs::normalize_record (Claude Code)              │
│  • openclaw.rs::normalize_entry (OpenClaw, 不再 wrapper)   │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼ blocks
┌────────────────────────────────────────────────────────────┐
│  Layer 2: Block 级 (blocks/ BlockRegistry)                │
│  把单个 content block (item) → NormalizedBlock { kind, data }│
│  委托给 default_registry().normalize(item)                │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼ NormalizedBlock
┌────────────────────────────────────────────────────────────┐
│  Layer 3: 渲染级 (frontend BlockRenderer)                  │
│  已知 kind → 专属卡片 (TextBlock / ToolUseCard / ...)      │
│  未知 kind → UnknownBlockCard                              │
└────────────────────────────────────────────────────────────┘
```

### 为什么 OpenClaw 不再 wrapper 转 Claude?(v0.3.0 关键变化)

**之前 (v0.2.x)**:

```rust
// openclaw.rs::normalize_entry
let mut transformed = serde_json::Map::new();
transformed.insert("type", "message");  // ← 伪造成 Claude
// ... 拷贝字段 + 把 role: "tool" 改写成 "user"
claude::normalize_record(&Value::Object(transformed))  // 再走 Claude 路径
```

**问题**:

- 两套 parser 耦合在一段 match 里
- TS 端 `normalize.ts` 已经独立处理 OpenClaw,**前后端架构不对称**
- `role: "tool"` 的改写 → 还原 patch,易漏
- 加新 block type 必须同时改 `claude.rs` 和 `openclaw.rs` wrapper

**现在 (v0.3.0+)**:

```rust
// openclaw.rs::normalize_entry
match obj.get("type").and_then(|v| v.as_str()) {
    Some("message") => {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        let content = msg.get("content").unwrap_or(&Value::Null);
        // content 数组直接走 BlockRegistry
        let blocks = claude::normalize_content(content);
        NormalizedMessage { role, id, timestamp, blocks, ... }
    }
    Some("model_change") => /* meta block */,
    Some("compaction") => /* meta block */,
    // ...
}
```

OpenClaw 消息的 `role: "tool"` 现在直接保留,前端 `BlockRenderer` 根据 role 渲染对应样式。

---

## BlockHandler trait

```rust
// src-tauri/src/parser/blocks/mod.rs
pub trait BlockHandler: Send + Sync {
    /// 是否能处理这个 item(纯 type 字符串匹配)
    fn matches(&self, item: &Value) -> bool;

    /// 转成 NormalizedBlock;失败返回 Invalid(不静默吞)
    fn normalize(&self, item: &Value) -> BlockResult;

    /// 人类可读名字(日志 / 调试)
    fn name(&self) -> &'static str;
}
```

### 关键约束

**`matches()` 必须纯函数 + 无副作用**

```rust
// ✅ 正确:只读 type 字段
fn matches(&self, item: &Value) -> bool {
    item.get("type").and_then(|v| v.as_str()) == Some("text")
}

// ❌ 错:依赖外部状态
fn matches(&self, item: &Value) -> bool {
    self.config.some_flag && item.get("type")... // 不要这样
}
```

Registry 是线性查找,handler 数量 < 10,纯函数保证顺序无关性。

**`normalize()` 输出形状必须稳定**

`NormalizedBlock.data` 用 `#[serde(flatten)]` 序列化,字段直接铺到顶层:

```rust
pub struct NormalizedBlock {
    pub kind: String,
    #[serde(flatten)]
    pub data: serde_json::Map<String, Value>,
}
```

前端收到的是 `{ kind, ...data_keys }`。`block.label ?? block.kind` 这种 fallback
直接依赖具体字段,**字段缺失会显示成 `[kind]`**。

每个 handler 的单元测试必须 assert 关键字段存在:

```rust
#[test]
fn tool_use_handler() {
    let n = reg().normalize(&json!({
        "type": "tool_use", "id": "x", "name": "Bash", "input": {}
    })).unwrap();
    assert_eq!(n.kind, "tool_use");
    assert!(n.data.contains_key("name"));  // ← 必须 assert
    assert!(n.data.contains_key("input"));
}
```

---

## BlockRegistry 顺序

```rust
pub fn default_registry() -> BlockRegistry {
    BlockRegistry::new()
        .register(TextBlockHandler)
        .register(ThinkingBlockHandler)
        .register(ToolUseBlockHandler)
        .register(ToolResultBlockHandler)
        .register(ImageBlockHandler)
        .register(AgentListingHandler)
        .register(SkillListingHandler)
        .register(PlanModeHandler)
        .register(FileSnapshotHandler)
        .register(MetaBlockHandler)  // ← 必须最后!
}
```

**`MetaBlockHandler` 必须放在最后**,因为它的 `matches()` 返回 `true`(永远匹配)。
如果放在前面,所有 type 都会被它吃掉,显示成 meta 块。

`registry_order_does_not_matter_for_known_types` 测试已覆盖这点。

### 内部实现

```rust
impl BlockRegistry {
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
```

`Vec + 线性查找`。block 数量 < 10,O(N) 完全可接受。未来 block 数爆炸时
可换 `HashMap<String, Box<dyn BlockHandler>>`,但当前不需要。

---

## Handler 实现示例

### 简单 handler: TextBlockHandler

```rust
// src-tauri/src/parser/blocks/text.rs
pub struct TextBlockHandler;

impl BlockHandler for TextBlockHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("text")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let text = item.get("text")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_default();
        Ok(NormalizedBlock {
            kind: "text".to_string(),
            data: serde_json::Map::from_iter([("text".to_string(), Value::String(text))]),
        })
    }

    fn name(&self) -> &'static str { "text" }
}
```

### 多 alias handler: ToolUseBlockHandler

```rust
// 5 个 alias 同时识别
fn matches(&self, item: &Value) -> bool {
    matches!(
        item.get("type").and_then(|v| v.as_str()),
        Some("tool_use" | "toolUse" | "tool_call" | "function_call" | "toolCall")
    )
}

fn normalize(&self, item: &Value) -> BlockResult {
    let mut data = serde_json::Map::new();

    // arguments → input 重命名(pi-coding-agent 兼容)
    let raw_input = item.get("input")
        .or_else(|| item.get("arguments"))
        .cloned()
        .unwrap_or(Value::Null);
    data.insert("input".to_string(), raw_input);

    // 其它字段直传
    if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
        data.insert("id".to_string(), Value::String(id.to_string()));
    }
    if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
        data.insert("name".to_string(), Value::String(name.to_string()));
    }

    Ok(NormalizedBlock { kind: "tool_use".to_string(), data })
}
```

### 兜底 handler: MetaBlockHandler

```rust
pub struct MetaBlockHandler;

impl BlockHandler for MetaBlockHandler {
    fn matches(&self, item: &Value) -> bool {
        true  // ← 永远匹配,作为 catchall
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let type_str = item.get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let mut data = serde_json::Map::new();
        data.insert("type".to_string(), Value::String(type_str.clone()));
        data.insert("payload".to_string(), item.clone());  // 原始 payload
        Ok(NormalizedBlock {
            kind: "meta".to_string(),
            data,
        })
    }
}
```

---

## 前端 UnknownBlockCard

```tsx
// packages/frontend/src/components/UnknownBlockCard.tsx
<details className="unknown-block-card">
  <summary>
    <span className="unknown-kind-badge">? {block.kind}</span>
    <span className="unknown-label">{block.label}</span>
    <span className="unknown-field-count">{knownFields.length} 字段</span>
  </summary>
  <div className="unknown-body">
    {inferHints(payload).map((h) => (
      <span className="hint-pill">
        {h.type} ({h.confidence}%)
      </span>
    ))}
    <table className="unknown-fields">
      {Object.entries(payload).map(([k, v]) => (
        <FieldRow name={k} value={v} />
      ))}
    </table>
    <button onClick={() => copy(JSON.stringify(payload, null, 2))}>📋 复制</button>
    <a href={reportUrl} target="_blank">
      🐛 报告
    </a>
  </div>
</details>
```

### `inferHints(payload)` — 启发式推断

```ts
// packages/frontend/src/components/UnknownBlockCard.tsx
export function inferHints(payload: Record<string, unknown>): Hint[] {
  const hints: Hint[] = [];
  // 形态 1: tool_use
  if (
    typeof payload.id === "string" &&
    typeof payload.name === "string" &&
    ("input" in payload || "arguments" in payload)
  ) {
    hints.push({ type: "tool_use", confidence: 90 });
  }
  // 形态 2: citation
  if (typeof payload.text === "string" && Array.isArray(payload.citations)) {
    hints.push({ type: "citation", confidence: 75 });
  }
  // 形态 3: image
  if (typeof payload.mediaType === "string" || typeof payload.media_type === "string") {
    hints.push({ type: "image", confidence: 80 });
  }
  return hints;
}
```

**纯前端启发式**,Rust handler 不依赖其他 type 的语义,避免循环耦合。

---

## 添加新 block type — 完整流程

假设 openclaw v3 引入新 type `cache_stats`:

### Step 1: 后端 handler

新建 `src-tauri/src/parser/blocks/cache_stats.rs`:

```rust
//! Cache stats block handler
//! `{ type: "cache_stats", hits, misses, evictions, ... }`

use serde_json::Value;
use super::{BlockHandler, BlockResult};
use crate::parser::claude::NormalizedBlock;

pub struct CacheStatsHandler;

impl BlockHandler for CacheStatsHandler {
    fn matches(&self, item: &Value) -> bool {
        item.get("type").and_then(|v| v.as_str()) == Some("cache_stats")
    }

    fn normalize(&self, item: &Value) -> BlockResult {
        let mut data = serde_json::Map::new();
        for k in ["hits", "misses", "evictions"] {
            if let Some(v) = item.get(k) {
                data.insert(k.to_string(), v.clone());
            }
        }
        Ok(NormalizedBlock {
            kind: "cache_stats".to_string(),
            data,
        })
    }

    fn name(&self) -> &'static str { "cache_stats" }
}

#[cfg(test)]
mod tests {
    use crate::parser::blocks::default_registry;
    use serde_json::json;

    #[test]
    fn cache_stats_basic() {
        let n = default_registry().normalize(&json!({
            "type": "cache_stats",
            "hits": 100, "misses": 5, "evictions": 3
        })).unwrap();
        assert_eq!(n.kind, "cache_stats");
        assert_eq!(n.data.get("hits").and_then(|v| v.as_u64()), Some(100));
    }
}
```

### Step 2: 注册

`src-tauri/src/parser/blocks/mod.rs`:

```rust
pub mod cache_stats;
pub use cache_stats::CacheStatsHandler;

pub fn default_registry() -> BlockRegistry {
    BlockRegistry::new()
        // ... 现有 handler
        .register(CacheStatsHandler)
        .register(MetaBlockHandler)  // 仍最后
}
```

### Step 3: 前端可选专属渲染

如果想有专属 UI:

```tsx
// packages/frontend/src/components/MessageBubble.tsx::BlockRenderer
case "cache_stats":
  return (
    <div className="block-cache-stats">
      <span className="meta-kind-badge">📊 cache</span>
      <span>hits: {block.hits}</span>
      <span>misses: {block.misses}</span>
    </div>
  );
```

不写这一步也 OK,`MetaBlockHandler` 自动兜底 → `UnknownBlockCard` 显示字段表 + hint。

### Step 4: 验证

```bash
cd src-tauri && cargo test --lib              # 新 handler 单测
cd packages/frontend && pnpm exec tsc --noEmit  # TS 类型干净
```

---

## serde flatten 兼容性(关键风险)

`NormalizedBlock.data: Map<String, Value>` 用 `#[serde(flatten)]`,序列化为:

```json
{
  "kind": "tool_use",
  "id": "x",
  "name": "Bash",
  "input": {}
}
```

而不是:

```json
{ "kind": "tool_use", "data": { "id": "x", "name": "Bash", "input": {} } }
```

**前端类型** (`packages/shared/src/normalize.ts`):

```ts
export interface NormalizedBlockFE {
  kind: string;
  [key: string]: unknown; // data 字段全部 flatten 到顶层
}
```

**风险点**:

- handler 输出字段名错误 → 前端 fallback 到 `[kind]` 字面显示
- handler 字段缺失 → 前端读 `undefined` → fallback 链生效
- handler 多余字段 → 前端直接接收,无影响(但增加 payload 大小)

**预防**:

- 每个 handler 单元测试断言关键字段
- `UnknownBlockCard` 是兜底,任何异常最终都能看字段

---

## 已知 block type 速查

| 原始 type(s)                                                        | Normalized kind | 文件               | 前端渲染                                                     |
| ------------------------------------------------------------------- | --------------- | ------------------ | ------------------------------------------------------------ |
| `text`                                                              | `text`          | `text.rs`          | `<TextBlock>` Markdown                                       |
| `thinking` / `redacted_thinking`                                    | `thinking`      | `thinking.rs`      | `<ThinkingBlock>` 折叠                                       |
| `tool_use` / `toolUse` / `tool_call` / `function_call` / `toolCall` | `tool_use`      | `tool_use.rs`      | `<ToolUseCard>`                                              |
| `tool_result` / `toolResult`                                        | `tool_result`   | `tool_result.rs`   | `<ToolResultCard>`                                           |
| `image`                                                             | `image`         | `image.rs`         | `<ImageBlock>`                                               |
| `agent_listing_delta`                                               | `agent_listing` | `agent_listing.rs` | `<BlockMetaInfo>` + chip wrap 溢出保护 (v0.6.x)              |
| `skill_listing`                                                     | `skill_listing` | `skill_listing.rs` | `<BlockMetaInfo>` 默认全显示 (>6 行滚动) (v0.6.x)            |
| `plan_mode`                                                         | `plan_mode`     | `plan_mode.rs`     | `<MetaBlock>` reveal 按钮 + 失败行内三按钮 (v0.6.x)          |
| `file_history_snapshot`                                             | `file_snapshot` | `file_snapshot.rs` | `<MetaBlock>` 路径可点击 + 失败行内三按钮 (v0.6.x)           |
| `task_reminder`                                                     | `task_reminder` | `task_reminder.rs` | `<MetaBlock>` 含 id 串联 + description + blocks DAG (v0.6.x) |
| `agent_name` / `agent-name`                                         | `agent_name`    | `agent_name.rs`    | `<MetaBlock>` 单行 优雅展示 (v0.6.x)                         |
| `pr_link` / `pr-link`                                               | `pr_link`       | `pr_link.rs`       | `<MetaBlock>` 带链接徽章 (v0.6.x)                            |
| (其它)                                                              | `meta`          | `meta.rs`          | `<UnknownBlockCard>`                                         |

**多 alias 是有意为之** — 同一概念在不同 agent / 不同 schema 中命名不同,
handler `matches()` 一次认全,前端只需一个 `case "<kind>"`。

### v0.6.x 新增关键归一化 (`parser/claude.rs`)

- `NormalizedMessage.subagentId` — 从 envelope.agentId 提取(仅 `isSidechain=true` 时)
- 旧的 Rust 端写死 `None` 让 v0.5.0 浪费了这条关键关联 — v0.6.0 真正归一化进数据
- 测试: 3 case (有/无 isSidechain × 有/无 agentId)

---

## 性能

- `BlockRegistry::normalize` 线性查找 9 个 handler,每次 < 100ns
- 8MB JSONL (~20k records, ~50k blocks) 完整归一化 **< 600ms**(M1 Pro)
- 归一化不是热点路径(IO 占大头),handler 数量增长到 100 仍可接受

---

## 不在本文范围

- **自定义 renderer 插件**(v0.4+):用户能写自己的 BlockHandler 注入 registry
- **streaming 增量 normalize**:目前每条 batch 重新 normalize,未来增量
- **schema 版本协商**:Rust 端不感知 session format v3,假设全部 v3 兼容
- **多语言 i18n block**:目前 hint / label 写死中文,未来可抽 i18n key
