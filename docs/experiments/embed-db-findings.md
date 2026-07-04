# Graph Explorer 推进总结 (M2 收口态)

**日期**: 2026-07-04 (覆盖原 S4 文,保留 S0-S3 历史数据)
**分支**: `experimental/embed-db` (基于 `feature/subagent-parent-link`)
**状态**: 3 个 PoC 全部跑通且合并到主项目 (M1 + M2 完成)

> 历史内容(S0-S3 推进数据 + 决策依据)保留在本文件后半段,作"为什么这样选"的可追溯参考。**当前权威状态看 [docs/experiments/README.md](./README.md)** + [CHANGELOG.md](../../CHANGELOG.md) [Unreleased] 段。

---

## TL;DR — 完成态

| PoC          | 状态          | 合并 commit | 入口                      | 数据源 (M1/M2 → M3)                                    |
| ------------ | ------------- | ----------- | ------------------------- | ------------------------------------------------------ |
| G1 Graph     | 主项目已 ship | `bc24a08`   | `/graph?view=graph`       | fetch `/sessions.ndjson` → Tauri invoke `list_graph()` |
| G2 Analytics | 主项目已 ship | `683e61d`   | `/graph?view=analytics`   | (同上 — `graphStore` 三 view 共享)                     |
| G3 RAG       | 主项目已 ship | `683e61d`   | `/graph?view=rag[&q=...]` | (同上)                                                 |

**关键决策(2026-07-01 起的总览)**:

1. **升主线,合并 G1/G2/G3 进主项目 `packages/frontend/`** 而非新建独立 binary — 用户原话"实验特性只要分支分开,但与主线运行环境一支就好"
2. **不引入嵌入式图数据库** — 35 sessions × ~2KB ≈ 70KB 总内存,9ms 索引 / < 1ms 查询,DB 集成成本超过收益
3. **数据源短期双源**(fetch + experiment web),M3 切 Tauri invoke — 中途不破坏任一边
4. **子代理也能跳自己的详情页** — 复用 `SubagentPanel.tsx:79-110` 模板,`?path=` 持久化兜底

---

## 完成时间线 (M1 + M2)

| 日期       | commit                 | 阶段   | 关键变更                                                                                                                         |
| ---------- | ---------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-22 | (S0 起)                | 0      | branch + `experiment/embed-db/ingest/` 子 crate skeleton;NDJSON sink;SessionNode schema                                          |
| 2026-06-26 | (S1-G1)                | 1      | G1 force-directed 图渲染(60+ 节点:35 main + 25 subagent);`react-force-graph-2d` + d3-force                                       |
| 2026-06-28 | (S1.5 G1 补强)         | 2      | 节点半径 ∝ token / 角色配色 / 钻取模式 / 详情面板 / `display_title` 跨视图                                                       |
| 2026-06-28 | (S2-G2)                | 3      | G2 6 chart + 时间范围;recharts 引入;`analytics.ts` 6 个纯函数                                                                    |
| 2026-06-29 | (S3-G3)                | 4      | G3 hash-embedding lite (32-dim) + cosine topK + matched-tokens 高亮 + 预设 query                                                 |
| 2026-07-01 | (S4 收口)              | 5      | 本文件原版 writes:"3 PoC 全部跑通,建议 G1 升 main"                                                                               |
| 2026-07-02 | (S6 子节点 ts bug fix) | 6      | subagent 节点 `first_timestamp_ms` 真实化(`agent_id` 字段加到 SessionNode,Spawned edge 链路修复)                                 |
| 2026-07-03 | `4d4ea18`              | 7      | 实验 web:全图模式删 subagent 节点(折叠进详情面板)                                                                                |
| 2026-07-03 | `f41d555`              | 8      | 实验 web:详情面板跳 G3 RAG                                                                                                       |
| 2026-07-04 | `bc24a08`              | **M1** | **合并 G1 到主项目**:`/graph?view=graph`;`GraphDetailPanel` 跳主项目 `/session/:id` 原生路由;zustand `titleStore` + `graphStore` |
| 2026-07-04 | `683e61d`              | **M2** | **合并 G2 + G3**:recharts 引入;`AnalyticsView` / `RagChat` 搬入;`?q=query` 跨 tab prefill                                        |

3 PoC 决策 → 实施路径:S0-S3 推进(留 history) → 用户决定升主线 → M1 + M2 合并 → **M3 待启动**

