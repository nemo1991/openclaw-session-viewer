# 架构

## 总体设计

```
┌───────────────────────────────────────────────────────────────┐
│                    Tauri 2 Runtime                            │
│  ┌─────────────────────────┐  ┌─────────────────────────┐  │
│  │   WebView (WKWebView)   │  │   WebView (Edge WebView2│  │
│  │   macOS / iOS Safari    │  │   Windows)               │  │
│  │   WebKitGTK (Linux)     │  │                          │  │
│  └────────────┬────────────┘  └──────────────┬───────────┘  │
│               │  Tauri IPC (JSON over stdio)                 │
│  ┌────────────┴──────────────────────────────────────────┐   │
│  │              Rust Backend (src-tauri/src/)             │   │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐        │   │
│  │  │  Commands  │  │   Parser   │  │    LLM     │        │   │
│  │  │  (12 个)   │  │  (JSONL)   │  │  Client    │        │   │
│  │  └────────────┘  └────────────┘  └────────────┘        │   │
│  │  ┌────────────┐  ┌────────────┐                       │   │
│  │  │    FS      │  │   Cache    │                       │   │
│  │  │  Paths     │  │   Moka     │                       │   │
│  │  └────────────┘  └────────────┘                       │   │
│  └─────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────────────┐
        │      Local Filesystem               │
        │  ~/.claude/projects/.../*.jsonl     │
        │  ~/.openclaw/agents/.../sessions/   │
        └─────────────────────────────────────┘
```

## 数据流

### 1. 启动

```
App 启动
  ↓
Rust setup() → AppPaths::new() 解析 ~/.claude 和 ~/.openclaw
  ↓
Frontend mount → App → loadSettings() (Tauri invoke get_settings)
  ↓
SessionsRoute mount → load() → list_sessions
  ↓
Rust list_sessions:
  - scan ~/.claude/projects/<key>/*.jsonl
  - 解析头部 50 条提取 title/messageCount/totalTokens
  - 关联 ~/.claude/sessions/<pid>.json → livePid
  - 关联 ~/.claude/projects/<key>/<uuid>/subagents/ → subagentDir
  ↓
返回 SessionMeta[] → 前端渲染列表
```

### 2. 打开会话

```
点击会话卡片
  ↓
navigate(/session/<id>, { state: { session } })
  ↓
SessionDetailRoute mount → useTranscriptStore.start(jsonlPath)
  ↓
Rust stream_transcript:
  - 监听 transcript-batch / transcript-done 事件
  - spawn_blocking → stream_batches(jsonl, 500/batch)
    - BufReader 64KB → for_each_line
    - normalize (Claude) or normalize_entry (OpenClaw)
    - tx.blocking_send(StreamBatch { entries })
  - spawn → while rx.recv() { app.emit("transcript-batch", batch) }
  ↓
Frontend listenTranscriptBatches → entries: [...s.entries, ...batch.entries]
  ↓
TranscriptView 虚拟列表渲染
```

### 3. 全局搜索 (Cmd+K)

```
Cmd+K → SearchPalette 显示
  ↓
输入 → debounce 300ms → searchStore.search(q)
  ↓
listenSearchAll 监听 global-search-hit / global-search-done
  ↓
invoke("search_all", { query })
  ↓
Rust search_all:
  - 收集所有 jsonl 路径
  - spawn_blocking: for path { for_each_line { substring 搜索 } }
    - tx.blocking_send(GlobalSearchHit)
  - spawn: while rx.recv() { app.emit("global-search-hit", hit) }
  ↓
前端 set({ hits: [...s.hits, hit] })
  ↓
SearchPalette 渲染结果列表
```

### 4. 大模型分析

```
设置页填 API Key/Base URL → save_settings (写入 app_config_dir/settings.json)
  ↓
打开分析视图 → 选模板 + 选范围
  ↓
analyze_session(path, template, range, baseUrl, apiKey, model)
  ↓
Rust analyze_session:
  - 解析整个 jsonl
  - context.rs::build_context 按 range 过滤 + 序列化
  - system = ANALYSIS_PROMPTS[template]  (替换 {{context}})
  - llm/anthropic.rs::stream_anthropic:
    - POST {baseUrl}/v1/messages (stream=true)
    - SSE 解析 content_block_delta.text
    - tx.send((text, usage))
  - spawn: while rx.recv() { app.emit("analyze-event", AnalyzeEvent) }
  ↓
Frontend listenAnalyze → 流式更新 result
```

