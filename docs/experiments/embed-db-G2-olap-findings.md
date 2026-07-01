# S2 / G2 findings: Analytics view 跑通 (frontend-only)

**日期**: 2026-07-01
**Sprint**: S2 (下周)
**方向**: G2 OLAP — SQL 跨维度聚合 / 统计可视化
**分支**: `experimental/embed-db`
**PoC 状态**: ✅ **demo 跑通 (front-end 走纯聚合,不走 DuckDB)**

---

## ✅ 完成清单

- [x] `web/src/analytics.ts` — 6 个纯函数聚合 + 时间范围过滤
- [x] `web/src/views/AnalyticsView.tsx` — 6 个 recharts + 时间范围切换 (24h/7d/30d/all) + Token Top 10 表
- [x] `web/src/Analytics.css` — 暗色 KPI / chart-card / table 样式
- [x] `pnpm add recharts@^3.9.1` (默认 + d3 依赖,自动)
- [x] `App.tsx` Analytics tab 从 "planned" → enabled
- [x] `pnpm build` 0 errors → dist/ 762KB JS (gzip 229KB) — recharts + d3 占了大部分
- [x] vite preview HTTP=200,sessions.ndjson + JS bundle 都能 serve
- [x] **真数据二次聚合 sanity check**:Node.js 模拟 analytics 函数从 s2.ndjson 跑数据

---

## ⚠️ 同样策略 — 不上 DuckDB

**计划里** G2 OLAP 用 `duckdb-rs` 列存 SQL;**实际** 跟 G1 一样,**纯前端聚合**:

- 35 sessions × 2KB 完全在浏览器内存里
- DuckDB Rust bundle + WASM 集成成本大(DuckDB WASM 在 Vite 里启动慢 + ~20MB)
- 6 个聚合 ~7 个简单 for-loop,毫秒级,在 React render 一次性算完
- **何时需要 DuckDB**: sessions 突破 10k 或需要 SQL cube/rollup/window function 时(留作 S5+)

---

## 6 个聚合功能展示

| #   | Chart                                          | 数据来源                                             |
| --- | ---------------------------------------------- | ---------------------------------------------------- |
| 1   | sessions_per_day × source (stacked bar)        | node.first_timestamp_ms / last_timestamp_ms + source |
| 2   | token_top_10 (horizontal bar)                  | node.token_total desc                                |
| 3   | top_tools (bar — sessions_count + total_calls) | edge `UsedTool` 聚合                                 |
| 4   | model_avg_thinking (bar)                       | node.primary_model + thinking_count                  |
| 5   | retry_rate (pie — 4 error_count 分桶)          | node.error_count 分桶                                |
| 6   | subagent_chain_distribution (bar)              | node.subagent_count 分桶                             |

外加:

- **6 KPI 卡片** (总 token / 总 session / 平均 token/session / subagent 调用数 / 错误总数 / 日期范围)
- **Token Top 10 表** 高密度 hover 高亮

---

## 真数据 sanity check (35 sessions)

```
=== G2 demo (35 sessions) ===
total tokens: 1.42B
total subagents: 26
total errors: 190
total thinking: 1048
sessions w/ subagents: 2
models: {
  'MiniMax-M3': { count: 34, tok: 1420546361, think: 1022 },
  'MiniMax-M2.7': { count: 1, tok: 2465323, think: 26 }
}
top 5 by tokens:
  a2349f0e-856 tok= 1.12B subagents= 25 err= 122   ← 长会话
  87d29ce8-5bd tok= 231.45M subagents= 0 err= 22
  bafe7b80-08f tok= 12.39M subagents= 0 err= 2
  a2349f0e-856 tok= 7.70M subagents= 0 err= 10     ← subagent JSONL
  a2349f0e-856 tok= 5.82M subagents= 0 err= 0      ← subagent JSONL
```

**关键观察**:

- OpenClaw Session Viewer 自己开发那个长会话 (a2349f0e) 消耗 1.12B tokens、25 subagent、122 errors — 真的"工具调用 + 思考"狠
- **2 个模型混用** (MiniMax-M3 34 次 + M2.7 1 次) — 展示模型选择漂移
- top 5 里有 3 个 `a2349f0e-...` 是 subagent JSONL(被当独立 session 列出)— 这是个**预期内的 limitation**:Ingest 没把 subagent JSONL 跟它的 parent 关联显示,S2 view 也保持现状

---

## 用户能看出的洞察

假设用户每月看 Analytics 视图:

1. **Token 趋势**: 看 30 天 / all 切换,看 token 总消耗有没有异常飙升
2. **错误率**: 4 分桶后,如果有 session 飘到 20+ errors,就是 "我最近是不是太累了" 或者 "agent 模型最近在挣扎什么"
3. **模型漂移**: 多个 model bar 一目了然 — "我什么时候从 M2.7 切到 M3?"
4. **Subagent 层级**: "10+ subagent" bucket 如果大量出现 = 深度使用 → G1 Graph view 去看具体哪个 session

---

## 决策与发现

### ✅ 好

