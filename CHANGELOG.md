# 更新日志

所有重要变更记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]

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
