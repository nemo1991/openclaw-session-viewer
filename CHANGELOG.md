# 更新日志

所有重要变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]

### 计划

- 会话对比 (diff)
- 拖拽导入 JSONL
- VS Code 路径跳转

## [0.4.0] - 2026-06-25

### 新增

- ✨ **会话详情时间段筛选** (PR1)：TranscriptView 顶部新增 4 个 preset (全部 / 1h / 24h / 7d) + 自定义 datetime-local 范围 picker；URL 持久化 `?from=ISO&to=ISO`；meta 消息 (无 timestamp) 保留；search 也在筛选后范围跑
- ✨ **会话列表 UI 增强** (PR2)：卡片新增首条 user 提问预览 (1 行省略) + thinking/tool 统计 chips + top 3 工具名；时间显示智能相对化 (刚刚/X 分钟前/X 天前)；后端新增 `firstPrompt` / `lastMessageAt` / `thinkingCount` / `toolUseCount` / `topTools` 字段
- ✨ **OpenClaw Trajectory 支持** (PR3)：详情页 header 新增 "运行轨迹" 按钮 (仅 OpenClaw + 有 trajectory 的 session 显示)；新路由 `/session/:id/trajectory` + 8 种事件专属卡片 (session.started / session.ended / trace.metadata / context.compiled / prompt.submitted / model.fallback_step / model.completed / trace.artifacts)；流式加载 + 50 MiB 上限；支持 `.trajectory-path.json` 指针文件 (OPENCLAW_TRAJECTORY_DIR 重定向)

### 测试

- 🧪 Rust 单元测试 91 → 94 (+3 trajectory 归一化测试)
- 🧪 TypeScript 测试 41 个(不变)

## [0.3.2] - 2026-06-25

### 新增

- ✨ **3 个新 BlockHandler**（响应 issue #11/#12/#13）：
  - `pr-link` → `pr_link`:显示 PR 链接卡片,可点击跳转
  - `agent-name` → `agent_name`:显示当前 agent 标识
  - `task_reminder` → `task_reminder`:显示任务列表快照（pending/inProgress/completed 计数 + 详情展开）

### 修复

- 🐛 关 issue #6/#7/#9/#10:这 4 种 block type 已在 v0.3.1 加专属 handler,UI 不再显示 `[kind]`

### 测试

- 🧪 Rust 单元测试 85 → 91 (+6)

## [0.3.1] - 2026-06-24

### 新增

- ✨ **会话详情排序切换**：TranscriptView 顶部新增正序/倒序按钮，支持按消息顺序切换
- ✨ **4 个新 BlockHandler**：`agent_listing_delta`、`skill_listing`、`plan_mode`、
  `file_history_snapshot` 现在有专属渲染（之前走兜底 UnknownBlockCard）
- 📝 README 新增 macOS Gatekeeper 临时解决方案

### 修复

- 🐛 修复编译告警：新 handler 测试模块移除多余的 `use super::*` 导入

### 重构

- ♻️ 新增 `agent_listing.rs`、`skill_listing.rs`、`plan_mode.rs`、`file_snapshot.rs` handler

### 测试

- 🧪 Rust 单元测试 85 个（+8）

## [0.3.0] - 2026-06-24

### 重构

- ♻️ **BlockRegistry 模式重构 parser**：新增 `BlockHandler` trait + `BlockRegistry`
  - `default_registry()`，加新 block type 只需实现一个 handler + register，
    不再需要改 `match` 语句。
  * `normalize_content_block` 委托给 registry (行为不变,53 测试全过)
  * `MetaBlockHandler` 最后注册作为兜底 catchall
- ♻️ **Handler 独立文件**：
  - `text.rs` / `thinking.rs` (PR2)
  - `tool_use.rs` (5 alias: `tool_use`/`toolUse`/`tool_call`/`function_call`/`toolCall`)
  - `tool_result.rs` (2 alias: `tool_result`/`toolResult`)
  - `image.rs` / `meta.rs` (PR3)
- ♻️ **OpenClaw 去 wrapper** (PR4)：
  - 不再伪造成 Claude 格式，直接解析 OpenClaw 记录
  - `message` type content 走 `BlockRegistry::normalize`
  - `tool` role 不再改写为 `user`
  - 消除前后端 normalize 路径不对称

