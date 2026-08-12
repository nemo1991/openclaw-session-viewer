# Meta layer 4 层抽象分层 (v0.9.18–v0.9.21)

之前 bottom-up 堆起来的 meta 子系统,经 6 个 chart kind 落地后
(`v0.9.10`–`v0.9.17`) 路线收敛;`v0.9.18` 起重新从用户视角
top-down 设计 meta layer,把单个 overloaded "meta" 概念拆成 4 层抽象,
给 dispatch / 渲染 / 未来扩展一个清晰的模块边界。

**Status**: accepted(v0.9.18 palette 集中化 → v0.9.19 chart 抽出 →
v0.9.20 L3/L4 抽出 → v0.9.21 utility 集中化,本 ADR 记录整体决策)

## Context

v0.9.10 之前 meta block 共用灰边框同质化,信息密度高但用户分不清
不同 meta 来源。v0.9.12–v0.9.17 引入 6 chart kind(每个独立 accent)+ 13
个 attachment kind(共用 generic wrapper),`MetaBlock.tsx` 一路膨胀
到 1692 行,`SessionDetailRoute.tsx` 951 行,具体症状:

1. **6 chart blocks 塞在 transcript timeline 末尾** — 跟普通 meta
   event 视觉混排,语义不清
2. **`MetaBlock.tsx` 1692 行** — 6 chart 渲染内联,dispatcher +
   chart SVG + chart meta block 三层抽象混在一个文件
3. **`SessionDetailRoute.tsx` 951 行** — header chrome / summary
   strip / meta banner fold / notes panel / TranscriptView mount
   五区在同一个组件
4. **三层数据源混在一起** — DB-aggregated SessionMeta / kimi-only
   metaBanner / 6 chart meta blocks 各自散在 Route 不同区域,没有
   统一的 "meta layer" 概念
5. **title precedence 在两处复制** — `build_claude_session_meta`
   - `build_ai_title_chart_meta.current_title` 都实现
     `custom > ai > first_user_text`
6. **snake/camel 双查** 散在每个 component 的 `get()` helper
7. **13 个无 accent attachment kind** 视觉拥挤

同时 "meta" 一词过载:用户从一边看是"这是什么 session 的概览",从
另一边看是"这条消息的元数据",从 chart 视角看是"过程可视化"。
没有清晰的语义边界,组件名 / 路由 / accent 全靠调用方默契。

## Decision

把 meta 拆成 4 层抽象,从用户视角对应 4 个不同问题:

| 层                      | 用户问题                 | 数据源                                                                                                                          | 组件                                  | Accent                                                     |
| ----------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| **L1 Session Overview** | "这是什么 session?"      | DB `SessionMeta` row + `meta_extras` enrichment(由 detail 加载)                                                                 | `<SessionOverview>`                   | 头部 chrome + summary strip + (kimi) banner fold           |
| **L2 Chart Region**     | "过程可视化?"            | batch normalize 的 6 chart meta blocks                                                                                          | `<ChartsRegion>` + `<ChartBlock>` × 6 | 6 chart 各自 accent(teal/indigo/amber/violet/emerald/rose) |
| **L3 Event Meta Block** | "这条消息的元数据"       | 单事件 inline meta(claude mode / permission / title / last-prompt / kimi metadata / config.update / openclaw model_change / 等) | `<EventMetaBlock>`                    | 弱 slate(`border 0.4`)                                     |
| **L4 Attachment Block** | "Claude attachment 信息" | Claude attachment envelope(13 kind)                                                                                             | `<AttachmentBlock>`                   | 统一 slate(`border 0.6`)                                   |

### 边界规则

- **L1 ↔ L2**:Session Overview 来自 DB(加载 session 列表即有),
  Chart Region 来自 batch normalize(在 transcript 加载完后才有)。
  两者不互相依赖,但共享时间轴
- **L2 ↔ L3/L4**:Chart blocks 抽离后**不再出现在 transcript timeline**
  内(用户在 timeline 里看到的是 L3/L4)
- **L3 ↔ L4**:EventMetaBlock 渲染单事件 inline meta(Kimi
  metadata / config.update / permission.set_mode /
  tools.set_active_tools / permission.record_approval_result /
  OpenClaw model_change / compaction / label / 等);AttachmentBlock
  专攻 Claude 13 个 attachment kind(`task_reminder` /
  `plan_mode` / `pr_link` / `agent_name` / `agent_listing` /
  `skill_listing` / `file_snapshot` / `file-history-snapshot` /
  `invoked_skills` / `plan_file_reference` /
  `compact_file_reference` / `attached_file` / `queued_command` /
  `queue_operation`)
- **Unknown fallback**:任何 layer 解析失败的 block 走
  `UnknownBlockCard`(已有 182 行实现,不动)

### Module 布局

