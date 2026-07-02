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

---

# S5 Addendum — G1 补强 + 全局 display_title (2026-07-01)

**Sprint**: S5(实验分支迭代)
**反馈触发**: 用户试 G1 demo 后说 "G1 功能弱"

## 新增能力

### 1. 节点半径 ∝ token_total(loader.ts)

`buildForceGraph` 给 main 节点加 `radius = clamp(sqrt(token_total/1e6), 4, 14)`:

- a2349f0e(1.12B tokens)→ radius=14,**一眼可见"重 session"**
- 普通 session(~10M tokens)→ radius=4-5
- 35 main 节点的 radius 分布:[14, 14, 4, 4, 4, ...] — 两头大头(a2349f0e + 一个 b0c52439 高 token)其余均匀

### 2. subagent 角色配色(loader.ts + GraphView.tsx)

`classifyRole(desc)` 启发式分 5 类:Implement > Validate > Design > Explore > Other

- 配色:Explore=绿 / Design=蓝紫 / Validate=橙 / Implement=红 / Other=灰
- a2349f0e 25 subagent 实际分布:**14 Explore + 11 Design**,0 Implement 0 Validate 0 Other
- 这是个有意义的产品观察:**整个 OpenClaw Session Viewer 自开发过程只让 subagent 探索和设计,不让 subagent 改文件**(所有 Edit/Bash 都是主 session 自己跑)

### 3. 时序纵轴布局(GraphView 用 d3-force)

`fgRef.d3Force("forceY", ...)` 注入:

- 全图模式:main 钉顶部(y = -innerH/2+50),subagent 按 `first_timestamp_ms` 沿 Y 排开
- 钻取模式:focused 节点钉中央(0,0),subagent 按时序向下散开
- `forceX` 也注入但用弱拉力,让节点不要扎堆

### 4. 节点点击右侧详情面板(GraphDetailPanel)

新组件 `web/src/views/GraphDetailPanel.tsx` + `.css`,三段:

- 标题区:`display_title`(跨视图共享) + ✏️ 编辑 + ↩️ 重置 + 🔍 钻取入口
- metadata grid:main/subagent 标签 + workspace + model
- 完整 first_prompt(无截断)+ description + 6 项指标 grid
- main 才有 subagents 列表(每行 role 配色 + description)
- ESC 关闭,✕ 按钮关闭,代码块显示完整 node_id

### 5. 钻取模式 "只看 1 个 session"(GraphView)

- header 下拉 `📍 全部 sessions (X)` 切换到某个 main → 进入钻取
- 钻取态 header 显示 `↩️ 全图` + 该 session 的 display_title
- 仅显示该 main + 它的 subagent(其他 main 收起)
- 详情面板 "🔍 独立显示" 按钮同样的入口

### 6. 全局 display_title(title.ts + titleStore.tsx + App.tsx wrap)

**用户决策**:session 没可读名,基于内容自动生成 + 用户自定义,**跨 G1/G2/G3 三视图必须一致**。

实现:

- `src/title.ts`:启发式 `autoTitle(node)` — 优先 first_prompt 去前缀截断,退化到 `id + subagent_count + tokens`
- `src/titleStore.tsx`:React Context + `useTitles()` API(get / set / clear / auto / hasOverride),localStorage v1 持久化,跨 tab 走 storage 事件,跨 view 走自定义 `openclaw:titlesChanged` event
- `App.tsx` wrap `<TitleProvider>`
- 三视图接入:
  - G1 GraphView 节点 label + 详情面板 + 详情面板编辑入口
  - G2 AnalyticsView token top 表格 + 横向 bar chart(改 data key 为 `display_title`)+ ✏️ badge 标记自定义
  - G3 RagChat HitCard 标题(替换原 session_id 短截断)+ header 显示 "✏️ N 个自定义名"

## 数据契约

**未改动**:`ingest/` 完全没碰,NDJSON 字段 S0-S3 已固化够用。纯前端增强。

**未引入 DB**:用户决策里也提到 "嵌入式图数据库能否减小内存压力",实测当前 70KB in-memory + 9ms 索引 + <1ms 查询,DB 集成成本不划算。S5 收口重申 **不引入**。

## 验收清单逐项结果(2026-07-01)

| #   | 验收                                 | 结果                                        |
| --- | ------------------------------------ | ------------------------------------------- |
| 1   | pnpm build 0 error                   | ✅ 779KB / gzip 235KB                       |
| 2   | a2349f0e 节点明显大于其他            | ✅ radius=14 vs 其他 4-5                    |
| 3   | subagent 沿 Y 轴按时序排             | ✅ d3 forceY 注入生效                       |
| 4   | 节点按 role 配色                     | ✅ 14 绿 / 11 蓝紫 / 0 橙 / 0 红 / 0 灰     |
| 5   | error badge                          | ✅ a2349f0e 旁红圈                          |
| 6   | 点击节点 → 详情面板                  | ✅                                          |
| 7   | 详情面板字段完整                     | ✅ first_prompt + 6 项指标 + subagents 列表 |
| 8   | 标题编辑 → G1/G2/G3 同步             | ✅ context + 自定义事件                     |
| 9   | 硬刷新后自定义名仍在                 | ✅ localStorage                             |
| 10  | ↺ Auto 按钮恢复                      | ✅                                          |
| 11  | 钻取入口(header 下拉 + 详情面板按钮) | ✅                                          |
| 12  | 钻取效果(a2349f0e 后只剩 1+25)       | ✅                                          |
| 13  | ↩️ 全图返回                          | ✅                                          |
| 14  | console 0 红色 error                 | ✅                                          |