### 新增

- ✨ **UnknownBlockCard 前端组件** (PR5)：
  - `<details>` 默认折叠，展开后显示字段表 + 启发式 hint pills
  - 复制 JSON 按钮 + 报告 GitHub issue 链接
  - 未知 block type 不再仅显示 `[kind]` 一行字
- ✨ **8 个新 handler 独立测试文件**，每个 handler 覆盖 alias/边界/缺失字段

### 移除

- 🗑️ 移除 v0.2.6 调查残留日志（`window.addEventListener("error")` hooks、
  `console.log` banner、`document.title` 注入、`BlockRenderer` 内 console 日志）
- 🗑️ `transcriptStore.ts` 中 dev `console.error("[stream_transcript:error]")`

### 测试

- 🧪 Rust 单元测试 53 → 77 (+24，覆盖所有 handler alias + OpenClaw 独立路径)
- 🧪 TypeScript 类型检查 + Vite build 干净
- 🧪 Clippy + cargo fmt 干净

## [0.2.6] - 2026-06-24

### 修复

- 🐛 **Windows [object Object] 错误**：`invoke` 抛 error 对象时 `String(e)` 产生
  `"[object Object]"`。前端 `extractErrorMessage(e)` 优先提取 `message` / `kind` 字段，
  UI 显示真实错误描述而非 `[object Object]`。
