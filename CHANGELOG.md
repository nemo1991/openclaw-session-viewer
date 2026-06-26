# 更新日志

所有重要变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]

## [0.4.3] - 2026-06-25

### 修复

- 🐛 **会话内搜索 Next 按钮不滚动 + 加结果下拉列表** (`f5d54cf`)：原 useEffect 调 `jumpToEntry` 走 `scrollIntoView` 改 window viewport，但目标 entry 多半在虚拟列表的未渲染区(overscan 10)，`querySelector` 返回 null 静默失败。`TranscriptView` 加 `useEffect` 调 `virtualizer.scrollToIndex(localIdx, { align: "center" })` 把目标 entry 滚到可视区中央，让 DOM 就绪。
- 🐛 **高亮 CSS selector 错配** (`f5d54cf`)：`SearchInSessionBar.css` 写的是 `.transcript-view .msg.search-hit-current`，但 `TranscriptView` 把 className 加在**外层 wrapper div** 而不是内层 `.msg`，永远匹配不上。改成 `.transcript-view [data-entry-index].search-hit-current`。
- 🐛 **n/p 键缺失** (`f5d54cf`)：i18n 字符串和按钮 tooltip 都写 `(n)`/`(p)`，但只绑了 `enter` / `shift+enter`。补 `useKey("n")` / `useKey("p")`，跟其它键统一。
- ✨ **结果下拉列表** (`f5d54cf`)：搜索框下加 `position: absolute` dropdown，前 100 条 + "…还有 N 条"；每行 `#entryIndex · role · 时间 + snippet`，当前命中行加 `.is-active`；row click 调新 store action `setCurrentHitIndex(i)` 跳到该 entry；row mouseEnter 也 setCurrentHitIndex(悬停预览)；键盘 `↑/↓` 在 query 非空时 intercept 切 hit(空 query 让出原生光标行为)。
- 🐛 **下拉 dropdown 飘到屏幕外** (`b2dba36`)：`.search-in-session-bar-wrapper` CSS 类漏写 → 没有 `position: relative`，`.search-results-dropdown` 的 `position: absolute; top: 100%` 锚定到错误祖先，飘屏。
- 🐛 **时间筛选下点 row 跳到 hits[0] 而非点击的 i** (`b2dba36` / `379a135`)：`SearchInSessionBar` 里 row 渲染用了 `entries.find((e) => e.index === hit.entryIndex)`(全量)，跟 TranscriptView 渲染的 `filteredEntries` 不一致；filter 模式下 row 显示的 entry 可能不在 filter 范围，filter 范围变化时 ref 不稳定 → 真正根因是 `searchableEntries` 没用 `useMemo` 包装，`entries.filter()` 每次 render 返回新数组，触发 `useEffect([open, debouncedQuery, searchableEntries])` 每帧跑 `search()`，而 `search()` 内部会重置 `currentHitIndex = 0`。修：`searchableEntries` 用 `useMemo` 包，row 查找改用 `searchableEntries`。
- 🐛 **点 row 后 dropdown 不关** (`2dc04ed`)：onClick 调 `setQuery("")` → `showDropdown = query.length > 0` 自动折叠，bar 仍在可继续搜。
- 🐛 **倒序 + filter 无限下拉** (`2dc04ed`)：原 auto-scroll useEffect 有 `!sortAsc` 和 `filterActive` 早 return，倒序 + filter 时新 entry 加载到顶部(倒序时新内容在顶)但用户 scroll 位置指向"旧底部"，virtualizer 总尺寸持续增长，体感"无限下拉"。改成"用户在底部(50px 容差)时跟随滚到底"统一逻辑，倒序 + filter 也能正常停止。
- 🐛 **点 row 没正确定位** (`8f1c6f1`)：双跳转冲突 — `SearchInSessionBar` useEffect 调 `onJump → scrollIntoView` 改 window viewport，同时 `TranscriptView` useEffect 调 `virtualizer.scrollToIndex` 改 transcript-scroll 内部 scrollTop，两个改不同容器，`scrollIntoView` 覆盖 `scrollToIndex` 结果。修：`SearchInSessionBar` 不再调 `onJump`，只靠 `TranscriptView` 的 `scrollToIndex` 唯一负责滚动。`?line=N` URL 跳转仍走 `jumpToEntry` 不受影响。
- 🐛 **agent-name meta block 不识别** (`8f1c6f1`)：`MetaBlockRenderer` case 是 `"agent_name"`(下划线)但 Claude JSONL `type` 是 `"agent-name"`(连字符)，switch 不匹配走 `UnknownBlockCard` 兜底；`isKnownMetaLabel` 也没列 `"agent-name"`。两个地方都加 `"agent-name"` 双匹配。

### 测试