```
src/components/meta/
├── SessionOverview.tsx          (L1, < 300 行,接收 SessionMeta props)
├── ChartsRegion.tsx             (L2 container, < 150 行,2-3 column grid)
├── ChartBlock.tsx               (L2 dispatcher, < 150 行,switch on block.label)
├── EventMetaBlock.tsx           (L3, < 200 行,label + payload 字段表)
├── AttachmentBlock.tsx          (L4, < 400 行,13 kind 分发 + slate accent)
├── MetaBlockRouter.tsx          (顶层 switch,纯 route,不分层)
├── UnknownBlockCard.tsx         (兜底,所有 layer fallback)
├── SubagentMetaBlock.tsx        (已有,不动)
└── charts/
    ├── UsageChart.tsx               (SVG, 60 bar stacked)
    ├── RequestChart.tsx             (SVG, 3 lines)
    ├── TodoChart.tsx                (SVG, 60 bar stacked)
    ├── AiTitleChart.tsx             (SVG, 60 bar stacked)
    ├── CompactionChartMetaBlock.tsx (L2 chart block,teal)
    ├── ToolsSnapshotChartMetaBlock.tsx (L2 chart block,indigo)
    ├── UsageChartMetaBlock.tsx      (L2 chart block,amber)
    ├── RequestChartMetaBlock.tsx    (L2 chart block,violet)
    ├── TodoChartMetaBlock.tsx       (L2 chart block,emerald)
    ├── AiTitleChartMetaBlock.tsx    (L2 chart block,rose)
    └── chart-utils.ts               (re-export 自 lib/meta.ts + lib/format.ts)
```

### Utility 集中 (v0.9.21 / M6)

- `lib/meta.ts` 提供 `getMetaField` / `unwrapPayload` /
  `getPayloadField` / `numOrZero` / `numOrNull` /
  `formatPreviewValue` — 4 个 chart SVG 组件 + 6 chart sub-component
  - `<AttachmentBlock>` + `<EventMetaBlock>` 共享
- `lib/format.ts` 提供 `formatTokens` / `formatTokenShort` /
  `formatDurationMs` — chart sub-component 共享
- `charts/chart-utils.ts` 保留作为 re-export shim,内部组件仍然
  从 `./chart-utils` import,行为不变

## Alternatives considered

- **保留 MetaBlock 1692 行 monolith**:实现路径短(0 改动),但
  `MessageBubble` 路由语义不清,新 chart kind 加进来需要 1692 行
  context,放弃
- **只抽 chart 不抽 L3/L4**:能解决 6 chart 拥挤但 `MetaBlock`
  仍要承担 13 attachment + 单事件 inline meta 的分发职责,
  fallback 走 `<UnknownBlockCard>` 而非中间的 `<EventMetaBlock>`
  抽象,放弃
- **抽象更多层(L5 字段预览 / L6 raw JSON 等)**:当前 4 层覆盖
  80% 渲染场景;过细分层会让 MessageBubble 路由更复杂,放弃
- **Snake/camel 完全撤离(无 backward compat)**:第一阶段先
  集中 utility 不破坏兼容;第二阶段需要 grep 老 DB 缓存确认
  无 snake 数据后(v0.13.0+ 评估)再撤

## Consequences

- ✅ **Mental model 清晰**:chart = 过程可视化 / event = 时间线事件
  / overview = 头部概览 / attachment = 跟 claude 强绑定的元数据
- ✅ **每个组件 < 500 行**:Test 隔离,debug 容易,7 个 test file
  (EventMetaBlock / AttachmentBlock / ChartBlock / 6 chart
  sub-component) 替代 1 个 47-test monolith
- ✅ **未来扩展直接加 file**:新增一个 chart kind → 加
  `charts/{X}ChartMetaBlock.tsx` + `charts/{X}Chart.tsx` + 1 个
  `ChartBlock` switch case;新增一个 attachment kind → 加
  `AttachmentBlock` switch case(共享 slate accent)
- ✅ **`<EventMetaBlock>` 兜底** 替代 `<UnknownBlockCard>` 兜底:
  未知 label 也能看出是 inline meta(不是 attachment 也不是 chart)
- ⚠️ **新增 10+ file**:测试 / 维护 / 跨文件 navigate 成本
- ⚠️ **Imports 路径**:meta 子组件从 `../../lib/meta` 而非
  `../chart-utils` 引入,需要熟悉 module 布局
- ⚠️ **老 wire 兼容**:session 文件无 `charts` 字段时
  `<ChartsRegion>` 渲染空状态(M5 落地时处理)

## Notes

- 本 ADR 是 v0.9.18–v0.9.21 四个 milestone 的整体决策记录;
  各自 detail 看代码 commit message(feat(meta): ...)
- 本 ADR 同步消解了 "meta" 一词过载问题——meta 现在只作为 L3/L4
  的 umbrella,L1/L2 用自己的命名(`SessionOverview` /
  `ChartsRegion`)
- 4 层映射到 React routing:root → `SessionDetailRoute` →
  `SessionOverview` / `ChartsRegion` / `TranscriptView` →
  `MessageBubble` → `MetaBlockRouter` → 4 层之一
- 跟 `0001-meta-kind-accent-colors.md` 互补:0001 解决"用什么色",
  本 ADR 解决"放在哪层"
