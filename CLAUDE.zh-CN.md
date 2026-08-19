# openclaw-session-viewer(中文)

跨平台桌面应用(Tauri 2 + React 19 + Zustand),让用户浏览本地的 OpenClaw、Claude Code、Kimi AI 会话 JSONL 文件。JSONL 流在 Rust 端解析,batch collapse 成 normalized messages,然后流式传给 React 前端做 transcript 渲染(virtualized list + 按 meta kind 的 chart 系列)。

- GitHub:`nemo1991/openclaw-session-viewer`
- pnpm workspace:`packages/frontend`、`packages/shared`、`src-tauri`
- 技术栈:Rust 2021 + Tauri 2 + React 19 + TypeScript + Zustand + Vite + vitest

## 常用命令

- `pnpm dev` — 前端 dev server(Vite)
- `pnpm dev:tauri` — 全应用 dev 模式(Tauri + Vite)
- `pnpm build` — 构建 shared + frontend
- `pnpm build:tauri` — 完整 Tauri release 构建
- `pnpm test` — 跑全部测试(vitest frontend + cargo test backend)
- `pnpm typecheck` — workspace 范围 `tsc --noEmit`
- `pnpm lint` — workspace lint
- `pnpm format` — prettier(TS/TSX/CSS/MD)
- `pnpm format:rust` — cargo fmt

## 代码约定

- 匹配周围代码的注释密度、命名和风格。
- 代码引用用 `file_path:line_number` 格式 — 可点击。
- Rust snake_case 字段 + `serde(rename_all = "camelCase")` 兼容 JSON。前端用 `get()` helper 同时读 snake_case 后端或 camelCase pre-rename payload。
- 用 `pnpm --filter @ocsv/<package>` 限定命令到单个 package。
- Lint-staged prettier 会在 commit 前重新格式化文件,预期会被改写。
- 不要 `git add` 生成的文件;看 `.gitignore`。
- 长 builder 函数加 `#[allow(clippy::too_many_lines)]`,而不是人为拆分。

## Agent skills

### Issue 跟踪器

GitHub Issues 通过 `gh` CLI(仓库 `nemo1991/openclaw-session-viewer`)。远程别名是 `openclaw-session-lookup`,不是 `origin` — 通过 `git push openclaw-session-lookup <branch>` 推送。见 `docs/agents/issue-tracker.md`。

### Triage 标签

默认规范 5 标签:`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`。见 `docs/agents/triage-labels.md`。

### 领域文档

Multi-context 布局 — 根 `CONTEXT-MAP.md` 指向每个 context 的 `CONTEXT.md`(frontend / shared / src-tauri)。见 `docs/agents/domain.md`。
