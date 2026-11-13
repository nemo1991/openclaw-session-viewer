# CONTEXT-MAP(中文)

仓库根目录的指针,指向每个 context 的 `CONTEXT.md`。Skill 应该按主题读相关的 context。

## Contexts

- **`packages/frontend`** — React 19 + Zustand + Tauri webview 前端。会话浏览 UI、transcript 渲染、virtualized message 列表、MetaBlock chart 系列。见 `packages/frontend/CONTEXT.md`。
- **`packages/shared`** — 跨 package 的 TypeScript 类型。Tauri command 的 wire 类型(`NormalizedMessage`、`NormalizedBlock` 等)。见 `packages/shared/CONTEXT.md`。
- **`src-tauri`** — Rust 后端(Tauri 2,无 axum)。四种 wire 格式(`claude`、`openclaw`、`kimi`、`dsh`)的 parser,session metadata builder,transcript 流式,嵌入式 SQLite 层,暴露给 webview 的 commands。见 `src-tauri/CONTEXT.md`。

## 系统级决策

架构决策以 ADR 形式记录在各 context 的 `docs/adr/` 下:`src-tauri/docs/adr/`(parser / 后端)、`packages/frontend/docs/adr/`(meta 层 / UI)、`packages/shared/docs/adr/`(类型 / source union)。跨切面的主题(release、monorepo、CI)写在 `docs/` 而非集中 ADR 索引。