---

## 实现规模 (实际 LOC)

| 层                      | Rust LOC | TS LOC                              | 依赖                                           |
| ----------------------- | -------- | ----------------------------------- | ---------------------------------------------- |
| ingest crate            | ~660     | —                                   | (零外部 — 纯 serde_json + walkdir)             |
| experiment web          | —        | ~1700 (5 个 view + 5 个 store/load) | react-force-graph-2d 600KB, d3 380KB, recharts |
| 主项目集成 (M1+M2 净增) | 0        | +11 文件,~900 行                    | recharts 装到主项目                            |

---

## 完成态架构 (M2 收口)

```
packages/frontend/src/
├── routes/
│   ├── GraphExplorerRoute.tsx      /graph 顶 tab 入口 + useSearchParams
│   ├── SessionsRoute.tsx           列表 + topbar 跳 /graph
│   └── SessionDetailRoute.tsx      原生 /session/:id (已支持 subagent context)
├── views/graph/
│   ├── GraphView.tsx               G1 force-directed + custom canvas
│   ├── GraphDetailPanel.tsx        详情面板 + 跳主项目原生 /session/:id
│   ├── AnalyticsView.tsx           G2 6 chart
│   ├── RagChat.tsx                 G3 hash-embedding + cosine
│   ├── graphStore.ts               zustand 共享 entries
│   ├── titleStore.ts               zustand 跨 tab display_title
│   ├── loader.ts / title.ts / analytics.ts / rag.ts / graph-types.ts / types.ts
│   └── {GraphDetailPanel,AnalyticsView,RagChat}.css
└── public/
    └── sessions.ndjson             M1/M2 临时数据源,M3 切 Tauri invoke
```

**会话详情跳转**(主项目原生的能力,被 G1 复用):

- main 节点: `navigate(/session/<sessionId>, { state: { session: <realMeta> } })`
- subagent 节点: `navigate(/session/<agentId>?path=<jsonlPath>, { state: { session: <virtualMeta>, subagentContext: {...} } })`
- 复用模板: `SubagentPanel.tsx:79-110` (主项目早已实现,subagent 跳父 + `?path=` F5 兜底)
- 之前跳 G3 RAG 按钮(实验 web 跳同应用另一 view)被替代为跳主项目原生的 `/session/:id`

---

## 待办 (M3 — 未启动)

1. **ingest crate 合并到 src-tauri**:`src-tauri/src/commands/graph.rs` 加 `list_graph(app: AppHandle) -> Vec<GraphEntry>` Tauri command;复用 moka cache 5min TTL
2. **`graphStore.load()` 切 Tauri invoke**:`packages/frontend/src/lib/api.ts` `apiListGraph()` 替换 `fetch('/sessions.ndjson')` 为 `invoke('list_graph')`
3. **删除实验 web**:`git rm -r experiment/embed-db/web/` + ingest crate(若已合并)
4. **清理 CI / README / docs** 残留 `experiment/` 引用
5. **用户决定时机合并** `experimental/embed-db` → `main`
6. **补 vitest + e2e** — M1/M2 跳过测试,M3 收尾时补 `loader.test` / `titleStore.test` / `GraphView.test` / `GraphDetailPanel.test` / `analytics.test` / `rag.test` + `e2e/graph-explorer.spec.ts`

触发 M3 的先决条件:

- 全部 6 个文件测试写过且过
- Tauri dev 启动后 `/graph?view=graph` 数据流从 invoke 来
- e2e smoke 全过
- 主项目原有 4 个 route 都不破

---

## 历史 (S0-S3 决策依据,保留作可追溯参考)

> 以下保留作"为什么这样选"的依据。**当前状态以上方完成态为准**。

### S4 原始决策(2026-07-01 写下,后由 M1+M2 覆盖)

| PoC               | 推荐决策                             | 当前实际(2026-07-04)               |
| ----------------- | ------------------------------------ | ---------------------------------- |
| **G1 Graph**      | 升主线首选                           | 已 ship M1 (`bc24a08`)             |
| **G2 Analytics**  | 保留 — dashboard                     | 已 ship M2 (`683e61d`)             |
| **G3 RAG (lite)** | 留 lite 入口,M2 真 embedding 推 v0.8 | M2 ship lite;真 embedding 仍待未来 |

G1 胜出的原因(现在依然成立):

