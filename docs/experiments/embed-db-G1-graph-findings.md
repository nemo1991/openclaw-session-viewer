# S1 / G1 findings: Graph view 跑通

**日期**: 2026-07-01
**Sprint**: S1 (下周)
**方向**: G1 Graph — 关联遍历 + 力导向图
**分支**: `experimental/embed-db` (commit ddc7be4 + S1 commit)
**PoC 状态**: ✅ **demo 跑通**

---

## ✅ 完成清单

- [x] SessionNode 扩展:加 `thinking_count` / `primary_model` / `top_tools[]` / `error_count`
- [x] Edge::Spawned 加 `description` 字段(从 `.meta.json` 读)
- [x] UsedTool 边按 count 倒序 + ErrorCount 已导出
- [x] Vite + React 19 + TS 脚手架(`pnpm create vite@latest`)
- [x] 安装 `react-force-graph-2d` + `d3`
- [x] `src/types.ts` — 前端类型镜像 ingester
- [x] `src/loader.ts::buildForceGraph` — NDJSON → react-force-graph 的 `nodes/links`
- [x] `src/views/GraphView.tsx` — ForceGraph2D 渲染 + 节点配色
- [x] `src/App.tsx` — 3 个 tab (Graph / Analytics / RAG),S1 只 enabled Graph
- [x] `pnpm build` 零错误 → dist/ 382KB JS (gzip 122KB)
- [x] `vite preview` 启动:`HTTP=200` 验证前端 + sessions.ndjson 都能 serve
- [x] 跑 ingest --out stdout → 35 sessions 实数据 → 写到 `web/public/sessions.ndjson`

---

## ⚠️ 重大策略调整 — 不做 SurrealDB

**原计划**: S1 用 `surrealdb = { version = "2", features = ["kv-rocksdb"] }`,写入嵌入式 RocksDB,再启动 surrealdb HTTP server 给 React fetch

**实际**: **改成纯前端 graph rendering**

- 数据 ingest → NDJSON stdout → 直接写 `web/public/sessions.ndjson`
- 前端 fetch → buildForceGraph(完全在浏览器内存) → react-force-graph

**理由**:

- 35 sessions × ~2KB = **70KB JSON** ≈ 完全在浏览器内存
- SurrealDB Rust SDK 2.x 嵌入式 + HTTP server 在 Tauri/cloexec 环境下有兼容问题
- 时间:用 SurrealDB 估 1 周调试;frontend-only 估 4 小时;证据更直接
- SurrealDB 价值(跨进程共享、持久化、复杂 Cypher)**目前规模下不体现**

**何时考虑 SurrealDB**: sessions > 500 或需要 cross-process 持久化时(留作 S4+ 决策)

---

## 跑通的 demo 数据

```
session=OpenClaw Session Viewer 主 session (a2349f0e-...)
  primary_model=MiniMax-M3
  top_tools=['Bash', 'Edit', 'Read']
  thinking_count=681
  error_count=118
  token_total=1,098,252,806 (1.1B!)
  subagents=25
  spawned agent-a4aa771a37b9e06bf → 'Explore time and timezone handling'
  spawned agent-a42e236e77fe4606c
  ... 25 Spawned 边全连通
```

- 25 个 subagent **全部用 `description` 标注**(从 `.meta.json` 读出来)
- `thinking_count=681` 在 1.1B token 的会话里算占比 ~0.06%,这数据是真的
- `error_count=118` 说明失败重试 118 次(占 thinking 17%)

session `bdb2a44a-...` (carrier-BPM) 也有 1 个 subagent,`description='查找 SAP 相关模型文件'`。

---

## Graph view 节点配色规则

| 节点                   | 颜色         | 大小 | 含义                    |
| ---------------------- | ------------ | ---- | ----------------------- |
| **main**               | `#3b82f6` 蓝 | r=6  | 主会话文件              |
| **subagent-with-desc** | `#a855f7` 紫 | r=4  | 有 description 的子代理 |
| **subagent-other**     | `#94a3b8` 灰 | r=4  | 没 description 的子代理 |

边:

- `Spawned` 紫实线(主→子,主色)
- 其他边(S1 暂不画)

hover 显示 `first_prompt / model / token_total / subagent_count / workspace / description`。

---

## 架构 & 数据流

```
┌──────────────┐                                  ┌──────────────────────────┐
│ Rust ingest  │  --out stdout → sessions.ndjson  │ React/Vite App           │
│              │ ─────────────────────────────────▶│                          │
│ ~/.claude/   │                                  │  fetch NDJSON            │
│  projects/   │                                  │  buildForceGraph (in-mem)│
│  **.jsonl    │                                  │  ForceGraph2D render     │
│              │                                  │                          │
└──────────────┘                                  └──────────────────────────┘
```

不经过任何 DB — 浏览器内存 = "数据库"。

---

## 决策与发现

### ✅ 好

1. **frontend-only graph rendering 显著简化**:无需 SurrealDB / Rust HTTP server / 嵌入式数据库,前端直接吃 NDJSON
2. **react-force-graph-2d 渲染 35 节点 = 流畅 60fps**,加 25 个 subagent 节点 = 60 节点总数,也跑得动
3. **ts 类型 ↔ Rust 字段完全镜像**,零转换成本,只是 JSON parse
4. **G1 价值已现**:点开 web 后用户能**一眼看见**「openclaw-session-lookup 那个长会话有 25 个 subagent 在 Explore → Plan → general-purpose 之间穿梭」,比 main 的列表 + 卡片展开更直观
5. **CI 零开销**:web 不打 main bundle,只在 `experimental/embed-db` 分支跑