1. **零数据库依赖** — 跟 G1 同步策略,前端 in-memory
2. **TypeScript 聚合函数 = 数据流检查 + 类型约束 + 不写 SQL 也强类型**
3. **6 个 chart + 时间范围切换 = 一个完整 dashboard**
4. **recharts 默认 d3 dep 拉进来**,bundle 大了(762KB),但研究 PoC 阶段不 care
5. **真数据 sanity check** 给出 insight(2 个模型 + 1 个超级会话)— 直接说明 OLAP 价值

### ⚠️ 限制 (在 demo 里已知)

1. **25 subagent JSONL 被当独立 sessions** — Ingest 不知道哪些 agent-\*.jsonl 已经算在 parent 里。修复方案:parser 加一个 subagent JSONL 的 marker (`is_subagent_root=true`),V2 view 折叠到 parent。这个超出 S2 范围,S4 决策时考虑
2. **retry_rate 用 error_count 桶代替真"重试率"** — 重试率需要 tool_use 失败后立刻有同 tool 的下次调用,得解析 message 顺序 — 真正实现要全文件扫或 SQL
3. **时间范围只过滤 first/last_timestamp_ms** — Claude session 通常 < 24h 跨度,所以 24h/7d/30d 主要用来遮蔽"老数据"
4. **没做 SQL 输入框** — Plan 里 4. ("Ask SQL" mini 输入框) 跳过了;前端 in-memory 不需要 SQL,需要时再加 SQL.js 也行

---

## 文件清单 (本 sprint 新增)

```
experiment/embed-db/web/
└── src/
    ├── analytics.ts                 # ⭐ 6 聚合 + summary + formatNum/formatDate
    ├── Analytics.css                # ⭐ 全 dashboard 样式
    └── views/AnalyticsView.tsx      # ⭐ 6 chart + 6 KPI + Top 10 表

docs/experiments/
└── embed-db-G2-olap-findings.md    # ⭐ 本文件
```

### 修改

- `experiment/embed-db/web/src/App.tsx` — Analytics tab 从 "S2 (planned)" → "S2", enabled
- `experiment/embed-db/web/src/App.css` — 重写(把 Analytics.css @import 进)
- `experiment/embed-db/web/package.json` — +`recharts`
- `experiment/embed-db/web/public/sessions.ndjson` — 重新 ingest 写入(75KB,新字段都到位)

---

## 验证步骤 (你也能跑)

```bash
cd /Users/forcetone/workspace/claude/openclaw-session-lookup

# 重新 ingest 数据
cargo run --manifest-path experiment/embed-db/Cargo.toml --release --quiet -- ingest -p ~/.claude/projects --out stdout > experiment/embed-db/web/public/sessions.ndjson 2>/dev/null
wc -l experiment/embed-db/web/public/sessions.ndjson

cd experiment/embed-db/web
pnpm build                     # 应该 0 errors, ~290ms
pnpm preview &                 # :4173

# 浏览器
NO_PROXY='*' open http://127.0.0.1:4173/
# 点 "G2 Analytics" tab
# 看 6 chart + 6 KPI + token top 10 表
# 切换 24h / 7d / 30d / all 顶栏按钮
```

---

## 候选 run time

- **ingest** (35 jsonl 实数据):< 1 秒
- **pnpm build**: 0.29 秒 (recharts + d3 让 bundle 翻倍到 762KB)
- **HTTP fetch /sessions.ndjson**: 200ms
- **前端 aggregate 35 sessions**: < 5ms (per call-site,useMemo 缓存)
- **Total render**: < 200ms

---

## 路径进度

| Sprint | 任务                          | Status |
| ------ | ----------------------------- | :----: |
| S0     | ingest skeleton + stdout sink |   ✅   |
| S1     | G1 Graph view (PoC)           |   ✅   |
| S2     | G2 OLAP (analytics 视图)      |   ✅   |
| S3     | G3 RAG (聊天 UI)              |   ⏳   |
| S4     | 三 PoC findings + 决策        |   ⏳   |

下一步 = **S3 G3 RAG**。

---

## S3 启动时的 5 个待办

1. **embedding 方案**: 选 OpenAI text-embedding-3-small API (有 key 优先) **或** 本地 fastembed-rs (无 key)
2. **FTS5 vs embed-only**: 先做 embed(简化)
3. **web/src/views/RagChat.tsx**:
   - 搜索框
   - 流式调用 LLM (复用 main analyze 流式端点,POST /analyze_session 改 path=NDJSON 在内存)
   - **不要 LLM**: 先做 "embedding 召回 + 显示 top 5 sessions" 的简化版
4. **ingest 加 embedding**:**不**,只在 ingest 加 assistant text block 落到 extra field,embedding 在 web 里现算 (冷启动 < 5s for 35 sessions)
5. **可选:cargo run 启动一个小 HTTP server 给前端调** — 或者全跑前端(WebAssembly/JS lib)

—

## 决策对照 (plan 里的 G2 验收标准)

| 标准                                                |       状态        |
| --------------------------------------------------- | :---------------: |
| ingest --out parquet --path ~/.claude/projects 跑完 | ⚠️ 改 stdout sink |
| web Analytics 视图打开 6 个 chart < 3s 全部渲染     |        ✅         |
| SQL 输入框跑 SELECT ... 返回结果                    |       跳过        |
| 时间范围筛选 24h/7d/30d 表头跟着重算                |        ✅         |

跟 G1 一样,G2 的"实质"(聚合可视化)已验证;DuckDB 留作 S5+ 决策。
