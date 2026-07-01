# S4: 三 PoC 综合 findings + 决策建议

**日期**: 2026-07-01
**Sprint**: S4 (决赛) — 收口
**状态**: ✅ **三个 PoC 全部跑通**
**分支**: `experimental/embed-db` (commit 885adf7 + S4 commit)

---

## TL;DR

| PoC               | 价值                        | 成本 | 推荐                                       |
| ----------------- | --------------------------- | ---- | ------------------------------------------ |
| **G1 Graph**      | ⭐⭐⭐⭐⭐                  | 中   | **✅ 主推** — 升主线首选                   |
| **G2 Analytics**  | ⭐⭐⭐⭐                    | 低   | **✅ 保留** — dashboard 模式               |
| **G3 RAG (lite)** | ⭐⭐⭐ (M1) / ⭐⭐⭐⭐ (M2) | 低   | **🟡 保留 lite 作为入口** — 真 LLM 留 v0.8 |

**本轮出 demo 给所有 3 个方向,但**G1 Graph 显著胜出\*\*:

- 用户**一眼就能看见** agent 拓扑(60 节点力导向图),main 项目做不到
- 完成 = 浏览器端纯 React 渲染 = 零外部依赖
- 用最少代码解决最大的"认知负担"问题

---

## 三 PoC 对比表

### 维度 1:能给用户回答什么问题?

| PoC               | 强项问题                                                                                         | 弱项问题                                |
| ----------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------- |
| **G1 Graph**      | "这个 session 调用了哪些 subagent?谁 spawn 谁?" / "一个 session 里 25 个 subagent 是怎么协作的?" | 找具体文本内容 (要配合 G3) / 跨 session |
| **G2 Analytics**  | "最近 30 天 token 总消耗?" / "模型漂移?" / "哪个 session 错误率最高?"                            | 单 session 详情 / 关联关系              |
| **G3 RAG (lite)** | "我上次写 API 是哪个 session 怎么做的?" / "我 retry 最多的工具是啥?" (hash 不能跨字面)           | 语义模糊查询 (想睡 vs 疲倦)             |

### 维度 2:实现成本 (实际 LOC + 时间)

| PoC               | Rust LOC              | TS LOC                                 | 总耗时  | 主要依赖                     |
| ----------------- | --------------------- | -------------------------------------- | ------- | ---------------------------- |
| **G1 Graph**      | +110 (parser + graph) | ~250 (loader + GraphView)              | ~6 小时 | react-force-graph-2d (600KB) |
| **G2 Analytics**  | 0                     | ~570 (analytics + AnalyticsView + CSS) | ~3 小时 | recharts + d3 (380KB)        |
| **G3 RAG (lite)** | +30 (parser snippets) | ~300 (rag + RagChat + CSS)             | ~3 小时 | 0 deps (纯 JS)               |

### 维度 3:用户价值 (定性打分 1-5)

| 维度                | G1                    | G2 (M1)                | G3 (lite)        |
| ------------------- | --------------------- | ---------------------- | ---------------- |
| 跨 session 检索能力 | 5 (subagent 拓扑)     | 3 (聚合 + 不能 single) | 4 (召回 top-K)   |
| 可解释性            | 5 (节点 + 边肉眼可见) | 4 (SQL 类图表)         | 3 (hash 不透明)  |
| 学习曲线(用户)      | 5 (一打开就知道)      | 4 (6 chart 合理)       | 3 (要输入 query) |
| 学习曲线(开发者)    | 3 (parser 加字段)     | 2 (analytics 函数)     | 2 (rag.ts 简单)  |
| 演示价值            | 5 (视觉震撼)          | 4 (数据密集)           | 3 (冷静)         |
| 持久化价值          | 1 (无状态)            | 1 (无状态)             | 1 (无状态)       |

### 维度 4:扩展性

| PoC          | 加 schema 字段难度           | 数据规模上限                   |
| ------------ | ---------------------------- | ------------------------------ |
| G1 Graph     | 易 (parser.rs+graph.rs,几天) | 60-100 节点 fluent             |
| G2 Analytics | 易 (analytics.ts+UI)         | 500+ rows OK                   |
| G3 RAG lite  | 易 (rag.ts embed 替身)       | 1000+ session OK (~150ms 索引) |

