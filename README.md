<div align="center">

# OpenClaw Session Viewer

**跨平台桌面应用，本地浏览 Claude Code / OpenClaw / Kimi Code / DeepSeek Harness 的会话转录**

[![Tauri](https://img.shields.io/badge/Tauri-2-blue?logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61dafb?logo=react)](https://react.dev)
[![Rust](https://img.shields.io/badge/Rust-2021-orange?logo=rust)](https://www.rust-lang.org)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)]()
[![Release](https://img.shields.io/github/v/release/nemo1991/openclaw-session-viewer)](https://github.com/nemo1991/openclaw-session-viewer/releases/latest)

[下载](#下载) · [快速开始](#快速开始) · [架构](#架构) · [开发](#开发) · [故障排除](#故障排除) · [文档索引](#文档索引)

</div>

---

## 支持的源

| Source               | 路径                                                          | 格式       | 自      |
| -------------------- | ------------------------------------------------------------- | ---------- | ------- |
| **Claude Code**      | `~/.claude/projects/<encoded>/<sid>.jsonl`                    | jsonl      | v0.1    |
| **OpenClaw**         | `~/.openclaw/agents/<id>/sessions/<sid>.jsonl`                | jsonl      | v0.2    |
| **Kimi Code**        | `~/.kimi-code/sessions/wd_*/session_*/agents/main/wire.jsonl` | jsonl      | v0.9.0  |
| **DeepSeek Harness** | `~/.dsh/sessions/<project>/session-<uuid>/session.jsonl.zstd` | zstd jsonl | v0.9.28 |

更多格式细节见 [docs/OPENCLAW_SESSION_FORMAT.md](docs/OPENCLAW_SESSION_FORMAT.md) + [src-tauri/docs/adr/0002-dsh-source-m11.md](src-tauri/docs/adr/0002-dsh-source-m11.md)。

---

## DeepSeek Harness 支持 (v0.9.28+)

dsh 是第 4 种支持的 wire 源,有几个独特之处:

**`.jsonl.zstd` 透明解压** — 所有 dsh 文件用 zstd 压缩存储,本应用通过扩展名派发:

```rust
// parser/jsonl.rs
pub fn for_each_line_auto(path, cb) {
    if path.extension() == "zstd" {
        for_each_line_zst(path, cb)  // 走 zstd::Decoder 透明解压
    } else {
        for_each_line(path, cb)      // 原 jsonl 路径不变
    }
}
```

Claude / OpenClaw / Kimi 走非 zstd 分支,零侵入。

**Envelope 形 wire 事件** — 每条事件 `{type, seq, time, data}`:

- `user/message` → `role: user`, text blocks
- `assistant/message` → `role: assistant`, reasoning / text / tool-call 混合 blocks
- `tool/result` → `role: tool`, `is_error` 标记
- `session` / `session/title` / `permission/preset` / `sandbox/mode` / `approval/policy` / `todo/write` → meta block
- **流式 chunk** (`assistant/chunk` / `reasoning-chunks` / `text-chunks` / `tool-call-chunks`) → 返回 `None`,被终态 `assistant/message` 覆盖避免双计
- **协议层 noise** (`step/start` / `step/end` / `turn/start` / `tool/call` / `llm/retry` 等) → 返回 `None`,避免 9337 行 session 详情页被 541 个 noise meta pill 主导 (v0.9.28 M11.4)

**聚合 MetaBanner** (v0.9.28 M11.3+) — 顶部折叠面板汇总:

- `protocol_version` (从 `session.version`)
- `permission_mode` / `sandbox_mode` / `approval_policy` (从同名 event,M11.5 修复 sandbox 覆盖 permission 的 bug)
- `model_alias` / `thinking_effort` / `active_tool_count` (从 `request/header.config`)
- `approval_count` / `compaction_count`

**项目目录名** — dsh 用 `--Users-foo-bar--` 包裹形式,存储时透明保留为 `dsh:<dir-name>`,显示时 strip brackets delegate decode (跟 Claude 编码算法相同)。

详细架构决策见 [ADR 0002](src-tauri/docs/adr/0002-dsh-source-m11.md)。

---

## 下载

从 [Releases 页面](https://github.com/nemo1991/openclaw-session-viewer/releases/latest) 下载:

- **macOS** — `OpenClaw Session Viewer_<version>_aarch64.dmg` (Apple Silicon) / `_x64.dmg` (Intel)
- **Linux** — `_<version>_amd64.AppImage` (便携) / `_amd64.deb` (Debian/Ubuntu)
- **Windows** — `_<version>_x64_en-US.msi` (MSI) / `_x64-setup.exe` (NSIS)

每个 release 附带 `SHA256SUMS.txt`,用 `shasum -a 256 -c` 校验。

---

## 快速开始

**前置**:Node ≥ 20 · pnpm ≥ 9 · Rust ≥ 1.77 · [Tauri 系统依赖](docs/CROSS_PLATFORM_BUILD.md)

```bash
git clone https://github.com/nemo1991/openclaw-session-viewer.git
cd openclaw-session-viewer
pnpm install
pnpm tauri dev      # 开发模式
pnpm tauri build    # 生产构建
```

详细多平台构建说明见 [docs/CROSS_PLATFORM_BUILD.md](docs/CROSS_PLATFORM_BUILD.md)。

---

## 架构

**Tauri 2 + Rust 后端** (流式 JSONL 解析 + SQLite 聚合) + **React 19 + Zustand 前端** (虚拟列表 + TanStack Router)。

关键设计:

- **3 个 workspace 包** — `packages/shared` (跨进程类型) · `packages/frontend` (UI) · `src-tauri` (Rust)
- **扩展名派发 reader** — `.jsonl` vs `.jsonl.zstd` 走不同解析器,单一 dispatch 入口
- **BlockRegistry 模式** — `BlockHandler` trait + 可注册 registry,新增 block type 无需改 match,未知 block 走 `UnknownBlockCard` 兜底
- **Pass 1 单次 sync** (v0.9.27+) — `build_*_session_meta` 直接 47 列 INSERT,删了旧的两阶段 enrich loop
- **Moka mtime 缓存** — 重复打开会话零延迟;`sync_one_file` 三元组 (size+mtime+line_count) 缓存跳过未变化文件;**stale banner 检测** (v0.9.28 M11.5) 让 M11 之前 sync 的 dsh/kimi session 自动重跑 aggregator
- **路径白名单** — 所有 FS 操作必须落在已知 source root (`~/.claude/` / `~/.openclaw/` / `~/.kimi-code/` / `~/.dsh/`) 下

完整架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) + [docs/PARSER_ARCHITECTURE.md](docs/PARSER_ARCHITECTURE.md)。

---

## 开发

### 项目结构

```
.
├── packages/
│   ├── shared/           # 跨进程共享 TypeScript 类型
│   └── frontend/         # React + Vite + TS UI
├── src-tauri/            # Rust 后端 (Tauri 2)
│   ├── src/parser/       # 流式 JSONL 解析 + 归一化
│   │   ├── claude.rs / openclaw.rs / kimi.rs / dsh.rs / meta_aggregator.rs
│   │   └── blocks/       # BlockRegistry + 独立 handler
│   ├── src/commands/     # Tauri commands (sessions / transcript / analyze / export / graph / subagents)
│   ├── src/db/           # SQLite schema + migrations + sync
│   └── docs/adr/         # 架构决策记录
├── docs/                 # 项目文档
├── fixtures/             # 测试数据 (claude / openclaw / kimi / dsh)
└── .github/workflows/    # CI/CD (3 平台并行, docs-only 跳过)
```

### 测试

```bash
# Rust 单元测试
cd src-tauri && cargo test --lib

# TypeScript 单元测试
pnpm -r test

# 类型检查 + Lint
pnpm typecheck
cd src-tauri && cargo clippy --lib -- -D warnings && cargo fmt --check
```

当前测试覆盖:390 Rust + ~50 shared + 689 frontend = **1129+ tests**。

### 添加新会话源

以 dsh 为参考 (canonical example):

1. **`packages/shared/src/normalize.ts`** — `SessionSource` union 加 `"dsh"`
2. **`src-tauri/src/parser/`** — 新建 `dsh.rs` 写 `normalize_dsh_record(record, idx) -> Option<NormalizedMessage>`,返回 `None` 过滤流式 chunk / 协议层 noise
3. **`src-tauri/src/parser/meta_aggregator.rs`** — 新增 `aggregate_dsh(path)`,写到 `MetaExtras.{error_count, thinking_count, meta_banner, todo_summary, kimi_token_usage}`
4. **`src-tauri/src/commands/sessions.rs`** — `build_dsh_session_meta(ds)` 装配 SessionMeta(quick path 50 行 head + full aggregator)
5. **`src-tauri/src/fs/{paths,walker,source}.rs`** — 路径发现 + 遍历
6. **`src-tauri/src/db/{schema,migrations,sync}.rs`** — `source` CHECK 加新值 + sync loop 加新分支
7. **`packages/frontend/src/{state, routes, i18n}/`** — filter chip + source badge + i18n label
8. **`docs/adr/000N-<name>.md`** — 记录架构决策

详细 M11 拆分参考 [src-tauri/docs/adr/0002-dsh-source-m11.md](src-tauri/docs/adr/0002-dsh-source-m11.md)。

### 快捷键

| 快捷键       | 功能           |
| ------------ | -------------- |
| `Cmd/Ctrl+K` | 全局跨会话搜索 |
| `Cmd/Ctrl+F` | 当前会话内搜索 |
| `Cmd/Ctrl+E` | 导出当前会话   |
| `Cmd/Ctrl+,` | 设置           |

---

## 故障排除

**macOS 窗口空白** — 必须从 `.app` bundle 启动,不能直接跑裸二进制:

```bash
open "src-tauri/target/release/bundle/macos/OpenClaw Session Viewer.app"
```

**macOS DMG 提示"已损坏"** — 没 Apple 开发者签名被 Gatekeeper 拦截:

```bash
sudo xattr -rd com.apple.quarantine /Applications/OpenClaw\ Session\ Viewer.app
```

**dsh session banner 没显示新字段** (sandbox / approval policy) — 旧 DB 行 `meta_banner_json` 是 NULL,但 sync 缓存 (`size+mtime+line_count`) 不会变,所以新 aggregator 不会跑。修复见 [v0.9.28 M11.5 commit](src-tauri/src/db/sync.rs): `is_meta_banner_null_by_path` 检测 stale 行,自动触发 re-sync。

更多问题见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

---

## 路线图

5 行 release timeline:

- **v0.9.28** — DeepSeek Harness 第 4 种 source (zstd 透明解压) + M11.3 banner 聚合 + M11.4 noise filter + M11.5 sandbox/approval routing 修复
- **v0.9.27** — M10 Pass 2→Pass 1 单 pass 切流 (47 列 INSERT)
- **v0.9.26** — M9 Pass 1↔Pass 2 parallel-run validation
- **v0.9.25** — snake/camel 第二阶段撤兼容
- **v0.9.24** — `SessionHeader` + `SessionNotesPanel` + `useSessionActions` 抽离

完整版本历史: [CHANGELOG.md](CHANGELOG.md)

v0.9.29+ backlog:dsh `parent_uuid` (等 dsh schema 加字段) · dsh subagent walk · `kimi_token_usage` rename → `session_token_usage` · dsh streaming-chunk 可视化 · OpenAI ChatCompletion 兼容 LLM 后端 · i18n (en-US / ja-JP)。

---

## 文档索引

**架构** — [ARCHITECTURE](docs/ARCHITECTURE.md) · [PARSER_ARCHITECTURE](docs/PARSER_ARCHITECTURE.md) · [OPENCLAW_SESSION_FORMAT](docs/OPENCLAW_SESSION_FORMAT.md)

**ADR** — [0001 Claude batch normalize](src-tauri/docs/adr/0001-claude-batch-normalize-v0917.md) · [0002 dsh source M11](src-tauri/docs/adr/0002-dsh-source-m11.md)

**工程** — [RELEASING](docs/RELEASING.md) · [CROSS_PLATFORM_BUILD](docs/CROSS_PLATFORM_BUILD.md) · [SECURITY](docs/SECURITY.md) · [E2E_TESTING](docs/E2E_TESTING.md) · [TROUBLESHOOTING](docs/TROUBLESHOOTING.md)

**Graph Explorer 实验** ([docs/experiments/](docs/experiments/)) — [README](docs/experiments/README.md) · [G1 graph](docs/experiments/embed-db-G1-graph-findings.md) · [G2 OLAP](docs/experiments/embed-db-G2-olap-findings.md) · [G3 RAG](docs/experiments/embed-db-G3-rag-findings.md)

**变更** — [CHANGELOG.md](CHANGELOG.md)

---

## 许可证

[MIT](LICENSE)

## 致谢

[Tauri](https://tauri.app/) · [OpenClaw](https://github.com/openclaw/openclaw) · [Claude Code](https://claude.com/code) · [Kimi Code](https://kimi.moonshot.cn/) · [DeepSeek Harness](https://github.com/deepseek-ai) · [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent)

---

<div align="center">

如果这个项目对你有帮助,给个 ⭐ !

</div>
