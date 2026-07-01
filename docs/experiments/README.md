# 嵌入式数据库探索实验

> **位置**: `experiment/embed-db/`
> **分支**: `experimental/embed-db` (基于 `feature/subagent-parent-link`)
> **目标**: 探索 3 个 PoC 方向,看哪个真正契合「跨 session 关联大模型执行思路」的产品愿景

---

## 三个 PoC

| PoC          | 方向                       | DB 选型                      | 前端                   | Sprint | findings                                                       |
| ------------ | -------------------------- | ---------------------------- | ---------------------- | ------ | -------------------------------------------------------------- |
| **G1 Graph** | 图遍历(子代理调用链可视化) | surrealdb (embedded RocksDB) | react-force-graph      | S1     | [embed-db-G1-graph-findings.md](embed-db-G1-graph-findings.md) |
| **G2 OLAP**  | SQL 跨维度聚合             | duckdb-rs (列存)             | recharts + react-table | S2     | [embed-db-G2-olap-findings.md](embed-db-G2-olap-findings.md)   |
| **G3 RAG**   | 自然语言对话式分析         | sqlite-vec + sqlite-fts5     | 聊天 UI                | S3     | [embed-db-G3-rag-findings.md](embed-db-G3-rag-findings.md)     |

每个 PoC 一个章节跟踪 demo / 决策点。

---

## 节奏

| Sprint        | 目标                     | Demo                                                   | Findings                                           |
| ------------- | ------------------------ | ------------------------------------------------------ | -------------------------------------------------- |
| **S0** (本周) | branch + ingest skeleton | `cargo run -- ingest --out stdout` 输出 node/edge JSON | [embed-db-S0-findings.md](embed-db-S0-findings.md) |
| **S1**        | G1 Graph view            | Web graph view + 1 示例 Cypher                         | G1 findings                                        |
| **S2**        | G2 OLAP                  | Analytics 视图 + 6 chart                               | G2 findings                                        |
| **S3**        | G3 RAG                   | Search 模式扩展 + LLM 流式                             | G3 findings                                        |
| **S4**        | 决策                     | `embed-db-findings.md` 综合 + 推荐结论                 | 总 findings                                        |

---

## 共享基础

**复用 main 已有代码** (路径引用,不复制):

- `src-tauri/src/parser/claude.rs::normalize_record` — Claude JSONL → `NormalizedMessage`
- `src-tauri/src/parser/openclaw.rs::normalize_entry` — OpenClaw JSONL → `NormalizedMessage`
- `src-tauri/src/fs/walker.rs::list_jsonl_files` — 扫目录
- `src-tauri/src/commands/sessions.rs::build_*_session_meta` — 生成 SessionMeta

**ingest 子 crate** 把这些函数再输出成可独立跑的 CLI,只换 sink。

**数据来源**: 用户本地的 `~/.claude/projects/**.jsonl` + `~/.openclaw/agents/**/sessions/*.jsonl`。

---

## 同步策略

- **定期 rebase main**: main 上有 commit 后,`git rebase feature/subagent-parent-link`
- **不并回 main**: 本分支是平行实验,不污染主产品
- **不绑 main CI**: 本分支不跑 `.github/workflows/release.yml`

---

## 不在范围

- 不做生产级 observability / metrics / 健康检查
- 不做 schema migration versioning(实验坏了 `rm -rf ~/.cache/openclaw-experiment/*` 重 ingest)
- 不做 mobile / iOS / Android
- 不动 `src-tauri/src/commands/**` 与 `packages/frontend/src/**`

---

## 何时收口

三个信号:

1. **3 个 PoC 全部跑通** → 写总 findings + 推荐决策
2. **某个 PoC 跑不通且不可救** → 直接弃用
3. **用户对某条路径特别有热情** → 调整 sprint 重心

详见 plan 文件 (root): [openclaw-session-session-session-transient-kernighan.md](../../openclaw-session-session-session-transient-kernighan.md)