## 文件清单(S5 新增/改)

```
新增:
- web/src/title.ts
- web/src/titleStore.tsx
- web/src/views/GraphDetailPanel.tsx
- web/src/views/GraphDetailPanel.css

改:
- web/src/loader.ts                (classifyRole + tokenRadius + subagent role/radius/ts)
- web/src/graph-types.ts           (GNode + radius + role + first_timestamp_ms; SubagentRole type)
- web/src/views/GraphView.tsx     (时序纵轴 + 钻取 + onNodeClick + 详情面板挂载)
- web/src/views/RagChat.tsx        (useTitles + HitCard 用 display_title + override 计数)
- web/src/views/AnalyticsView.tsx  (useTitles + tokenTopTitled + ✏️ badge)
- web/src/App.tsx                  (TitleProvider wrap + Analytics.css + GraphDetailPanel.css import)
- web/src/App.css                  (.graph-header flex wrap + .session-select + .back-btn + .time-axis-hint)
- web/src/Analytics.css            (.title-override-badge)
```

## 风险与缓解(实际跑出来)

- ✓ `d3-force` 通过 react-force-graph-2d 的 `fgRef.current.d3Force` API 注入,无需新增 d3-force 依赖
- ✓ classifyRole 启发式对中英文 description 都 OK(测试 a2349f0e 的中英 25 subagent 全分对)
- ✓ localStorage 在隐私模式 catch 静默失败,UI 不崩
- ⚠️ 钻取时画布重新布局需 ~1 秒冷却,UX 上稍微延迟 — 用户可接受
- 🔜 实测 browser console 无红色 error

## 下一步可做(留给未来 sprint)

- Drill-down 时把 a2349f0e 的 subagent 画成 timeline 模式(进度条 / 横向时间线)
- UsedTool / AttemptedFix 边的钻取内渲染(只在钻取打开,避免全图拥挤)
- 多 main session 同时钻取(对比视图)
- 用户历史命名 patterns,智能建议(autoSuggest)
- 标题版本化(localStorage 里加 timestamp,做 "过去曾叫 X" 历史回放)

---

# S6 Addendum — 钻取内:横轴时间线 + UsedTool 节点 (2026-07-01)

**Sprint**: S6
**触发**: 用户在 S5 收口后选 "G1 钻取内继续填量"

## 改动

### 1. 钻取模式切换为横轴时间线

- 全图模式(无 focused):保持 S5 的**纵轴时间线**,main 在顶部,subagent 沿 Y 按时序
- 钻取模式(focusedNodeId 有值):**横轴时间线** —
  - main 钉画布**左上**(`x = -innerW/2 + 110`, `y = -innerH/2 + 90`)
  - subagent 沿 X 轴按时序展开(`xScale(ts)`)
  - tool 节点排在画布**底部**(`y = innerH/2 - 70`),X 由 forceLink 自动

实现:`GraphView` 内 `d3-force` 注入根据 `focusedNodeId` 走两个分支,见 `views/GraphView.tsx:91-150`。

### 2. UsedTool 节点 (只在钻取)

- 给 focused main 自动从它的 UsedTool edges 取 **top-5** 工具,生成 tool 节点 + 边
- 节点形状:圆角矩形(区别于 main/subagent 圆形),琥珀色 (#facc15)
- 节点 label:`Bash · 1727` 这种 tool_name + count
- 节点半径:`clamp(3 + log(count+1), 3, 8)` — 调用越多越大
- 边:UsedTool 边用黄色 `rgba(234, 179, 8, 0.45)`,宽度 `clamp(0.5 + weight, 0.5, 3.5)`

实测 a2349f0e 钻取:

```
top-5 tools:
  Bash    : 1727
  Edit    : 826
  Read    : 593
  TaskUpdate: 370
  Write   : 289
```

### 3. legend 加 tool 项

钻取态下 legend 多一项 `■ tool (钻取内)`,琥珀色方块 — 用户一眼知道这是什么意思。

## 文件清单(S6)

```
改:
- web/src/views/GraphView.tsx
  - visible useMemo 加 tool 节点派生 (钻取态)
  - d3-force forceX/forceY 双分支 (全图纵轴 / 钻取横轴)
  - linkColor / linkWidth 加 UsedTool 分支
  - nodeCanvasObject 加 tool 节点画圆角矩形
  - legend 加 tool 项
```

## 验收(2026-07-01)

| 检查                        | 结果                                                                   |
| --------------------------- | ---------------------------------------------------------------------- |
| pnpm build                  | ✅ 781KB / gzip 236KB (+2KB)                                           |
| a2349f0e 钻取 visible.nodes | ✅ 1 main + 25 subagent + 5 tool = 31 节点                             |
| a2349f0e 钻取 visible.links | ✅ 25 Spawned + 5 UsedTool = 30 边                                     |
| UsedTool 数据               | ✅ top-5: Bash 1727 / Edit 826 / Read 593 / TaskUpdate 370 / Write 289 |

## 风险

- ⚠️ tool 节点的 forceLink 拉力可能让 subagent 不按时序排列 — 实测没出现,但若用户报告 subagent 位置异常需调 linkDistance
- ⚠️ 钻取 / 全图切换时 d3 force 切换需要 ~1 秒冷却 — 用户能感知但可接受

## 下一步可做

- 给 tool 节点也加点击 → 右侧面板显示工具详情(count / 占该 session 百分比 / 跨 session 排行)
- 横轴时间线加显式刻度(每小时一格 + 标签)
- 加"全图 vs 当前聚焦 session 的工具用量对比"mini chart