---

## 每个 PoC 的"实质洞察"

### G1 Graph — 为什么胜出

打开 G1 Graph,用户**立刻**看出:

- OpenClaw Session Viewer 自己开发的 session (a2349f0e) **有 25 个 subagent**
- 每个 subagent 都有 `description` 注释(`"Explore time and timezone handling"`、`"查找 SAP 相关模型文件"`)
- 用 1.1B tokens,这是该用户**知道但从未图形化看到**的事实

main 项目 /session/<uuid> 详情页也能看到 SubagentPanel + SubagentInlineSummary,但需要**打开特定 session**。G1 直接给**全局视角**。

### G2 Analytics — 实用但不惊艳

打开 G2 Analytics,用户看到:

- 6 个 chart + 6 KPI,数据真实(1.42B tokens、26 subagent、190 errors、1048 thinking)
- 模型漂移一目了然:MiniMax-M3 × 34 + M2.7 × 1
- Token top 5 列表带 hover 高亮

**vs G1**: 它告诉用户**"你的数据是啥"**,但没告诉"为什么是这样"。纯聚合,洞察要用户自己摸索。

### G3 RAG (lite) — 召回 OK 但语义窄

输入 `openclaw session`,**精准召回 a2349f0e cosine 0.752**(OpenClaw Session Viewer dev)。
但输入 `想睡的 session`(或者需要同义召回的 query),hash embedding 完全失败。
**这个 PoC 证明了**:**用户确实想跨 session 召回,但需要更聪明的检索**。M1 (hash) 是 baseline,M2 (真 embedding) 才能完成 promise。

---

## 推荐:三阶段收口

### 阶段 1 (本周完成 ✅):三个 PoC 都跑通

三个 demo 都能开浏览器看到效果,信息密度对比明显。

### 阶段 2 (下一步建议):挑主推一个升 main

推荐 **G1 Graph 升 main**:

- 价值最高
- 不需要 backend 数据库(纯前端 React)
- Tauri 项目里直接做个 `/explore` route 把 GraphView 塞进去
- main session URL 兼容(click 节点跳 main 项目 `/session/<uuid>`)

代码量:

- `web/src/views/GraphView.tsx` → `packages/frontend/src/views/`
- `web/src/loader.ts` (NDJSON 加载) → 等价改成调 Tauri command 拉 SessionMeta
- 节点颜色 + hover + 渲染逻辑保留
- 实验分支的 `ingest/` **完全不动**(用 main 项目自己的 list_sessions 流)

### 阶段 3 (可选):G2 Analytics 进 settings tab

Analytics 作为"Advanced" tab 进 main,跟 Settings 并列:

- 复用 6 个聚合函数 + recharts
- 数据源:调 `apiListSessions()` (v0.6.1 已有) 一次性拉
- 时间范围切换天然支持(localStorage 持久化)

### 阶段 4 (未来 v0.8+):G3 RAG 真版本

换 `fastembed-rs` wasm (~30MB) 或 OpenAI text-embedding-3-small:

- 解除 M1 lite 的"不能跨字面召回"问题
- 但加 30MB model 体积,**只在该方向被选择升 main 时再加**

---

## 决策记录

### ✅ 已决定:继续在实验分支开发,定期 rebase main

参考 main commit list:实验分支 4 个 commit 全部在 `experimental/embed-db` 上,跟 main 解耦良好。

### ✅ 已决定:不上任何后端数据库

理由:35 sessions × 2KB 在浏览器内存里 9ms 索引,< 1ms 查询。DuckDB / SurrealDB / SQLite-vec 全部**没**增加价值。后续如果 sessions 突破 1 万,再考虑 SQLite-vec + FTS5(那个是 BM25 / FTS 的真正用场)。

### ✅ 已决定:实验分支不并回 main

写这份 findings 后,**实验分支保持 active**,等用户在 main 里推进 Graph v0.7.x 时 — 那个 PR 才会"消化"实验分支的代码。

### 🟡 待用户决定:G1 是否升 main?

