# Graph Explorer 实验记录

> **位置**: `experiment/embed-db/` (原型) + `packages/frontend/src/views/graph/` (合并后)
> **分支**: `experimental/embed-db` (基于 `feature/subagent-parent-link`)
> **目标**: 跨 session 关联大模型执行思路

---

## 状态 (M2 收口, 2026-07-04)

3 个 PoC 合并到主项目,挂 `/graph` 顶 tab 下:

| PoC          | 入口                      | 合并 commit |
| ------------ | ------------------------- | ----------- |
| G1 Graph     | `/graph?view=graph`       | `bc24a08`   |
| G2 Analytics | `/graph?view=analytics`   | `683e61d`   |
| G3 RAG       | `/graph?view=rag[&q=...]` | `683e61d`   |

详细状态 + 时间线 + 架构图 + 实现规模见 [embed-db-findings.md](./embed-db-findings.md) (这是 M2 完成态的权威摘要)。

3 个 PoC 详细推进过程在各 findings 文件:

- [S0 skeleton](embed-db-S0-findings.md)
- [S1-S6 G1](embed-db-G1-graph-findings.md) — G1 胜出原因 + 节点配色规则 + 限制
- [S2 G2](embed-db-G2-olap-findings.md) — 6 chart 选型 + recharts vs visx
- [S3 G3](embed-db-G3-rag-findings.md) — hash embedding vs 真 embedding 边界

M3 TODO(切 Tauri 源 + 删 experiment/)见 [CHANGELOG.md](../../CHANGELOG.md) `[Unreleased].### 待办 (M3)` + 实施详情见 plan 文件 `/Users/forcetone/.claude/plans/openclaw-session-session-session-transient-kernighan.md`。

---

## 数据来源

用户本地的 `~/.claude/projects/**.jsonl` + `~/.openclaw/agents/**/sessions/*.jsonl`。

复用主项目已有的 Rust 解析层:`src-tauri/src/parser/{claude,openclaw}.rs` + `src-tauri/src/commands/sessions.rs::build_*_session_meta`。实验分支独立 `experiment/embed-db/ingest/` 子 crate 用同样逻辑,但额外输出 `Edges` 和 RAG snippets。

---

## 双源对照

| 环境             | 端口 | 入口              | 用途                    |
| ---------------- | ---- | ----------------- | ----------------------- |
| 主项目           | 1420 | `/graph?view=...` | 生产路径,M1+M2 已 ship  |
| 实验 web (M1 前) | 4173 | tabs 切 view      | 历史原型,M3 后 `git rm` |

跑实验 web: `cd experiment/embed-db/web && pnpm install && pnpm dev`(数据生成: `cargo run --manifest-path experiment/embed-db/Cargo.toml -- ingest --out experiment/embed-db/web/public/sessions.ndjson`,然后拷到 `packages/frontend/public/sessions.ndjson`)。

---

## 同步策略

- 在 `experimental/embed-db` 分支迭代,跟 `feature/subagent-parent-link` 保持 rebasable
- M3 完成后,用户决定是否合并到 `main`

---

## 不在范围

- 不动 `src-tauri/src/commands/sessions.rs` 的 `list_sessions` 路径
- 不上真 LLM(hash-embedding lite 够 demo)
- Graph 与 Detail 共存靠独立 `graphStore`,不动 `sessionsStore.ts`