## 模块边界

### `packages/shared/src/` — 跨进程类型

- **单一来源**: ClaudeRecord/OpenClawEntry/normalized 都定义在这里
- **跨端使用**:
  - 前端 import 类型 + 归一化函数
  - Rust 不直接 import(语言不通),但通过相同 schema 序列化
- **必须保持同步**: 添加新字段时 Rust 和 TS 一起改

### `src-tauri/src/parser/` — 数据归一化

- **职责**: 把原始 JSON Value 转成统一 `NormalizedMessage`
- **独立**: 不依赖 Tauri,可独立测试
- **两个 parser**:
  - `claude.rs::normalize` — Claude Code JSONL → NormalizedMessage
  - `openclaw.rs::normalize_entry` — OpenClaw JSONL → 转换为 Claude 格式再调 normalize

### `src-tauri/src/commands/` — Tauri 边界

- **职责**: 接收 invoke,返回 serde 序列化的 JSON
- **错误**: `AppResult<T>` → 序列化为 `{ kind, message }` 给前端
- **路径安全**: 每次接受路径参数都做 `assert_within_lexical`

### `src-tauri/src/llm/` — 外部 API 客户端

- **职责**: 流式调用 Anthropic Messages API
- **适配**: 通过 `baseUrl` 切换官方/MiniMax/任何兼容代理
- **不依赖**: 与 commands/parser/cache 完全解耦,可单独测试

## 性能关键路径

### 启动时间线(M1 Pro 实测)

| 步骤 | 时间 |
|---|---|
| Tauri 启动到 webview ready | 200ms |
| webview 加载 index.html (静态) | 50ms |
| main.tsx 执行 + React mount | 50ms |
| get_settings invoke | 5ms |
| list_sessions invoke (含 11 个会话解析) | 50ms |
| 第一次 render | 50ms |
| **总冷启动** | **~400ms** |

### 8MB JSONL 打开

| 步骤 | 时间 |
|---|---|
| stream_transcript 启动 | 5ms |
| 第一批 500 条 emit | 50ms |
| 第一批 React render | 30ms |
| **首屏可见** | **~85ms** |
| 后续每批 (500 条/批) | 30ms |
| 全 20000 条解析完 | ~600ms |

### 搜索 (Cmd+K)

| 步骤 | 时间 |
|---|---|
| spawn_blocking 启动 | 5ms |
| for_each_line 第一条匹配 | 1ms |
| emit 第一个 hit | 1ms |
| **首个结果可见** | **~10ms** |

## 安全模型

### 路径白名单

所有 Tauri 命令接受路径参数时必须通过 `assert_within_lexical`:

```rust
let p = Path::new(&input_path);
if p.starts_with(&state.paths.claude.projects_dir) {
    assert_within_lexical(&state.paths.claude.projects_dir, p)?;
} else if let Some(oc) = &state.paths.openclaw {
    if p.starts_with(&oc.agents_dir) {
        assert_within_lexical(&oc.agents_dir, p)?;
    } else {
        return Err(PathSecurity(...));
    }
}
```

### 攻击面

- ❌ 无法读取 `~/.ssh/id_rsa` 等其他位置
- ❌ 无法删除文件(没有 delete 命令)
- ❌ 无法执行任意命令
- ✅ 只能读 `~/.claude/` 和 `~/.openclaw/` 下的 JSONL/MD/TXT
- ✅ API Key 存在 `app_config_dir/settings.json`(用户家目录,OS 权限保护)

## 扩展点

### 添加新的 Tauri 命令

1. 在 `src-tauri/src/commands/` 新建 `xxx.rs`
2. `mod.rs` 加 `pub mod xxx;`
3. `lib.rs` 的 `invoke_handler!` 加 `commands::xxx::my_command`
4. 前端 `lib/api.ts` 加 `apiMyCommand()` 包装

### 添加新的内容块类型

1. `claude-types.ts` 加新 union 成员
2. `parser/claude.rs::normalize_content_block` 加映射
3. `components/MessageBubble.tsx::BlockRenderer` 加 case
4. 添加测试覆盖

### 替换 LLM 后端

只需修改 `src-tauri/src/llm/anthropic.rs`,保持 `stream_anthropic` 签名不变。OpenAI 兼容:改 POST URL 和 SSE 解析。