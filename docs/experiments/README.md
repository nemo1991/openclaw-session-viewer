# Graph Explorer 实验记录

> 位置: `experiment/embed-db/` (原型) + `packages/frontend/src/views/graph/` (合并后)
> 分支: `experimental/embed-db` (基于 `feature/subagent-parent-link`)
> 目标: 跨 session 关联大模型执行思路(子代理调用链可视化 + SQL 跨维度聚合 + 自然语言对话式分析)

---

## 状态总结 (M2 收口)

3 个 PoC 全部跑通,**已经合并到主项目** `packages/frontend/`,挂在 `/graph` 顶 tab 下:

- G1 Graph: force-directed 图 + 节点点击跳主项目 `/session/:id` 原生详情
- G2 Analytics: 6 chart + 时间范围切换
- G3 RAG: hash-embedding + cosine topK + 跨 tab prefill (`?q=query`)

**不再**在独立 Vite 服务跑(原 4173 实验 web 仍可跑作双源对照,但生产路径是 1420)。

`experiment/embed-db/` 留有完整 PoC 推进记录,作历史/可恢复参考。`docs/experiments/embed-db-findings.md` 是 S4 收口时的综合分析 + 推荐结论。

---

## 三个 PoC 推进记录

| PoC          | 方向                       | Frontend                     | Sprint | Findings                                                       |
| ------------ | -------------------------- | ---------------------------- | ------ | -------------------------------------------------------------- |
| G1 Graph     | 图遍历(子代理调用链可视化) | react-force-graph-2d         | S1     | [embed-db-G1-graph-findings.md](embed-db-G1-graph-findings.md) |
| G2 Analytics | SQL 跨维度聚合             | recharts                     | S2     | [embed-db-G2-olap-findings.md](embed-db-G2-olap-findings.md)   |
| G3 RAG       | 自然语言对话式分析         | hash-embedding lite (32-dim) | S3     | [embed-db-G3-rag-findings.md](embed-db-G3-rag-findings.md)     |

---

## 推进节奏

| Sprint | 目标                                 | Findings 路径                                      |
| ------ | ------------------------------------ | -------------------------------------------------- |
| S0     | branch + ingest skeleton             | [embed-db-S0-findings.md](embed-db-S0-findings.md) |
| S1-S5  | G1 PoC 推进 + G1 补强 + S6 drilldown | G1 findings                                        |
| S2     | G2 Analytics PoC                     | G2 findings                                        |
| S3     | G3 RAG PoC                           | G3 findings                                        |
| S4     | 综合 + 推荐决策                      | [embed-db-findings.md](embed-db-findings.md)       |
| M1     | 合并 G1 到主项目                     | commit `bc24a08`                                   |
| M2     | 合并 G2 + G3 + 跨 tab prefill        | commit `683e61d`                                   |
| M3     | 数据源切 Tauri + 删 experiment/      | 未启动                                             |

---

## 共享基础

复用 main 已有代码:

- `src-tauri/src/parser/claude.rs::normalize_record` — Claude JSONL NormalizedMessage
- `src-tauri/src/parser/openclaw.rs::normalize_entry` — OpenClaw JSONL NormalizedMessage
- `src-tauri/src/fs/walker.rs::list_jsonl_files` — 扫目录
- `src-tauri/src/commands/sessions.rs::build_*_session_meta` — 生成 SessionMeta

`experiment/embed-db/ingest/` 是独立 CLI,sink 输出 NDJSON。M3 计划合并到 src-tauri + 新 `list_graph()` command。

**数据来源**: 用户本地的 `~/.claude/projects/**.jsonl` + `~/.openclaw/agents/**/sessions/*.jsonl`。

---

## 合并后架构 (M1 + M2 完成态)

```
packages/frontend/src/
├── routes/
│   ├── GraphExplorerRoute.tsx     /graph 顶 tab 入口
│   ├── SessionsRoute.tsx          列表 + topbar 跳 /graph
│   └── SessionDetailRoute.tsx     原生 /session/:id (subagent context 已支持)
├── views/graph/
│   ├── GraphView.tsx              G1 force-directed 图
│   ├── GraphDetailPanel.tsx       节点详情 + 跳主项目原生会话详情
│   ├── AnalyticsView.tsx          G2 6 chart
│   ├── RagChat.tsx                G3 hash-embedding RAG
│   ├── graphStore.ts              zustand 共享 entries
│   ├── titleStore.ts              zustand 跨 tab display_title
│   └── ...
└── public/
    └── sessions.ndjson            M1/M2 临时数据源 (M3 切 Tauri)
```

**会话详情跳转模式** (复用 `SubagentPanel.tsx:79-110` 模板):

```ts
// main 节点
navigate(`/session/${sessionId}`, { state: { session: <realMeta> } });

// subagent 节点
navigate(`/session/${agentId}?path=${jsonlPath}`, {
  state: { session: <virtualMeta>, subagentContext: { parentSessionId, agentId, agentType } }
});
```

`?path=` 持久化兜底,F5 刷新后子会话仍能加载(`SessionDetailRoute.tsx:63-92`)。

---

## 同步策略

- 持续在 `experimental/embed-db` 分支迭代
- 跟 `feature/subagent-parent-link` 保持 rebasable
- M3 完成后,用户决定是否合并到 `main`

---

## 不在范围

- 不动 `src-tauri/src/commands/sessions.rs` 的 `list_sessions` 路径(M3 才动)
- 不上真 LLM(M1-M3 hash-embedding lite 够 demo)
- 不动 `packages/frontend/src/state/sessionsStore.ts`(Graph / Detail 共存靠独立 graphStore)
