<div align="center">

# OpenClaw Session Viewer

**跨平台桌面应用，本地浏览 OpenClaw 和 Claude Code 的会话转录**

[![Tauri](https://img.shields.io/badge/Tauri-2-blue?logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-1.77+-orange?logo=rust)](https://www.rust-lang.org)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)]()
[![Release](https://img.shields.io/github/v/release/nemo1991/openclaw-session-viewer)](https://github.com/nemo1991/openclaw-session-viewer/releases/latest)

[下载](#-下载) · [功能](#-功能) · [快速开始](#-快速开始) · [架构](#-架构) · [开发](#-开发) · [故障排除](#-故障排除) · [路线图](#-路线图) · [文档索引](#-文档索引)

</div>

---

## 📖 简介

OpenClaw Session Viewer 是一个本地优先的桌面应用，让你可以方便地查看、搜索、分析 Claude Code 和 OpenClaw 的历史会话。

**为什么需要它？**

- 🤖 你的 CLI 会话记录存在 `~/.claude/projects/...` 里，但你只能用 `cat` 或文本编辑器看
- 🔍 想搜"上次是怎么解决 X 问题的"，但 JSONL 没法全文搜索
- 📊 想用 LLM 总结长会话、提取代码修改，但没法选范围
- 📤 想把某个会话分享给同事，但没有现成的导出工具

**这个应用解决上述所有问题。**

## 📥 下载

从 [Releases 页面](https://github.com/nemo1991/openclaw-session-viewer/releases/latest) 下载适合你平台的安装包:

| 平台                  | 文件                                               |
| --------------------- | -------------------------------------------------- |
| macOS (Apple Silicon) | `OpenClaw Session Viewer_<version>_aarch64.dmg`    |
| Linux (便携)          | `OpenClaw Session Viewer_<version>_amd64.AppImage` |
| Linux (Debian/Ubuntu) | `OpenClaw Session Viewer_<version>_amd64.deb`      |
| Windows (MSI)         | `OpenClaw Session Viewer_<version>_x64_en-US.msi`  |
| Windows (NSIS)        | `OpenClaw Session Viewer_<version>_x64-setup.exe`  |

### 校验

每个 release 都附带 `SHA256SUMS.txt`:

```bash
# macOS / Linux
shasum -a 256 -c SHA256SUMS.txt

# Windows (PowerShell)
Get-FileHash .\OpenClaw*.dmg -Algorithm SHA256
```

### Linux AppImage

```bash
chmod +x OpenClaw*.AppImage
./OpenClaw*.AppImage
```

变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## ✨ 功能

### 核心

- 📜 **完整会话转录** — 文本、思考、工具调用、工具结果、图片、附件、压缩事件,所有类型
- 🔍 **三种搜索**:
  - 全局跨会话 (`Cmd/Ctrl+K`) — 跨所有 .jsonl 文件搜索
  - 会话内 (`Cmd/Ctrl+F`) — 当前会话内客户端搜索,`n`/`p` 跳转
  - URL 跳转 (`?line=N`) — 直接定位到任意消息
- ↕️ **排序切换** — 会话详情顶部 `↑ 正序 / ↓ 倒序` 自由切换
- ⚡ **流式加载** — Rust `BufReader` 64KB 缓冲,500 条/批,8MB+ 大文件秒开
- 🟢 **实时状态** — 5 秒轮询 `~/.claude/sessions/<pid>.json`,显示运行中的 CLI 进程
- 📁 **工具溢出文件** — 自动加载 `tool-results/*.txt` 长输出

### 高级

- 🤖 **大模型分析** — 4 个预置模板 + 自定义 Prompt
  - 会话摘要、代码修改提取、错误/陷阱分析
  - 流式响应,实时显示 token 用量
  - 支持任何 Anthropic 兼容 API (MiniMax、自定义代理)
- 📤 **导出** — Markdown + HTML(独立可分享,带暗色主题)
- 🌐 **多源支持** — 同时支持 Claude Code (`~/.claude/`) 和 OpenClaw (`~/.openclaw/`)
- 📂 **自定义数据源** — 在设置页添加任意自定义根目录，自动探测类型，保存即热重载
- 🧩 **扩展设计** — `BlockRegistry` 模式 + `BlockHandler` trait，新 block type 只需实现一个 handler + register
- 🔮 **未知 block 兜底** — 新出现的 block type 自动显示为 `UnknownBlockCard`（字段表 + hint 推断 + 复制/报告）
- 🎨 **主题** — 深色/浅色/跟随系统
- 🌏 **中文界面** — 默认 zh-CN,可选 en-US

### 工程化

- ✅ **单元测试** — Rust 91 个 + TS 41 个 = **132 个测试**
- 🔒 **路径安全** — 所有 Tauri 命令做词法检查,防止 `../../etc/passwd`
- ♻️ **BlockRegistry 模式** — `BlockHandler` trait + 可扩展注册表,符合开闭原则
- 🔮 **未知 block 兜底** — 新出现的 block type 不再崩溃,显示为 `UnknownBlockCard`(字段表 + 启发式 hint + 复制/报告)
- 🚀 **自动更新** — Tauri updater + GitHub Releases
- 📦 **跨平台** — macOS (.dmg) / Windows (.msi) / Linux (.AppImage/.deb)
- 🛠️ **CI/CD** — GitHub Actions 三平台并行构建,docs-only 推送跳过 CI

## 📸 截图

> 待补充:运行 `pnpm tauri dev` 后截图

```
┌─────────────────────────────────────────────────────────────────────┐
│  会话查看器  [🔍 搜索 ⌘K]  [⚙ 设置]                  [- □ ×]        │
├─────────────────────────────────────────────────────────────────────┤
│ 会话 (247)        │ ▸ /Users/alice/projects/website     [● 实时]    │
│ [+ Claude] [+OC]  │ ────────────────────────────────────────────  │
│                    │ Claude Opus 4 · 142 条消息 · 2 天前            │
│ ▼ /Users/alice/…   │ ────────────────────────────────────────────  │
│  ● 重构 header  8MB│                                              │
│  ○ 加深色模式  3MB │ ┌─ 用户 · 14:08:32 ──────────────────────┐   │
│  ● 修页脚 bug   1MB│ │ 能否把 header 重构成 sticky 定位?       │   │
│                    │ └────────────────────────────────────────┘   │
│ 过滤:              │ ┌─ 助手 · 14:08:35 · Opus 4 ─────────────┐   │
│  ☑ 仅 Live         │ │ ▾ 思考 (4 秒)                          │   │
│  ☑ 含子代理        │ │   先看一下 Header 当前的 CSS…          │   │
└─────────────────────────────────────────────────────────────────────┘
```

## 🚀 快速开始

### 前置要求

- **Node.js** ≥ 20
- **pnpm** ≥ 9 (`npm i -g pnpm`)
- **Rust** ≥ 1.77 (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)
- **Tauri 系统依赖**: 见 [跨平台构建指南](docs/CROSS_PLATFORM_BUILD.md)

### 安装与运行

```bash
# 1. 克隆
git clone https://github.com/yourname/openclaw-session-viewer.git
cd openclaw-session-viewer

# 2. 安装依赖 (注意:有些镜像源不稳定,推荐 registry.npmjs.org)
pnpm config set registry https://registry.npmjs.org/
pnpm install

# 3. 开发模式 (热重载 + devtools)
pnpm tauri dev

# 4. 生产构建
pnpm tauri build
```

构建产物:

- **macOS**: `src-tauri/target/release/bundle/macos/OpenClaw Session Viewer.app`
- **DMG**: `src-tauri/target/release/bundle/dmg/*.dmg`
- **Linux AppImage/deb**: `src-tauri/target/release/bundle/{appimage,deb}/*`
- **Windows MSI**: `src-tauri/target/release/bundle/msi/*.msi`

> ℹ️ **为什么是英文文件名?**: Tauri bundler 在 Windows MSI 阶段用 WiX 3.x 的
> `light.exe`,对非 ASCII 文件名支持差
> ([tauri-apps/tauri#8363](https://github.com/tauri-apps/tauri/issues/8363))。
> 所以 `productName` 用 ASCII,只在窗口标题(`app.windows[].title`)
> 保留中文显示。

> ⚠️ **不要** 直接运行 `target/release/openclaw-session-viewer` 裸二进制。macOS 上 Tauri 2 必须在 `.app` bundle 内运行才能正确初始化 webview,否则窗口会出现但内容空白。详见 [故障排除](#-故障排除)。

### 首次使用

1. 启动应用,会话列表自动加载 `~/.claude/projects/` 下的所有会话
2. 点击任意会话卡片查看完整转录
3. 按 `Cmd+K` (macOS) 或 `Ctrl+K` (Windows/Linux) 全局搜索
4. 按 `Cmd+F` 在当前会话内搜索
5. 进入设置页填写 Anthropic API Key 以启用大模型分析

## 🏗 架构

```
┌──────────────────────────────────────────────────────────┐
│                     Frontend (React)                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐     │
│  │Sessions  │ │Session   │ │Analyze   │ │Settings  │     │
│  │Route     │ │Detail    │ │Route     │ │Route     │     │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘     │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Zustand Stores (sessions, transcript, search, …)  │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Tauri IPC: invoke() + listen() events              │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────┬───────────────────────────────┘
                           │ Tauri commands
┌──────────────────────────┴───────────────────────────────┐
│                    Backend (Rust)                         │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Commands (12 个 Tauri commands)                    │ │
│  │  list_sessions / stream_transcript / search_all /  │ │
│  │  analyze_session / export_markdown / …             │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐      │
│  │  JSONL Parser│ │  Anthropic   │ │  Path Safety │      │
│  │  (streaming) │ │  Client (SSE)│ │  (词法校验)  │      │
│  └──────────────┘ └──────────────┘ └──────────────┘      │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Moka mtime 缓存 + Notify 文件监听                  │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│                   Local Filesystem                        │
│  ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl           │
│  ~/.claude/sessions/<pid>.json                           │
│  ~/.openclaw/agents/<id>/sessions/<uuid>.jsonl          │
└──────────────────────────────────────────────────────────┘
```

**关键设计决策**:

1. **Tauri 2 + Rust 后端** — 包小(~5MB)、性能好(8MB JSONL 流式解析 600ms)
2. **共享类型包 (`packages/shared`)** — 前端和后端共用 TypeScript 类型定义
3. **BlockRegistry 模式** — `BlockHandler` trait + 可注册 registry，新增 block type 无需改 match
4. **Moka 缓存 + mtime 失效** — 重复打开会话零延迟
5. **虚拟列表 (`@tanstack/react-virtual`)** — 2 万条记录仍 60fps
6. **路径白名单** — 所有 FS 操作必须落在已知 root 下

详见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)

### 数据格式

OpenClaw / Claude Code 各自的 session 目录布局、JSONL schema、字段语义,以及本应用
如何归一化/过滤,见 [docs/OPENCLAW_SESSION_FORMAT.md](docs/OPENCLAW_SESSION_FORMAT.md)
(从 openclaw 源码 + 官方文档交叉验证)。

## 🛠 开发

### 项目结构

```
.
├── packages/
│   ├── shared/           # 跨进程共享 TypeScript 类型
│   └── frontend/         # React + Vite + TS UI
├── src-tauri/            # Rust 后端 (Tauri 2)
│   ├── src/
│   │   ├── parser/       # 流式 JSONL 解析 + 归一化
│   │   │   ├── blocks/   # BlockRegistry + 独立 handler 文件 (text/thinking/tool_use/…)
│   │   │   ├── claude.rs
│   │   │   └── openclaw.rs
│   │   ├── commands/     # 12 个 Tauri 命令
│   │   ├── llm/          # Anthropic 兼容 API 客户端
│   │   ├── fs/           # 路径解析 + 安全检查
│   │   └── cache/        # Moka mtime 缓存
│   └── icons/            # PNG/ICNS/ICO 图标
├── docs/                 # 项目文档
│   ├── ARCHITECTURE.md
│   ├── PARSER_ARCHITECTURE.md   # BlockRegistry 详解
│   ├── CROSS_PLATFORM_BUILD.md
│   ├── OPENCLAW_SESSION_FORMAT.md
│   ├── RELEASING.md
│   └── TROUBLESHOOTING.md
├── scripts/
│   └── seed-fixture.ts   # 生成测试 JSONL
├── fixtures/             # 测试数据
└── .github/workflows/    # CI/CD
```

### 测试

```bash
# Rust 单元测试 (91 个)
cd src-tauri && cargo test --lib

# TypeScript 单元测试 (41 个)
cd packages/shared && pnpm test

# 类型检查
cd packages/frontend && pnpm exec tsc --noEmit

# Clippy (lint)
cd src-tauri && cargo clippy --all-targets -- -D warnings

# 全部
pnpm -r test
```

### 添加新会话源

假设要支持新的存储格式 (例如 `~/.myagent/sessions/`):

1. 在 `packages/shared/src/` 添加类型定义
2. 在 `src-tauri/src/parser/` 添加归一化函数
3. 在 `src-tauri/src/commands/sessions.rs` 添加扫描逻辑
4. 在 `src-tauri/src/fs/paths.rs` 添加路径布局
5. 在前端 `SessionMeta.source` 加新枚举值

### 大模型分析自定义 Prompt

在 `packages/shared/src/analysis-prompts.ts` 修改模板,或在前端"自定义"模式下输入任意 prompt。

### 快捷键

| 快捷键       | 功能              |
| ------------ | ----------------- |
| `Cmd/Ctrl+K` | 全局跨会话搜索    |
| `Cmd/Ctrl+F` | 当前会话内搜索    |
| `Cmd/Ctrl+E` | 导出当前会话      |
| `Cmd/Ctrl+,` | 设置              |
| `n` / `p`    | 搜索结果下一/上一 |
| `Esc`        | 关闭弹窗          |

## 🔧 故障排除

<details>
<summary><b>macOS: 启动后窗口是空白</b></summary>

**原因**: 直接运行了 `target/release/openclaw-session-viewer` 裸二进制,而非 `.app` bundle。

**解决**:

```bash
# ✅ 正确:
open "src-tauri/target/release/bundle/macos/OpenClaw 会话查看器.app"

# ❌ 错误:
./src-tauri/target/release/openclaw-session-viewer
```

Tauri 2 在 macOS 上必须从 `.app` bundle 启动,LaunchServices 才能正确初始化 webview 子进程。否则窗口出现但 `WebContent.xpc` 不派生,看不到内容。

</details>

<details>
<summary><b>macOS: 从 GitHub Releases 下载的 DMG 提示"已损坏,无法打开"</b></summary>

**原因**: CI 构建的 DMG 没有 Apple 开发者签名,未经公证的应用被 Gatekeeper 拦截。

**临时解决**:

```bash
# 将 App 拖到 Applications 文件夹后,终端执行:
sudo xattr -rd com.apple.quarantine /Applications/OpenClaw\ Session\ Viewer.app
```

或者右键 App → 打开 → 对话框中点「打开」。

> 后续会接入 Apple 开发者签名 + 公证流程,届时不再有此提示。

</details>

<details>
<summary><b>搜索点击后程序崩溃</b></summary>

**原因**: `useSearchInSessionStore()` 返回整个 store 对象,作为 `useEffect` 的依赖会导致:

```
store 引用变化 → useEffect 重跑 → 调用 search() 更新 store → 引用再变 → 死循环
→ React: Maximum update depth exceeded → 组件卸载
```

**解决**: 用 selector 模式分别订阅:

```tsx
// ❌ 错
const search = useSearchInSessionStore();
useEffect(() => {
  search.search(entries);
}, [entries, search]);

// ✅ 对
const search = useSearchInSessionStore((s) => s.search);
useEffect(() => {
  search(entries);
}, [entries]);
```

</details>

<details>
<summary><b>大文件加载慢 / 卡顿</b></summary>

8MB+ JSONL 首次打开需要 ~600ms 解析。已做流式分批 (500 条/批),前端用虚拟列表。如果仍然慢:

- 检查是否启用了 moka 缓存(默认开启)
- 关闭其他读取 `~/.claude/` 的程序

</details>

<details>
<summary><b>大模型分析报 401/403</b></summary>

API Key 错误或 Base URL 不对。在设置页检查:

- **Base URL**: 默认 `https://api.anthropic.com`,用 MiniMax 则改为 `https://api.minimaxi.com/anthropic`
- **API Key**: 填 `sk-ant-...` 或对应平台的密钥

</details>

<details>
<summary><b>路径穿越攻击防护</b></summary>

所有 Tauri 命令的路径参数都做词法检查,必须在 `~/.claude/` 或 `~/.openclaw/` 下。如果看到 `PathSecurity` 错误,说明传入了非法路径。

</details>

更多问题及解决方案见 [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

## 🗺 路线图

### 已完成 (v0.1.0 → v0.3.1)

- [x] 基础会话列表 + 转录查看
- [x] 全局/会话内搜索
- [x] 大模型分析 (4 模板 + 自定义)
- [x] Markdown/HTML 导出
- [x] OpenClaw 存储支持 (含 trajectory 过滤)
- [x] 实时 PID 状态
- [x] 多 Agent UI 二级分组 (v0.2.4)
- [x] 自定义数据源根目录 + 热重载 (v0.2.5)
- [x] Windows [object Object] 修复 (v0.2.6)
- [x] BlockRegistry 模式重构 + UnknownBlockCard (v0.3.0)
- [x] 会话详情排序切换 (v0.3.1)
- [x] 3 个新 BlockHandler: `pr-link` / `agent-name` / `task_reminder` (v0.3.2)
- [x] 单元测试 (132 个)
- [x] 跨平台 CI (macOS/Windows/Linux)
- [x] docs-only 推送跳过 CI (paths-ignore)

### 计划中 (v0.4.0+)

- [ ] **会话对比** — diff 两个会话的工具调用差异
- [ ] **拖拽导入** — 拖入 JSONL 文件直接打开
- [ ] **VS Code 集成** — 点击路径跳转到编辑器
- [ ] **OpenClaw trajectory 查看** — 复用现有 pointer 文件
- [ ] **OpenAI ChatCompletion 兼容** — 大模型后端多支持
- [ ] **i18n 完善** — 英文/日文界面

## 🤝 贡献

欢迎 PR! 一些建议:

1. 添加新功能前先开 issue 讨论
2. 保持单元测试覆盖
3. 遵循现有代码风格(rustfmt + prettier)
4. 提交前跑 `pnpm -r test && pnpm typecheck`
5. **docs-only 提交**会自动跳过 CI;如果同时改代码 + docs,CI 正常跑(看路径规则)

## 📚 文档索引

| 文档                                                          | 用途                                        |
| ------------------------------------------------------------- | ------------------------------------------- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md)                       | 总体架构、数据流、性能基准、安全模型        |
| [PARSER_ARCHITECTURE.md](docs/PARSER_ARCHITECTURE.md)         | BlockRegistry + BlockHandler 设计、扩展指南 |
| [CROSS_PLATFORM_BUILD.md](docs/CROSS_PLATFORM_BUILD.md)       | macOS / Windows / Linux 构建、签名、公证    |
| [OPENCLAW_SESSION_FORMAT.md](docs/OPENCLAW_SESSION_FORMAT.md) | OpenClaw JSONL schema,trajectory 文件机制   |
| [RELEASING.md](docs/RELEASING.md)                             | 维护者发版流程,故障恢复                     |
| [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)                 | 已修过的 bug 与开发经验                     |
| [CHANGELOG.md](CHANGELOG.md)                                  | 各版本变更记录                              |

## 📄 许可证

[MIT](LICENSE)

## 🙏 致谢

- [Tauri](https://tauri.app/) — 出色的跨平台桌面框架
- [OpenClaw](https://github.com/openclaw/openclaw) — 启发了本项目
- [Claude Code](https://claude.com/code) — JSONL schema 的事实标准
- [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) — OpenClaw 会话格式参考

---

<div align="center">

如果这个项目对你有帮助,给个 ⭐ !

</div>