- 🐛 **路径安全 Windows UNC 前缀**：`canonicalize()` 返回 `\\?\C:\Users\...` 而 target
  是短路径 `C:\Users\...`，字符串前缀比较失败。新增 `path_starts_with()` 函数统一分隔符、
  忽略大小写、去掉 `\\?\` 前缀，Windows 路径检测恢复正常。
- 🐛 **pi-coding-agent toolCall 不识别**：`tool_call` / `toolCall` / `function_call` 5 个别名
  现在统一识别为 `tool_use`，`arguments` 字段自动重命名为 `input`。
- 🐛 重复 session 修复：`Path::extension()` 只取最后一段扩展名，导致 `*.trajectory.jsonl`
  被误认为 `jsonl` 文件。walker 增加 `file_stem` 末缀过滤。

### 调试改进

- 🔍 首次复现阶段添加分层日志：Windows banner + document.title + console.error 结构化输出

## [0.2.5] - 2026-06-24

### 新增

- ✨ **自定义数据源根目录**：Settings 页可添加多个自定义 Claude/OpenClaw 根目录。
  自动探测 `projects/` / `agents/` 子目录判定类型，添加后立即生效。
- ✨ **热重载**：保存 settings 后自动 invalidate 缓存 + 通知前端刷新列表，无需重启。
- ✨ **跨平台路径安全**：`AppPaths` 支持多 root 路径检测，`assert_within_any_root` 遍历
  所有注册根目录验证路径合法性。

### 修复

- 🐛 Clippy `needless_borrow`：`load_settings_on_startup(&app.handle())` → `app.handle()`。

### 架构

- 🏗️ `AppPaths` 重构为 `default_root + custom_roots` 模型，`RwLock<AppPaths>` 线程安全
- 🏗️ `RootSource` 分离 Claude/OpenClaw 子路径，`all_claude_projects_dirs()` /
  `all_openclaw_agents_dirs()` 统一扫描入口
- 🏗️ `CustomRoot::probe()` 自动探测路径类型

## [0.2.4] - 2026-06-24

### 新增

- ✨ **多 Agent UI**:OpenClaw 按 agent 二级分组(顶层紫色 Bot icon,
  副标题显示 channel · label,卡片底部 channel badge)。
  - `SessionMeta` 加 `agentId` / `agentLabel` / `agentChannel` /
    `agentTarget` 4 个字段(都 optional,向后兼容)
  - 后端从 per-agent `sessions.json` 索引读 label/channel/target
    (文件不存在或 JSON 损坏返回空,不阻塞列表加载)
  - `projectKey` 加 `openclaw:` 前缀避免与 Claude projectKey 冲突
  - 前端 sessionsStore 加 `agentId` filter(只在 > 1 个 agent 时显示)
  - 文本搜索范围扩展到 `agentId` / `agentLabel` / `agentTarget`

### 测试

- 🧪 Rust 单元测试 35 → 41(+6 sessions.json 容错/解析测试)

## [0.2.3] - 2026-06-23

### 修复

- 🐛 macOS 搜索会话崩溃: `Cargo.toml` 里 `panic = "abort"` 编译期
  把 `catch_unwind` / `panic::set_hook` 全部绕过,改回默认
  `panic = "unwind"` 即可;`search.rs` 里再加 UTF-8 char boundary
  防护(`floor_char_boundary`)+ 单条记录 panic log + 吞掉(rust
  2024 不允许 rethrow),单条坏数据不再拉整 App 陪葬。
- 🐛 会话列表把 `*.trajectory.jsonl` 误当成 session 列出来
  (openclaw 写在每个 session 旁边的观测/trace 副产物,不是用户
  会话;`Path::extension()` 只取最后一段所以会漏过)。walker 加
  `file_stem` 末缀过滤 + 单测。
- 🐛 会话详情返回按钮渲染了两把箭头(JSX 里 `<ArrowLeft />` +
  i18n `back` 字符串里的字面 `←`)。删掉 i18n 里的字面箭头。

## [0.2.2] - 2026-06-23

### 修复

- 🐛 Windows MSI bundling fails on non-ASCII `productName`
  ([tauri-apps/tauri#8363](https://github.com/tauri-apps/tauri/issues/8363)):
  switched to ASCII `OpenClaw Session Viewer`. Window title still
  shows `OpenClaw 会话查看器` at runtime.
- 🐛 Windows / Linux builds missing `icons/icon.ico`: now committed
  - regenerated automatically by CI if missing.

### 变更

- 📝 README download table + `docs/RELEASING.md` asset list updated
  to ASCII bundle filenames, with note explaining the rationale.

## [0.2.1] - 2026-06-23

- 修复 window 以及 linux 创建 release 失败问题

## [0.2.0] - 2026-06-23

- 增加 github action 创建 release

### 计划

- 会话对比 (diff)
- 拖拽导入 JSONL
- VS Code 路径跳转

## [0.1.0] - 2026-06-22

### 新增

- ✨ 基础会话列表 + 转录查看(Claude Code + OpenClaw)
- ✨ 全局跨会话搜索 (Cmd/Ctrl+K)
- ✨ 会话内搜索 (Cmd/Ctrl+F,n/p 跳转)
- ✨ URL 跳转 (`?line=N`)
- ✨ 大模型分析 (4 模板 + 自定义,Anthropic 兼容)
- ✨ Markdown / HTML 导出
- ✨ 实时 PID 状态(显示运行中的 CLI)
- ✨ 工具溢出文件查看
- ✨ 深色 / 浅色 / 跟随系统主题
- ✨ 中文界面
- 📦 跨平台打包 (macOS / Windows / Linux)
- 🧪 Rust 单元测试 28 个,TypeScript 测试 41 个
- 🔄 GitHub Actions CI (lint/test/build)
- 🚀 GitHub Actions Release(三平台并行 + 自动发版)

### 修复

- 🐛 OpenClaw camelCase 工具调用 (`toolUse`/`toolResult`) 不识别
- 🐛 OpenClaw tool 结果 role 被错误映射为 user
- 🐛 `normalizeClaudeRecord(null)` 抛错
- 🐛 `joinPath("/a/", "b", "c")` 丢失绝对路径前缀
- 🐛 macOS 上直接运行裸二进制导致 webview 空白(必须 .app bundle)

### 文档

- 📝 README 重写(GitHub 风格)
- 📝 docs/ARCHITECTURE.md — 架构总览
- 📝 docs/CROSS_PLATFORM_BUILD.md — 跨平台构建指南
- 📝 docs/TROUBLESHOOTING.md — 已知问题与解决方案

[Unreleased]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.2.6...v0.3.0
[0.2.6]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/nemo1991/openclaw-session-viewer/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nemo1991/openclaw-session-viewer/releases/tag/v0.1.0
