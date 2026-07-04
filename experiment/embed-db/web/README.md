# experiment/embed-db/web — 历史 Vite 原型

> **状态(2026-07-04)**: M1 + M2 已合并完成。G1/G2/G3 现在跑在主项目 `packages/frontend/` 的 `/graph?view=...` 顶 tab 下(端口 1420)。本目录保留作**双源对照** —— 仍可跑作历史参考,M3 完成时 `git rm`。

## 跑起来

```bash
cd experiment/embed-db/web
pnpm install
pnpm dev   # 端口 4173
```

## 数据

需要 `public/sessions.ndjson`,从 ingest crate 生成:

```bash
cargo run --manifest-path experiment/embed-db/Cargo.toml -- ingest --out experiment/embed-db/web/public/sessions.ndjson
```

## 端口对照

| 环境             | 端口 | 入口                                |
| ---------------- | ---- | ----------------------------------- |
| 主项目(生产路径) | 1420 | `/graph?view=graph\|analytics\|rag` |
| 本实验 web(历史) | 4173 | tabs 切 view                        |

## 已迁入主项目

| 实验 web                                           | 主项目                                                          |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `src/App.tsx`                                      | `packages/frontend/src/routes/GraphExplorerRoute.tsx`           |
| `src/views/GraphView.tsx`                          | `packages/frontend/src/views/graph/GraphView.tsx`               |
| `src/views/GraphDetailPanel.tsx`                   | `packages/frontend/src/views/graph/GraphDetailPanel.tsx`        |
| `src/views/AnalyticsView.tsx`                      | `packages/frontend/src/views/graph/AnalyticsView.tsx`           |
| `src/views/RagChat.tsx`                            | `packages/frontend/src/views/graph/RagChat.tsx`                 |
| `src/loader.ts / title.ts / analytics.ts / rag.ts` | `packages/frontend/src/views/graph/` 同名                       |
| `src/titleStore.tsx`                               | `packages/frontend/src/views/graph/titleStore.ts`(zustand 改造) |
| `src/graph-types.ts / types.ts`                    | `packages/frontend/src/views/graph/` 同名                       |

详见 [docs/experiments/README.md](../../docs/experiments/README.md) + [CHANGELOG.md](../../CHANGELOG.md) 的 [Unreleased] 段。
