# Graph Explorer 推进总结(M2 收口态,2026-07-04)

> 历史内容(S0-S3 推进数据 + 决策依据)保留在本文件后半段。当前权威状态看 [README.md](./README.md) + [CHANGELOG.md](../../CHANGELOG.md) [Unreleased] 段 + [plan 文件](../../../.claude/plans/openclaw-session-session-session-transient-kernighan.md)。

---

## TL;DR

3 个 PoC 全部跑通并合并到主项目 `packages/frontend/`,挂 `/graph` 顶 tab 下。

| PoC          | 入口                      | 合并 commit |
| ------------ | ------------------------- | ----------- |
| G1 Graph     | `/graph?view=graph`       | `bc24a08`   |
| G2 Analytics | `/graph?view=analytics`   | `683e61d`   |
| G3 RAG       | `/graph?view=rag[&q=...]` | `683e61d`   |

**关键决策**:

1. **升主线** — 合并 G1/G2/G3 进 `packages/frontend/` 而非独立 binary(用户原话"实验特性分支分开,但与主线运行环境一支就好")
2. **不引入嵌入式图数据库** — 35 sessions × ~2KB ≈ 70KB in-memory,9ms 索引 / < 1ms 查询,DB 成本 > 收益
3. **数据源短期双源**(fetch + experiment web),M3 切 Tauri invoke
4. **子代理也能跳详情** — 复用 `SubagentPanel.tsx:79-110` 模板,`?path=` F5 兜底

---

## 完成时间线 (M1 + M2)

| 日期       | commit    | 阶段   | 关键变更                                                                                               |
| ---------- | --------- | ------ | ------------------------------------------------------------------------------------------------------ |
| 2026-06-22 | —         | S0     | branch + `experiment/embed-db/ingest/`;NDJSON sink                                                     |
| 2026-06-26 | —         | S1     | G1 force-directed 图 (60+ 节点)                                                                        |
| 2026-06-28 | —         | S1.5   | 节点半径 ∝ token / 角色配色 / 钻取 / 详情面板 / `display_title`                                        |
| 2026-06-28 | —         | S2     | G2 6 chart + 时间范围                                                                                  |
| 2026-06-29 | —         | S3     | G3 hash-embedding + cosine topK                                                                        |
| 2026-07-01 | —         | S4     | 综合 findings + 推荐升 main                                                                            |
| 2026-07-02 | —         | S6     | subagent 节点 `agent_id` 链路修复                                                                      |
| 2026-07-04 | `bc24a08` | **M1** | **合并 G1 到主项目**:`/graph?view=graph`;`GraphDetailPanel` 跳主项目 `/session/:id`;zustand store 改造 |
| 2026-07-04 | `683e61d` | **M2** | **合并 G2 + G3**:recharts 引入;`?q=` 跨 tab prefill                                                    |

---

## 完成态架构

```
packages/frontend/src/
├── routes/GraphExplorerRoute.tsx        /graph 顶 tab 入口
├── views/graph/
│   ├── GraphView.tsx                    G1 force-directed
│   ├── GraphDetailPanel.tsx             节点详情 + 跳主项目原生
│   ├── AnalyticsView.tsx                G2 6 chart
│   ├── RagChat.tsx                      G3 hash-embedding
│   ├── graphStore.ts                    zustand 共享 entries
│   ├── titleStore.ts                    zustand 跨 tab display_title
│   └── loader / title / analytics / rag / graph-types / types
└── public/sessions.ndjson               M3 切 Tauri invoke
```

**会话详情跳法**(主项目原生的能力,G1 复用):

```ts
// main 节点
navigate(`/session/${sessionId}`, { state: { session: <realMeta> } });
// subagent 节点
navigate(`/session/${agentId}?path=${jsonlPath}`, {
  state: { session: <virtualMeta>, subagentContext: {...} }
});
// 完全复用 SubagentPanel.tsx:79-110 模板
```

---

## 实现规模

| 层                      | Rust LOC | TS LOC            | 依赖                                 |
| ----------------------- | -------- | ----------------- | ------------------------------------ |
| ingest crate            | ~660     | —                 | (零外部 — serde_json + walkdir)      |
| experiment web          | —        | ~1700             | react-force-graph-2d 600KB, recharts |
| 主项目集成 (M1+M2 净增) | 0        | +11 文件, ~900 行 | recharts 装到主项目                  |

---

## 待办 (M3)

见 [CHANGELOG.md](../../CHANGELOG.md) `[Unreleased].### 待办 (M3)` 段 + [docs/experiments/README.md](./README.md) 的"M3 TODO"段。本文件不重复列,跟两处保持同步。

---

## 历史 (S0-S3 决策依据)

> S0-S3 各 sprint 的实数据 + 决策过程记录在各 findings 文件,保留作"为什么这样选"的可追溯参考:
>
> - [S0 skeleton](embed-db-S0-findings.md)
> - [S1 G1](embed-db-G1-graph-findings.md) — G1 胜出原因 + 节点配色规则 + 限制
> - [S2 G2](embed-db-G2-olap-findings.md) — 6 chart 选型 + recharts vs visx
> - [S3 G3](embed-db-G3-rag-findings.md) — hash embedding vs 真 embedding 边界
>
> 维度对比 (S4 原始分数 1-5): G1 跨 session 检索 5 / 可解释性 5 / 演示价值 5;G3 lite 语义召回 3-4。

---

## 一句话结论

**G1 + G2 + G3 已 ship 到主项目**(`/graph?view=...`),双源对照 (1420/4173)。**M3 切 Tauri invoke + 删 experiment/** 是最后一步,等用户决定时机。