- 选项 A:**立即升 main** — 写 PR,带 G1 GraphView 进 main
- 选项 B:**暂时搁置实验** — v0.6.1 已 ship,主项目先固化,实验分支冷藏
- 选项 C:**继续实验** — 加 message-level edges + subagent graph 节点 hover 展示 sub-graph

---

## 风险与缓解

| 风险                                | 缓解                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| 实验分支腐烂 (没人 main batch 进来) | 1 个月无 commit 自动归档到 `archive/embed-db/`                  |
| 升 main 时 rebase 大冲              | 实验分支只动 `experiment/embed-db/`,零接触 main — rebase 0 冲突 |
| G1 / G2 视觉风格跟 main 不一致      | 升 main 时改用 main 项目的 CSS 变量 + 设计 token                |
| 用户数据集会变(用户源数据变更)      | 重新 ingest + 重新 build 是 1 行命令                            |

---

## 文件总览 (S0 + S1 + S2 + S3)

```
docs/experiments/
├── README.md                              # 3 PoC 概览
├── embed-db-S0-findings.md                # S0 findings
├── embed-db-G1-graph-findings.md          # S1 findings
├── embed-db-G2-olap-findings.md           # S2 findings
├── embed-db-G3-rag-findings.md            # S3 findings
└── embed-db-findings.md                   # ⭐ S4 (本文件)

experiment/embed-db/
├── Cargo.toml                             # workspace
├── ingest/                                # ⭐ Rust 子 crate (~660 行)
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs
│       ├── cli.rs
│       ├── graph.rs                       # SessionNode (含 RAG snippets)
│       ├── scanner.rs
│       ├── parser.rs                      # 6 step 提取
│       └── sinks/stdout.rs                # NDJSON output
└── web/                                   # ⭐ Vite + React + TS (~1700 行)
    ├── package.json
    ├── vite.config.ts
    ├── public/sessions.ndjson             # 35 sessions × ~2.9 snippets = 90KB
    └── src/
        ├── main.tsx
        ├── App.tsx                        # 3-tab 路由
        ├── App.css / Analytics.css / RagChat.css
        ├── types.ts
        ├── loader.ts                      # NDJSON → graph nodes/links
        ├── graph-types.ts
        ├── analytics.ts                   # 6 聚合函数
        ├── rag.ts                         # hash embedding + cosine
        └── views/
            ├── GraphView.tsx               # ⭐ G1 (react-force-graph-2d)
            ├── AnalyticsView.tsx           # ⭐ G2 (recharts × 6)
            └── RagChat.tsx                 # ⭐ G3 (cosine topK 召回)
```

---

## 运行时数据 (实测)

```
35 sessions 真实数据
├─ G1: react-force-graph-2d 渲染 60+ 节点 (35 main + 25 subagent) 流畅
├─ G2: 6 chart + 6 KPI + token top 10 表
└─ G3: hash-embedding 索引 9ms / query < 1ms
```

OpenClaw Session Viewer 分支 `feature/subagent-parent-link` 上的真实会话:

- **a2349f0e-...**: OpenClaw Session Viewer 自开发主会话
  - 1.12B tokens / 25 subagent / 122 errors / 681 thinking blocks
  - primary_model = MiniMax-M3
  - top 3 工具: Bash / Edit / Read
  - **G1**:25 个紫点 subagent 节点,每点都有 description
  - **G2**:token top 1,该 session 占总 token 79%
  - **G3**:`openclaw session` query → cosine 0.752 **第一名**

---

## 三 PoC 价值排序 (从用户视角)

```
★  G1 Graph           ← 视觉冲击第一 / 立刻给 insight
★★  G2 Analytics      ← 数据清点 / 看到模型漂移 / top sessions
★★★  G3 RAG (lite)    ← 跨 session 自然语言探索的雏形
                       但需要真 embedding 才能 replace 关键词搜索
```

---

## 一句话结论

**三个 PoC 全部跑通,G1 Graph 是接下来最该升 main 的那个**(视觉震撼 + 纯 React + 零依赖)。G2 是个不错的 dashboard,但已经在 G1 里"看见"了。G3 lite 是更远期的 roadmap 项目(真 embedding 才是完整 promise)。

实验分支不会并回 main,留给将来的 v0.7.x Graph view PR 用。
