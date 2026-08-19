# CONTEXT-MAP(中文)

仓库根目录的指针,指向每个 context 的 `CONTEXT.md`。Skill 应该按主题读相关的 context。

## Contexts

- **`packages/frontend`** — React 19 + Zustand + Tauri webview 前端。会话浏览 UI、transcript 渲染、virtualized message 列表、MetaBlock chart 系列。见 `packages/frontend/CONTEXT.md`。
- **`packages/shared`** — 跨 package 的 TypeScript 类型 + Zod schema。Tauri command 的 wire 类型(`NormalizedMessage`、`NormalizedBlock` 等)。见 `packages/shared/CONTEXT.md`。
- **`src-tauri`** — Rust 后端(Tauri 2,无 axum)。三种 wire 格式(`claude`、`kimi`、`openclaw`)的 parser,session metadata builder,transcript 流式,DB 层(计划中),暴露给 webview 的 commands。见 `src-tauri/CONTEXT.md`。

## 系统级决策

`docs/adr/` 持有跨多个 context 的决策(release 流程、monorepo 布局、CI 等)。Context 内的 ADR 在 `src/<context>/docs/adr/` 下(例如 parser 层决策放 `src-tauri/docs/adr/`)。
