# experiment/embed-db/web — 历史 Vite 原型

> **状态(2026-07-04)**: M1 + M2 已合并到主项目 `packages/frontend/`(G1/G2/G3 跑在 `/graph?view=...`)。本目录保留作双源对照,M3 完成后 `git rm`。

## 跑起来

```bash
cd experiment/embed-db/web
pnpm install && pnpm dev    # 端口 4173

# 数据(35 sessions ~90KB)
cargo run --manifest-path experiment/embed-db/Cargo.toml -- ingest \
  --out experiment/embed-db/web/public/sessions.ndjson
```

| 环境             | 端口 | 入口                                |
| ---------------- | ---- | ----------------------------------- |
| 主项目(生产路径) | 1420 | `/graph?view=graph\|analytics\|rag` |
| 本实验 web       | 4173 | tabs 切 view                        |

详见 [docs/experiments/README.md](../../docs/experiments/README.md)。
