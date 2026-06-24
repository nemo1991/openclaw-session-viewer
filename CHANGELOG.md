# 更新日志

所有重要变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]

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