- 🧪 Rust 单元测试 94 个（不变）
- 🧪 TypeScript 测试 41 → 51（不变，v0.4.3 全是 UI 修复,无新增单测）

## [0.4.2] - 2026-06-25

### 新增

- ✨ **Edit 工具 line-level diff 视图** (PR1)：引入 `diff` (jsdiff) npm 库,Edit `tool_use` 卡片从折叠 JSON dump 改成红删/绿增 inline diff,未变行灰色,`replace_all: true` 加 "替换全部" badge;5000 行 cap 走 fallback。`packages/frontend/src/lib/diff.ts` 薄包装 + `diff.test.ts` 5 case 单测。
- ✨ **Bash/Read/Task (TaskUpdate+TaskCreate) / tool_result 默认展开 + 优化展示** (PR2)：所有 tool 卡片 `useState(true)` 默认展开;Bash 卡片在等宽 code block 里显示 `command`、italic 灰字 `description`、"后台" badge;Read 卡片头部 `file_path` 粗体 + "lines N–M" offset/limit 指示;Task 卡片区分 TaskCreate (description + subagent_type + prompt 预览) vs TaskUpdate (taskId + status 大 badge);tool_result 卡片对常见代码文件后缀 lazy-import shiki 跑语法高亮 (前 500 字符)。其它 tool (Glob/Grep/WebFetch/WebSearch/Write/MultiEdit) 享受 default-open 但 body 仍 JSON dump。
- ✨ **时区设置** (PR3)：AppSettings 加 `timezone` 字段,Settings → Appearance 加下拉 (auto/UTC/Asia/Shanghai/Asia/Tokyo/Europe/London/America/New_York/America/Los_Angeles,7 个常用 IANA);所有时间展示 (会话列表 / 详情 / 轨迹 / 消息气泡) 跟随;TranscriptView 时间 filter bar 的 `datetime-local` 改 TZ-aware (用 `formatLocalInputToIsoInTz` 显式把 naive 字符串按选定 TZ 解析,不再依赖浏览器 OS TZ);filter preset (1h/24h/7d) 数学 TZ-agnostic 仍正确。`format.test.ts` 5 case 单测覆盖 TZ 转换。

### 变更

- 🔧 **会话列表 source 默认改回 OpenClaw**：v0.4.1 改成 Claude 防止误把 OpenClaw 当普通会话看,现在改回 OpenClaw (项目初衷),无 OpenClaw 数据时显示现有 "无匹配" 空状态,用户自行切 Claude。

### 测试

- 🧪 Rust 单元测试 94 个（不变）
- 🧪 TypeScript 测试 41 → 51 (+10: diff 5 + format 5)

## [0.4.1] - 2026-06-25

### 修复

- 🐛 **详情页深色主题 meta 块**：`theme/tokens.css` 缺少 `--color-surface-1` / `--color-surface-2` 两个 token，深色主题下 `.block-meta-info` 系列 fallback 到 `#f5f5f5` 浅灰背景，深色面板上变成"浅紫底深紫字"突兀。补 token 并清理 MessageBubble.css / TrajectoryView.css 里的硬编码 fallback。
- 🐛 **子代理会话字段没专属样式**：Claude sub-agent 会话 content 数组里的 `mode` / `permission-mode` / `ai-title` / `custom-title` / `last-prompt` 被后端归一化成 `kind: "meta"`，前端走简化 pill 渲染（一行 `📄 mode: normal`），挤主流程。新增 `SubagentMetaBlock` 组件，按 label 识别并渲染成可折叠 details，默认折叠。
- 🐛 **meta 分支的 7 种已知 block 没识别**：`file-history-snapshot` / `agent_listing_delta` / `skill_listing` / `plan_mode` / `pr-link` / `agent_name` / `task_reminder` 在 meta 消息里走 UnknownBlockCard 兜底样式（`? meta xxx N 字段`）。抽出共享 `MetaBlockRenderer` 组件，从 `block.payload` 解包字段（attachment 类型的数据全在 payload 里），按 label 路由到对应专属样式（🤖 agent / 🛠 skill / 📋 plan_mode / 📁 file_snapshot 等）。

### 变更

- 🔧 **列表侧边栏 source 默认改 Claude**：移除"全部"单选，只剩 Claude / OpenClaw 二选一；首次打开默认进 Claude，避免误把 OpenClaw 会话当成普通会话看。
- 🔧 **tool-chip 深色主题对比度**：`tool-chip` 背景从 `var(--color-surface-2, #e5e5e5)` 改成 `var(--color-bg-hover)` + 边框 + `var(--color-text)`，深色下清晰。

### 测试

- 🧪 Rust 单元测试 94 个（不变）
- 🧪 TypeScript 测试 41 个（不变）

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