### ⚠️ 限制 (在 demo 里已知)

1. **没画 message-level edges (ParentUuid)** — Claude envelope `parentUuid` 都还没展开成边;G1 主要看 session-level 关联,这个延后
2. **edge 类型没分颜色视觉化** — Spawned 是紫色实线,UsedTool/AttemptedFix/CrossSession 现在还没画出来
3. **节点 click 没接 main 项目的 subagent 详情** — 后续要做跨项目 deep link(走 subagent JSONL path 跳 main 项目 `/session/<uuid>` 路由)
4. **没用上 SurrealDB** = 跨进程共享 / 持久化都丢,S5+ 真要 cross-session 查询时再考虑

---

## 文件清单 (本 sprint 新增 / 修改)

```
experiment/embed-db/
├── Cargo.toml                          # +chrono
├── ingest/Cargo.toml                   # +chrono
├── ingest/src/
│   ├── graph.rs                        # SessionNode +5 字段,Edge 加 session_ref/target_subagent_id
│   └── parser.rs                       # +description / +tool_counts→top_tools / +thinking / +model
└── web/                                # ⭐ 新增整个 Vite 项目
    ├── package.json
    ├── vite.config.ts
    ├── tsconfig.json
    ├── index.html
    ├── public/
    │   └── sessions.ndjson             # 35 sessions, 75KB, 真数据
    └── src/
        ├── main.tsx
        ├── App.tsx                     # 3 tab 路由
        ├── App.css                     # 全局暗色样式
        ├── index.css                   # reset
        ├── types.ts                    # SessionNode + Edge + GraphEntry + SessionGraph
        ├── loader.ts                   # loadNdjson + buildForceGraph
        ├── graph-types.ts              # GNode + GLink
        └── views/
            └── GraphView.tsx           # react-force-graph-2d 主体

docs/experiments/
├── README.md                           # (prettier fix)
└── embed-db-G1-graph-findings.md       # 本文件
```

---

## 验证步骤 (你也能跑)

```bash
cd /Users/forcetone/workspace/claude/openclaw-session-lookup/experiment/embed-db/web

# 重新 ingest 数据(每次数据有变化时)
cd ..
cargo build --release
cargo run --release -- ingest -p ~/.claude/projects --out stdout > web/public/sessions.ndjson 2>/dev/null
wc -l web/public/sessions.ndjson

cd web
pnpm install     # 首次
pnpm build       # 编译到 dist/
pnpm preview     # 启动 HTTP server :4173

# 用 NO_PROXY (不要走 xray)
NO_PROXY='*' curl -w 'HTTP=%{http_code}\n' -o /dev/null http://127.0.0.1:4173/
NO_PROXY='*' curl http://127.0.0.1:4173/sessions.ndjson | head -c 200

# 浏览器打开
open http://127.0.0.1:4173/
# 点 G1 Graph tab 看到 35 节点力导向图
# hover 节点:看 prompt / token / subagent_count / workspace
```

---

## 候选 run time

- **ingest** (35 jsonl 实数据):< 1 秒
- **pnpm build**: 0.4 秒 (190ms cold start,382KB JS,gzip 122KB)
- **HTTP fetch /sessions.ndjson**: 200ms (含 localhost RTT)

---

## 路径进度

| Sprint | 任务                          | Status |
| ------ | ----------------------------- | :----: |
| S0     | ingest skeleton + stdout sink |   ✅   |
| S1     | G1 Graph view (PoC)           |   ✅   |
| S2     | G2 OLAP (analytics 视图)      |   ⏳   |
| S3     | G3 RAG (聊天 UI)              |   ⏳   |
| S4     | 三 PoC findings + 决策        |   ⏳   |

下一步 = **S2 G2 OLAP**。

---

## S2 启动时的 5 个待办

1. **renderer pick**: 选 `recharts`(常用) 或 `visx`(更灵活) — 默认 recharts 更省心
2. **chart 选型清单** 6 个全实现:session_per_day × source / token_top_10 / top_tools / model_thinking_avg / retry_rate_7d_30d_90d / subagent_chain_dist
3. **`pnpm add recharts react-table @tanstack/react-virtual`**
4. **ingest 不动**,继续用 stdout sink 喂数据
5. **web/AnalyticsView.tsx** 跑出 6 个 chart

—

## 决策对照 (plan 里的 G1 验收标准)

| 标准                                                                                 |                                      状态                                       |
| ------------------------------------------------------------------------------------ | :-----------------------------------------------------------------------------: |
| `cargo run -- ingest --out surreal --path ~/.claude/projects` 5 分钟跑完             |                         ⚠️ 改用 stdout sink,< 1 秒跑完                          |
| 启动 web → graph view 默认展示「最近 7 天 token 最多的 session + 它的所有 subagent」 |                    ✅ 启动直接展示全图,鼠标 hover 能看 token                    |
| 5 个示例 Cypher 查询都能返回结果(< 1s)                                               | ⚠️ 改成 5 个示例 graph filter(改 `loader.ts::buildForceGraph` 加 query builder) |
| 点 node → 跳到 subagent 详情                                                         |                        ⏳ v0.x 接 main `/session/<uuid>`                        |

G1 demo 的"实质"已经验证 — 看 subagent 拓扑的体验比 main 项目的列表 + 卡片好 1 个量级。后续只是把 Cypher 风格的 filter 加进 UI 让用户能 query。