- 用户**一眼**看见 agent 拓扑;main 项目做不到
- 纯前端 React = 零 backend 依赖
- 最少代码解决最大"认知负担"问题

### 各 PoC 实质洞察 (S0-S3)

**G1 Graph**: 在 a2349f0e 上看到 25 个 subagent 节点(全部 Explore/Design 角色,纯思考无实施),1.1B tokens — 用户**早就知道但从未图形化看到**的事实。

**G2 Analytics**: 6 个聚合函数 + 6 KPI,1.42B tokens / 26 subagent / 190 errors / 1048 thinking;模型漂移一目了然。但纯聚合,洞察靠用户自己摸索。

**G3 RAG (lite)**: hash embedding 召回精准但语义窄(`想睡` query 失败)。证明"用户确实想跨 session 召回,但需要真 embedding"。M1 (hash) 是 baseline;真 embedding 是 v0.8+ 路线项目。

### 维度对比表 (S4 原始)

| 维度                | G1  | G2 (lite) | G3 (lite) |
| ------------------- | --- | --------- | --------- |
| 跨 session 检索能力 | 5   | 3         | 4         |
| 可解释性            | 5   | 4         | 3         |
| 学习曲线(用户)      | 5   | 4         | 3         |
| 学习曲线(开发者)    | 3   | 2         | 2         |
| 演示价值            | 5   | 4         | 3         |
| 持久化价值          | 1   | 1         | 1         |

### S4 当时数据快照

```
35 sessions 真实数据
├─ G1: react-force-graph-2d 渲染 60+ 节点 (10 main + 25 subagent + 26 tool 等)
├─ G2: 6 chart + 6 KPI + token top 10 表
└─ G3: hash-embedding 索引 9ms / query < 1ms
```

`feature/subagent-parent-link` 上的 a2349f0e:

- 1.12B tokens / 25 subagent / 122 errors / 681 thinking blocks
- primary_model = MiniMax-M3 (主项目 Claude Code 模型 — 写错,实际是开发用的模型)
- top 3 工具: Bash / Edit / Read

> 注: a2349f0e 是 OpenClaw Session Viewer **自身开发用的会话语料**(用户在此会话开发 viewer 本身),不是真实用户会话数据。

### S4 当时推荐的"阶段 2"决策(已落地)

| S4 阶段 2 推荐                          | 实际落地                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| G1 升 main (`/explore` 或类似)          | `/graph?view=graph` (跟 S4 推荐 `Tauri 路由加 /explore` 略有差,但实质一致)                        |
| 合并后用 main 项目的 `list_sessions` 流 | M1/M2 用 `useGraphStore + fetch NDJSON`(双源);**M3 才接入 Tauri `list_graph()`**,正是 S4 推荐路径 |
| ingest crate 完全不动                   | M1/M2 不动(M3 才合并到 src-tauri)                                                                 |

---

## 文件总览 (历史 + 当前)

```
docs/experiments/
├── README.md                              # 3 PoC 概览 + 当前状态
├── embed-db-S0-findings.md                # S0 skeleton
├── embed-db-G1-graph-findings.md          # S1 G1;末尾 addendum 标 M1+M2
├── embed-db-G2-olap-findings.md           # S2 G2
├── embed-db-G3-rag-findings.md            # S3 G3
└── embed-db-findings.md                   # 本文件 — 完成态 + 历史

experiment/embed-db/                       # M3 后整个 git rm
├── Cargo.toml                             # workspace
├── ingest/                                # Rust 子 crate (~660 行)
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs / cli.rs
│       ├── graph.rs                       # SessionNode (含 RAG snippets + agent_id)
│       ├── scanner.rs
│       ├── parser.rs                      # 6 step 提取 + extract_agent_id_from_path
│       └── sinks/stdout.rs                # NDJSON output
└── web/                                   # Vite + React + TS (~1700 行,4173 跑)
    ├── package.json
    ├── vite.config.ts
    ├── public/sessions.ndjson             # 35 sessions → 36 行 NDJSON (~90KB)
    └── src/                                # 后续迁到主项目 (M1+M2 已完成)
```

---

## 一句话结论(2026-07-04 更新)

**3 PoC 全部 ship 到主项目**(M1 + M2 收口),G1 + G2 + G3 在 `/graph?view=...` 顶 tab 下跑,数据源临时走 fetch /sessions.ndjson,**M3 切 Tauri invoke + 删 experiment/** 是下一步(等用户决定时机)。

---
